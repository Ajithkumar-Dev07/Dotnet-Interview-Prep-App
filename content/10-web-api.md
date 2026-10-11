---
title: Web API
description: Building secure, versioned HTTP APIs with ASP.NET Core - middleware, DI, JWT and error handling
icon: "API"
color: "#4f46e5"
---

## Building APIs

### Q: What are the dependency injection service lifetimes in ASP.NET Core and when do you use each?
difficulty: Medium
tags: dependency-injection, api, architecture
id: di-service-lifetimes

#### Definition
ASP.NET Core has a built-in dependency injection container that supports three service lifetimes.
A **Transient** service gets a new instance every time it is resolved.
A **Scoped** service gets one instance per scope, which in a web app means one per HTTP request.
A **Singleton** service gets one instance for the whole application lifetime, shared by all requests and threads.
The lifetime is chosen when registering with `AddTransient`, `AddScoped` or `AddSingleton`.
.NET 8 added keyed services, which let you register several implementations under different keys.
The container disposes the `IDisposable` instances it created when their scope or the application ends.
Choosing the wrong lifetime can cause captive dependencies, thread-safety bugs and memory leaks.

#### Answer
I'd explain it with a table and then the bug everyone hits:

| Lifetime | Instance per | Typical examples |
|---|---|---|
| Transient | Every resolution | Lightweight stateless helpers, validators |
| Scoped | HTTP request | `DbContext`, unit of work, current-user context |
| Singleton | Application | Configuration, caches, `HttpClient` handlers, `ServiceBusClient` |

**The captive dependency problem:** if a singleton depends on a scoped service, the scoped instance is captured and lives forever. In my experience this shows up as a `DbContext` shared across threads, which throws "A second operation was started on this context". In Development, ASP.NET Core enables **scope validation**, which throws at startup or resolution when this happens.

Rules I follow:
- A service should only depend on services with the **same or longer** lifetime.
- Singletons must be **thread-safe**.
- In a singleton or `BackgroundService` that needs scoped services, I create a scope with `IServiceScopeFactory.CreateScope()`.
- I use `IHttpClientFactory` or a typed client instead of `new HttpClient()` per call, which avoids socket exhaustion.

**Real-world:** `DbContext` is scoped via `AddDbContext`. Repositories are scoped too. Message clients such as `ServiceBusClient` are singletons because they are expensive and thread-safe.

**Follow-ups:**
- "Why not make everything singleton?" Shared state causes concurrency bugs.
- "What are keyed services?" They use `AddKeyedScoped<IPayment, StripePayment>("stripe")` together with `[FromKeyedServices("stripe")]`.

#### Code
```csharp title="Lifetimes, keyed services and safe scoped access from a singleton"
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>           // Scoped by default
    o.UseSqlServer(builder.Configuration.GetConnectionString("Db")));
builder.Services.AddScoped<IOrderRepository, OrderRepository>();
builder.Services.AddTransient<IPriceCalculator, PriceCalculator>();
builder.Services.AddSingleton(TimeProvider.System);

// .NET 8+ keyed services
builder.Services.AddKeyedScoped<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedScoped<IPaymentGateway, PayPalGateway>("paypal");

builder.Services.AddHostedService<OutboxPublisher>();

// Background service is a singleton: never inject DbContext directly!
public sealed class OutboxPublisher(IServiceScopeFactory scopes, ILogger<OutboxPublisher> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var scope = scopes.CreateAsyncScope();   // new scope per iteration
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var pending = await db.OutboxMessages.Where(m => !m.Sent).Take(50).ToListAsync(ct);
            log.LogInformation("Publishing {Count} messages", pending.Count);
            // ... publish + mark sent
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }
}
```

### Q: How do you implement API versioning in ASP.NET Core Web API?
difficulty: Medium
tags: api, versioning, routing, http
id: web-api-versioning

#### Definition
API versioning lets an API change without breaking existing clients.
Several versions of an endpoint can be exposed side by side.
In ASP.NET Core it is usually implemented with the `Asp.Versioning.Mvc` package, or `Asp.Versioning.Http` for Minimal APIs.
This package replaced the older `Microsoft.AspNetCore.Mvc.Versioning` package.
Clients can request a version through the URL segment, the query string, a header or the media type.
Controllers and actions declare the versions they support with `[ApiVersion]`, and `MapToApiVersion` maps actions to specific versions.
Old versions can be marked deprecated, and the package reports supported and deprecated versions in response headers.

#### Answer
I'd start with **when** to version: only for **breaking changes**, such as removing or renaming fields, changing types or changing semantics. Adding optional fields is not breaking.

| Strategy | Example | Pros | Cons |
|---|---|---|---|
| URL segment | `/api/v2/orders` | Visible, cache-friendly, easy in Swagger | Not "pure" REST (the URI should identify the resource) |
| Query string | `?api-version=2.0` | Easy default | Easy to forget, harder to cache |
| Header | `X-Api-Version: 2.0` | Clean URLs | Invisible, harder to test in a browser |
| Media type | `Accept: application/json;v=2` | Most RESTful | Complex for clients |

