---
title: LINQ
description: Language Integrated Query - deferred execution, IEnumerable vs IQueryable, common operators and writing LINQ that performs well in memory and with EF Core.
icon: "LQ"
color: "#2563eb"
---

## Fundamentals

### Q: What is deferred execution in LINQ?
difficulty: Easy
tags: linq, deferred-execution, collections, performance
id: deferred-execution

#### Definition
Deferred execution means a LINQ query is not run when it is defined, but only when its results are enumerated.
Defining a query such as `Where` or `Select` just builds a pipeline of iterators (or an expression tree for `IQueryable`).
Enumeration happens with `foreach`, or when calling an operator that needs the data, such as `ToList`, `Count`, `First` or `Sum`.
Operators that return a single value or a materialised collection are executed immediately.
Because execution is deferred, each enumeration re-runs the whole query against the current state of the source.
Streaming operators like `Where` and `Select` yield one element at a time, while `OrderBy` and `GroupBy` must read the full source first.
Deferred execution enables composition and laziness, but it can cause repeated work and surprising results if misunderstood.

#### Answer
I'd explain it as: **a LINQ query is a recipe, not the meal.** Writing `var q = orders.Where(o => o.Total > 100);` stores the recipe; nothing runs until someone enumerates `q`.

**Key points**
- **Deferred (lazy)**: `Where`, `Select`, `SelectMany`, `Take`, `Skip`, `OrderBy`, `GroupBy`, `Join`, `Distinct`.
- **Immediate**: `ToList`, `ToArray`, `ToDictionary`, `Count`, `Any`, `First`, `Single`, `Sum`, `Max`, `Aggregate`.
- Within deferred operators, **streaming** ones (`Where`, `Select`) process one item at a time; **non-streaming** ones (`OrderBy`, `GroupBy`, `Reverse`) buffer the whole source on first `MoveNext`.

| Benefit | Risk |
|---|---|
| Compose queries in steps (add filters conditionally) | Multiple enumeration repeats expensive work |
| Process huge/infinite sequences lazily | Results reflect source changes after definition |
| `Take(10)` stops early | Exceptions surface at enumeration, far from the definition |
| EF Core builds one SQL statement | Enumerating after `DbContext` disposal throws |

**Real-world usage:** I build EF Core queries conditionally (`if (filter.Status is not null) query = query.Where(...)`) and materialise once at the end with `ToListAsync`. For in-memory pipelines over large files I rely on streaming with `File.ReadLines`.

**Pitfalls / follow-ups**
- The IDE warning "Possible multiple enumeration of IEnumerable" is real: calling `Count()` then `foreach` runs the query twice. Materialise with `ToList()` if you need it more than once.
- Closures capture variables, not values: changing a captured variable before enumeration changes the result.
- Returning a lazy `IEnumerable` from a method that disposes its data source (e.g. a `using` reader) leads to `ObjectDisposedException`.
- "Is `yield return` related?" Yes, it is how you write your own deferred, streaming operators.

#### Code
```csharp title="When does the query actually run?"
var numbers = new List<int> { 1, 2, 3 };
int threshold = 1;

// Defined, not executed. The lambda captures the VARIABLE threshold.
IEnumerable<int> query = numbers.Where(n =>
{
    Console.WriteLine($"  checking {n}");
    return n > threshold;
});

numbers.Add(4);      // source changes after the query was defined
threshold = 2;       // captured variable changes too

Console.WriteLine("First enumeration:");
foreach (var n in query) Console.WriteLine(n);   // 3, 4  (sees both changes)

Console.WriteLine("Count():");
Console.WriteLine(query.Count());                 // runs the whole pipeline AGAIN

// Materialise once when you need the results multiple times
List<int> snapshot = query.ToList();
numbers.Add(5);
Console.WriteLine(snapshot.Count);                // 2 - snapshot is fixed
```

