---
title: Entity Framework Core
description: DbContext, change tracking, migrations, loading strategies and query performance in EF Core 8/9
icon: "EF"
color: "#16a34a"
---

## Basics & DbContext

### Q: What is DbContext and how does change tracking work in EF Core?
difficulty: Easy
tags: ef-core, orm, change-tracking, database
id: dbcontext-change-tracking

#### Definition
DbContext is the central class in EF Core that represents a session with the database.
It combines the Unit of Work and Repository patterns: DbSet<T> properties expose queryable tables.
Entities returned by a query are tracked by the ChangeTracker, which records their original values.
Each tracked entity has a state: Added, Unchanged, Modified, Deleted or Detached.
When SaveChanges is called, EF Core detects changes, generates INSERT/UPDATE/DELETE statements and runs them in a transaction.
DbContext is lightweight, not thread-safe, and meant to be short-lived.
In ASP.NET Core it is registered with a scoped lifetime, so one instance is used per HTTP request.

#### Answer
I'd explain DbContext as **a unit of work that remembers what it loaded**. When I query an entity, EF Core stores a snapshot of its original values. When I call `SaveChanges()`, it runs `DetectChanges()`, compares current values with the snapshot, and emits only the SQL needed — for example an `UPDATE` with just the modified columns.

Key points:
- **Entity states** – `Added`, `Unchanged`, `Modified`, `Deleted`, `Detached`. You can inspect them via `context.Entry(entity).State`.
- **SaveChanges is transactional** – all pending changes succeed or fail together; EF Core batches statements into few round trips.
- **Scoped lifetime** – `AddDbContext` registers it per request. Injecting it into a singleton is a classic bug (captive dependency, threading issues).
- **Not thread-safe** – running two queries in parallel on the same context throws "A second operation was started on this context".
- **DbContext pooling** – `AddDbContextPool` reuses instances to cut allocation cost in high-throughput APIs.

| Lifetime choice | When |
|---|---|
| Scoped (default) | Web requests |
| `IDbContextFactory<T>` | Blazor Server, background services, parallel work |
| Pooled | Hot paths where context creation shows up in profiling |

In real projects I also use `ExecuteUpdateAsync` / `ExecuteDeleteAsync` (EF Core 7+) for bulk operations, because they bypass change tracking entirely and run a single SQL statement.

> **Likely follow-ups:** "How do you update a disconnected entity?" (`Update()` or `Attach` + set state), "How do you handle concurrency?" (a `[Timestamp]` rowversion token and catching `DbUpdateConcurrencyException`).

#### Code
```csharp title="DbContext setup, change tracking and bulk updates"
public class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Pick up all IEntityTypeConfiguration<T> classes in this assembly
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(ShopDbContext).Assembly);
    }
}

// Program.cs – scoped by default; pooling for a busy API
builder.Services.AddDbContextPool<ShopDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop")));

// Service method
public async Task MarkShippedAsync(int orderId, CancellationToken ct)
{
    var order = await _db.Orders.FirstAsync(o => o.Id == orderId, ct); // tracked, state = Unchanged

    order.Status = OrderStatus.Shipped;                                 // snapshot differs
    Console.WriteLine(_db.Entry(order).State);                          // Modified

    await _db.SaveChangesAsync(ct); // UPDATE Orders SET Status = @p0 WHERE Id = @p1
}

// Bulk update without loading entities (EF Core 7+): single UPDATE statement
await _db.Orders
    .Where(o => o.Status == OrderStatus.Pending && o.CreatedAt < cutoff)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Cancelled), ct);
```

### Q: How do EF Core migrations work and how do you deploy them safely?
difficulty: Medium
tags: ef-core, migrations, database, deployment
id: ef-core-migrations

#### Definition
Migrations are EF Core's way of evolving the database schema incrementally to match the C# model.
Each migration is a generated class with Up and Down methods describing the schema change.
EF Core compares the current model with a model snapshot file to decide what changed.
Migrations are created with `dotnet ef migrations add` and applied with `dotnet ef database update`.
Applied migrations are recorded in the `__EFMigrationsHistory` table in the target database.
For production, migrations can be exported as idempotent SQL scripts or as a self-contained migration bundle.
Migration code is ordinary C#, so it can be edited to add raw SQL or data transformations.

#### Answer
In my experience the commands are easy; **the deployment strategy** is what interviewers probe.

Workflow I follow:
1. Change entities / configuration.
2. `dotnet ef migrations add AddOrderStatus` – review the generated code, especially for unexpected drops or renames.
3. Commit the migration **and** the `ModelSnapshot` together.
4. In CI, generate an artifact: `dotnet ef migrations script --idempotent` or `dotnet ef migrations bundle`.
5. Apply it as a deployment step, before the new app version starts.

| Approach | Pros | Cons |
|---|---|---|
| `Database.Migrate()` at startup | simple | race conditions with multiple instances, app needs DDL rights |
| Idempotent SQL script | DBA can review, works with any tool | extra pipeline step |
| Migration bundle (`efbundle`) | single executable, no SDK needed | still needs DDL rights in pipeline |

