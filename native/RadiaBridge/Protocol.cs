using System.Text.Json;
using System.Text.Json.Serialization;

namespace RadiaBridge;

/// <summary>
/// Newline-delimited JSON over stdio. Every outbound message carries a "t" tag
/// that Electron switches on; commands arrive on stdin tagged with "c".
/// </summary>
public static class Protocol
{
    private static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // stdout is shared by the media thread and the audio thread, and a torn
    // line would break the reader on the other side.
    private static readonly object WriteLock = new();

    public static void Send(object message)
    {
        var json = JsonSerializer.Serialize(message, Options);
        lock (WriteLock)
        {
            Console.Out.Write(json);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
    }

    public static void Error(string code, string message) =>
        Send(new { t = "error", code, message });

    /// <summary>Diagnostics go to stderr so they never corrupt the data stream.</summary>
    public static void Log(string message) => Console.Error.WriteLine(message);
}

public sealed class TrackMessage
{
    public string t => "track";
    public required TrackPayload track { get; init; }
}

public sealed class TrackPayload
{
    public required string title { get; init; }
    public required string artist { get; init; }
    public required string album { get; init; }
    public required string appId { get; init; }
    public required string status { get; init; }
    public required long positionMs { get; init; }
    public required long durationMs { get; init; }
    public string? artHash { get; init; }
    public required long sampledAt { get; init; }
    public required bool canNext { get; init; }
    public required bool canPrev { get; init; }
    public required bool canSeek { get; init; }
}

/// <summary>Result of a transport command, so the UI can undo optimistic state.</summary>
public sealed class AckMessage
{
    public string t => "ack";
    public required string cmd { get; init; }
    public required bool ok { get; init; }
}

public sealed class ArtMessage
{
    public string t => "art";
    public required string hash { get; init; }
    public required string dataUrl { get; init; }
}

public sealed class AudioMessage
{
    public string t => "audio";
    public required AudioPayload frame { get; init; }
}

public sealed class AudioPayload
{
    public required long ts { get; init; }
    public required double rms { get; init; }
    public required double sub { get; init; }
    public required double bass { get; init; }
    public required double mid { get; init; }
    public required double treble { get; init; }
    public required double flux { get; init; }
    public required bool onset { get; init; }
    public required double bpm { get; init; }
}
