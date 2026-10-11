---
title: Dapper
description: Micro-ORM fundamentals, parameterized queries, multi-mapping, stored procedures and transactions
icon: "Dp"
color: "#0891b2"
---

## Fundamentals

### Q: What is Dapper and how does it compare to EF Core?
difficulty: Easy
tags: dapper, orm, ef-core, performance
id: dapper-vs-ef-core

#### Definition
Dapper is a lightweight micro-ORM for .NET created by the Stack Overflow team.
It is a set of extension methods on IDbConnection such as Query, QueryFirstOrDefault and Execute.
You write the SQL yourself, and Dapper maps the result columns to object properties by name.
It caches the generated mapping code per query, so materialization is close to hand-written ADO.NET speed.
Dapper has no change tracking, no LINQ provider, no migrations and no relationship management.
EF Core is a full ORM that generates SQL from LINQ, tracks changes and manages the schema.
Many teams use both: EF Core for writes and domain logic, Dapper for read-heavy or complex queries.

#### Answer
I'd describe Dapper as **"ADO.NET without the boilerplate"**. I still own the SQL, but I don't write `SqlDataReader` loops or map columns manually.

| | Dapper | EF Core |
|---|---|---|
| SQL | hand-written | generated from LINQ |
| Change tracking | none | built in |
| Migrations | none (use DbUp, Flyway, SSDT) | built in |
| Relationships | manual multi-mapping | navigations, Include |
| Learning curve | low, if you know SQL | higher |
| Raw performance | very close to ADO.NET | good, slightly more overhead |
| Provider portability | SQL is provider-specific | LINQ mostly portable |

When I pick Dapper:
- **Reporting / dashboards** with complex joins, CTEs or window functions.
- **Hot read paths** where every allocation matters.
- Calling **existing stored procedures** in a legacy database.
- Small services where a full ORM is overkill.

When I pick EF Core: rich domain models, many writes with relationships, and teams that benefit from LINQ and migrations. Since EF Core 8 can also map raw SQL to unmapped types with `SqlQuery<T>`, the gap is smaller, but Dapper is still simpler for SQL-first code.

Pitfalls: SQL lives in strings, so **typos surface only at runtime** — I cover queries with integration tests (Testcontainers). Column names must match property names, or I alias them (`first_name AS FirstName`). And you must manage connection lifetime yourself — always `using`.

> **Follow-ups:** "Can you use both in one app?" (yes, even sharing `DbContext.Database.GetDbConnection()` and the same transaction), "Is Dapper safe from SQL injection?" (only if you use parameters).

#### Code
```csharp title="Basic Dapper repository with an injected connection factory"
public interface IDbConnectionFactory
{
    Task<IDbConnection> CreateOpenConnectionAsync(CancellationToken ct = default);
}

public sealed class SqlConnectionFactory(string connectionString) : IDbConnectionFactory
{
    public async Task<IDbConnection> CreateOpenConnectionAsync(CancellationToken ct = default)
    {
        var conn = new SqlConnection(connectionString);   // Microsoft.Data.SqlClient
        await conn.OpenAsync(ct);
        return conn;
    }
}

public sealed class ProductRepository(IDbConnectionFactory factory)
{
    public async Task<IEnumerable<ProductDto>> GetByCategoryAsync(int categoryId)
    {
        using var conn = await factory.CreateOpenConnectionAsync();

        // Columns map to ProductDto properties by name (aliases fix mismatches)
        const string sql = """
            SELECT p.Id, p.Name, p.UnitPrice AS Price
            FROM dbo.Products AS p
            WHERE p.CategoryId = @CategoryId AND p.IsActive = 1
            ORDER BY p.Name;
            """;

        return await conn.QueryAsync<ProductDto>(sql, new { CategoryId = categoryId });
    }

    public async Task<int> UpdatePriceAsync(int id, decimal price)
    {
        using var conn = await factory.CreateOpenConnectionAsync();
        // Execute returns the number of affected rows
        return await conn.ExecuteAsync(
            "UPDATE dbo.Products SET UnitPrice = @price WHERE Id = @id;",
            new { id, price });
    }
}

public sealed record ProductDto(int Id, string Name, decimal Price);
```

### Q: How do parameterized queries work in Dapper and how do they prevent SQL injection?
difficulty: Medium
tags: dapper, sql, security, sql-injection
id: dapper-parameterized-queries

