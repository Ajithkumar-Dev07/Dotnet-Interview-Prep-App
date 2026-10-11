---
title: C#
description: Core C# language fundamentals - the type system, memory model and modern language features every .NET developer is expected to know.
icon: "C#"
color: "#7c3aed"
---

## Types & Memory

### Q: What is the difference between a value type and a reference type?
difficulty: Easy
tags: memory, types, stack, heap
id: value-vs-reference

#### Definition
A value type holds its data directly, while a reference type holds a reference (pointer) to an object on the managed heap.
Value types include `int`, `double`, `bool`, `enum` and any `struct`; reference types include `class`, `record`, `interface`, `delegate`, `string` and arrays.
Assigning a value type copies the whole value, so the two variables are independent.
Assigning a reference type copies only the reference, so both variables point at the same object.
Value types cannot be `null` unless wrapped in `Nullable<T>` (`int?`), whereas reference types can be `null`.
Where a value type lives depends on context: locals usually live on the stack, but fields of a class live on the heap with their owner.
Reference-type objects are always allocated on the managed heap and reclaimed by the garbage collector.

#### Answer
I'd explain it as **"copy semantics vs. shared semantics"** first, and only then talk about stack and heap, because the memory location is an implementation detail.

**Key points**
- **Value types** (`struct`, primitives, `enum`) are copied on assignment and when passed to methods (unless passed with `ref`, `in` or `out`).
- **Reference types** (`class`, `record`, arrays, `string`) share one object; mutating it through one variable is visible through all.
- `string` is a reference type but **immutable**, so it *behaves* like a value in most code.
- Equality: value types compare field-by-field by default (`ValueType.Equals`), classes compare by reference unless overridden; `record` types give you value equality on a reference type.

| Aspect | Value type | Reference type |
|---|---|---|
| Assignment | Copies data | Copies reference |
| Default value | Zeroed (`0`, `false`) | `null` |
| Inheritance | Sealed, can implement interfaces | Full inheritance |
| GC pressure | None when on the stack | Tracked by GC |

**Real-world usage:** In my experience, small, immutable structs (like `DateTime`, `Guid`, a `Money` type) cut allocations in hot paths. Everything with identity or a lifecycle (entities, services) should be a class.

**Pitfalls / follow-ups**
- "Are value types always on the stack?" No. A struct field inside a class, a struct in an array, or a captured local in a lambda lives on the heap.
- Large mutable structs are a trap: copies are expensive and mutating a copy (e.g. from a `List<T>` indexer) silently does nothing.
- Expect a follow-up on **boxing**, which happens when a value type is treated as `object` or an interface.

#### Code
```csharp title="Copy vs shared semantics"
public struct PointStruct { public int X; public int Y; }
public class PointClass { public int X; public int Y; }

public static class Demo
{
    public static void Run()
    {
        // Value type: b gets its own copy of the data
        var a = new PointStruct { X = 1, Y = 1 };
        var b = a;
        b.X = 99;
        Console.WriteLine(a.X); // 1  - a is untouched

        // Reference type: c and d point to the same heap object
        var c = new PointClass { X = 1, Y = 1 };
        var d = c;
        d.X = 99;
        Console.WriteLine(c.X); // 99 - change visible through both

        // Passing to methods follows the same rules
        Mutate(a);   // mutates a copy
        Mutate(c);   // mutates the shared object
        Console.WriteLine($"{a.X} / {c.X}"); // 1 / 42
    }

    private static void Mutate(PointStruct p) => p.X = 42;
    private static void Mutate(PointClass p) => p.X = 42;
}
```

```csharp title="The mutable-struct-in-a-list pitfall"
// Top-level program: statements first, type declarations at the bottom
var counters = new List<Counter> { new() };

// counters[0] returns a COPY, so this increments a temporary
var tmp = counters[0];
tmp.Increment();
Console.WriteLine(counters[0].Value); // 0

// Fix 1: write the copy back
counters[0] = tmp;

// Fix 2: use an array and mutate in place via the element reference
var array = new Counter[1];
array[0].Increment();                 // arrays expose the element by reference
Console.WriteLine(array[0].Value);    // 1

// Fix 3 (best): make the struct immutable, e.g. a readonly record struct
public struct Counter { public int Value; public void Increment() => Value++; }
public readonly record struct Money(decimal Amount, string Currency);
```