In my experience, **URL segment versioning** is the most practical for public APIs. Header versioning suits internal APIs behind a gateway.

Key settings:
- `DefaultApiVersion` together with `AssumeDefaultVersionWhenUnspecified` lets old clients keep working.
- `ReportApiVersions = true` adds the `api-supported-versions` and `api-deprecated-versions` headers.
- `AddApiExplorer` with `GroupNameFormat = "'v'VVV"` produces one Swagger document per version.

**Pitfalls:**
- Copy-pasting whole controllers per version. I share the service layer and version only the contract (DTOs and controllers).
- Keeping v1 forever. Publish a deprecation policy and use `Sunset` headers.

**Follow-up:** "How do you version Minimal APIs?" I'd use `app.NewApiVersionSet()` with `.WithApiVersionSet(...)` on route groups.

#### Code
```csharp title="Asp.Versioning with URL segment + header readers"
// dotnet add package Asp.Versioning.Mvc.ApiExplorer
builder.Services.AddControllers();
builder.Services.AddApiVersioning(options =>
{
    options.DefaultApiVersion = new ApiVersion(1, 0);
    options.AssumeDefaultVersionWhenUnspecified = true;
    options.ReportApiVersions = true;                       // api-supported-versions header
    options.ApiVersionReader = ApiVersionReader.Combine(
        new UrlSegmentApiVersionReader(),
        new HeaderApiVersionReader("X-Api-Version"));
})
.AddMvc()
.AddApiExplorer(options =>
{
    options.GroupNameFormat = "'v'VVV";                     // v1, v2 -> Swagger docs
    options.SubstituteApiVersionInUrl = true;
});

[ApiController]
[Route("api/v{version:apiVersion}/orders")]
[ApiVersion("1.0", Deprecated = true)]
[ApiVersion("2.0")]
public class OrdersController(IOrderService orders) : ControllerBase
{
    [HttpGet("{id:int}"), MapToApiVersion("1.0")]
    public async Task<ActionResult<OrderV1Dto>> GetV1(int id)
        => Ok(OrderV1Dto.From(await orders.GetAsync(id)));

    [HttpGet("{id:int}"), MapToApiVersion("2.0")]
    public async Task<ActionResult<OrderV2Dto>> GetV2(int id)  // v2 adds currency + line items
        => Ok(OrderV2Dto.From(await orders.GetAsync(id)));
}
```

## Security & Middleware

### Q: How do you secure an ASP.NET Core Web API with JWT bearer authentication?
difficulty: Hard
tags: security, jwt, authentication, api
id: jwt-authentication

#### Definition
JWT (JSON Web Token) bearer authentication is a stateless scheme in which the client sends a signed token in the `Authorization: Bearer <token>` header.
A JWT has three Base64Url-encoded parts: header, payload (claims) and signature.
The API validates the signature, issuer, audience and lifetime on every request without a server-side session.
In ASP.NET Core this is configured with `AddAuthentication().AddJwtBearer()` from the `Microsoft.AspNetCore.Authentication.JwtBearer` package.
The validated claims populate `HttpContext.User`, which authorization policies and `[Authorize]` then evaluate.
Tokens are normally issued by an identity provider such as Microsoft Entra ID, Auth0 or Duende IdentityServer.
Because JWTs are only signed, not encrypted, they must never contain secrets.

#### Answer
I'd describe the flow first: the client authenticates with the identity provider and receives an access token, then calls the API with the bearer header. The JWT middleware validates the token and builds a `ClaimsPrincipal`, and authorization checks policies.

Key points:
- **Validation:** check the issuer, audience, lifetime and signing key. With an IdP, I set `Authority`, and the middleware downloads signing keys from the OIDC discovery document and rotates them automatically.
- **Short-lived access tokens** (5–60 minutes) plus **refresh tokens**. JWTs cannot easily be revoked, so short expiry is the main mitigation.
- **Authorization:** I prefer **policy-based** authorization (`RequireClaim("scope", "orders.write")`, roles, custom requirements) over hard-coded role strings.
- **Transport:** HTTPS only.

| | JWT (stateless) | Cookie/session |
|---|---|---|
| Server state | None | Session store |
| Revocation | Hard (short expiry, deny-list) | Easy |
| Best for | APIs, mobile, service-to-service | Server-rendered web apps |
| CSRF risk | Low (header-based) | Needs anti-forgery |

**Pitfalls I've seen:**
- Middleware order: `UseAuthentication` must come before `UseAuthorization`.
- Symmetric keys hard-coded in `appsettings.json`. These belong in Key Vault, and asymmetric keys (RS256) are better.
- Not validating the audience, which lets tokens issued for another API be accepted.
- A default `ClockSkew` of 5 minutes, which makes tokens appear to "expire late".

