---
title: C# Advanced
description: Advanced C# for senior roles - async/await internals, concurrency, garbage collection, IDisposable and high-performance memory APIs like Span<T>.
icon: "C#+"
color: "#9333ea"
---

## Async & Concurrency

### Q: How does async/await work, and what are the common pitfalls?
difficulty: Medium
tags: async, tasks, concurrency, performance
id: async-await-explained

#### Definition
`async`/`await` is compiler support for writing asynchronous, non-blocking code in a sequential style.
The compiler rewrites an `async` method into a state machine that implements `IAsyncStateMachine`.
When an `await` hits an operation that has not completed, the method returns to its caller and the thread is released.
When the awaited operation finishes, a continuation resumes the method from where it left off.
The resumption runs on the captured `SynchronizationContext` (UI apps) or the thread pool (ASP.NET Core and console apps).
Async methods return `Task`, `Task<T>`, `ValueTask`/`ValueTask<T>` or `IAsyncEnumerable<T>`, and exceptions are captured in the returned task.
The main benefit is scalability for I/O-bound work: no thread sits blocked waiting for the network or disk.

#### Answer
I'd explain it as: **async is about not wasting threads while waiting, not about running things in parallel.** A web server handling 10,000 concurrent requests that each wait on a database can do so with a handful of threads.

**Key points**
- The compiler generates a state machine; locals become fields so they survive across awaits.
- If the awaited task is already complete, execution continues **synchronously** with no thread switch.
- Exceptions are stored in the task and re-thrown at the `await` (the first inner exception for `AggregateException`).
- `ConfigureAwait(false)` skips the captured context; important in libraries, not needed in ASP.NET Core (no `SynchronizationContext`).

**Common pitfalls I look for in code reviews**

| Pitfall | Why it hurts | Fix |
|---|---|---|
| `.Result` / `.Wait()` | Blocks a thread, can deadlock in UI/legacy ASP.NET | `await` all the way up |
| `async void` | Exceptions crash the process, cannot be awaited | Return `Task` (only event handlers use `async void`) |
| Sequential awaits of independent calls | Total latency adds up | `Task.WhenAll` |
| `Task.Run` in ASP.NET Core for I/O | Just moves work to another pool thread | Use the real async API |
| Missing `CancellationToken` | Work continues after the client leaves | Accept and pass tokens through |

**Real-world usage:** every controller action, EF Core query (`ToListAsync`), `HttpClient` call and message handler in my projects is async end to end.

**Follow-ups the interviewer may ask**
- "Does `await` create a new thread?" No. I/O completion uses OS callbacks (IOCP/epoll); no thread is blocked.
- "What is `ValueTask` for?" Avoiding the `Task` allocation when the result is often synchronous (e.g. cache hits); never await a `ValueTask` twice.
- "How do you handle exceptions from `WhenAll`?" `await` throws the first one; inspect `task.Exception.InnerExceptions` for all.

#### Code
```csharp title="Parallel I/O with WhenAll and cancellation"
public sealed class DashboardService(HttpClient http, ILogger<DashboardService> logger)
{
    public async Task<Dashboard> LoadAsync(int userId, CancellationToken ct)
    {
        // Start all three I/O calls WITHOUT awaiting - they run concurrently
        Task<Profile?> profileTask = http.GetFromJsonAsync<Profile>($"users/{userId}", ct);
        Task<Order[]?> ordersTask  = http.GetFromJsonAsync<Order[]>($"users/{userId}/orders", ct);
        Task<int> unreadTask       = GetUnreadCountAsync(userId, ct);

        try
        {
            // Total latency ~= the slowest call, not the sum of all three
            await Task.WhenAll(profileTask, ordersTask, unreadTask);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            logger.LogInformation("Dashboard load for {UserId} cancelled", userId);
            throw;
        }

        // Tasks are complete, so awaiting them again is free and unwraps results
        return new Dashboard(await profileTask, await ordersTask ?? [], await unreadTask);
    }

    private async Task<int> GetUnreadCountAsync(int userId, CancellationToken ct)
    {
        var response = await http.GetAsync($"users/{userId}/unread", ct);
        response.EnsureSuccessStatusCode();
        return int.Parse(await response.Content.ReadAsStringAsync(ct));
    }
}

public record Profile(string Name);
public record Order(int Id, decimal Total);
public record Dashboard(Profile? Profile, Order[] Orders, int Unread);
```