```csharp title="Writing a deferred, streaming operator with yield"
public static class EnumerableExtensions
{
    // Splits a sequence into batches lazily (built-in Chunk() does this since .NET 6)
    public static IEnumerable<List<T>> Batch<T>(this IEnumerable<T> source, int size)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        return Iterator(source, size);   // validate eagerly, iterate lazily

        static IEnumerable<List<T>> Iterator(IEnumerable<T> source, int size)
        {
            var batch = new List<T>(size);
            foreach (var item in source)
            {
                batch.Add(item);
                if (batch.Count == size)
                {
                    yield return batch;
                    batch = new List<T>(size);
                }
            }
            if (batch.Count > 0) yield return batch;
        }
    }
}

// Streams a multi-GB file: only one batch of lines is in memory at a time
// foreach (var lines in File.ReadLines("huge.csv").Skip(1).Batch(1000))
//     await importer.ImportAsync(lines);
```

### Q: What is the difference between IEnumerable<T> and IQueryable<T>?
difficulty: Medium
tags: linq, ef-core, collections, expression-trees
id: ienumerable-vs-iqueryable

#### Definition
`IEnumerable<T>` represents an in-memory sequence that can be iterated, and its LINQ operators take delegates (`Func<T, bool>`).
Those delegates are compiled code that runs in your process, using LINQ to Objects.
`IQueryable<T>` extends `IEnumerable<T>` and represents a query against an external data source through an `IQueryProvider`.
Its LINQ operators take expression trees (`Expression<Func<T, bool>>`) that describe the code as data.
The provider, such as EF Core, translates the expression tree into another language like SQL and executes it at the source.
This means filtering, sorting and paging with `IQueryable` happen in the database, not in application memory.
Once a query is cast or enumerated as `IEnumerable`, any further operators run in memory.

#### Answer
I'd explain it as **"where does the filtering happen?"** With `IQueryable` the database does the work; with `IEnumerable` your application server does it, after pulling the data over the network.

**Key points**

| Aspect | `IEnumerable<T>` | `IQueryable<T>` |
|---|---|---|
| Namespace | `System.Collections.Generic` | `System.Linq` |
| Operators take | `Func<T,...>` delegates | `Expression<Func<T,...>>` trees |
| Executed by | LINQ to Objects, in memory | Query provider (EF Core -> SQL) |
| Best for | In-memory collections | Databases and remote sources |
| Any C# method allowed? | Yes | Only what the provider can translate |

