using System.Text.Json;

namespace RadiaBridge;

/// <summary>
/// The sensor helper. Electron spawns this and talks to it over stdio; it owns
/// the two capabilities Node cannot reach on Windows - the WinRT media session
/// and WASAPI loopback capture.
///
/// Run it directly in a terminal to watch the raw stream, which is the quickest
/// way to tell whether a problem is in the capture or in the UI.
/// </summary>
public static class Program
{
    public static async Task<int> Main()
    {
        // stdout is a data channel; anything stray on it corrupts the protocol.
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        var media = new MediaSession();
        var audio = new AudioCapture();

        try
        {
            await media.StartAsync();
        }
        catch (Exception ex)
        {
            Protocol.Error("media-init", ex.Message);
        }

        audio.Start();

        Protocol.Send(new { t = "hello", version = "0.1.0", media = true, audio = true });

        // Poll the timeline periodically. The session raises change events, but
        // several players do not fire them while position advances normally, so
        // without this the progress bar drifts from reality on long tracks.
        using var timer = new Timer(_ => media.RequestPublish(), null, 2000, 5000);

        await ReadCommandsAsync(media, audio);

        audio.Dispose();
        await media.DisposeAsync();
        return 0;
    }

    private static async Task ReadCommandsAsync(MediaSession media, AudioCapture audio)
    {
        while (true)
        {
            var line = await Console.In.ReadLineAsync();
            // stdin closing means Electron exited - shut down rather than orphan.
            if (line is null) return;
            if (string.IsNullOrWhiteSpace(line)) continue;

            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (!root.TryGetProperty("c", out var command)) continue;

                // Not awaited: the session worker already serialises these in
                // order, and blocking the reader here would let one slow command
                // starve every command queued behind it.
                switch (command.GetString())
                {
                    case "playpause":
                        _ = media.PlayPauseAsync();
                        break;
                    case "next":
                        _ = media.NextAsync();
                        break;
                    case "prev":
                        _ = media.PreviousAsync();
                        break;
                    case "seek":
                        if (root.TryGetProperty("positionMs", out var position))
                            _ = media.SeekAsync(position.GetInt64());
                        break;
                    case "threshold":
                        if (root.TryGetProperty("value", out var threshold))
                            audio.Threshold = threshold.GetDouble();
                        break;
                    case "refresh":
                        media.RequestPublish();
                        break;
                }
            }
            catch (Exception ex)
            {
                Protocol.Error("command", ex.Message);
            }
        }
    }
}