```csharp title="Anti-patterns and their fixes"
public class ReportController(IReportService reports) : ControllerBase
{
    // BAD: sync-over-async blocks a thread pool thread (and deadlocks in classic ASP.NET)
    [HttpGet("bad")]
    public IActionResult GetBad() => Ok(reports.BuildAsync(CancellationToken.None).Result);

    // GOOD: async all the way, cancellation flows from the request
    [HttpGet("good")]
    public async Task<IActionResult> GetGood(CancellationToken ct)
        => Ok(await reports.BuildAsync(ct));
}

public class CachedPriceService(IPriceApi api)
{
    private readonly Dictionary<string, decimal> _cache = new();

    // ValueTask avoids allocating a Task on the hot cache-hit path
    public ValueTask<decimal> GetPriceAsync(string sku, CancellationToken ct)
    {
        if (_cache.TryGetValue(sku, out var cached))
            return ValueTask.FromResult(cached);          // synchronous, no allocation

        return new ValueTask<decimal>(FetchAndCacheAsync(sku, ct));
    }

    private async Task<decimal> FetchAndCacheAsync(string sku, CancellationToken ct)
    {
        var price = await api.GetPriceAsync(sku, ct);
        _cache[sku] = price; // note: use ConcurrentDictionary if shared across threads
        return price;
    }
}
```

### Q: What is the difference between a Task and a Thread?
difficulty: Hard
tags: async, threading, concurrency, tasks
id: task-vs-thread

#### Definition
A `Thread` is an operating-system level unit of execution with its own stack, typically around 1 MB reserved.
Creating and destroying threads is expensive, and each one is scheduled by the OS.
A `Task` is a higher-level abstraction representing an asynchronous operation that will complete in the future.
A task may run code on a thread-pool thread, or it may represent pure I/O that uses no thread at all while waiting.
Tasks support results, continuations, composition (`WhenAll`, `WhenAny`), cancellation and exception propagation.
The thread pool reuses a set of worker threads and adjusts their number with a hill-climbing algorithm.
In modern .NET you almost always use tasks; dedicated threads are reserved for special long-running or affinity scenarios.

#### Answer
The way I put it in interviews: **a thread is a worker, a task is a promise of a result.** A task might be executed by a worker, or it might just be waiting for a network card to signal completion.

**Key differences**

| Aspect | `Thread` | `Task` |
|---|---|---|
| Abstraction level | OS / low-level | Logical operation |
| Cost | ~1 MB stack, kernel object | Small heap object |
| Return value | None (use shared state) | `Task<T>` |
| Exceptions | Unhandled crashes the process | Captured, re-thrown on `await` |
| Composition | Manual `Join` | `await`, `WhenAll`, `WhenAny`, `ContinueWith` |
| Cancellation | None built-in (`Abort` removed) | `CancellationToken` |
| I/O waiting | Blocks the thread | No thread consumed |

**When I would still use a dedicated `Thread`**
- A long-lived loop that must not compete with the pool, e.g. a custom message pump (`TaskCreationOptions.LongRunning` also gives you a dedicated thread).
- Needing a specific apartment state (`STA` for COM/WinForms interop) or thread priority.

**Real-world usage:** in ASP.NET Core I use `async` tasks for I/O, `Parallel.ForEachAsync` for throttled concurrent I/O, `Parallel.For` or PLINQ for CPU-bound batch work, and `BackgroundService` for long-running workers instead of raw threads.

