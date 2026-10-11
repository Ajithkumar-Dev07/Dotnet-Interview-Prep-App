---
title: OOP & SOLID
description: Object-oriented design in C# - the four pillars, abstract classes vs interfaces, SOLID principles and the design patterns interviewers ask about most.
icon: "OOP"
color: "#db2777"
---

## OOP Pillars

### Q: What are the four pillars of object-oriented programming?
difficulty: Easy
tags: oop, design, polymorphism, encapsulation
id: four-pillars-of-oop

#### Definition
Object-oriented programming organises code around objects that combine state (data) with the behaviour that operates on it.
Encapsulation hides internal state behind a well-defined public surface and protects the object's invariants.
Abstraction exposes only the essential concepts of an object and hides the implementation details.
Inheritance lets a class reuse and specialise the members of a base class, forming an "is-a" relationship.
Polymorphism lets code work with a base type or interface while the actual runtime type decides the behaviour.
In C#, polymorphism comes from `virtual`/`override` and interfaces (runtime) and from overloading and generics (compile time).
Together these pillars aim to make code easier to change, reuse and reason about.

#### Answer
In my experience interviewers want more than four textbook words, so I explain each pillar **with the C# feature that implements it and why it matters in real code**.

**Key points**
- **Encapsulation**: private fields, properties with validation, `private set`/`init`, and methods like `order.AddLine()` instead of exposing `List<OrderLine>`. It protects invariants (an order total can never be negative).
- **Abstraction**: interfaces and abstract classes such as `IPaymentGateway`; the caller cares *what* it does, not *how*.
- **Inheritance**: `class SavingsAccount : Account`. Useful for shared behaviour, but it creates the tightest coupling possible.
- **Polymorphism**: a `List<Account>` where each account's `CalculateInterest()` behaves differently at runtime.

| Pillar | C# mechanism | Main benefit |
|---|---|---|
| Encapsulation | Access modifiers, properties | Protects invariants |
| Abstraction | Interfaces, abstract classes | Decouples callers |
| Inheritance | `: BaseClass`, `base` | Code reuse |
| Polymorphism | `virtual`/`override`, interfaces | Extensibility |

**Real-world usage:** in my projects the most valuable pillars day to day are encapsulation (rich domain models) and polymorphism via interfaces (dependency injection, testing with mocks). I use inheritance sparingly.

**Pitfalls / follow-ups**
- "Composition or inheritance?" I favour **composition over inheritance**; deep hierarchies become fragile (the fragile base class problem).
- "What is the difference between overloading and overriding?" Overloading is compile-time (same name, different signature); overriding is runtime (same signature, `virtual`/`override`).
- `new` hides a member rather than overriding it, which breaks polymorphism when called through the base type.
- Anemic domain models (public setters everywhere) are a sign encapsulation has been lost.

#### Code
```csharp title="Encapsulation, inheritance and polymorphism together"
public abstract class Account
{
    private readonly List<decimal> _transactions = [];   // encapsulated state

    protected Account(string owner) => Owner = owner;

    public string Owner { get; }
    public decimal Balance { get; private set; }          // no public setter
    public IReadOnlyList<decimal> Transactions => _transactions;

    public void Deposit(decimal amount)
    {
        if (amount <= 0) throw new ArgumentOutOfRangeException(nameof(amount));
        Balance += amount;                                 // invariant enforced here
        _transactions.Add(amount);
    }

    // Abstraction + polymorphism: each subtype decides how interest works
    public abstract decimal CalculateMonthlyInterest();

    public virtual string Describe() => $"{GetType().Name} for {Owner}: {Balance:C}";
}

public sealed class SavingsAccount(string owner) : Account(owner)
{
    public override decimal CalculateMonthlyInterest() => Balance * 0.04m / 12;
}

public sealed class CheckingAccount(string owner) : Account(owner)
{
    public override decimal CalculateMonthlyInterest() => 0m;
    public override string Describe() => base.Describe() + " (no interest)";
}

// The caller works with the abstraction; the runtime type picks the behaviour
public static class InterestJob
{
    public static decimal Run(IEnumerable<Account> accounts) =>
        accounts.Sum(a => a.CalculateMonthlyInterest());
}
```

```csharp title="Overriding vs hiding with new"
public class Animal
{
    public virtual string Speak() => "...";
    public string Kind() => "animal";
}

public class Dog : Animal
{
    public override string Speak() => "Woof";   // runtime polymorphism
    public new string Kind() => "dog";           // hides, does NOT override
}

public static class HidingDemo
{
    public static void Run()
    {
        Animal pet = new Dog();

        Console.WriteLine(pet.Speak()); // "Woof"   - virtual dispatch uses runtime type
        Console.WriteLine(pet.Kind());  // "animal" - hidden member uses static type

        Dog dog = (Dog)pet;
        Console.WriteLine(dog.Kind());  // "dog"
    }
}
```

