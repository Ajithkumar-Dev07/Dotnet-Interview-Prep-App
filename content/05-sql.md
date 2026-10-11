---
title: SQL
description: T-SQL queries, joins, window functions, indexing and transactions on SQL Server
icon: "SQL"
color: "#ea580c"
---

## Queries & Joins

### Q: What are the different types of JOINs in SQL Server and when do you use each?
difficulty: Easy
tags: sql, joins, database, queries
id: sql-join-types

#### Definition
A JOIN combines rows from two or more tables based on a related column, usually a foreign key.
INNER JOIN returns only the rows that have a match on both sides.
LEFT (OUTER) JOIN returns all rows from the left table plus matching rows from the right, filling NULLs where there is no match.
RIGHT JOIN is the mirror image, and FULL OUTER JOIN returns all rows from both sides, matched where possible.
CROSS JOIN produces a Cartesian product of every row on the left with every row on the right.
A self join joins a table to itself, typically for hierarchies such as employee and manager.
SQL Server also offers CROSS APPLY and OUTER APPLY to join each row to the output of a table-valued expression.

#### Answer
I'd explain joins in terms of **which rows survive** the operation, because that's what interviewers really want to hear.

- **INNER JOIN** – only matching rows; my default for "orders with their customer".
- **LEFT JOIN** – keep everything on the left; I use it for "customers *and* their orders, even if they have none", or for anti-joins (`WHERE o.Id IS NULL`).
- **FULL OUTER JOIN** – reconciliation jobs, e.g. comparing a staging table to production.
- **CROSS JOIN** – generating combinations, like every product × every month for a report grid.
- **CROSS / OUTER APPLY** – "top N per group" or calling a table-valued function per row.

| Join | Unmatched left rows | Unmatched right rows |
|------|--------------------|---------------------|
| INNER | dropped | dropped |
| LEFT | kept (NULLs right) | dropped |
| RIGHT | dropped | kept (NULLs left) |
| FULL | kept | kept |

In my experience the most common bug is putting a filter on the right-hand table in the `WHERE` clause of a LEFT JOIN. `WHERE o.Status = 'Paid'` silently turns it back into an INNER JOIN, because NULL rows fail the predicate. The fix is to move that condition into the `ON` clause.

> **Likely follow-ups:** "How do you find customers with no orders?" (LEFT JOIN + `IS NULL` or `NOT EXISTS`), "Difference between `NOT IN` and `NOT EXISTS`?" (`NOT IN` returns nothing if the subquery contains a NULL), and "When would you use APPLY instead of a join?"

#### Code
```sql title="Join types, anti-join and the LEFT JOIN filter pitfall"
-- INNER JOIN: only customers who have placed orders
SELECT c.CustomerId, c.Name, o.OrderId, o.Total
FROM dbo.Customers AS c
INNER JOIN dbo.Orders AS o ON o.CustomerId = c.CustomerId;

-- LEFT JOIN: every customer, with paid orders if any.
-- The filter lives in ON, otherwise the LEFT JOIN degrades to an INNER JOIN.
SELECT c.CustomerId, c.Name, o.OrderId, o.Total
FROM dbo.Customers AS c
LEFT JOIN dbo.Orders AS o
       ON o.CustomerId = c.CustomerId
      AND o.Status = 'Paid';

-- Anti-join: customers who never ordered (NOT EXISTS is NULL-safe)
SELECT c.CustomerId, c.Name
FROM dbo.Customers AS c
WHERE NOT EXISTS (SELECT 1 FROM dbo.Orders AS o WHERE o.CustomerId = c.CustomerId);

-- Self join: employee with their manager's name
SELECT e.Name AS Employee, m.Name AS Manager
FROM dbo.Employees AS e
LEFT JOIN dbo.Employees AS m ON m.EmployeeId = e.ManagerId;

-- CROSS APPLY: latest 3 orders per customer
SELECT c.Name, x.OrderId, x.OrderDate
FROM dbo.Customers AS c
CROSS APPLY (
    SELECT TOP (3) o.OrderId, o.OrderDate
    FROM dbo.Orders AS o
    WHERE o.CustomerId = c.CustomerId
    ORDER BY o.OrderDate DESC
) AS x;
```