**Pitfalls / follow-ups**
- **Thread-pool starvation**: blocking calls (`.Result`, `Thread.Sleep`) inside tasks tie up pool threads and the pool injects new ones slowly, so latency explodes under load.
- `Task.Run` is for **CPU-bound** work; wrapping an I/O call in it does not make it more async.
- "What is the difference between `Task.Delay` and `Thread.Sleep`?" `Delay` uses a timer and frees the thread; `Sleep` blocks it.
- `Task.Factory.StartNew` with an async lambda returns `Task<Task>`; prefer `Task.Run`, which unwraps it.

#### Code
```csharp title="Thread vs Task side by side"
// Thread: no return value, manual coordination, unhandled exceptions kill the process
int threadResult = 0;
var thread = new Thread(() => threadResult = ExpensiveCalculation(10))
{
    IsBackground = true,
    Name = "calc-worker"
};
thread.Start();
thread.Join();                       // blocks the calling thread
Console.WriteLine(threadResult);

// Task: result, exception propagation and composition built in
Task<int> cpuTask = Task.Run(() => ExpensiveCalculation(10)); // CPU work on the pool
int taskResult = await cpuTask;      // caller's thread is free while waiting

// Pure I/O task: no thread is used while the request is in flight
using var http = new HttpClient();
Task<string> ioTask = http.GetStringAsync("https://example.com");

// Compose: wait for whichever finishes first, with a timeout
Task finished = await Task.WhenAny(ioTask, Task.Delay(TimeSpan.FromSeconds(2)));
Console.WriteLine(finished == ioTask ? "Downloaded" : "Timed out");

// Thread.Sleep blocks a thread; Task.Delay just schedules a timer
await Task.Delay(100);

static int ExpensiveCalculation(int n) =>
    Enumerable.Range(1, n * 1_000_000).Sum(i => i % 7);
```

```csharp title="Throttled concurrency with Parallel.ForEachAsync"
public sealed class ImageSyncWorker(IImageClient client, ILogger<ImageSyncWorker> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            IReadOnlyList<string> ids = await client.GetPendingIdsAsync(stoppingToken);

            var options = new ParallelOptions
            {
                MaxDegreeOfParallelism = 8,          // at most 8 downloads in flight
                CancellationToken = stoppingToken
            };

            // Async-aware: does not block pool threads while awaiting I/O
            await Parallel.ForEachAsync(ids, options, async (id, ct) =>
            {
                var bytes = await client.DownloadAsync(id, ct);
                await client.StoreAsync(id, bytes, ct);
            });

            logger.LogInformation("Synced {Count} images", ids.Count);
            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
        }
    }
}
```

## Memory & Performance

### Q: How do IDisposable and the garbage collector work together?
difficulty: Medium
tags: memory, gc, idisposable, resources
id: idisposable-and-gc

#### Definition
The garbage collector automatically reclaims managed memory for objects that are no longer reachable.
It is generational: short-lived objects live in Gen 0, survivors are promoted to Gen 1 and Gen 2, and objects of 85,000 bytes or more go to the Large Object Heap.
The GC does not know how to release unmanaged resources such as file handles, sockets or database connections, nor when it is best to do so.
`IDisposable` provides a deterministic `Dispose()` method to release those resources as soon as you are done.
The `using` statement or declaration guarantees `Dispose` is called, even when an exception is thrown.
`IAsyncDisposable` and `await using` do the same for resources that need asynchronous cleanup.
A finalizer (`~T()`) is a last-resort safety net that the GC runs later, and it is costly and non-deterministic.

#### Answer
I'd explain it as **two separate jobs**: the GC manages *memory*, `IDisposable` manages *everything else*. Disposing an object does not free its memory; it releases the resource it wraps, and the GC reclaims the memory later.

**Key points**
- The GC is triggered by allocation pressure, not by scope; you cannot predict when it runs.
- Gen 0 collections are cheap; Gen 2 (full) collections are expensive, so long-lived garbage hurts.
- Objects with finalizers survive at least one extra collection because they go onto the finalization queue.
- In modern code you rarely write finalizers; wrap native handles in a `SafeHandle`, which has its own finalizer.

