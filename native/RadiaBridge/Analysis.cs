using NAudio.Dsp;

namespace RadiaBridge;

/// <summary>
/// Turns a stream of mono samples into the handful of numbers the rim actually
/// animates from: band energies, a beat flag, and a tempo estimate.
/// </summary>
public sealed class Analysis
{
    public const int FftSize = 2048;
    private const int HopSize = FftSize / 2;          // 50% overlap
    private const int Bins = FftSize / 2;

    private readonly int _sampleRate;
    private readonly float[] _window = new float[FftSize];
    private readonly float[] _ring = new float[FftSize];
    private int _ringFill;

    private readonly Complex[] _fft = new Complex[FftSize];
    private readonly float[] _magnitude = new float[Bins];
    // Log-compressed magnitudes from the previous hop, for the flux.
    private readonly float[] _previousLog = new float[Bins];
    private readonly int _bassTop, _midTop;

    // Envelope-followed band energies, which is what actually leaves the helper.
    private double _sub, _bass, _mid, _treble, _rms;

    // Spectral flux history, for the adaptive onset threshold and tempo estimate.
    private readonly Queue<double> _fluxHistory = new();
    private const int FluxHistoryLength = 86;         // ~2s at 43 hops/sec
    private readonly double[] _scratch = new double[FluxHistoryLength];
    private double _previousFlux;
    private readonly List<double> _onsetTimes = new();
    private double _lastOnsetTime = -1;
    private double _clock;
    private double _bpm;

    // Beat tracker: a phase-locked loop on top of the onsets. Onsets are the
    // evidence; the beat is the tempo-locked prediction the rim moves on.
    private double _nextBeatTime = -1;
    private double _beatConfidence;
    private const double BeatWindow = 0.25;       // +/- share of a period an onset may miss by
    private const double PllGain = 0.35;          // how much of the timing error is corrected per beat
    private const double PeriodGain = 0.08;       // how much of it the tempo absorbs (second-order PLL)
    private const double TempoAgreement = 0.08;   // histogram tempos further than this from a locked one are ignored
    private const double ConfidenceGain = 0.25;
    private const double ConfidenceLoss = 0.15;
    private const double RejectLoss = 0.1;        // an off-grid onset is mild evidence the grid is wrong
    private const double LockedConfidence = 0.4;  // below this the next onset re-seeds the phase
    // Strength scale: a heard beat is 0.6-1.0 by how far it cleared the
    // threshold, a predicted fill 0.35-0.5 by confidence. Measuring heard beats
    // from zero made most of them ~0.1 and the rim barely moved on them.
    private const double HeardFloor = 0.6;
    private const double PredictedFloor = 0.35;
    private const double PredictedCeiling = 0.5;
    private const double SilentRms = 0.02;

    // Onset threshold: median + MadFactor * MAD of the recent flux. Robust to
    // the onsets themselves inflating the statistics the way a std-dev would.
    // 2.0 rather than 2.5 so quiet beats reach the tracker, which now does the
    // false-positive filtering the threshold used to have to.
    private const double MadFactor = 2.0;
    private const double MinMad = 0.02;
    private const double LogGain = 20;                // magnitude scale before log(1+x)
    private const double MidWeight = 0.25;            // 250Hz-2kHz contribution to flux

    public Analysis(int sampleRate)
    {
        _sampleRate = sampleRate;
        var binWidth = (double)sampleRate / FftSize;
        _bassTop = (int)(250 / binWidth);
        _midTop = (int)(2000 / binWidth);
        for (int i = 0; i < FftSize; i++)
        {
            // Hann window - the usual choice for music onset work; it trades a
            // slightly wider main lobe for much lower spectral leakage.
            _window[i] = 0.5f * (1f - MathF.Cos(2f * MathF.PI * i / (FftSize - 1)));
        }
    }

