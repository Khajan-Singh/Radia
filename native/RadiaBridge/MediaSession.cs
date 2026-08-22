using System.Security.Cryptography;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace RadiaBridge;

/// <summary>
/// Watches the Windows media session for whatever is currently playing. This is
/// player-agnostic on purpose: Spotify, Apple Music, a browser tab and Groove
/// all surface through the same API, so the rim follows whatever makes sound.
///
/// Every call into WinRT happens on <see cref="SessionWorker"/>'s thread - see
/// that class for why. Change notifications arrive on arbitrary COM threads and
/// are immediately posted back onto the worker rather than acted on in place.
/// </summary>
public sealed class MediaSession : IAsyncDisposable
{
    private readonly SessionWorker _worker = new();

    /// <summary>
    /// How long a non-playing session has to stay "current" before it is
    /// allowed to take over the display.
    ///
    /// Windows reorders the current session on playback-state transitions, and
    /// a track skip produces a brief paused/changing flap. Without this, any
    /// paused source sitting in the background - a parked YouTube tab is the
    /// usual one - gets promoted for a fraction of a second on every skip and
    /// the whole UI flickers over to it and back.
    /// </summary>
    private static readonly TimeSpan SwitchGrace = TimeSpan.FromMilliseconds(1200);

    // Only ever touched from the worker thread.
    private GlobalSystemMediaTransportControlsSessionManager? _manager;
    private GlobalSystemMediaTransportControlsSession? _session;
    private string? _lastArtHash;
    private string? _attachedAppId;
    private Timer? _switchTimer;

    public Task StartAsync() => _worker.RunAsync(() =>
    {
        try
        {
            _manager = SessionWorker.Await(
                GlobalSystemMediaTransportControlsSessionManager.RequestAsync(),
                "session manager");
            _manager.CurrentSessionChanged += (_, _) => _worker.Post(Attach);
            Attach();
        }
        catch (Exception ex)
        {
            Protocol.Error("media-init", Describe(ex));
        }
        return true;
    });

    /// <summary>Requests a publish without waiting for it. Safe from any thread.</summary>
    public void RequestPublish() => _worker.Post(Publish);

    // ─── Worker-thread internals ─────────────────────────────────────────────

    private void Attach() => Attach(false);

    /// <summary>
    /// Adopts whatever Windows now calls the current session, subject to one
    /// rule: a session that is actually <c>Playing</c> wins immediately, but
    /// anything else - paused, stopped, or nothing at all - has to still be
    /// current <see cref="SwitchGrace"/> later before it is accepted.
    ///
    /// That is what keeps a parked background tab from stealing the display
    /// during the momentary flap a player produces when it changes track,
    /// while a source the user genuinely starts still takes over at once.
    /// </summary>
    /// <param name="deferred">
    /// True when this is the re-check fired by the grace timer, which accepts
    /// its candidate rather than deferring again - otherwise a permanently
    /// paused source could never take over at all.
    /// </param>
    private void Attach(bool deferred)
    {
        try
        {
            var candidate = _manager?.GetCurrentSession();
            var candidateId = SafeAppId(candidate);

            // Already on this app: nothing to re-subscribe, and crucially no
            // artwork reset (see below).
            if (candidate is not null && _session is not null && candidateId == _attachedAppId)
            {
                CancelSwitch();
                Publish();
                return;
            }

            if (!deferred && _session is not null && !IsPlaying(candidate))
            {
                // Might just be the flap. Give it a moment to prove itself.
                ScheduleSwitchRecheck();
                return;
            }

            CancelSwitch();

            if (_session is not null)
            {
                _session.MediaPropertiesChanged -= OnChanged;
                _session.PlaybackInfoChanged -= OnPlaybackChanged;
                _session.TimelinePropertiesChanged -= OnTimelineChanged;
            }

            var appChanged = candidateId != _attachedAppId;
            _session = candidate;
            _attachedAppId = candidateId;

            if (_session is not null)
            {
                _session.MediaPropertiesChanged += OnChanged;
                _session.PlaybackInfoChanged += OnPlaybackChanged;
                _session.TimelinePropertiesChanged += OnTimelineChanged;
            }

            // Only a genuinely different app means new artwork. Resetting on
            // every attach made the cover re-send - and visibly re-render -
            // twice for what was really one source staying put.
            if (appChanged) _lastArtHash = null;
            Publish();
        }
        catch (Exception ex)
        {
            Protocol.Error("session-attach", Describe(ex));
        }
    }