Common pitfalls:
- **Renames detected as drop + add** – EF sometimes can't tell a rename, which loses data. I check the generated code and use `RenameColumn`.
- **Merge conflicts on the snapshot** when two developers add migrations; the fix is to remove and re-add one on top of the other.
- **Breaking changes with zero downtime** – I use expand/contract: add the new column, deploy code that writes both, backfill, then remove the old column in a later release.
- Never edit a migration that's already been applied in a shared environment.

> **Follow-ups:** "How do you seed data?" (`HasData` for static reference data, or `UseSeeding`/`UseAsyncSeeding` in EF Core 9), "How do you roll back?" (`database update <PreviousMigration>` runs the `Down` methods).

#### Code
```csharp title="A migration with a safe rename and data backfill"
public partial class SplitCustomerName : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Rename instead of drop/add so existing data is preserved
        migrationBuilder.RenameColumn(
            name: "Name", table: "Customers", newName: "FirstName");

        migrationBuilder.AddColumn<string>(
            name: "LastName", table: "Customers",
            type: "nvarchar(100)", maxLength: 100, nullable: true);

        // Custom data migration with raw SQL
        migrationBuilder.Sql("""
            UPDATE Customers
            SET LastName  = LTRIM(SUBSTRING(FirstName, CHARINDEX(' ', FirstName) + 1, 100)),
                FirstName = LEFT(FirstName, CHARINDEX(' ', FirstName) - 1)
            WHERE CHARINDEX(' ', FirstName) > 0;
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("UPDATE Customers SET FirstName = CONCAT(FirstName, ' ', LastName);");
        migrationBuilder.DropColumn(name: "LastName", table: "Customers");
        migrationBuilder.RenameColumn(name: "FirstName", table: "Customers", newName: "Name");
    }
}
```

```bash title="CLI commands for development and CI/CD"
# Create and apply locally
dotnet ef migrations add SplitCustomerName
dotnet ef database update

# CI: produce a reviewable, re-runnable script
dotnet ef migrations script --idempotent --output artifacts/migrate.sql

# CI: or a self-contained executable bundle
dotnet ef migrations bundle --self-contained -r linux-x64 --output artifacts/efbundle
./artifacts/efbundle --connection "$SHOP_CONNECTION_STRING"
```

## Querying & Performance

### Q: What is the N+1 problem and how do eager, lazy and explicit loading differ?
difficulty: Medium
tags: ef-core, performance, n-plus-one, orm
id: ef-core-n-plus-one-loading

#### Definition
Loading strategies control when EF Core fetches related entities through navigation properties.
Eager loading uses Include and ThenInclude to load related data in the same query.
Lazy loading fetches a navigation automatically the first time it is accessed, via proxies or ILazyLoader.
Explicit loading fetches a navigation on demand with Entry(...).Collection(...).LoadAsync().
The N+1 problem occurs when one query loads N parents and then N extra queries load each parent's children.
It is most often caused by lazy loading inside a loop or during serialization.
It is fixed with eager loading, projection with Select, or split queries.

#### Answer
I'd explain N+1 with a concrete example: list 100 orders, then for each order access `order.Customer.Name`. With lazy loading that's **1 query for orders + 100 queries for customers**. Locally it feels fine; in production with network latency it's a disaster.

| Strategy | How | When I use it |
|---|---|---|
| Eager | `Include` / `ThenInclude` | I know I need the related data |
| Lazy | `UseLazyLoadingProxies()` + `virtual` navs | rarely; desktop apps or prototypes |
| Explicit | `Entry(x).Collection(...).LoadAsync()` | conditional loading of one relation |
| Projection | `Select(o => new OrderDto {...})` | read-only APIs — my default |

Key points:
- Lazy loading is **off by default** in EF Core, and I keep it off in web APIs.
- **Projection** is usually best: EF generates a single SQL with only the needed columns and no tracking.
- Multiple collection `Include`s cause a **Cartesian explosion** (rows multiply). `AsSplitQuery()` issues one query per collection instead.
- Filtered includes (`Include(o => o.Lines.Where(l => l.Qty > 0))`) are supported since EF Core 5.

How I detect it: enable logging (`LogTo` or `Microsoft.EntityFrameworkCore.Database.Command` at Information), look for repeated near-identical SQL, or use Application Insights / MiniProfiler.

> **Follow-ups:** "What's the downside of split queries?" (multiple round trips and no consistency guarantee without a transaction), "Can serializing an entity trigger N+1?" (yes, with lazy loading — another reason to return DTOs).

