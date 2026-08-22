using System.Collections.Concurrent;
using Windows.Foundation;

namespace RadiaBridge;

/// <summary>
/// Runs every media-session call on one dedicated thread.
///
/// The WinRT session objects are marshalled to the apartment they were created
/// in, and calling one from any other thread fails with RPC_E_WRONG_THREAD
/// (0x8001010E) - permanently, for that object and everything reached through
/// it. In an async console app that is very easy to trip: a single `await` can
/// resume its continuation on a different thread-pool thread, and from then on
/// every command and every property read throws.
///
/// Rather than hope continuations land somewhere compatible, all session work is
/// queued onto this thread and performed synchronously, so the objects are only
/// ever touched from the apartment that owns them.
/// </summary>
internal sealed class SessionWorker : IDisposable
{
    /// <summary>Ceiling on a single session call, so one that never returns cannot wedge the queue.</summary>
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(4);

    private readonly BlockingCollection<Action> _queue = new();
    private readonly Thread _thread;

    public SessionWorker()
    {
        _thread = new Thread(Loop)
        {
            IsBackground = true,
            Name = "radia-media-session"
        };
        // MTA: an STA thread would need a message pump to service COM calls, and
        // blocking on a WinRT operation from one would deadlock.
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
    }

    private void Loop()
    {
        foreach (var work in _queue.GetConsumingEnumerable())
        {
            try
            {
                work();
            }
            catch (Exception ex)
            {
                // One failed item must never take the thread down; the whole
                // media pipeline would go silent with it.
                Protocol.Log($"session worker: {ex.GetType().Name} {ex.Message}");
            }
        }
    }

    /// <summary>Queues work. Order is preserved, so callers get sequencing for free.</summary>
    public void Post(Action work)
    {
        if (!_queue.IsAddingCompleted) _queue.Add(work);
    }

    /// <summary>Queues work and completes when it has run.</summary>
    public Task<T> RunAsync<T>(Func<T> work)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(() =>
        {
            try { tcs.TrySetResult(work()); }
            catch (Exception ex) { tcs.TrySetException(ex); }
        });
        return tcs.Task;
    }

    /// <summary>
    /// Blocks on a WinRT operation from the worker thread. Deliberately
    /// synchronous: awaiting here would hand the continuation to the thread pool
    /// and reintroduce the very cross-thread access this class exists to avoid.
    /// </summary>
    public static T Await<T>(IAsyncOperation<T> operation, string what) =>
        Block(operation.AsTask(), what);

    /// <summary>Same, for the progress-reporting operations (stream reads).</summary>
    public static T Await<T, TProgress>(IAsyncOperationWithProgress<T, TProgress> operation, string what) =>
        Block(operation.AsTask(), what);

    private static T Block<T>(Task<T> task, string what)
    {
        if (!task.Wait(CallTimeout))
        {
            throw new TimeoutException($"{what} did not complete within {CallTimeout.TotalSeconds:0.#}s");
        }
        return task.Result;
    }

    public void Dispose() => _queue.CompleteAdding();
}