### Q: What is the difference between an abstract class and an interface?
difficulty: Medium
tags: oop, interfaces, design, inheritance
id: abstract-class-vs-interface

#### Definition
An abstract class is a base class that cannot be instantiated and may contain fields, constructors, implemented members and abstract members.
A class can inherit from only one abstract class, because C# supports single inheritance of classes.
An interface is a contract that defines a set of members that implementing types must provide.
A class or struct can implement many interfaces.
Since C# 8, interfaces can include default method implementations, and since C# 11 they can declare static abstract members.
Interfaces still cannot hold instance fields or constructors, so they carry no per-instance state.
Use an abstract class to share state and behaviour within a family of types, and an interface to define a capability across unrelated types.

#### Answer
I'd explain it as **"is-a with shared implementation" vs. "can-do contract"**. `SavingsAccount` *is an* `Account`; a `Logger`, a `Cache` and a `Repository` *can be* `IDisposable`.

**Key points**

| Feature | Abstract class | Interface |
|---|---|---|
| Multiple inheritance | No (one base class) | Yes (many interfaces) |
| Instance fields / state | Yes | No |
| Constructors | Yes | No |
| Access modifiers on members | Any | Public by default (others allowed since C# 8) |
| Default implementations | Yes | Yes (C# 8+) |
| Static abstract members | No | Yes (C# 11, used by generic math) |
| Structs can use it | No | Yes |

**How I choose in real projects**
- **Interface first** for anything injected via DI (`IOrderRepository`, `IEmailSender`): easy to mock and to swap implementations.
- **Abstract class** when several implementations share real code and state, e.g. a `BackgroundService`-style template or a `HttpMessageHandler` base.
- Often **both**: an interface for consumers plus an abstract base class that implements the boilerplate (`IRepository<T>` + `RepositoryBase<T>`).

**Pitfalls / follow-ups**
- Default interface methods are mainly for **evolving published interfaces** without breaking implementers, not a replacement for abstract classes. They are only callable through the interface type.
- Adding a member to an abstract class is non-breaking if it is virtual; adding an abstract member breaks every subclass.
- "Can an interface have private methods?" Yes since C# 8, as helpers for default implementations.
- Static abstract members enable patterns like `T.Parse(...)` and `INumber<T>` in generic code.

#### Code
```csharp title="Interface for the contract, abstract class for shared code"
public interface INotificationSender
{
    string Channel { get; }
    Task SendAsync(string recipient, string message, CancellationToken ct = default);

    // Default implementation (C# 8+): added later without breaking implementers
    Task SendManyAsync(IEnumerable<string> recipients, string message, CancellationToken ct = default)
        => Task.WhenAll(recipients.Select(r => SendAsync(r, message, ct)));
}

// Template Method: shared validation/logging, subclasses provide the transport
public abstract class NotificationSenderBase(ILogger logger) : INotificationSender
{
    protected readonly ILogger Logger = logger;   // shared state - only possible here
    public abstract string Channel { get; }

    public async Task SendAsync(string recipient, string message, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(recipient);
        Logger.LogInformation("Sending {Channel} to {Recipient}", Channel, recipient);
        await SendCoreAsync(recipient, message, ct);
    }

    protected abstract Task SendCoreAsync(string recipient, string message, CancellationToken ct);
}

public sealed class SmsSender(ILogger<SmsSender> logger, ISmsGateway gateway)
    : NotificationSenderBase(logger)
{
    public override string Channel => "sms";
    protected override Task SendCoreAsync(string to, string msg, CancellationToken ct)
        => gateway.SendAsync(to, msg, ct);
}
```

```csharp title="Static abstract interface members (C# 11)"
public interface IShape<TSelf> where TSelf : IShape<TSelf>
{
    static abstract string Name { get; }
    static abstract TSelf CreateDefault();
    double Area();
}

public readonly record struct Square(double Side) : IShape<Square>
{
    public static string Name => "Square";
    public static Square CreateDefault() => new(1);
    public double Area() => Side * Side;
}

public readonly record struct Circle(double Radius) : IShape<Circle>
{
    public static string Name => "Circle";
    public static Circle CreateDefault() => new(1);
    public double Area() => Math.PI * Radius * Radius;
}

public static class ShapeFactory
{
    // Calls static members through the type parameter - impossible with abstract classes
    public static string Describe<T>() where T : IShape<T>
    {
        T shape = T.CreateDefault();
        return $"Default {T.Name} has area {shape.Area():F2}";
    }
}

// ShapeFactory.Describe<Circle>() -> "Default Circle has area 3.14"
```

## SOLID & Design Patterns

### Q: Explain the SOLID principles with examples.
difficulty: Medium
tags: solid, design, dependency-injection, architecture
id: solid-principles

#### Definition
SOLID is a set of five object-oriented design principles that make code easier to maintain, test and extend.
Single Responsibility: a class should have one reason to change.
Open/Closed: software entities should be open for extension but closed for modification.
Liskov Substitution: subtypes must be usable wherever their base type is expected without breaking correctness.
Interface Segregation: clients should not be forced to depend on members they do not use.
Dependency Inversion: high-level modules should depend on abstractions, not on low-level concrete implementations.
The principles were popularised by Robert C. Martin and underpin patterns like dependency injection and clean architecture.

#### Answer
I'd explain each principle with **the smell it fixes**, because that shows I've applied them rather than memorised them.

| Principle | Smell it fixes | Typical .NET fix |
|---|---|---|
| **S**RP | "God" service with validation, DB, email and PDF code | Split into focused classes / MediatR handlers |
| **O**CP | Growing `switch` on a type or enum | Strategy pattern, register implementations in DI |
| **L**SP | Subclass throws `NotSupportedException` or weakens guarantees | Rethink hierarchy, use separate interfaces |
| **I**SP | Interface with 20 members, mocks full of `throw` | Smaller role interfaces (`IReader`, `IWriter`) |
| **D**IP | `new SqlRepository()` inside business logic | Constructor injection of `IRepository` |

**Key points**
- **SRP** is about *reasons to change* (actors), not "one method per class".
- **OCP** in .NET is usually achieved with DI: add a new `IDiscountRule` implementation instead of editing existing code.
- **LSP**'s classic example is `Square : Rectangle`; in .NET, `ReadOnlyCollection<T>` implementing `IList<T>.Add` by throwing is a real-world violation.
- **DIP** is a principle; **dependency injection** is the technique and the ASP.NET Core container is the tool.

**Real-world usage:** in my last projects, applying DIP and ISP made unit testing straightforward (mock a small interface), and OCP via strategy registration let us add new payment providers without touching the checkout code.

**Pitfalls / follow-ups**
- Over-applying SOLID leads to an explosion of one-line interfaces; I apply it where change is likely.
- "Is DIP the same as IoC?" IoC is the broader idea (the framework calls you); DIP is about the direction of dependencies.
- Be ready for "show me a violation in code and refactor it".

#### Code
```csharp title="Before: one class violating SRP, OCP and DIP"
public class OrderService
{
    public void PlaceOrder(Order order)
    {
        // Validation, pricing, persistence and email all in one place (SRP)
        if (order.Lines.Count == 0) throw new InvalidOperationException("Empty order");

        // Every new customer type means editing this switch (OCP)
        order.Discount = order.CustomerType switch
        {
            "Gold"   => order.Total * 0.10m,
            "Silver" => order.Total * 0.05m,
            _        => 0m
        };

        // Concrete dependencies created inline - impossible to unit test (DIP)
        var repo = new SqlOrderRepository("Server=prod;...");
        repo.Save(order);
        new SmtpEmailSender().Send(order.CustomerEmail, "Order confirmed");
    }
}
```

```csharp title="After: small abstractions injected via DI"
public interface IDiscountRule                    // OCP: add rules, don't edit code
{
    bool AppliesTo(Order order);
    decimal Calculate(Order order);
}

public sealed class GoldDiscount : IDiscountRule
{
    public bool AppliesTo(Order o) => o.CustomerType == "Gold";
    public decimal Calculate(Order o) => o.Total * 0.10m;
}

public interface IOrderRepository { Task SaveAsync(Order order, CancellationToken ct); } // ISP
public interface IEmailSender { Task SendAsync(string to, string body, CancellationToken ct); }

// SRP: orchestration only. DIP: depends on abstractions.
public sealed class PlaceOrderHandler(
    IEnumerable<IDiscountRule> rules,
    IOrderRepository repository,
    IEmailSender email)
{
    public async Task HandleAsync(Order order, CancellationToken ct)
    {
        order.Discount = rules.FirstOrDefault(r => r.AppliesTo(order))?.Calculate(order) ?? 0m;
        await repository.SaveAsync(order, ct);
        await email.SendAsync(order.CustomerEmail, "Order confirmed", ct);
    }
}

// Program.cs
// builder.Services.AddScoped<IDiscountRule, GoldDiscount>();
// builder.Services.AddScoped<IOrderRepository, EfOrderRepository>();
// builder.Services.AddScoped<PlaceOrderHandler>();
```

### Q: Which design patterns do you use most in .NET applications?
difficulty: Hard
tags: design-patterns, design, dependency-injection, architecture
id: common-design-patterns

#### Definition
Design patterns are reusable, named solutions to recurring software design problems.
The Gang of Four grouped them into creational, structural and behavioural patterns.
Creational patterns (Factory, Builder, Singleton) control how objects are created.
Structural patterns (Adapter, Decorator, Facade) control how objects are composed.
Behavioural patterns (Strategy, Observer, Mediator, Chain of Responsibility) control how objects interact and share responsibility.
Modern .NET already embeds many patterns: DI is a factory and lifetime manager, middleware is a chain of responsibility, and events implement observer.
Patterns are a shared vocabulary for design discussions, not goals in themselves.

#### Answer
In my experience the best answer names **a handful of patterns I've actually used, where .NET uses them, and the trade-off**, rather than reciting all 23.

**Patterns I use most**

| Pattern | Type | Where I've used it / where .NET uses it |
|---|---|---|
| Strategy | Behavioural | Pricing/discount rules, payment providers resolved from DI |
| Decorator | Structural | Caching or retry around a repository, `DelegatingHandler` for `HttpClient` |
| Factory | Creational | `IHttpClientFactory`, creating handlers by message type |
| Builder | Creational | `WebApplication.CreateBuilder`, test data builders |
| Mediator | Behavioural | MediatR command/query handlers in CQRS |
| Chain of Responsibility | Behavioural | ASP.NET Core middleware pipeline |
| Observer | Behavioural | C# events, `IObservable<T>`, domain events |
| Repository / Unit of Work | Enterprise | EF Core's `DbSet<T>` and `DbContext` already implement them |

**Key points**
- **Singleton** is usually expressed as a DI lifetime (`AddSingleton`) instead of a static `Instance`, which keeps it testable.
- **Decorator** is my favourite for cross-cutting concerns: add caching without touching the original class (OCP).
- Many patterns exist to satisfy SOLID: Strategy for OCP, Adapter for DIP across third-party SDKs.

**Pitfalls / follow-ups**
- Wrapping EF Core in a generic repository often adds abstraction without value; I only add one when it hides real query logic.
- Pattern overuse ("AbstractFactoryFactory") increases complexity; I introduce a pattern when a second variation actually appears.
- "How would you implement a thread-safe singleton?" `Lazy<T>` or, better, a DI singleton.
- "Difference between Decorator and Proxy?" Decorator adds behaviour; Proxy controls access (lazy loading, remoting).

#### Code
```csharp title="Decorator: adding caching without changing the repository"
public interface IProductRepository
{
    Task<Product?> GetByIdAsync(int id, CancellationToken ct);
}

public sealed class EfProductRepository(AppDbContext db) : IProductRepository
{
    public Task<Product?> GetByIdAsync(int id, CancellationToken ct) =>
        db.Products.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct);
}

// Same interface, wraps the real implementation and adds caching
public sealed class CachedProductRepository(
    IProductRepository inner, HybridCache cache) : IProductRepository
{
    public async Task<Product?> GetByIdAsync(int id, CancellationToken ct) =>
        await cache.GetOrCreateAsync(
            $"product:{id}",
            async token => await inner.GetByIdAsync(id, token),
            cancellationToken: ct);
}

// Program.cs - wire the decorator manually (or use Scrutor's .Decorate<>())
// builder.Services.AddHybridCache();
// builder.Services.AddScoped<EfProductRepository>();
// builder.Services.AddScoped<IProductRepository>(sp =>
//     new CachedProductRepository(
//         sp.GetRequiredService<EfProductRepository>(),
//         sp.GetRequiredService<HybridCache>()));
```

```csharp title="Strategy resolved with keyed services (.NET 8)"
public interface IPaymentProvider
{
    Task<string> ChargeAsync(decimal amount, CancellationToken ct);
}

public sealed class StripeProvider : IPaymentProvider
{
    public Task<string> ChargeAsync(decimal amount, CancellationToken ct) =>
        Task.FromResult($"stripe_{Guid.NewGuid():N}");
}

public sealed class PayPalProvider : IPaymentProvider
{
    public Task<string> ChargeAsync(decimal amount, CancellationToken ct) =>
        Task.FromResult($"paypal_{Guid.NewGuid():N}");
}

public sealed class CheckoutService(IServiceProvider services)
{
    // The strategy is chosen at runtime by key; adding a provider needs no code change here
    public Task<string> PayAsync(string provider, decimal amount, CancellationToken ct)
    {
        var strategy = services.GetRequiredKeyedService<IPaymentProvider>(provider);
        return strategy.ChargeAsync(amount, ct);
    }
}

// Program.cs
// builder.Services.AddKeyedScoped<IPaymentProvider, StripeProvider>("stripe");
// builder.Services.AddKeyedScoped<IPaymentProvider, PayPalProvider>("paypal");
// builder.Services.AddScoped<CheckoutService>();
```