    /// <summary>
    /// Re-runs the switch decision after the grace period. One timer, rearmed
    /// rather than replaced, and it only ever posts back onto the worker: the
    /// session objects must not be touched from a thread-pool thread.
    /// </summary>
    private void ScheduleSwitchRecheck()
    {
        _switchTimer ??= new Timer(_ => _worker.Post(() => Attach(true)));
        _switchTimer.Change(SwitchGrace, Timeout.InfiniteTimeSpan);
    }

    private void CancelSwitch() =>
        _switchTimer?.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);

    private static bool IsPlaying(GlobalSystemMediaTransportControlsSession? session)
    {
        try
        {
            return session?.GetPlaybackInfo()?.PlaybackStatus
                == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        }
        catch
        {
            return false;
        }
    }

    private static string? SafeAppId(GlobalSystemMediaTransportControlsSession? session)
    {
        try
        {
            return session?.SourceAppUserModelId;
        }
        catch
        {
            return null;
        }
    }

    // These fire on COM threads, so they only enqueue - never touch the session.
    private void OnChanged(GlobalSystemMediaTransportControlsSession s, MediaPropertiesChangedEventArgs e) => _worker.Post(Publish);
    private void OnPlaybackChanged(GlobalSystemMediaTransportControlsSession s, PlaybackInfoChangedEventArgs e) => _worker.Post(Publish);
    private void OnTimelineChanged(GlobalSystemMediaTransportControlsSession s, TimelinePropertiesChangedEventArgs e) => _worker.Post(Publish);

    private void Publish()
    {
        var session = _session;
        if (session is null) return;

        try
        {
            var props = SessionWorker.Await(session.TryGetMediaPropertiesAsync(), "media properties");
            var timeline = session.GetTimelineProperties();
            var playback = session.GetPlaybackInfo();

            // Position is absolute within the media and StartTime is not always
            // zero, so both have to be rebased or position/duration are in
            // different frames and the progress ratio is quietly wrong.
            var duration = timeline.EndTime - timeline.StartTime;
            var position = timeline.Position - timeline.StartTime;
            if (position < TimeSpan.Zero) position = TimeSpan.Zero;
            if (duration > TimeSpan.Zero && position > duration) position = duration;

            string? artHash = null;
            if (props?.Thumbnail is not null)
            {
                var bytes = ReadThumbnail(props.Thumbnail);
                if (bytes is not null)
                {
                    artHash = Convert.ToHexString(MD5.HashData(bytes))[..16];
                    // Artwork is large relative to everything else on this pipe,
                    // so it only goes out when it actually changes.
                    if (artHash != _lastArtHash)
                    {
                        _lastArtHash = artHash;
                        Protocol.Send(new ArtMessage
                        {
                            hash = artHash,
                            dataUrl = $"data:{SniffMime(bytes)};base64," + Convert.ToBase64String(bytes)
                        });
                    }
                }
            }
            else
            {
                _lastArtHash = null;
            }

            Protocol.Send(new TrackMessage
            {
                track = new TrackPayload
                {
                    title = props?.Title ?? string.Empty,
                    artist = props?.Artist ?? string.Empty,
                    album = props?.AlbumTitle ?? string.Empty,
                    appId = session.SourceAppUserModelId ?? string.Empty,
                    status = playback?.PlaybackStatus switch
                    {
                        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "playing",
                        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => "paused",
                        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped => "stopped",
                        _ => "unknown"
                    },
                    positionMs = (long)position.TotalMilliseconds,
                    durationMs = (long)duration.TotalMilliseconds,
                    artHash = artHash,
                    sampledAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    canNext = playback?.Controls.IsNextEnabled ?? false,
                    canPrev = playback?.Controls.IsPreviousEnabled ?? false,
                    canSeek = playback?.Controls.IsPlaybackPositionEnabled ?? false
                }
            });
        }
        catch (Exception ex)
        {
            Protocol.Error("session-publish", Describe(ex));
            // A wrong-thread or disconnected failure means this session handle is
            // finished; drop it so the next attach picks up a live one.
            _session = null;
            _worker.Post(Attach);
        }
    }

    /// <summary>
    /// Reports the real image type from the magic bytes. The label used to be
    /// hardcoded to png while these are usually jpeg; consumers sniff content
    /// so nothing broke visibly, but nothing downstream could trust the type.
    /// </summary>
    private static string SniffMime(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
            return "image/jpeg";
        if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 &&
            bytes[2] == 0x4E && bytes[3] == 0x47)
            return "image/png";
        if (bytes.Length >= 12 && bytes[0] == 0x52 && bytes[1] == 0x49 &&
            bytes[2] == 0x46 && bytes[3] == 0x46 && bytes[8] == 0x57 &&
            bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
            return "image/webp";
        if (bytes.Length >= 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46)
            return "image/gif";
        if (bytes.Length >= 2 && bytes[0] == 0x42 && bytes[1] == 0x4D)
            return "image/bmp";
        // Unknown: jpeg is the overwhelmingly common case for session artwork,
        // and every consumer here sniffs content anyway.
        return "image/jpeg";
    }

    private static byte[]? ReadThumbnail(IRandomAccessStreamReference reference)
    {
        try
        {
            using var stream = SessionWorker.Await(reference.OpenReadAsync(), "thumbnail open");
            if (stream.Size == 0) return null;
            var buffer = new Windows.Storage.Streams.Buffer((uint)stream.Size);
            SessionWorker.Await(
                stream.ReadAsync(buffer, (uint)stream.Size, InputStreamOptions.None),
                "thumbnail read");
            using var reader = DataReader.FromBuffer(buffer);
            var bytes = new byte[buffer.Length];
            reader.ReadBytes(bytes);
            return bytes;
        }
        catch
        {
            // Some sources advertise a thumbnail they cannot actually produce.
            return null;
        }
    }

    // ─── Commands ────────────────────────────────────────────────────────────

    /// <summary>
    /// Runs a transport command on the worker thread and acknowledges the result,
    /// so the UI can undo optimistic state when a player refuses.
    /// </summary>
    private Task RunCommand(
        string name,
        Func<GlobalSystemMediaTransportControlsSession, IAsyncOperation<bool>> action)
        => _worker.RunAsync(() =>
        {
            // Re-resolve rather than trusting the cached handle: the owning app
            // may have closed, restarted, or handed the session off since.
            //
            // But only accept the re-resolved handle if it belongs to the app
            // that is actually on screen. Windows can promote a different
            // session between the click and this running, and without the
            // check a Next meant for Spotify gets delivered to whatever was
            // promoted, which starts playing something the user never asked
            // for. A restarted app keeps its AUMID, so the original intent
            // still holds.
            var current = _manager?.GetCurrentSession();
            var session = SafeAppId(current) == _attachedAppId ? current : _session;
            session ??= _session ?? current;
            if (session is null)
            {
                Protocol.Error(name, "no active media session");
                Protocol.Send(new AckMessage { cmd = name, ok = false });
                return false;
            }

            try
            {
                var ok = SessionWorker.Await(action(session), name);
                if (!ok) Protocol.Log($"{name}: session declined the command");
                Protocol.Send(new AckMessage { cmd = name, ok = ok });
                return ok;
            }
            catch (Exception ex)
            {
                Protocol.Error(name, Describe(ex));
                Protocol.Send(new AckMessage { cmd = name, ok = false });
                _session = null;
                _worker.Post(Attach);
                return false;
            }
        });

    public Task PlayPauseAsync() => RunCommand("cmd-playpause", s => s.TryTogglePlayPauseAsync());

    public Task NextAsync() => RunCommand("cmd-next", s => s.TrySkipNextAsync());

    public Task PreviousAsync() => RunCommand("cmd-prev", s => s.TrySkipPreviousAsync());

    public async Task SeekAsync(long positionMs)
    {
        await RunCommand("cmd-seek", s =>
        {
            // The UI works in the rebased frame published above, so StartTime has
            // to go back on before handing the value to the session. And
            // TryChangePlaybackPosition takes 100ns ticks, not milliseconds.
            var start = s.GetTimelineProperties().StartTime;
            var target = TimeSpan.FromMilliseconds(positionMs) + start;
            return s.TryChangePlaybackPositionAsync(target.Ticks);
        });

        // Players keep reporting the old position for a moment after a seek, so
        // reading it back immediately just republishes the stale value. The delay
        // happens off the worker; only the publish itself is queued back onto it.
        await Task.Delay(400);
        RequestPublish();
    }

    /// <summary>WinRT failures carry no Message, so the HRESULT has to be spelled out.</summary>
    private static string Describe(Exception ex)
    {
        var hint = ex.HResult switch
        {
            unchecked((int)0x8001010E) => " (RPC_E_WRONG_THREAD)",
            unchecked((int)0x800706BA) => " (RPC server unavailable)",
            _ => string.Empty
        };
        return $"{ex.GetType().Name} 0x{ex.HResult:X8}{hint} {ex.Message}".Trim();
    }

    public ValueTask DisposeAsync()
    {
        // Dispose the timer before the worker: a pending re-check would
        // otherwise post onto a queue that is already shutting down.
        _switchTimer?.Dispose();
        _switchTimer = null;
        _worker.Dispose();
        return ValueTask.CompletedTask;
    }
}