    /// <summary>
    /// Feeds mono samples in, emitting one frame per completed hop.
    ///
    /// A capture callback usually carries several hops' worth of audio. Emitting
    /// only the newest would silently swallow any onset that landed in an
    /// earlier hop, which is exactly the transient the rim is supposed to catch.
    /// </summary>
    public void Feed(ReadOnlySpan<float> samples, Action<AudioPayload> emit)
    {
        foreach (var sample in samples)
        {
            _ring[_ringFill++] = sample;
            if (_ringFill < FftSize) continue;

            emit(Process());

            // Slide the window forward by one hop, keeping the overlap.
            Array.Copy(_ring, HopSize, _ring, 0, FftSize - HopSize);
            _ringFill = FftSize - HopSize;
        }
    }

    private AudioPayload Process()
    {
        double sumSquares = 0;
        for (int i = 0; i < FftSize; i++)
        {
            sumSquares += _ring[i] * _ring[i];
            _fft[i].X = _ring[i] * _window[i];
            _fft[i].Y = 0;
        }

        FastFourierTransform.FFT(true, (int)Math.Log2(FftSize), _fft);

        // Onset evidence is half-wave rectified flux (only growth counts, so a
        // note ending is not a beat) of log-compressed magnitudes (so the scale
        // barely moves with system volume), weighted toward the bass: kicks and
        // snares live below 250Hz, and counting the top band let hi-hats fire
        // the detector three times per beat.
        double flux = 0;
        for (int i = 0; i < Bins; i++)
        {
            var magnitude = MathF.Sqrt(_fft[i].X * _fft[i].X + _fft[i].Y * _fft[i].Y);
            _magnitude[i] = magnitude;
            var logMag = MathF.Log(1f + (float)LogGain * magnitude);
            var delta = logMag - _previousLog[i];
            _previousLog[i] = logMag;
            if (delta <= 0 || i > _midTop) continue;
            flux += i <= _bassTop ? delta : MidWeight * delta;
        }

        var instantRms = Math.Sqrt(sumSquares / FftSize);
        _rms = Envelope(_rms, Compress(instantRms * 6), 0.5, 0.06);
        _sub = Envelope(_sub, BandEnergy(20, 60), 0.6, 0.08);
        _bass = Envelope(_bass, BandEnergy(60, 250), 0.6, 0.08);
        _mid = Envelope(_mid, BandEnergy(250, 2000), 0.5, 0.07);
        _treble = Envelope(_treble, BandEnergy(2000, 8000), 0.5, 0.07);

        var onset = DetectOnset(flux, out var strength);
        var (beat, beatStrength) = TrackBeat(onset, strength);
        _clock += (double)HopSize / _sampleRate;

        return new AudioPayload
        {
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            rms = Math.Round(_rms, 4),
            sub = Math.Round(_sub, 4),
            bass = Math.Round(_bass, 4),
            mid = Math.Round(_mid, 4),
            treble = Math.Round(_treble, 4),
            flux = Math.Round(flux, 4),
            onset = onset,
            bpm = Math.Round(_bpm, 1),
            beat = beat,
            beatStrength = Math.Round(beatStrength, 4),
            beatPhase = Math.Round(BeatPhase(), 3),
            beatConfidence = Math.Round(_beatConfidence, 2)
        };
    }