**Follow-ups:** "Where do you store tokens in a SPA?" Keep them in memory, or use the BFF pattern with HttpOnly cookies, not localStorage. "How would you revoke a token?" Use short expiry plus refresh token rotation.

#### Code
```csharp title="JWT bearer setup with policies (.NET 8/9)"
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // Using an identity provider: keys come from /.well-known/openid-configuration
        options.Authority = builder.Configuration["Auth:Authority"]; // e.g. https://login.microsoftonline.com/{tenant}/v2.0
        options.Audience  = builder.Configuration["Auth:Audience"];   // e.g. api://orders-api
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(1)                      // default is 5 min
        };
    });

builder.Services.AddAuthorizationBuilder()
    .AddPolicy("orders.write", p => p.RequireClaim("scp", "orders.write"))
    .AddPolicy("admin", p => p.RequireRole("Admin"));

var app = builder.Build();
app.UseAuthentication();   // builds HttpContext.User from the token
app.UseAuthorization();    // evaluates [Authorize] / policies

app.MapPost("/orders", (CreateOrder cmd, ClaimsPrincipal user) =>
        Results.Created($"/orders/{Guid.NewGuid()}", cmd))
   .RequireAuthorization("orders.write");
```

```http title="Calling the API with a bearer token"
POST /orders HTTP/1.1
Host: api.contoso.com
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...
Content-Type: application/json

{ "productId": 42, "quantity": 2 }
```

### Q: How do you implement global exception handling in ASP.NET Core Web API?
difficulty: Medium
tags: middleware, error-handling, api, problem-details
id: global-exception-handling

#### Definition
Global exception handling catches unhandled exceptions in one central place.
That place turns each exception into a consistent HTTP error response, so try/catch blocks are not scattered across every controller.
In .NET 8 and later, the recommended approach is to implement `IExceptionHandler` and register it with `AddExceptionHandler<T>()` and `UseExceptionHandler()`.
Errors should be returned as RFC 9457 Problem Details (`application/problem+json`), enabled with `AddProblemDetails()`.
Alternatives include custom middleware wrapping `next()` in try/catch, and MVC exception filters.
Exception filters only cover controller actions, not the rest of the pipeline.
The handler should log the exception, map known exception types to status codes, and avoid leaking stack traces in production.

#### Answer
In my experience the modern answer is **`IExceptionHandler` + Problem Details**.

- `IExceptionHandler.TryHandleAsync` returns `true` if it handled the exception. Several handlers can be chained in registration order, which lets me map validation errors to 400, not-found to 404 and everything else to 500.
- `AddProblemDetails()` makes framework errors (404s, model validation, `Results.Problem`) use the same format. `UseStatusCodePages()` covers empty error responses.
- I add a `traceId` to the response so support can correlate it with logs or Application Insights.

| Approach | Covers | Notes |
|---|---|---|
| `IExceptionHandler` (.NET 8+) | Whole pipeline after it | Recommended, DI-friendly, testable |
| Custom middleware | Whole pipeline after it | Fine, but more boilerplate |
| Exception filter | MVC actions only | Misses middleware and result errors |
| `UseDeveloperExceptionPage` | Dev only | Never in production |

**Pitfalls:**
- Using exceptions for **control flow**, such as throwing on every validation failure. Exceptions are expensive, so returning a `Result` type or `ValidationProblem` is often better.
- Leaking `exception.Message` to clients in production, which can expose SQL or internal details.
- Registering `UseExceptionHandler` too late. It must be near the **top** of the pipeline.
- Trying to write a response after it has started (`Response.HasStarted`).

**Follow-up:** "How does middleware order affect this?" Only middleware registered *after* `UseExceptionHandler` is protected, because each middleware wraps the next.

#### Code
```csharp title="IExceptionHandler with Problem Details (.NET 8/9)"
public sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetails) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext http, Exception ex, CancellationToken ct)
    {
        var (status, title) = ex switch
        {
            NotFoundException      => (StatusCodes.Status404NotFound, "Resource not found"),
            ValidationException    => (StatusCodes.Status400BadRequest, "Validation failed"),
            UnauthorizedAccessException => (StatusCodes.Status403Forbidden, "Forbidden"),
            _                      => (StatusCodes.Status500InternalServerError, "Unexpected error")
        };

        if (status == 500) logger.LogError(ex, "Unhandled exception");
        else logger.LogWarning(ex, "Handled {Status}", status);

        http.Response.StatusCode = status;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = http,
            Exception = ex,
            ProblemDetails = { Title = title, Status = status,
                Detail = status == 500 ? null : ex.Message }       // never leak 500 details
        });
    }
}

// Program.cs
builder.Services.AddProblemDetails(o => o.CustomizeProblemDetails = c =>
    c.ProblemDetails.Extensions["traceId"] = c.HttpContext.TraceIdentifier);
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

var app = builder.Build();
app.UseExceptionHandler();     // first in the pipeline
app.UseStatusCodePages();
```