### Q: What are window functions and CTEs, and how do you use them together?
difficulty: Medium
tags: sql, window-functions, cte, queries
id: sql-window-functions-cte

#### Definition
A window function performs a calculation across a set of rows related to the current row without collapsing them like GROUP BY does.
It is defined with the OVER clause, which can PARTITION BY a column and ORDER BY within each partition.
Common examples are ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD and aggregates such as SUM() OVER.
A Common Table Expression (CTE) is a named, temporary result set defined with WITH and scoped to a single statement.
CTEs improve readability by breaking a complex query into logical steps.
A recursive CTE references itself and is used to walk hierarchies such as org charts or category trees.
CTEs are not materialized in SQL Server; they are inlined into the query plan like a derived table.

#### Answer
In my experience these two features replace most of the cursors and self-joins I used to see in legacy code.

**Window functions** keep every detail row but add an aggregate or ranking "alongside" it:
- `ROW_NUMBER()` – unique sequence; perfect for de-duplication and "top N per group".
- `RANK()` / `DENSE_RANK()` – ties share a rank; RANK leaves gaps, DENSE_RANK doesn't.
- `LAG()` / `LEAD()` – compare with the previous / next row (month-over-month change).
- `SUM() OVER (ORDER BY ... ROWS UNBOUNDED PRECEDING)` – running totals.

**CTEs** give names to intermediate steps. Since you can't reference a window function in `WHERE`, I typically compute `ROW_NUMBER()` in a CTE and filter in the outer query.