    /// <summary>
    /// Locks a beat clock to the onsets. Raw onsets are uneven: a fill lands
    /// off the grid, a soft verse drops a kick, a vocal consonant fires the
    /// detector between beats. Moving the rim on every onset reads as jitter.
    /// This keeps a predicted next-beat time from the tempo, lets an onset near
    /// it correct the phase (a PLL), ignores onsets far from it once locked,
    /// and fills in a softer beat when the expected onset never arrives - so
    /// motion stays regular through a quiet bar and stops within a few beats
    /// of the music actually stopping.
    /// </summary>
    private (bool beat, double strength) TrackBeat(bool onset, double strength)
    {
        if (_bpm <= 0)
        {
            // No tempo yet: nothing to predict, pass the evidence straight through.
            _beatConfidence = 0;
            _nextBeatTime = -1;
            return (onset, onset ? strength : 0);
        }

        var period = 60.0 / _bpm;
        var locked = _nextBeatTime >= 0 && _beatConfidence >= LockedConfidence;

        if (onset)
        {
            var error = _nextBeatTime >= 0 ? _clock - _nextBeatTime : double.PositiveInfinity;
            if (Math.Abs(error) <= BeatWindow * period)
            {
                // On the grid: nudge the clock toward where the beat really
                // fell, and let the tempo absorb a little of the error too, so
                // a lock that is consistently early or late drifts into tune
                // instead of correcting the same way every beat.
                period += PeriodGain * error;
                _bpm = Math.Clamp(60.0 / period, 60, 200);
                _nextBeatTime += PllGain * error + period;
                _beatConfidence = Math.Min(1, _beatConfidence + ConfidenceGain);
                return (true, strength);
            }
            if (!locked)
            {
                // Not locked: adopt this onset as the downbeat and start predicting from it.
                _nextBeatTime = _clock + period;
                _beatConfidence = Math.Min(1, _beatConfidence + ConfidenceGain);
                return (true, strength);
            }
            // Locked and off the grid: evidence, not a beat. Syncopation costs
            // a little confidence; a grid that is simply wrong rejects most
            // onsets, bleeds out within a few bars, and gets re-seeded.
            _beatConfidence = Math.Max(0, _beatConfidence - RejectLoss);
            return (false, 0);
        }

        // Expected a beat and none came. While the music is still audible,
        // fill it in softly and lose some confidence; enough misses in a row
        // unlock the tracker so the next real onset re-seeds it.
        if (locked && _clock >= _nextBeatTime + BeatWindow * period)
        {
            _nextBeatTime += period;
            _beatConfidence = Math.Max(0, _beatConfidence - ConfidenceLoss);
            if (_rms > SilentRms) return (true, PredictedFloor + (PredictedCeiling - PredictedFloor) * _beatConfidence);
        }

        return (false, 0);
    }

    /// <summary>Progress through the current beat, 0 just after one and rising to 1 at the next.</summary>
    private double BeatPhase()
    {
        if (_bpm <= 0 || _nextBeatTime < 0 || _beatConfidence < LockedConfidence) return 0;
        var period = 60.0 / _bpm;
        return Math.Clamp(1 - (_nextBeatTime - _clock) / period, 0, 1);
    }

    /// <summary>Mean magnitude across a frequency range, compressed into 0-1.</summary>
    private double BandEnergy(double lowHz, double highHz)
    {
        var binWidth = (double)_sampleRate / FftSize;
        var low = Math.Max(1, (int)(lowHz / binWidth));
        var high = Math.Min(Bins - 1, (int)(highHz / binWidth));
        if (high <= low) return 0;

        double sum = 0;
        for (int i = low; i <= high; i++) sum += _magnitude[i];
        return Compress(sum / (high - low + 1) * 40);
    }

    /// <summary>
    /// Music has a huge dynamic range; a linear mapping leaves the rim either
    /// black or saturated. This is a soft knee that keeps quiet detail visible.
    /// </summary>
    private static double Compress(double value) => Math.Min(1.0, Math.Sqrt(Math.Max(0, value)));

    private static double Envelope(double current, double input, double attack, double release)
    {
        var k = input > current ? attack : release;
        return current + (input - current) * k;
    }