### Q: What are boxing and unboxing, and why do they matter for performance?
difficulty: Medium
tags: memory, performance, generics, types
id: boxing-and-unboxing

#### Definition
Boxing is the implicit conversion of a value type to `object` or to an interface it implements.
The runtime allocates a new object on the managed heap and copies the value into it.
Unboxing is the explicit conversion from that object back to the original value type.
Unboxing checks the runtime type and copies the value back out, throwing `InvalidCastException` on a mismatch.
Each box is a separate heap allocation that the garbage collector must later clean up.
Generics were introduced largely to avoid boxing in collections and algorithms.
In hot paths, unnecessary boxing causes extra allocations, GC pressure and lost performance.

#### Answer
In my experience boxing is rarely a problem in business code, but it is a classic cause of hidden allocations in **hot loops, logging and collections**, so I treat it as a performance smell rather than a bug.

**Where boxing sneaks in**
- Non-generic collections: `ArrayList`, `Hashtable`, `IList` (old APIs).
- Calling an interface method on a struct through the interface variable, e.g. `IComparable c = 5;`.
- `string.Format` / `params object[]` APIs and older logging overloads with value-type arguments.
- Calling `GetType()` or a non-overridden `ToString()`/`Equals()` on a struct.
- `Enum.HasFlag` on older runtimes (the JIT now optimises this away).

**How I avoid it**
- Use generic collections (`List<int>`, `Dictionary<TKey,TValue>`).
- Use generic constraints (`where T : IComparable<T>`) instead of interface parameters, so the JIT specialises code for each struct.
- Override `Equals`, `GetHashCode` and `ToString` on structs, or use `record struct` which does it for you.
- Use interpolated strings: since C# 10 they go through `DefaultInterpolatedStringHandler` and avoid boxing.

| | Boxing | Unboxing |
|---|---|---|
| Direction | value -> `object`/interface | `object` -> value |
| Syntax | Implicit | Explicit cast |
| Cost | Heap allocation + copy | Type check + copy |

**Follow-ups the interviewer may ask**
- "Can you unbox to a different type?" No: a boxed `int` must be unboxed as `int` (or `int?`), not `long`.
- "How do you detect it?" BenchmarkDotNet with `[MemoryDiagnoser]`, the allocation profiler, or IL inspection for `box` instructions.
- Mutating a boxed struct changes the copy in the box, not the original.

#### Code
```csharp title="Boxing in practice"
int number = 42;

object boxed = number;          // box: heap allocation, value copied
int unboxed = (int)boxed;       // unbox: type check + copy back

// long wrong = (long)boxed;    // InvalidCastException at runtime
long ok = (long)(int)boxed;     // unbox to int first, then convert

// Hidden boxing: non-generic collection
var legacy = new System.Collections.ArrayList();
legacy.Add(number);             // boxes every element

// No boxing: generic collection stores ints inline
var modern = new List<int> { number };

// Hidden boxing: calling through an interface variable
IComparable comparable = number;   // boxed
Console.WriteLine(comparable.CompareTo(10));

// Mutating a boxed struct changes only the boxed copy
object boxedPoint = new Point(1, 2);
((IMovable)boxedPoint).Move(10);
Console.WriteLine(((Point)boxedPoint).X); // 11 (inside the box)

public interface IMovable { void Move(int dx); }
public struct Point(int x, int y) : IMovable
{
    public int X = x, Y = y;
    public void Move(int dx) => X += dx;
}
```

```csharp title="Avoiding boxing with generic constraints"
// Usage
bool a = MathHelpers.IsGreaterBoxed(5, 3);  // 2 allocations
bool b = MathHelpers.IsGreater(5, 3);        // 0 allocations
int sum = MathHelpers.Sum<int>([1, 2, 3]);   // 6, 0 allocations

public static class MathHelpers
{
    // Interface parameter: every struct argument is boxed
    public static bool IsGreaterBoxed(IComparable left, object right)
        => left.CompareTo(right) > 0;

    // Generic constraint: JIT creates a specialised version per struct,
    // the call is direct (often inlined) and nothing is allocated
    public static bool IsGreater<T>(T left, T right) where T : IComparable<T>
        => left.CompareTo(right) > 0;

    // .NET 7+ generic math: no boxing and works for any numeric type
    public static T Sum<T>(ReadOnlySpan<T> values) where T : System.Numerics.INumber<T>
    {
        T total = T.Zero;
        foreach (var v in values) total += v;
        return total;
    }
}
```