| Mechanism | Deterministic? | Purpose |
|---|---|---|
| GC | No | Reclaims managed memory |
| `Dispose` / `using` | Yes | Releases resources now |
| Finalizer | No | Backup cleanup if `Dispose` was missed |

**Real-world usage**
- `DbContext`, `SqlConnection`, `FileStream`, `HttpResponseMessage` always go in `using`.
- In ASP.NET Core, the DI container disposes scoped and transient services it created at the end of the scope.
- `HttpClient` is the famous exception: don't create and dispose it per request (socket exhaustion); use `IHttpClientFactory` or a long-lived instance.

**Pitfalls / follow-ups**
- "Should I call `GC.Collect()`?" Almost never; it hurts performance and the GC tunes itself.
- Event subscriptions keep subscribers alive: a classic managed memory leak. Unsubscribe in `Dispose`.
- Implement `Dispose` idempotently and call `GC.SuppressFinalize(this)` only if you have a finalizer.
- Workstation vs Server GC, and `GCSettings.LatencyMode`, are good senior-level follow-ups.

#### Code
```csharp title="Implementing IDisposable and IAsyncDisposable"
// Usage: disposal is guaranteed even if WriteAsync throws
await using (var audit = new AuditWriter("audit.log"))
{
    await audit.WriteAsync("User 42 logged in");
}

public sealed class AuditWriter : IDisposable, IAsyncDisposable
{
    private readonly FileStream _stream;
    private readonly StreamWriter _writer;
    private bool _disposed;

    public AuditWriter(string path)
    {
        _stream = new FileStream(path, FileMode.Append, FileAccess.Write,
                                 FileShare.Read, bufferSize: 4096, useAsync: true);
        _writer = new StreamWriter(_stream);
    }

    public Task WriteAsync(string entry)
    {
        ObjectDisposedException.ThrowIf(_disposed, this); // .NET 7+ helper
        return _writer.WriteLineAsync($"{DateTime.UtcNow:O} {entry}");
    }

    // Sealed class wrapping only managed IDisposables: no finalizer needed
    public void Dispose()
    {
        if (_disposed) return;          // idempotent
        _writer.Dispose();              // flushes and closes the stream
        _disposed = true;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        await _writer.DisposeAsync();   // async flush, no blocking I/O
        _disposed = true;
    }
}
```

```csharp title="A managed memory leak via events"
public sealed class PriceTicker
{
    public event EventHandler<decimal>? PriceChanged;
    public void Publish(decimal price) => PriceChanged?.Invoke(this, price);
}

// The long-lived ticker holds a reference to every subscriber through its delegate.
// Without unsubscribing, widgets can never be collected, even after the UI drops them.
public sealed class PriceWidget : IDisposable
{
    private readonly PriceTicker _ticker;

    public PriceWidget(PriceTicker ticker)
    {
        _ticker = ticker;
        _ticker.PriceChanged += OnPriceChanged;
    }

    private void OnPriceChanged(object? sender, decimal price) =>
        Console.WriteLine($"New price: {price:C}");

    // Dispose breaks the reference so the GC can reclaim the widget
    public void Dispose() => _ticker.PriceChanged -= OnPriceChanged;
}
```

### Q: What is Span<T> and when should you use it?
difficulty: Hard
tags: memory, performance, span, allocations
id: span-of-t

#### Definition
`Span<T>` is a `ref struct` that represents a contiguous region of memory in a type-safe, bounds-checked way.
The memory can be a managed array, a slice of a string, stack memory from `stackalloc`, or native memory.
Slicing a span creates a new view over the same memory without copying or allocating.
`ReadOnlySpan<T>` is the read-only counterpart and is what `string.AsSpan()` returns.
Because it is a `ref struct`, a span can only live on the stack: it cannot be a field of a class, be boxed, or be captured by a lambda.
Before C# 13 it could not be used across `await` or in iterators at all; now it is allowed only where it does not cross those boundaries.
`Memory<T>` is the heap-storable companion type for asynchronous scenarios.