**Real-world usage**
- In repositories I keep queries as `IQueryable` while composing filters, projections (`Select` into DTOs) and paging (`Skip`/`Take`), then call `ToListAsync()` once.
- After materialising, I switch to in-memory LINQ for logic that cannot be translated (custom C# methods, complex formatting).

**Pitfalls / follow-ups**
- **Accidental client-side evaluation**: a method that accepts `IEnumerable<T>` and calls `.Where()` will download the whole table first, then filter.
- `AsEnumerable()` deliberately switches to in-memory processing from that point on.
- EF Core 3+ throws `InvalidOperationException` when a non-final operator cannot be translated (only the final `Select` may contain client code), which is safer than the silent client evaluation of EF Core 2.
- Should a repository return `IQueryable`? It is flexible but leaks persistence concerns; many teams return materialised lists or use the specification pattern.
- Follow-up: "What is an expression tree?" A data structure representing code (`Expression<Func<...>>`) that a provider can inspect and translate.

#### Code
```csharp title="Same code, very different SQL"
public sealed class OrderQueries(AppDbContext db)
{
    // GOOD: IQueryable - filter, projection and paging all become SQL
    public Task<List<OrderSummary>> GetLargeOrdersAsync(int page, CancellationToken ct) =>
        db.Orders
          .Where(o => o.Total > 1000)                 // WHERE Total > 1000
          .OrderByDescending(o => o.CreatedAt)        // ORDER BY CreatedAt DESC
          .Skip(page * 20).Take(20)                   // OFFSET / FETCH
          .Select(o => new OrderSummary(o.Id, o.Customer.Name, o.Total)) // only 3 columns
          .ToListAsync(ct);

    // BAD: the parameter type silently switches to LINQ to Objects
    public List<Order> GetLargeOrdersSlow() => FilterLarge(db.Orders);

    private static List<Order> FilterLarge(IEnumerable<Order> orders) =>
        orders.Where(o => o.Total > 1000).ToList();   // SELECT * FROM Orders, then filter in memory

    // Deliberate switch: translate what we can, then run C# logic in memory
    public async Task<List<string>> GetLabelsAsync(CancellationToken ct)
    {
        var rows = await db.Orders
            .Where(o => o.CreatedAt >= DateTime.UtcNow.AddDays(-7))
            .Select(o => new { o.Id, o.Total })
            .ToListAsync(ct);                          // SQL ends here

        return rows.Select(r => FormatLabel(r.Id, r.Total)).ToList(); // in memory
    }

    private static string FormatLabel(int id, decimal total) => $"#{id:D6} - {total:C}";
}

public record OrderSummary(int Id, string CustomerName, decimal Total);
```

```csharp title="Delegate vs expression tree"
using System.Linq.Expressions;

// A delegate is compiled code: it can only be executed
Func<Product, bool> isCheapFunc = p => p.Price < 10;

// An expression tree is data describing the code: a provider can translate it
Expression<Func<Product, bool>> isCheapExpr = p => p.Price < 10;

Console.WriteLine(isCheapExpr.Body);          // (p.Price < 10)
Console.WriteLine(isCheapExpr.Body.NodeType); // LessThan

// Overload resolution picks Queryable.Where(Expression) for IQueryable sources
IQueryable<Product> products = new List<Product>
{
    new("Pen", 2), new("Lamp", 35)
}.AsQueryable();

var cheap = products.Where(isCheapExpr).ToList();      // stays IQueryable
var cheap2 = products.Where(isCheapFunc).ToList();     // falls back to Enumerable.Where!

// You can compile an expression into a delegate, but not the other way round
Func<Product, bool> compiled = isCheapExpr.Compile();
Console.WriteLine(compiled(new Product("Mug", 8)));    // True

public record Product(string Name, decimal Price);
```

## Performance

### Q: What are common LINQ performance pitfalls and how do you avoid them?
difficulty: Medium
tags: linq, performance, collections, memory
id: linq-performance-pitfalls

#### Definition
LINQ trades a small amount of runtime overhead for expressive, declarative code.
In memory, that overhead comes from delegate invocations, iterator objects and intermediate allocations.
Most performance problems, however, come from how a query is written rather than from LINQ itself.
Typical issues are multiple enumeration, using the wrong operator, and nested lookups that make an algorithm quadratic.
Choosing the right data structure, such as a `HashSet` or `Dictionary` for lookups, often matters far more than avoiding LINQ.
Recent .NET versions heavily optimise LINQ, including vectorised `Sum`, `Min` and `Max` and specialised iterators for arrays and lists.
The rule is to write clear LINQ first, then profile and optimise only the proven hot paths.

#### Answer
In my experience LINQ is rarely "slow" by itself; **the algorithm hidden inside the query is**. I look for these patterns in code reviews:

**Key pitfalls and fixes**

| Pitfall | Why it's slow | Better |
|---|---|---|
| `seq.Count() > 0` on a lazy `IEnumerable` | May enumerate everything | `Any()` (or the `Count` property on collections) |
| `Where(p).Count() > 0` | Counts every match | `Any(p)` stops at the first match |
| `Contains` on a `List` inside a loop | O(n * m) | Build a `HashSet<T>` once, O(1) lookups |
| `items.First(x => x.Id == id)` repeatedly | Linear scan each time | `ToDictionary` / `ToLookup` once |
| Multiple enumeration of a lazy query | Re-runs the whole pipeline | Materialise once with `ToList()` |
| `OrderBy(...).First()` | O(n log n) sort | `MinBy`/`MaxBy` (.NET 6+), O(n) |
| `Select(...).ToList()` in tight loops | Allocations, GC pressure | Plain `for` loop over a span/array |

**Real-world usage:** I once fixed a reconciliation job that took 40 minutes because it did `invoices.FirstOrDefault(i => i.Number == payment.InvoiceNumber)` inside a loop over 200k payments. Replacing it with a dictionary built once brought it under 10 seconds.

**Pitfalls / follow-ups**
- Don't micro-optimise everything: in a typical API the database round trip dwarfs LINQ overhead.
- `Count()` is already optimised for `ICollection<T>`, so `list.Count()` is cheap; `TryGetNonEnumeratedCount` (.NET 6+) lets you check without enumerating.
- Measure with **BenchmarkDotNet** and `[MemoryDiagnoser]` before and after.
- Follow-up: "Would you replace LINQ with loops?" Only in measured hot paths; readability usually wins.

#### Code
```csharp title="From O(n*m) to O(n+m) with the right lookup"
public sealed record Payment(string InvoiceNumber, decimal Amount);
public sealed record Invoice(string Number, decimal Due, string Customer);

public static class Reconciliation
{
    // SLOW: linear search inside a loop => O(payments * invoices)
    public static List<(Payment, Invoice?)> MatchSlow(
        IReadOnlyList<Payment> payments, IReadOnlyList<Invoice> invoices) =>
        payments.Select(p => (p, invoices.FirstOrDefault(i => i.Number == p.InvoiceNumber)))
                .ToList();

    // FAST: build the dictionary once => O(payments + invoices)
    public static List<(Payment, Invoice?)> MatchFast(
        IReadOnlyList<Payment> payments, IReadOnlyList<Invoice> invoices)
    {
        Dictionary<string, Invoice> byNumber = invoices.ToDictionary(i => i.Number);

        return payments
            .Select(p => (p, byNumber.GetValueOrDefault(p.InvoiceNumber)))
            .ToList();
    }

    // Group-style lookups: ToLookup handles one-to-many without repeated scans
    public static decimal TotalDueFor(IEnumerable<Invoice> invoices, string customer)
    {
        ILookup<string, Invoice> byCustomer = invoices.ToLookup(i => i.Customer);
        return byCustomer[customer].Sum(i => i.Due);   // missing key => empty, no exception
    }
}
```

```csharp title="Choosing the right operator"
public static class OperatorChoices
{
    public static void Run(IEnumerable<Order> orders, IReadOnlyList<int> vipIds)
    {
        // Materialise once if enumerated multiple times
        var list = orders as IReadOnlyCollection<Order> ?? orders.ToList();

        // Any() stops at the first match; Count() > 0 may scan everything
        bool hasLarge = list.Any(o => o.Total > 10_000);

        // MaxBy is O(n); OrderByDescending(...).First() sorts the whole list
        Order? biggest = list.MaxBy(o => o.Total);

        // HashSet for repeated Contains checks
        var vipSet = vipIds.ToHashSet();
        var vipOrders = list.Where(o => vipSet.Contains(o.CustomerId)).ToList();

        // Check count without forcing enumeration (.NET 6+)
        if (orders.TryGetNonEnumeratedCount(out int count))
            Console.WriteLine($"Known count: {count}");

        // Built-in batching instead of manual Skip/Take loops (O(n^2) on IEnumerable)
        foreach (Order[] chunk in list.Chunk(500))
            Console.WriteLine($"Processing {chunk.Length} orders");

        Console.WriteLine($"{hasLarge} {biggest?.Id} {vipOrders.Count}");
    }
}

public record Order(int Id, int CustomerId, decimal Total);
```

### Q: How do you write efficient LINQ queries with EF Core?
difficulty: Hard
tags: linq, ef-core, performance, sql
id: efficient-linq-ef-core

#### Definition
EF Core translates LINQ queries over `IQueryable<T>` into SQL that is executed by the database.
Efficient queries push filtering, projection, sorting, paging and aggregation into that SQL rather than into memory.
Projection with `Select` retrieves only the columns you need instead of full entities.
`AsNoTracking` skips change-tracking overhead for read-only queries.
Eager loading with `Include` avoids the N+1 problem, and `AsSplitQuery` avoids cartesian explosion when including several collections.
Async methods such as `ToListAsync` free the thread while waiting for the database.
Inspecting the generated SQL with `ToQueryString()` or logging is essential to verify what actually runs.

#### Answer
I'd say the golden rule is: **let the database do what databases are good at, and fetch only what you need.** Most EF Core performance issues I've fixed were really LINQ-shape issues.

**My checklist**
- **Project early** with `Select` into DTOs: fewer columns, no tracking, and no lazy-load surprises.
- **`AsNoTracking()`** for read-only queries (or set `QueryTrackingBehavior.NoTracking` on read-heavy contexts).
- **Avoid N+1**: use `Include` or projection instead of touching navigation properties in a loop.
- **`AsSplitQuery()`** when including multiple collections to avoid a huge cartesian JOIN.
- **Page with `Skip`/`Take`** after a deterministic `OrderBy`; consider keyset paging for deep pages.
- **Bulk operations**: `ExecuteUpdateAsync` / `ExecuteDeleteAsync` (EF Core 7+) instead of loading entities to modify them.
- **Compiled queries** (`EF.CompileAsyncQuery`) for very hot queries.

| Problem | Symptom | Fix |
|---|---|---|
| N+1 queries | Hundreds of identical SELECTs in logs | `Include` or `Select` projection |
| Over-fetching | `SELECT *` with large text columns | `Select` into a DTO |
| Cartesian explosion | Huge row counts, slow `Include` chains | `AsSplitQuery()` |
| Client-side work | `ToList()` before `Where` | Keep it `IQueryable` until the end |

**Real-world usage:** on a reporting endpoint, replacing `Include(...).ToList()` followed by in-memory `GroupBy` with a projected, server-side `GroupBy` cut response time from seconds to under 200 ms.

**Pitfalls / follow-ups**
- `Contains` on a large in-memory list becomes a big `IN` clause; EF Core 8 sends it as a JSON parameter (`OPENJSON`) for better plan caching.
- Calling `Count()` and then `ToList()` hits the database twice.
- "How do you see the SQL?" `ToQueryString()`, `LogTo(Console.WriteLine)`, or the SQL Server profiler / Application Insights.

#### Code
```csharp title="Projection, no-tracking and avoiding N+1"
public sealed class CustomerReportService(AppDbContext db)
{
    // BAD: N+1 - one query for customers, then one per customer for orders (lazy loading)
    public async Task<List<string>> GetReportSlowAsync(CancellationToken ct)
    {
        var customers = await db.Customers.ToListAsync(ct);
        return customers
            .Select(c => $"{c.Name}: {c.Orders.Sum(o => o.Total)}") // triggers a query each time
            .ToList();
    }

    // GOOD: a single SQL query with aggregation done by the database
    public Task<List<CustomerTotal>> GetReportAsync(DateTime since, CancellationToken ct) =>
        db.Customers
          .AsNoTracking()
          .Where(c => c.IsActive)
          .Select(c => new CustomerTotal(
              c.Id,
              c.Name,
              c.Orders.Where(o => o.CreatedAt >= since).Sum(o => o.Total),
              c.Orders.Count(o => o.CreatedAt >= since)))
          .OrderByDescending(r => r.Total)
          .Take(50)
          .ToListAsync(ct);

    // Inspect the SQL during development
    public string DebugSql(DateTime since) =>
        db.Customers.Where(c => c.Orders.Any(o => o.CreatedAt >= since)).ToQueryString();
}

public record CustomerTotal(int Id, string Name, decimal Total, int OrderCount);
```

```csharp title="Split queries, bulk updates and compiled queries"
public sealed class OrderMaintenance(AppDbContext db)
{
    // Multiple collection includes: split into separate SQL queries to avoid cartesian explosion
    public Task<Order?> GetFullOrderAsync(int id, CancellationToken ct) =>
        db.Orders
          .Include(o => o.Lines)
          .Include(o => o.Payments)
          .AsSplitQuery()
          .FirstOrDefaultAsync(o => o.Id == id, ct);

    // EF Core 7+: one UPDATE statement, no entities loaded into memory
    public Task<int> ArchiveOldOrdersAsync(DateTime cutoff, CancellationToken ct) =>
        db.Orders
          .Where(o => o.CreatedAt < cutoff && o.Status == OrderStatus.Completed)
          .ExecuteUpdateAsync(s => s
              .SetProperty(o => o.Status, OrderStatus.Archived)
              .SetProperty(o => o.ArchivedAt, DateTime.UtcNow), ct);

    // Compiled query: LINQ-to-SQL translation is cached once for a hot path
    private static readonly Func<AppDbContext, int, Task<Order?>> ById =
        EF.CompileAsyncQuery((AppDbContext ctx, int id) =>
            ctx.Orders.AsNoTracking().FirstOrDefault(o => o.Id == id));

    public Task<Order?> GetByIdFastAsync(int id) => ById(db, id);
}
```