## Language Features

### Q: When would you use a record instead of a class?
difficulty: Medium
tags: records, types, immutability, design
id: records-vs-classes

#### Definition
A `record` is a type whose compiler-generated members give it value-based equality.
Two record instances are equal when all their properties are equal, rather than when they are the same object.
The compiler also synthesises `ToString`, `GetHashCode`, `Deconstruct` and a copy constructor used by `with` expressions.
Positional records (`record Person(string Name)`) generate `init`-only properties, encouraging immutability.
`record` (or `record class`) is a reference type, while `record struct` is a value type with the same features.
Records support inheritance between records, but not between a record and a normal class.
They are designed for data-centric types such as DTOs, messages, events and value objects.

#### Answer
I'd explain it this way: **a class models something with identity, a record models a value**. Two `Order` entities with the same data are still two different orders; two `Address` values with the same data are the same address.

**What a record gives me for free**
- Value equality (`Equals`, `==`, `GetHashCode`) across all properties.
- Non-destructive mutation with `with`: `var moved = address with { City = "Oslo" };`.
- A readable `ToString()` like `Address { Street = ..., City = ... }`, which is great in logs and tests.
- Concise positional syntax and deconstruction.

| | `class` | `record` | `record struct` |
|---|---|---|---|
| Kind | Reference | Reference | Value |
| Equality | Reference | Value | Value |
| Immutable by default | No | Positional: yes | No (use `readonly record struct`) |
| `with` support | No | Yes | Yes |

**Where I use them in real projects**
- API request/response DTOs and MediatR commands/queries.
- Domain events and integration messages.
- DDD value objects (`Money`, `DateRange`).
- Keys for dictionaries and caches, thanks to correct `GetHashCode`.

**Pitfalls / follow-ups**
- **Shallow equality**: a `List<T>` property is compared by reference, so two records with equal-looking lists are not equal.
- `with` makes a **shallow copy**, so nested mutable objects are shared.
- Avoid records for **EF Core entities**: value equality and the generated hash code conflict with change tracking and identity.
- "Are records immutable?" Only if you use `init`/positional properties; you can still declare mutable `set` properties.

#### Code
```csharp title="Record basics: equality, with, deconstruction"
public record Address(string Street, string City, string PostCode);

public static class RecordDemo
{
    public static void Run()
    {
        var a1 = new Address("1 Main St", "London", "E1 6AN");
        var a2 = new Address("1 Main St", "London", "E1 6AN");

        Console.WriteLine(a1 == a2);                 // True  - value equality
        Console.WriteLine(ReferenceEquals(a1, a2));  // False - different objects

        // Non-destructive mutation: a1 is unchanged
        var moved = a1 with { City = "Manchester" };
        Console.WriteLine(moved);
        // Address { Street = 1 Main St, City = Manchester, PostCode = E1 6AN }

        // Deconstruction comes from the positional parameters
        var (street, city, _) = moved;
        Console.WriteLine($"{street}, {city}");

        // Works as a dictionary key because GetHashCode is value-based
        var cache = new Dictionary<Address, decimal> { [a1] = 4.99m };
        Console.WriteLine(cache[a2]);                // 4.99
    }
}
```

```csharp title="Value object with validation and the shallow-equality trap"
// Pitfall: collections are compared by reference
var b1 = new Basket("ann", ["apple"]);
var b2 = new Basket("ann", ["apple"]);
Console.WriteLine(b1 == b2); // False - different List instances
// Fix: override Equals/GetHashCode or use an immutable, comparable collection

var total = new Money(10, "eur") + new Money(5, "EUR");
Console.WriteLine(total);    // Money { Amount = 15, Currency = EUR }

public record Basket(string Owner, List<string> Items);

// readonly record struct: value type, immutable, no heap allocation
public readonly record struct Money
{
    public decimal Amount { get; }
    public string Currency { get; }

    public Money(decimal amount, string currency)
    {
        if (amount < 0) throw new ArgumentOutOfRangeException(nameof(amount));
        Amount = amount;
        Currency = currency.ToUpperInvariant();
    }

    public static Money operator +(Money a, Money b) =>
        a.Currency == b.Currency
            ? new Money(a.Amount + b.Amount, a.Currency)
            : throw new InvalidOperationException("Currency mismatch");
}
```

### Q: Explain pattern matching in modern C#.
difficulty: Hard
tags: pattern-matching, language-features, switch, design
id: pattern-matching