#### Code
```csharp title="N+1 problem and three ways to fix it"
// BAD: N+1 – with lazy loading enabled, each iteration fires a query for Customer
var orders = await db.Orders.Where(o => o.Status == OrderStatus.Paid).ToListAsync();
foreach (var o in orders)
    Console.WriteLine($"{o.Id}: {o.Customer.Name}"); // SELECT ... FROM Customers WHERE Id = @p (x N)

// FIX 1: Eager loading – one query with a JOIN
var withCustomers = await db.Orders
    .Include(o => o.Customer)
    .Where(o => o.Status == OrderStatus.Paid)
    .ToListAsync();

// FIX 2: Split query for multiple collections – avoids Cartesian explosion
var full = await db.Orders
    .Include(o => o.Lines).ThenInclude(l => l.Product)
    .Include(o => o.Payments)
    .AsSplitQuery()
    .ToListAsync();

// FIX 3 (preferred for read APIs): projection – only needed columns, no tracking
var dtos = await db.Orders
    .Where(o => o.Status == OrderStatus.Paid)
    .Select(o => new OrderSummaryDto(
        o.Id,
        o.Customer.Name,              // translated to a JOIN, not a lazy load
        o.Lines.Sum(l => l.Quantity * l.UnitPrice)))
    .ToListAsync();

// Explicit loading – load a navigation only when a condition requires it
var order = await db.Orders.FindAsync(orderId);
if (order is { RequiresReview: true })
    await db.Entry(order).Collection(o => o.Lines).LoadAsync();
```

### Q: When should you use AsNoTracking, and what other techniques improve EF Core query performance?
difficulty: Hard
tags: ef-core, performance, as-no-tracking, database
id: ef-core-asnotracking-performance

#### Definition
AsNoTracking tells EF Core not to register the returned entities in the ChangeTracker.
This skips snapshot creation and identity resolution, reducing memory use and CPU time.
It is ideal for read-only scenarios such as API GET endpoints and reports.
Entities returned this way cannot be saved with SaveChanges unless they are attached again.
AsNoTrackingWithIdentityResolution keeps no tracking but still de-duplicates the same entity in the result.
No-tracking can be set as the default with UseQueryTrackingBehavior on the options.
Other key performance techniques are projection, compiled queries, pagination and server-side filtering.

#### Answer
In my experience **tracking is the hidden cost** most teams don't notice. For every tracked entity EF keeps a snapshot and an identity map entry, and `DetectChanges` has to walk them all. On a read endpoint returning thousands of rows, `AsNoTracking()` alone can noticeably cut memory and latency.

My EF Core performance checklist:
- **`AsNoTracking()`** for read-only queries (or a no-tracking default plus `AsTracking()` where I write).
- **Project with `Select`** – fetch only needed columns; projections into non-entity types are never tracked.
- **Filter and paginate on the server** – `Where`/`Skip`/`Take` before `ToListAsync()`. Calling `ToList()` early pulls the whole table into memory.
- **Keyset pagination** for deep pages instead of large `Skip` values.
- **Compiled queries** (`EF.CompileAsyncQuery`) for very hot queries to skip LINQ translation.
- **Bulk operations** with `ExecuteUpdateAsync` / `ExecuteDeleteAsync`.
- **Inspect SQL** with `ToQueryString()` and check the execution plan for missing indexes.

| | Tracking | AsNoTracking |
|---|---|---|
| Change detection | yes | no |
| Identity resolution | yes | no (unless WithIdentityResolution) |
| Memory / CPU | higher | lower |
| Use for | updates | reads |

Pitfalls I mention: calling `Update()` on a no-tracking entity marks **every column** modified; client evaluation of untranslatable methods throws in EF Core 3+ (good, but surprises people); and `Contains` with a large list can generate huge `IN` clauses — EF Core 8 translates them with `OPENJSON` parameters instead.

> **Follow-ups:** "How do you log slow queries?" (interceptors or `LogTo` with `EnableSensitiveDataLogging` in dev only), "What is `FindAsync` vs `FirstOrDefaultAsync`?" (`Find` checks the change tracker first).

#### Code
```csharp title="Read-optimized repository with no-tracking, projection and compiled query"
public class ProductQueries(ShopDbContext db)
{
    // Compiled once, reused on every call – skips LINQ-to-SQL translation
    private static readonly Func<ShopDbContext, int, Task<ProductDto?>> GetByIdQuery =
        EF.CompileAsyncQuery((ShopDbContext ctx, int id) =>
            ctx.Products
               .AsNoTracking()
               .Where(p => p.Id == id)
               .Select(p => new ProductDto(p.Id, p.Name, p.Price))
               .FirstOrDefault());

    public Task<ProductDto?> GetByIdAsync(int id) => GetByIdQuery(db, id);

    // Keyset pagination: efficient even on page 10,000
    public async Task<List<ProductDto>> GetPageAsync(int? afterId, int pageSize, CancellationToken ct)
    {
        var query = db.Products.AsNoTracking();

        if (afterId is not null)
            query = query.Where(p => p.Id > afterId);

        return await query
            .OrderBy(p => p.Id)
            .Take(pageSize)                                  // filtered and paged in SQL
            .Select(p => new ProductDto(p.Id, p.Name, p.Price))
            .ToListAsync(ct);
    }
}

// Make no-tracking the default for a read-heavy service
builder.Services.AddDbContext<ShopDbContext>(o => o
    .UseSqlServer(connectionString)
    .UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));
```