    /// <summary>
    /// Flags an onset when flux rises clear of the recent distribution. The
    /// threshold is median + k*MAD over the last ~2s, so it self-tunes across a
    /// quiet intro and a loud chorus without any user knob; a fixed threshold
    /// cannot do that, and a mean/std-dev one is dragged up by the very spikes
    /// it is meant to find.
    /// </summary>
    private bool DetectOnset(double flux, out double strength)
    {
        strength = 0;
        var previousFlux = _previousFlux;
        _previousFlux = flux;

        _fluxHistory.Enqueue(flux);
        while (_fluxHistory.Count > FluxHistoryLength) _fluxHistory.Dequeue();
        var count = _fluxHistory.Count;
        if (count < FluxHistoryLength / 2) return false;

        var sorted = _scratch;
        _fluxHistory.CopyTo(sorted, 0);
        Array.Sort(sorted, 0, count);
        var median = sorted[count / 2];

        // Guard against silence, where the statistics are all numerical noise.
        if (median < 1e-3) return false;

        for (int i = 0; i < count; i++) sorted[i] = Math.Abs(sorted[i] - median);
        Array.Sort(sorted, 0, count);
        var mad = Math.Max(MinMad, sorted[count / 2] * 1.4826);

        // Rising edge only: the hop after a transient is usually still above
        // the threshold, and without this it fired again on the way down.
        var threshold = median + MadFactor * mad;
        var isOnset = flux > threshold
                   && flux > 1.3 * median
                   && flux > previousFlux;

        // Refractory period scaled to the tempo - half a beat, clamped so an
        // unknown or wild estimate cannot lock the detector up or let one hit
        // fire three times. 120 BPM gives the old fixed 250ms.
        var refractory = _bpm > 0 ? Math.Clamp(30.0 / _bpm, 0.15, 0.45) : 0.2;
        if (isOnset && _clock - _lastOnsetTime < refractory) isOnset = false;

        if (isOnset)
        {
            // How far clear of the noise floor the hit was: a kick that doubles
            // the threshold is a full-strength beat, a marginal one is HeardFloor.
            strength = HeardFloor + (1 - HeardFloor) * Math.Clamp((flux - threshold) / threshold, 0, 1);
            _lastOnsetTime = _clock;
            _onsetTimes.Add(_clock);
            if (_onsetTimes.Count > 32) _onsetTimes.RemoveAt(0);   // ~15-20s: long enough to vote, short enough to forget a tempo change
            EstimateTempo();
        }

        return isOnset;
    }

    /// <summary>
    /// Histograms inter-onset intervals and takes the strongest musically
    /// plausible one. Cheaper and steadier than autocorrelating the envelope.
    ///
    /// Once the beat tracker is locked, the histogram only fine-tunes: a
    /// syncopated section or a busy fill can flip the histogram's winner to a
    /// different tempo entirely, and following it there dragged the beat grid
    /// off a lock that was landing every beat. A locked tracker that is
    /// actually wrong loses confidence within a few beats, and then the
    /// histogram is allowed to re-seed it.
    /// </summary>
    private void EstimateTempo()
    {
        if (_onsetTimes.Count < 8) return;

        var buckets = new Dictionary<int, int>();
        for (int i = 1; i < _onsetTimes.Count; i++)
        {
            var interval = _onsetTimes[i] - _onsetTimes[i - 1];
            if (interval < 0.25 || interval > 2.0) continue;   // 30-240 BPM
            var bpm = 60.0 / interval;
            while (bpm < 70) bpm *= 2;                          // fold to a
            while (bpm > 180) bpm /= 2;                         // musical range
            var bucket = (int)Math.Round(bpm / 4) * 4;
            buckets[bucket] = buckets.GetValueOrDefault(bucket) + 1;
        }

        if (buckets.Count == 0) return;

        var best = 0;
        var bestCount = 0;
        foreach (var (bucket, count) in buckets)
        {
            if (count > bestCount) { bestCount = count; best = bucket; }
        }

        if (bestCount < 3) return;
        if (_bpm == 0) { _bpm = best; return; }

        var locked = _nextBeatTime >= 0 && _beatConfidence >= LockedConfidence;
        if (!locked) { _bpm = best; return; }               // nothing to protect: take the vote as-is
        if (Math.Abs(best - _bpm) > TempoAgreement * _bpm) return;
        _bpm = _bpm * 0.7 + best * 0.3;
    }

    /// <summary>Decays everything toward rest so the rim eases out of silence.</summary>
    public AudioPayload Idle()
    {
        _rms *= 0.9; _sub *= 0.9; _bass *= 0.9; _mid *= 0.9; _treble *= 0.9;
        _beatConfidence *= 0.9;
        return new AudioPayload
        {
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            rms = Math.Round(_rms, 4),
            sub = Math.Round(_sub, 4),
            bass = Math.Round(_bass, 4),
            mid = Math.Round(_mid, 4),
            treble = Math.Round(_treble, 4),
            flux = 0,
            onset = false,
            bpm = Math.Round(_bpm, 1),
            beat = false,
            beatStrength = 0,
            beatPhase = 0,
            beatConfidence = Math.Round(_beatConfidence, 2)
        };
    }
}
