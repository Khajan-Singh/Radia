using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace RadiaBridge;

/// <summary>
/// Captures whatever the speakers are playing via WASAPI loopback and pushes
/// analysis frames out. Deliberately source-agnostic: it hears Spotify, a
/// browser tab, and the notification chime alike.
/// </summary>
public sealed class AudioCapture : IDisposable
{
    private const double SilenceFloor = 1e-5;
    private const int SilenceFramesBeforeIdle = 40;   // roughly a second of hops

    private WasapiLoopbackCapture? _capture;
    private Analysis? _analysis;
    private MMDeviceEnumerator? _enumerator;
    private DeviceNotifier? _notifier;
    private float[] _mono = new float[8192];
    private int _silentFrames;
    private volatile bool _restarting;
    private readonly object _lock = new();

    public double Threshold { get; set; } = 1.4;

    public void Start()
    {
        lock (_lock)
        {
            StopCapture();

            try
            {
                _capture = new WasapiLoopbackCapture();
                _analysis = new Analysis(_capture.WaveFormat.SampleRate) { Threshold = Threshold };

                _capture.DataAvailable += OnData;
                _capture.RecordingStopped += OnStopped;
                _capture.StartRecording();

                Protocol.Log($"loopback started: {_capture.WaveFormat}");
            }
            catch (Exception ex)
            {
                Protocol.Error("audio-start", ex.Message);
            }
        }

        WatchDeviceChanges();
    }

    /// <summary>
    /// Loopback binds to one render device. If the user switches outputs mid
    /// track the old capture goes silent forever, so rebind on device changes.
    /// </summary>
    private void WatchDeviceChanges()
    {
        if (_notifier is not null) return;
        try
        {
            _enumerator = new MMDeviceEnumerator();
            _notifier = new DeviceNotifier(RestartSoon);
            _enumerator.RegisterEndpointNotificationCallback(_notifier);
        }
        catch (Exception ex)
        {
            Protocol.Log($"device notifications unavailable: {ex.Message}");
        }
    }

    private void RestartSoon()
    {
        if (_restarting) return;
        _restarting = true;
        Task.Run(async () =>
        {
            // Let the audio stack settle before grabbing the new default device.
            await Task.Delay(600);
            Protocol.Log("default output changed; restarting loopback");
            Start();
            _restarting = false;
        });
    }

    private void OnData(object? sender, WaveInEventArgs e)
    {
        var capture = _capture;
        var analysis = _analysis;
        if (capture is null || analysis is null || e.BytesRecorded == 0) return;

        try
        {
            var format = capture.WaveFormat;
            var channels = format.Channels;
            var bytesPerSample = format.BitsPerSample / 8;
            var frameCount = e.BytesRecorded / (bytesPerSample * channels);
            if (frameCount == 0) return;

            if (_mono.Length < frameCount) _mono = new float[frameCount * 2];

            var isFloat = format.Encoding == WaveFormatEncoding.IeeeFloat
                || (format.Encoding == WaveFormatEncoding.Extensible && bytesPerSample == 4);

            double peak = 0;
            for (int frame = 0; frame < frameCount; frame++)
            {
                double sum = 0;
                for (int channel = 0; channel < channels; channel++)
                {
                    var offset = (frame * channels + channel) * bytesPerSample;
                    sum += isFloat
                        ? BitConverter.ToSingle(e.Buffer, offset)
                        : BitConverter.ToInt16(e.Buffer, offset) / 32768.0;
                }
                var value = (float)(sum / channels);
                _mono[frame] = value;
                peak = Math.Max(peak, Math.Abs(value));
            }

            // WASAPI loopback delivers digital silence rather than stopping, so
            // silence has to be detected rather than waited for.
            if (peak < SilenceFloor)
            {
                if (++_silentFrames > SilenceFramesBeforeIdle)
                {
                    Protocol.Send(new AudioMessage { frame = analysis.Idle() });
                    _silentFrames = SilenceFramesBeforeIdle;   // keep decaying, don't overflow
                }
                return;
            }

            _silentFrames = 0;
            analysis.Threshold = Threshold;
            analysis.Feed(_mono.AsSpan(0, frameCount), payload =>
                Protocol.Send(new AudioMessage { frame = payload }));
        }
        catch (Exception ex)
        {
            Protocol.Error("audio-data", ex.Message);
        }
    }

    private void OnStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception is not null)
        {
            Protocol.Error("audio-stopped", e.Exception.Message);
            RestartSoon();
        }
    }

    private void StopCapture()
    {
        if (_capture is null) return;
        try
        {
            _capture.DataAvailable -= OnData;
            _capture.RecordingStopped -= OnStopped;
            _capture.StopRecording();
            _capture.Dispose();
        }
        catch { /* the device may already be gone; nothing useful to do */ }
        _capture = null;
    }

    public void Dispose()
    {
        lock (_lock) StopCapture();
        if (_enumerator is not null && _notifier is not null)
        {
            try { _enumerator.UnregisterEndpointNotificationCallback(_notifier); } catch { }
        }
        _enumerator?.Dispose();
    }

    /// <summary>Minimal notification sink; only the default-device change matters.</summary>
    private sealed class DeviceNotifier(Action onDefaultChanged) : IMMNotificationClient
    {
        public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
        {
            if (flow == DataFlow.Render && role == Role.Multimedia) onDefaultChanged();
        }

        public void OnDeviceStateChanged(string deviceId, DeviceState newState) { }
        public void OnDeviceAdded(string pwstrDeviceId) { }
        public void OnDeviceRemoved(string deviceId) { }
        public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key) { }
    }
}