#### Answer
I'd describe `Span<T>` as **"a safe pointer plus a length"**. Its purpose is to let you parse, slice and transform data **without allocating** new arrays or substrings, which is why the whole .NET runtime (Kestrel, `System.Text.Json`, `int.Parse`) is built on it.

**Key points**
- `"2024-05-01".AsSpan(0, 4)` gives a view of the year without creating a new string.
- `stackalloc` + `Span<T>` gives you fast, GC-free buffers for small, short-lived data.
- APIs such as `int.Parse(ReadOnlySpan<char>)`, `TryFormat`, `Utf8Formatter` and `MemoryExtensions` all accept spans.
- The JIT can eliminate bounds checks in simple loops over spans.

| Type | Lives on | Usable in async | Typical use |
|---|---|---|---|
| `Span<T>` | Stack only | Not across `await` | Synchronous slicing/parsing |
| `ReadOnlySpan<T>` | Stack only | Not across `await` | Read-only views (strings) |
| `Memory<T>` | Heap OK | Yes | Buffers passed to async I/O |
| `T[]` | Heap | Yes | General storage |

**Real-world usage:** I have used spans to parse large CSV/log files line by line, to build custom protocol parsers over `PipeReader`, and in hot API paths where profiling showed `Substring`/`Split` allocations dominating GC time.

**Pitfalls / follow-ups**
- `stackalloc` large buffers can cause `StackOverflowException`; keep it small (e.g. under 1 KB) or fall back to `ArrayPool<T>.Shared`.
- Don't return a span over a `stackalloc` buffer; the compiler's ref-safety rules will stop you.
- Don't reach for spans everywhere; they add complexity. Measure first with BenchmarkDotNet.
- Follow-up: "What is `ArrayPool<T>`?" A shared pool of reusable arrays to avoid repeated large allocations; always return what you rent.

#### Code
```csharp title="Allocation-free parsing with ReadOnlySpan<char>"
// Usage: only the final message string (if needed) is allocated
string raw = "2024-05-01|3|Payment failed for order 991";
if (LogParser.TryParse(raw, out var log))
    Console.WriteLine($"{log.Date} L{log.Level}: {raw.AsSpan(log.MessageStart)}");

public readonly record struct LogEntry(DateOnly Date, int Level, int MessageStart);

public static class LogParser
{
    // Line format: "2024-05-01|3|Payment failed for order 991"
    public static bool TryParse(ReadOnlySpan<char> line, out LogEntry entry)
    {
        entry = default;

        int first = line.IndexOf('|');
        if (first < 0) return false;

        ReadOnlySpan<char> datePart = line[..first];          // slice, no Substring
        ReadOnlySpan<char> rest = line[(first + 1)..];

        int second = rest.IndexOf('|');
        if (second < 0) return false;

        // Span-based overloads parse without creating intermediate strings
        if (!DateOnly.TryParseExact(datePart, "yyyy-MM-dd", out var date)) return false;
        if (!int.TryParse(rest[..second], out var level)) return false;

        entry = new LogEntry(date, level, first + 1 + second + 1);
        return true;
    }
}
```

```csharp title="stackalloc with ArrayPool fallback"
using System.Buffers;

public static class Hashing
{
    public static string ToUpperHex(ReadOnlySpan<byte> data)
    {
        int length = data.Length * 2;
        char[]? rented = null;

        // Small inputs: buffer on the stack. Large inputs: rent from the pool.
        Span<char> buffer = length <= 512
            ? stackalloc char[length]
            : (rented = ArrayPool<char>.Shared.Rent(length));

        try
        {
            for (int i = 0; i < data.Length; i++)
            {
                data[i].TryFormat(buffer.Slice(i * 2, 2), out _, "X2");
            }
            return new string(buffer[..length]); // single allocation: the result
        }
        finally
        {
            if (rented is not null)
                ArrayPool<char>.Shared.Return(rented); // always give it back
        }
    }
}
```