#### Definition
Pattern matching lets you test a value against a shape and extract data from it in a single expression.
It is used with the `is` operator, `switch` statements and `switch` expressions.
Type patterns check the runtime type and declare a typed variable (`if (shape is Circle c)`).
Property patterns inspect members (`{ Status: "Paid", Total: > 100 }`), and positional patterns use `Deconstruct`.
Relational (`>`, `<=`) and logical (`and`, `or`, `not`) patterns combine conditions declaratively.
List patterns (C# 11) match arrays and lists by element, including slices with `..`.
The compiler checks switch expressions for exhaustiveness and warns about unreachable or missing cases.

#### Answer
In my experience pattern matching is the biggest readability win in C# since LINQ. I describe it as **"declarative branching on the shape of data"** instead of nested `if`/cast chains.

**Pattern types I use regularly**
- **Type**: `obj is Customer c` (replaces `as` + null check).
- **Constant / null**: `x is null`, `x is not null` (cannot be broken by an overloaded `==`).
- **Property**: `order is { Status: OrderStatus.Paid, Lines.Count: > 0 }` (extended property patterns since C# 10).
- **Relational + logical**: `temp is >= 18 and < 25`.
- **Positional**: `point is (0, 0)` via `Deconstruct`.
- **List** (C# 11): `args is ["--help", ..]` or `[var first, .., var last]`.

| Old style | Pattern style |
|---|---|
| `var c = o as Circle; if (c != null)` | `if (o is Circle c)` |
| `if (x >= 1 && x <= 5)` | `if (x is >= 1 and <= 5)` |
| Large `switch` with `break` | `switch` expression returning a value |

**Real-world usage:** pricing and discount rules, mapping domain results to HTTP responses (`result switch { NotFound => 404, ... }`), parsing command-line arguments, and processing polymorphic messages without the visitor pattern.

**Pitfalls / follow-ups**
- **Order matters**: arms are evaluated top-down, so put specific cases before general ones; the compiler errors on arms that are already fully covered.
- A non-exhaustive switch expression throws `SwitchExpressionException` at runtime; always add a discard `_` arm or cover all cases.
- Interviewers may ask how this compares to polymorphism. My answer: use virtual methods when behaviour belongs to the type, and pattern matching when the logic belongs to the caller (closed hierarchies, DTOs).

#### Code
```csharp title="Switch expression with type, property and relational patterns"
public abstract record Shape;
public record Circle(double Radius) : Shape;
public record Rectangle(double Width, double Height) : Shape;
public record Triangle(double Base, double Height) : Shape;

public static class ShapeCalculator
{
    public static double Area(Shape shape) => shape switch
    {
        Circle { Radius: <= 0 }           => throw new ArgumentException("Invalid radius"),
        Circle c                          => Math.PI * c.Radius * c.Radius,
        Rectangle(var w, var h) when w == h => w * w,           // positional + guard
        Rectangle r                       => r.Width * r.Height,
        Triangle t                        => 0.5 * t.Base * t.Height,
        null                              => throw new ArgumentNullException(nameof(shape)),
        _                                 => throw new NotSupportedException(shape.GetType().Name)
    };

    public static string Classify(double area) => area switch
    {
        < 0          => "invalid",
        0            => "empty",
        > 0 and < 10 => "small",
        >= 10 and < 100 => "medium",
        _            => "large"
    };
}
```

```csharp title="Property and list patterns in business rules"
var order = new Order(new Customer("Silver", 6), 120m, ["WELCOME"]);
Console.WriteLine(DiscountRules.GetDiscount(order)); // 0.10 (YearsActive >= 5 wins: order matters)

public record Customer(string Tier, int YearsActive);
public record Order(Customer Customer, decimal Total, string[] Coupons);

public static class DiscountRules
{
    public static decimal GetDiscount(Order order) => order switch
    {
        // Extended property pattern (C# 10)
        { Customer.Tier: "Gold", Total: > 500m }         => 0.20m,
        { Customer: { Tier: "Gold" } or { YearsActive: >= 5 } } => 0.10m,

        // List patterns (C# 11): first coupon decides
        { Coupons: ["WELCOME", ..] }                     => 0.15m,
        { Coupons: [.., "LASTCHANCE"] }                  => 0.05m,
        { Coupons: [] }                                  => 0m,
        _                                                => 0.02m
    };
}
```