#### Definition
A parameterized query sends the SQL text and the values separately to the database server.
In Dapper, parameters are passed as an anonymous object or a DynamicParameters instance.
Each property becomes a named parameter such as @CustomerId, sent with its own type.
Because values are never concatenated into the SQL string, user input cannot change the query structure.
This is the primary defense against SQL injection.
Parameterization also lets SQL Server reuse cached execution plans across calls.
Dapper adds conveniences such as list expansion for IN clauses and DbString for precise string typing.

#### Answer
In my experience the rule is simple: **never build SQL with string interpolation from user input**. With Dapper it's easy to get wrong, because `$"... WHERE Name = '{name}'"` compiles and works — until someone enters `' OR 1=1 --`.

How Dapper handles parameters:
- **Anonymous objects** – `new { Email = email }` maps to `@Email`.
- **`DynamicParameters`** – when I need output/return parameters, explicit `DbType`, or to build parameters conditionally.
- **List expansion** – `WHERE Id IN @Ids` with an `int[]` is expanded into `@Ids1, @Ids2, ...`.
- **`DbString`** – sets `IsAnsi` and `Length`. This matters: .NET strings default to `nvarchar(4000)`; comparing them to a `varchar` column causes an **implicit conversion that can kill index seeks**.

| Approach | Safe? | Plan reuse |
|---|---|---|
| String concatenation | no | poor (new plan per value) |
| Dapper parameters | yes | good |
| Dynamic ORDER BY via whitelist | yes | good |

Real-world nuance: you **cannot parameterize identifiers** (table or column names, sort direction). For dynamic sorting I map user input to a whitelist of known column names. For dynamic filters I build the `WHERE` clause from fixed fragments while values stay parameters.

Another follow-up I expect: very large `IN` lists can hit the 2,100-parameter limit and bloat the plan cache — then I use a table-valued parameter (`AsTableValuedParameter`) or `STRING_SPLIT`/`OPENJSON`.

> **Follow-ups:** "What is parameter sniffing?", "How do you get an output parameter from a stored procedure?" (`DynamicParameters.Add(..., direction: ParameterDirection.Output)` then `Get<T>`).

#### Code
```csharp title="Safe parameters, IN lists, DbString and whitelisted sorting"
public async Task<IEnumerable<OrderDto>> SearchOrdersAsync(
    IDbConnection conn, OrderSearch search)
{
    // UNSAFE – never do this:
    // var sql = $"SELECT * FROM Orders WHERE CustomerEmail = '{search.Email}'";

    var sql = new StringBuilder("""
        SELECT o.Id, o.CustomerEmail, o.Status, o.Total, o.CreatedAt
        FROM dbo.Orders AS o
        WHERE 1 = 1
        """);
    var p = new DynamicParameters();

    if (!string.IsNullOrWhiteSpace(search.Email))
    {
        sql.Append(" AND o.CustomerEmail = @Email");
        // Matches a varchar(256) column: avoids implicit nvarchar conversion
        p.Add("Email", new DbString { Value = search.Email, IsAnsi = true, Length = 256 });
    }

    if (search.Statuses is { Length: > 0 })
    {
        sql.Append(" AND o.Status IN @Statuses");   // Dapper expands the array
        p.Add("Statuses", search.Statuses);
    }

    // Identifiers can't be parameters → whitelist them
    var orderBy = search.SortBy switch
    {
        "total" => "o.Total",
        "date"  => "o.CreatedAt",
        _       => "o.Id"
    };
    sql.Append($" ORDER BY {orderBy} {(search.Descending ? "DESC" : "ASC")}");

    return await conn.QueryAsync<OrderDto>(sql.ToString(), p);
}
```

## Advanced Mapping

### Q: How do multi-mapping and QueryMultiple work in Dapper?
difficulty: Hard
tags: dapper, mapping, multi-mapping, performance
id: dapper-multi-mapping-querymultiple

#### Definition
Multi-mapping maps a single row of a joined result set into several related objects.
It uses Query<T1, T2, TResult> with a map function and a splitOn argument.
splitOn names the column where Dapper starts populating the next type; it defaults to "Id".
For one-to-many joins, the parent rows repeat, so a dictionary is used to de-duplicate parents.
QueryMultiple executes one command that returns several result sets in a single round trip.
Each result set is read in order with Read<T> or ReadAsync<T> from a GridReader.
Both techniques avoid N+1 queries while keeping full control of the SQL.

#### Answer
I'd explain these as Dapper's answer to EF Core's `Include` — just more manual.

**Multi-mapping** (`Query<Order, Customer, Order>`):
- Dapper reads columns left to right; when it hits the `splitOn` column it starts filling the next type.
- For **one-to-one / many-to-one** (order → customer) the map function just assigns the navigation.
- For **one-to-many** (order → lines) the order repeats per line, so I keep a `Dictionary<int, Order>` and add lines to the existing instance.

**QueryMultiple**:
- I send a batch like `SELECT ... FROM Orders WHERE Id = @Id; SELECT ... FROM OrderLines WHERE OrderId = @Id;`.
- Then `ReadSingleAsync<Order>()` followed by `ReadAsync<OrderLine>()` — **in the same order** as the SQL.

| | Multi-mapping (JOIN) | QueryMultiple |
|---|---|---|
| Round trips | 1 | 1 |
| Duplicate parent data | yes, per child row | no |
| Best for | many-to-one, small 1:N | aggregates with several collections |
| Complexity | splitOn + dictionary | read order must match |

Pitfalls I mention:
- **Wrong `splitOn`** is the #1 bug: if the second table's key isn't called `Id`, set `splitOn: "CustomerId"`; columns must be selected in the right order.
- With a LEFT JOIN, the child object can be **null** when all its columns are null — handle it.
- Multiple collection JOINs cause a Cartesian product; switch to `QueryMultiple`.
- `QueryMultiple` must be read fully and in order; the `GridReader` should be disposed.

> **Follow-ups:** "How many types can you map?" (up to 7 generic types, or the `Type[]` overload), "How would you map a hierarchy?" (multi-mapping into a dictionary, or `QueryMultiple` and stitch in memory).

#### Code
```csharp title="Multi-mapping a one-to-many join with splitOn"
public async Task<IReadOnlyList<Order>> GetOrdersWithLinesAsync(IDbConnection conn, int customerId)
{
    const string sql = """
        SELECT o.Id, o.CreatedAt, o.Total,
               l.LineId, l.ProductName, l.Quantity, l.UnitPrice
        FROM dbo.Orders AS o
        LEFT JOIN dbo.OrderLines AS l ON l.OrderId = o.Id
        WHERE o.CustomerId = @customerId
        ORDER BY o.Id;
        """;

    var lookup = new Dictionary<int, Order>();

    await conn.QueryAsync<Order, OrderLine?, Order>(
        sql,
        (order, line) =>
        {
            // Parent row repeats for every line: reuse the first instance
            if (!lookup.TryGetValue(order.Id, out var existing))
                lookup.Add(order.Id, existing = order);

            if (line is not null)          // LEFT JOIN: order without lines
                existing.Lines.Add(line);

            return existing;
        },
        new { customerId },
        splitOn: "LineId");                // OrderLine columns start here

    return lookup.Values.ToList();
}
```

```csharp title="QueryMultiple: an aggregate in one round trip"
public async Task<OrderDetails?> GetOrderDetailsAsync(IDbConnection conn, int orderId)
{
    const string sql = """
        SELECT Id, CustomerId, CreatedAt, Total FROM dbo.Orders     WHERE Id = @orderId;
        SELECT LineId, ProductName, Quantity, UnitPrice
                                              FROM dbo.OrderLines WHERE OrderId = @orderId;
        SELECT PaymentId, Amount, PaidAt      FROM dbo.Payments   WHERE OrderId = @orderId;
        """;

    using var grid = await conn.QueryMultipleAsync(sql, new { orderId });

    // Read result sets in exactly the order they appear in the batch
    var order = await grid.ReadSingleOrDefaultAsync<Order>();
    if (order is null) return null;

    var lines    = (await grid.ReadAsync<OrderLine>()).ToList();
    var payments = (await grid.ReadAsync<Payment>()).ToList();

    return new OrderDetails(order, lines, payments);
}
```

### Q: How do you call stored procedures and use transactions with Dapper?
difficulty: Medium
tags: dapper, transactions, stored-procedures, database
id: dapper-stored-procedures-transactions

#### Definition
Dapper calls a stored procedure by passing its name and setting commandType to CommandType.StoredProcedure.
Input, output and return-value parameters are configured with DynamicParameters.
Table-valued parameters can be passed with DataTable.AsTableValuedParameter for set-based inserts.
Transactions are started with IDbConnection.BeginTransaction on an open connection.
The resulting IDbTransaction must be passed to every Dapper call that should take part in it.
Commit is called on success; disposing an uncommitted transaction rolls it back.
For spanning multiple connections or components, TransactionScope can be used with async flow enabled.

#### Answer
In my experience two things trip people up: **forgetting `commandType`** and **forgetting to pass the transaction** to each call.

Stored procedures:
- `commandType: CommandType.StoredProcedure` — otherwise Dapper sends the name as raw text.
- **Output parameters** via `DynamicParameters.Add("NewId", dbType: DbType.Int32, direction: ParameterDirection.Output)`, then `p.Get<int>("NewId")` *after* the call.
- **TVPs** for bulk-ish inserts: one call with many rows instead of a loop.

Transactions:
- Open the connection, `BeginTransaction()`, pass `transaction: tx` to every command.
- If a command on a connection with an active transaction doesn't receive it, SqlClient throws *"ExecuteReader requires the command to have a transaction..."*.
- Use `using` so an exception before `Commit()` rolls back automatically.

| Option | Scope | Notes |
|---|---|---|
| `IDbTransaction` | one connection | explicit, fastest, my default |
| `TransactionScope` | ambient | needs `TransactionScopeAsyncFlowOption.Enabled` for async; multiple connections can escalate to a distributed transaction |
| Transaction inside the proc | database | good when all logic lives in T-SQL |

Real-world: in a combined EF Core + Dapper app I share EF's connection and transaction — `db.Database.BeginTransactionAsync()` then `GetDbTransaction()` — so both ORMs commit atomically.

> **Follow-ups:** "What isolation level does BeginTransaction use?" (READ COMMITTED unless specified), "How do you retry on deadlock?" (catch `SqlException` 1205, or use Polly with a fresh transaction).

#### Code
```csharp title="Stored procedure with output parameter inside a transaction"
public async Task<int> PlaceOrderAsync(SqlConnection conn, PlaceOrder cmd, CancellationToken ct)
{
    await conn.OpenAsync(ct);
    await using var tx = await conn.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);

    try
    {
        // Table-valued parameter: all lines in a single call
        var lines = new DataTable();
        lines.Columns.Add("ProductId", typeof(int));
        lines.Columns.Add("Quantity", typeof(int));
        foreach (var l in cmd.Lines) lines.Rows.Add(l.ProductId, l.Quantity);

        var p = new DynamicParameters();
        p.Add("CustomerId", cmd.CustomerId);
        p.Add("Lines", lines.AsTableValuedParameter("dbo.OrderLineType"));
        p.Add("NewOrderId", dbType: DbType.Int32, direction: ParameterDirection.Output);

        await conn.ExecuteAsync("dbo.CreateOrder", p,
            transaction: tx, commandType: CommandType.StoredProcedure);

        var orderId = p.Get<int>("NewOrderId");   // read output AFTER execution

        // Second command must receive the same transaction
        await conn.ExecuteAsync(
            "UPDATE dbo.Customers SET LastOrderAt = SYSUTCDATETIME() WHERE Id = @CustomerId;",
            new { cmd.CustomerId }, transaction: tx);

        await tx.CommitAsync(ct);
        return orderId;
    }
    catch
    {
        await tx.RollbackAsync(ct);
        throw;
    }
}
```

```sql title="Table type and procedure called above"
CREATE TYPE dbo.OrderLineType AS TABLE (ProductId INT NOT NULL, Quantity INT NOT NULL);
GO
CREATE OR ALTER PROCEDURE dbo.CreateOrder
    @CustomerId INT,
    @Lines      dbo.OrderLineType READONLY,
    @NewOrderId INT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.Orders (CustomerId, CreatedAt) VALUES (@CustomerId, SYSUTCDATETIME());
    SET @NewOrderId = SCOPE_IDENTITY();

    INSERT dbo.OrderLines (OrderId, ProductId, Quantity)
    SELECT @NewOrderId, ProductId, Quantity FROM @Lines;
END;
```