| | CTE | Temp table (#t) |
|---|---|---|
| Scope | single statement | session / procedure |
| Materialized | no (inlined) | yes, has statistics |
| Indexable | no | yes |

A pitfall I mention: people assume a CTE referenced twice is computed once — it isn't, it's expanded twice. If the CTE is expensive and reused, a temp table is usually faster. Also, recursive CTEs stop at 100 levels by default; use `OPTION (MAXRECURSION n)` if you need more.

> **Follow-ups:** "Difference between ROW_NUMBER, RANK and DENSE_RANK?", "How do you delete duplicates?" (CTE + ROW_NUMBER + `DELETE FROM cte WHERE rn > 1`), and "What's the default window frame?" (`RANGE UNBOUNDED PRECEDING` when ORDER BY is present — prefer `ROWS` for performance).

#### Code
```sql title="Top N per group, running totals and de-duplication"
-- Top 2 highest-paid employees per department
WITH Ranked AS (
    SELECT  e.EmployeeId, e.Name, e.DepartmentId, e.Salary,
            ROW_NUMBER() OVER (PARTITION BY e.DepartmentId
                               ORDER BY e.Salary DESC) AS rn
    FROM dbo.Employees AS e
)
SELECT EmployeeId, Name, DepartmentId, Salary
FROM Ranked
WHERE rn <= 2;   -- window functions can't go in WHERE, so filter in the outer query

-- Running total and month-over-month change
SELECT  OrderMonth,
        Revenue,
        SUM(Revenue) OVER (ORDER BY OrderMonth
                           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS RunningTotal,
        Revenue - LAG(Revenue, 1, 0) OVER (ORDER BY OrderMonth)            AS ChangeFromPrev
FROM dbo.MonthlyRevenue;

-- Remove duplicate emails, keeping the oldest row
WITH Dupes AS (
    SELECT ROW_NUMBER() OVER (PARTITION BY Email ORDER BY CreatedAt) AS rn
    FROM dbo.Users
)
DELETE FROM Dupes WHERE rn > 1;
```

```sql title="Recursive CTE: walk an org chart"
WITH OrgChart AS (
    -- Anchor: the CEO (no manager)
    SELECT EmployeeId, Name, ManagerId, 0 AS Level
    FROM dbo.Employees
    WHERE ManagerId IS NULL

    UNION ALL

    -- Recursive member: direct reports of the previous level
    SELECT e.EmployeeId, e.Name, e.ManagerId, oc.Level + 1
    FROM dbo.Employees AS e
    INNER JOIN OrgChart AS oc ON e.ManagerId = oc.EmployeeId
)
SELECT EmployeeId, Name, Level
FROM OrgChart
ORDER BY Level, Name
OPTION (MAXRECURSION 50);   -- guard against cycles in bad data
```

## Indexes & Performance

### Q: What is the difference between a clustered and a non-clustered index?
difficulty: Medium
tags: sql, indexes, performance, database
id: clustered-vs-nonclustered-index

#### Definition
An index is a B-tree structure that lets SQL Server locate rows without scanning the whole table.
A clustered index defines the physical order of the data: its leaf level is the table itself.
Because of that, a table can have only one clustered index, and by default the primary key creates it.
A non-clustered index is a separate structure whose leaf level holds the key columns plus a row locator.
That locator is the clustered key (or a RID for a heap), so extra columns require a key lookup.
Included columns let a non-clustered index "cover" a query and avoid those lookups.
Indexes speed up reads but add cost to every INSERT, UPDATE and DELETE and consume storage.

#### Answer
I'd explain it with a book analogy: the **clustered index is the book itself**, sorted by page number, while a **non-clustered index is the index at the back** that points you to pages.

| | Clustered | Non-clustered |
|---|---|---|
| Per table | 1 | up to 999 |
| Leaf level | the actual data rows | key + clustered key / RID |
| Best for | range scans, ORDER BY on the key | selective lookups, covering queries |
| Extra cost | page splits on random keys | key lookups, write overhead |

Key points I make in interviews:
- **Choose the clustered key carefully** – narrow, unique, static and ever-increasing (`INT IDENTITY`, sequential GUID). A random `NEWID()` key causes page splits and fragmentation.
- The clustered key is copied into **every non-clustered index**, so a wide clustered key bloats them all.
- **Covering indexes** with `INCLUDE` remove key lookups — I look for "Key Lookup" operators in the execution plan.
- **Filtered indexes** (`WHERE IsDeleted = 0`) are great for soft-delete patterns.
- Column order matters: equality columns first, then range columns.

In real projects I start from the slow query's actual execution plan and Query Store, not from guesses. A common pitfall is over-indexing an OLTP table: ten indexes can make inserts noticeably slower.

> **Follow-ups:** "What is SARGability?" (wrapping a column in a function like `YEAR(OrderDate)` prevents an index seek), "Seek vs scan?", and "What's a heap?"

#### Code
```sql title="Clustered, covering and filtered indexes"
-- Clustered index on a narrow, ever-increasing key
CREATE TABLE dbo.Orders (
    OrderId     INT IDENTITY(1,1) NOT NULL,
    CustomerId  INT           NOT NULL,
    OrderDate   DATETIME2(0)  NOT NULL,
    Status      VARCHAR(20)   NOT NULL,
    Total       DECIMAL(18,2) NOT NULL,
    IsDeleted   BIT           NOT NULL DEFAULT 0,
    CONSTRAINT PK_Orders PRIMARY KEY CLUSTERED (OrderId)
);

-- Covering non-clustered index: seek on CustomerId + OrderDate,
-- Status and Total are INCLUDEd so no key lookup is needed
CREATE NONCLUSTERED INDEX IX_Orders_Customer_Date
    ON dbo.Orders (CustomerId, OrderDate DESC)
    INCLUDE (Status, Total);

-- Filtered index for the common "active rows only" query
CREATE NONCLUSTERED INDEX IX_Orders_Active_Status
    ON dbo.Orders (Status)
    WHERE IsDeleted = 0;

-- Non-SARGable: function on the column forces a scan
SELECT OrderId FROM dbo.Orders WHERE YEAR(OrderDate) = 2025;

-- SARGable rewrite: range predicate allows an index seek
SELECT OrderId FROM dbo.Orders
WHERE OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01';
```

### Q: Explain transactions, isolation levels and when you'd use a stored procedure.
difficulty: Hard
tags: sql, transactions, isolation-levels, stored-procedures
id: sql-transactions-isolation

#### Definition
A transaction is a unit of work that is either fully committed or fully rolled back.
Transactions guarantee the ACID properties: Atomicity, Consistency, Isolation and Durability.
The isolation level controls which concurrency anomalies one transaction can see from others.
SQL Server supports READ UNCOMMITTED, READ COMMITTED (default), REPEATABLE READ, SERIALIZABLE and SNAPSHOT.
Higher levels prevent dirty reads, non-repeatable reads and phantoms, at the cost of more locking and blocking.
READ COMMITTED SNAPSHOT (RCSI) uses row versioning in tempdb so readers don't block writers.
A stored procedure is precompiled, parameterized T-SQL stored in the database, often used to wrap a transaction.

#### Answer
In my experience the interesting part isn't the definition of ACID but **choosing the right isolation level** and handling errors correctly.

| Level | Dirty read | Non-repeatable read | Phantom | Mechanism |
|---|---|---|---|---|
| READ UNCOMMITTED | yes | yes | yes | no shared locks |
| READ COMMITTED | no | yes | yes | short shared locks |
| REPEATABLE READ | no | no | yes | holds shared locks |
| SERIALIZABLE | no | no | no | range locks |
| SNAPSHOT / RCSI | no | no* | no* | row versioning |

\*for SNAPSHOT; RCSI is statement-level consistency.

Points I make:
- I usually **enable RCSI** on OLTP databases – it removes most reader/writer blocking without code changes.
- `NOLOCK` is not a performance hint; it's READ UNCOMMITTED and can return **duplicate or missing rows**.
- Always use `SET XACT_ABORT ON` with `TRY...CATCH` so any error rolls back the whole transaction.
- Keep transactions **short** – never wait on user input or HTTP calls inside one.
- Access tables in a consistent order to reduce **deadlocks**; SQL Server picks a victim with error 1205, so the app should retry.

**Stored procedures** give plan caching, a security boundary (grant EXECUTE only) and fewer round trips. I use them for complex batch operations or reporting, while simple CRUD stays in EF Core. A pitfall is **parameter sniffing**: a plan compiled for a rare value gets reused for common ones — fixes include `OPTION (RECOMPILE)` or `OPTIMIZE FOR`.

> **Follow-ups:** "What causes a deadlock and how do you diagnose it?" (system_health Extended Events), "Optimistic vs pessimistic concurrency?" (`rowversion` column).

#### Code
```sql title="Transfer funds: stored procedure with transaction and error handling"
CREATE OR ALTER PROCEDURE dbo.TransferFunds
    @FromAccountId INT,
    @ToAccountId   INT,
    @Amount        DECIMAL(18,2)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;   -- any runtime error dooms and rolls back the transaction

    BEGIN TRY
        BEGIN TRANSACTION;

        -- UPDLOCK prevents two transfers reading the same balance concurrently
        DECLARE @Balance DECIMAL(18,2) =
            (SELECT Balance FROM dbo.Accounts WITH (UPDLOCK, ROWLOCK)
             WHERE AccountId = @FromAccountId);

        IF @Balance IS NULL OR @Balance < @Amount
            THROW 50001, 'Insufficient funds or account not found.', 1;

        UPDATE dbo.Accounts SET Balance = Balance - @Amount WHERE AccountId = @FromAccountId;
        UPDATE dbo.Accounts SET Balance = Balance + @Amount WHERE AccountId = @ToAccountId;

        INSERT dbo.Transfers (FromAccountId, ToAccountId, Amount, CreatedAt)
        VALUES (@FromAccountId, @ToAccountId, @Amount, SYSUTCDATETIME());

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;   -- re-raise the original error to the caller
    END CATCH
END;
GO

-- Enable row versioning so readers don't block writers (run once per database)
ALTER DATABASE ShopDb SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;
```
