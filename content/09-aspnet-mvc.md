---
title: ASP.NET MVC
description: Model-View-Controller web apps with ASP.NET Core MVC - lifecycle, routing, state passing, filters and model binding
icon: "MVC"
color: "#dc2626"
---

## MVC Fundamentals

### Q: Explain the request lifecycle of an ASP.NET Core MVC application.
difficulty: Medium
tags: mvc, middleware, routing, pipeline
id: mvc-request-lifecycle

#### Definition
The MVC request lifecycle is the sequence of steps from an incoming HTTP request to the rendered response.
Kestrel receives the request and builds an `HttpContext` for it.
The request then flows through the middleware pipeline configured in `Program.cs`.
Routing middleware matches the URL to an endpoint, such as a controller action.
The MVC invoker creates the controller through dependency injection and runs model binding and validation.
Filters (authorization, resource, action, exception, result) wrap the action execution.
The action returns an `IActionResult`, such as a `ViewResult`, which the view engine renders.
The response then travels back out through the middleware pipeline to the client.

#### Answer
I'd explain it as two nested pipelines: the **middleware pipeline** (app-wide) and the **MVC filter pipeline** (per action).

- **Hosting:** Kestrel (optionally behind IIS or Nginx) accepts the connection and creates `HttpContext`.
- **Middleware:** exception handling, HTTPS redirection, static files, `UseRouting`, `UseAuthentication`, `UseAuthorization`. Order matters: each one can short-circuit.
- **Endpoint selection:** routing picks the matching controller action from conventional or attribute routes.
- **Controller activation:** the controller is created per request and its constructor dependencies are resolved from DI.
- **Filters and binding:** authorization filters run first, then resource filters, then model binding and validation, then action filters around the action.
- **Result execution:** result filters wrap `ExecuteResultAsync`. For a `ViewResult`, Razor finds the view, applies the layout and writes HTML.

| Stage | Scope | Typical use |
|---|---|---|
| Middleware | Every request | Logging, auth, CORS, static files |
| Filters | MVC actions only | Validation, auditing, caching |

In my experience, most real bugs here come from **middleware order**. Common examples are calling `UseAuthorization` before `UseRouting`, or putting static files after auth so that CSS needs a login.

**Likely follow-ups:** "Where would you put cross-cutting logic: middleware or a filter?" I'd use middleware when the logic needs no MVC context and a filter when it needs action arguments or `ModelState`. Another one: "When is the view actually rendered?" It is rendered during result execution, after the action has returned.

#### Code
```csharp title="Program.cs - MVC pipeline order (.NET 8/9)"
var builder = WebApplication.CreateBuilder(args);

// Register MVC services: controllers, views, filters, model binders
builder.Services.AddControllersWithViews(options =>
{
    options.Filters.Add<AuditActionFilter>(); // global action filter
});

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error"); // outermost: catches everything below
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();      // short-circuits for /css, /js before auth runs
app.UseRouting();          // selects the endpoint
app.UseAuthentication();   // who are you?
app.UseAuthorization();    // are you allowed? (needs the selected endpoint)

// Conventional route: /{controller}/{action}/{id?}
app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

app.Run();
```

### Q: What is the difference between ViewData, ViewBag and TempData?
difficulty: Easy
tags: mvc, state-management, views
id: viewdata-viewbag-tempdata

#### Definition
ViewData, ViewBag and TempData are mechanisms for passing data from a controller to a view in ASP.NET MVC.
`ViewData` is a `ViewDataDictionary` of string keys to object values that lives for the current request only.
`ViewBag` is a `dynamic` wrapper over the same ViewData dictionary, so it offers property syntax without casting.
Because both use the same storage, `ViewBag.Title` and `ViewData["Title"]` refer to the same value.
`TempData` keeps data until it is read, so the data survives a redirect to the next request.
It is backed by a cookie provider by default, or by session state if configured.
It is commonly used for the Post-Redirect-Get pattern, for example to show a flash success message.

#### Answer
In my experience the cleanest answer starts with **lifetime** and **typing**:

| Feature | ViewData | ViewBag | TempData |
|---|---|---|---|
| Type | `ViewDataDictionary` | `dynamic` | `ITempDataDictionary` |
| Lifetime | Current request | Current request | Until read (survives redirect) |
| Casting needed | Yes | No | Yes |
| Compile-time safety | No | No | No |
| Storage | In memory | Same as ViewData | Cookie (default) or Session |

Key points I'd mention:
- **Prefer strongly-typed view models.** ViewData and ViewBag are for small extras like page titles or dropdown lists, not core data.
- **TempData semantics:** reading a value marks it for deletion at the end of the request. `Peek()` reads without marking, and `Keep()` retains values for one more request.
- **Real-world usage:** after a successful POST I set `TempData["Success"]` and redirect, and the layout shows the alert. This avoids duplicate form submits on browser refresh.

**Common pitfalls:**
- Storing complex objects in TempData. The cookie provider serialises with `System.Text.Json`, so only simple types work out of the box. You must serialise complex objects to JSON yourself.
- Large TempData cookies can exceed browser cookie size limits.
- ViewBag typos fail silently at runtime and show nothing.

**Follow-up:** "How do you pass data to a layout or partial?" I'd use ViewData for simple values, or a view component for anything with logic.

#### Code
```csharp title="Post-Redirect-Get with TempData and a typed view model"
public class ProductsController(IProductService service) : Controller
{
    [HttpGet]
    public async Task<IActionResult> Create()
    {
        ViewData["Title"] = "New product";              // dictionary syntax
        ViewBag.Categories = await service.GetCategoriesAsync(); // dynamic, same store
        return View(new ProductCreateVm());             // strongly-typed model preferred
    }

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(ProductCreateVm vm)
    {
        if (!ModelState.IsValid)
        {
            ViewBag.Categories = await service.GetCategoriesAsync();
            return View(vm);                            // redisplay with errors
        }

        var id = await service.CreateAsync(vm);
        TempData["Success"] = $"Product {id} created."; // survives the redirect
        return RedirectToAction(nameof(Details), new { id });
    }

    public async Task<IActionResult> Details(int id)
        => View(await service.GetAsync(id));
}

// _Layout.cshtml:
// @if (TempData["Success"] is string msg) { <div class="alert alert-success">@msg</div> }
```

## Filters & Pipeline

### Q: What are filters in ASP.NET Core MVC and in what order do they run?
difficulty: Medium
tags: mvc, filters, middleware, pipeline
id: mvc-filters-order

#### Definition
Filters are components that run code before or after specific stages of MVC action processing.
They are used for cross-cutting concerns such as authorization, caching, logging, validation and error handling.
ASP.NET Core defines five filter types: authorization, resource, action, exception and result filters.
They execute in that order and form a nested "Russian doll" around the action.
Filters can be applied globally, at the controller level, or on a single action.
For a given filter type, global filters wrap controller filters, which wrap action filters, unless the `Order` property is changed.
Unlike middleware, filters have access to MVC context such as action arguments, `ModelState` and the action result.

#### Answer
I'd walk through the order with what each filter is good for:

1. **Authorization filters** (`IAuthorizationFilter`) run first and can short-circuit with 401 or 403.
2. **Resource filters** (`IResourceFilter`) run before model binding. They are good for response caching or short-circuiting expensive work.
3. **Model binding and validation** happen next. This is not a filter, but it is a stage in the pipeline.
4. **Action filters** (`IActionFilter` / `IAsyncActionFilter`) wrap the action. They can read and modify arguments and inspect `ModelState`.
5. **Exception filters** handle unhandled exceptions from the action or the action filters.
6. **Result filters** wrap the result execution, for example to add response headers.

| | Middleware | Filter |
|---|---|---|
| Scope | Every request | MVC/Razor endpoints only |
| Access to `ModelState`/arguments | No | Yes |
| Registration | `app.Use...` | `[Attribute]`, global options |

**Real-world usage:** In my experience, a global validation action filter returns a consistent `ValidationProblemDetails`, and an auditing filter logs the user and action name.

**Pitfalls and follow-ups:**
- Filters that need DI services should use `[ServiceFilter(typeof(X))]` or `[TypeFilter]`, or be registered globally by type. Attributes cannot take constructor dependencies directly.
- Exception filters **do not** catch exceptions thrown in result execution or in middleware. For global error handling I prefer `UseExceptionHandler` or `IExceptionHandler`.
- Prefer the async interfaces, and don't implement both the sync and async versions on one filter.

#### Code
```csharp title="Async action filter with DI, applied via ServiceFilter"
public sealed class AuditActionFilter(ILogger<AuditActionFilter> logger) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        // BEFORE the action: arguments are already bound and validated
        var user = context.HttpContext.User.Identity?.Name ?? "anonymous";
        var action = context.ActionDescriptor.DisplayName;

        if (!context.ModelState.IsValid)
        {
            context.Result = new BadRequestObjectResult(context.ModelState); // short-circuit
            return;
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var executed = await next();   // run the action (and inner filters)
        sw.Stop();

        // AFTER the action
        logger.LogInformation("{User} ran {Action} in {Elapsed} ms (exception: {HasEx})",
            user, action, sw.ElapsedMilliseconds, executed.Exception is not null);
    }
}

// Registration
builder.Services.AddScoped<AuditActionFilter>();

[ServiceFilter(typeof(AuditActionFilter))]
public class OrdersController : Controller { /* ... */ }
```

### Q: How does model binding work, and how do you validate bound models?
difficulty: Hard
tags: mvc, model-binding, validation, security
id: mvc-model-binding

#### Definition
Model binding maps data from an HTTP request to action method parameters and properties.
Value providers supply data from form fields, route values, the query string and uploaded files.
Input formatters such as `System.Text.Json` read the request body for `[FromBody]` parameters.
The binder converts strings to the target types and builds complex objects recursively by property name.
Attributes such as `[FromRoute]`, `[FromQuery]`, `[FromForm]`, `[FromHeader]`, `[FromBody]` and `[FromServices]` control the source of each parameter.
After binding, validation runs Data Annotations or `IValidatableObject` rules and records errors in `ModelState`.
Binding and validation errors never throw exceptions; the action must check `ModelState.IsValid`.
The only exception is `[ApiController]`, which returns a 400 response automatically.

#### Answer
I'd explain it as **sources, then conversion, then validation**.

- **Sources:** For MVC controllers, binding checks form values, route data and the query string in that order. In `[ApiController]` controllers, complex types are inferred as `[FromBody]` and simple types as route or query values.
- **Conversion:** It uses type converters and is culture-aware for form and route data. For complex objects, the binder matches `prefix.PropertyName`, which also covers collections such as `Items[0].Qty`.
- **Validation:** Data Annotations (`[Required]`, `[Range]`, `[StringLength]`) and `IValidatableObject` add errors to `ModelState`. Many teams use FluentValidation for richer rules.

**Security pitfall: over-posting (mass assignment).** In my experience this is a classic follow-up. If you bind directly to an EF entity, an attacker can post `IsAdmin=true`. The fixes are:
- Bind to a **dedicated view model/DTO** (my preferred fix).
- Use `[Bind("Name,Price")]`, which is fragile.
- Use `TryUpdateModelAsync` with an explicit property list.

| Attribute | Source |
|---|---|
| `[FromRoute]` | `/orders/{id}` |
| `[FromQuery]` | `?page=2` |
| `[FromBody]` | JSON body (only one per action) |
| `[FromForm]` | form fields and `IFormFile` |
| `[FromServices]` | DI container |

**Other gotchas:**
- A missing value for a non-nullable `int` silently becomes `0` unless you add `[BindRequired]`.
- Only one `[FromBody]` parameter is allowed, because the body stream can only be read once.
- Custom binders (`IModelBinder`) are useful for things like comma-separated ID lists.

#### Code
```csharp title="DTO binding with validation to prevent over-posting"
public sealed class UpdateProfileVm : IValidatableObject
{
    [Required, StringLength(100)]
    public string DisplayName { get; set; } = "";

    [EmailAddress]
    public string? Email { get; set; }

    [Range(typeof(DateOnly), "1900-01-01", "2100-01-01")]
    public DateOnly? BirthDate { get; set; }

    // Cross-field rule
    public IEnumerable<ValidationResult> Validate(ValidationContext ctx)
    {
        if (BirthDate > DateOnly.FromDateTime(DateTime.UtcNow))
            yield return new ValidationResult("Birth date cannot be in the future.", [nameof(BirthDate)]);
    }
}

public class ProfileController(AppDbContext db) : Controller
{
    [HttpPost("profile/{id:int}"), ValidateAntiForgeryToken]
    public async Task<IActionResult> Update([FromRoute] int id, UpdateProfileVm vm)
    {
        if (!ModelState.IsValid) return View(vm);          // errors shown via asp-validation-for

        var user = await db.Users.FindAsync(id);
        if (user is null) return NotFound();

        // Map only allowed fields - IsAdmin can never be over-posted
        user.DisplayName = vm.DisplayName;
        user.Email = vm.Email;
        user.BirthDate = vm.BirthDate;
        await db.SaveChangesAsync();
        return RedirectToAction("Index");
    }
}
```
### Q: What are Action Filters in ASP.NET Core MVC?
difficulty: Medium
tags: aspnet-core, mvc, action-filters, filters
id: action-filters

#### Definition
An Action Filter in ASP.NET Core MVC is a component that executes logic before and after a controller action method runs.
It implements the `IActionFilter` or `IAsyncActionFilter` interface.
It allows developers to execute reusable logic without duplicating code across multiple action methods.
The `OnActionExecuting` method runs before the action method executes.
The `OnActionExecuted` method runs after the action method executes.
The asynchronous equivalent uses `OnActionExecutionAsync` to handle asynchronous operations.
Action filters can be applied globally, at the controller level, or to individual action methods.
They are commonly used for logging, input validation, auditing, and measuring execution time.
They are part of the ASP.NET Core MVC filter pipeline and execute after authorization and resource filters.

#### Answer

**Short answer:** Action Filters in ASP.NET Core MVC allow me to execute reusable logic before and after a controller action method runs. I use them to handle cross-cutting concerns such as logging, execution-time measurement, and auditing without repeating the same code in every action.

**How it works / Key points**

- **Before execution:** `OnActionExecuting` runs immediately before the controller action method executes, allowing me to inspect action arguments or perform preliminary checks.
- **After execution:** `OnActionExecuted` runs after the action method finishes, allowing me to inspect the action result or exception information.
- **Asynchronous execution:** I use `IAsyncActionFilter` and `OnActionExecutionAsync` when the filter needs to perform asynchronous operations.
- **Application scope:** I can register a filter globally, apply it to an entire controller using an attribute, or apply it to a specific action method.
- **Custom filters:** I can create a reusable filter by implementing `IActionFilter` or inheriting from `ActionFilterAttribute`.
- **Execution order:** Authorization filters execute before resource filters, followed by action filters, and then result filters. Exception filters have their own exception-handling stage in the MVC pipeline.

**Comparison**

| Aspect | Action Filter | Middleware |
|---|---|---|
| Execution scope | MVC controller actions | HTTP request pipeline |
| Context | MVC action context | HTTP context |
| Typical use | Action logging and auditing | Global request logging and exception handling |
| MVC dependency | Yes | No |
| Access to action arguments | Yes | Not directly |

**Real-world usage:** In a banking application, I can use an Action Filter to log when an employee accesses a loan application, including the action name and execution duration. This helps with application monitoring and auditing. For sensitive banking operations, I would also implement proper authentication, authorization, and secure audit logging rather than relying on the filter alone.

**Common pitfalls**

- Using an Action Filter for logic that should run before MVC, such as middleware-level request processing.
- Forgetting to call `next()` in an asynchronous filter, which prevents the action from executing.
- Assuming an Action Filter replaces authorization or business validation.
- Logging sensitive information, such as passwords, access tokens, or complete financial details.

**Likely follow-up questions**

- **What are the types of filters in ASP.NET Core MVC?** Authorization, resource, action, exception, and result filters.
- **What is the difference between `IActionFilter` and `IAsyncActionFilter`?** The first uses synchronous callbacks, while the second supports asynchronous execution.
- **Can I stop an action from executing inside a filter?** Yes, I can set `ActionExecutingContext.Result` before the action runs.
- **What is the difference between an Action Filter and an Authorization Filter?** Authorization filters determine whether a request is authorized, while Action Filters wrap controller action execution.

#### Code

**Example 1: Creating a custom Action Filter**

```csharp title="Custom Action Filter"
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

public class LogActionFilter : IActionFilter
{
    private readonly ILogger<LogActionFilter> _logger;

    public LogActionFilter(ILogger<LogActionFilter> logger)
    {
        _logger = logger;
    }

    public void OnActionExecuting(ActionExecutingContext context)
    {
        // Runs before the controller action.
        _logger.LogInformation(
            "Starting action: {Action}",
            context.ActionDescriptor.DisplayName);
    }

    public void OnActionExecuted(ActionExecutedContext context)
    {
        // Runs after the controller action.
        _logger.LogInformation(
            "Completed action: {Action}",
            context.ActionDescriptor.DisplayName);
    }
}
```

**Example 2: Registering and applying the filter**

```csharp title="Register and Use Action Filter"
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);

// Register MVC and the custom filter.
builder.Services.AddScoped<LogActionFilter>();
builder.Services.AddControllersWithViews();

var app = builder.Build();

app.UseRouting();
app.UseAuthorization();

app.MapDefaultControllerRoute();
app.Run();

public class LoansController : Controller
{
    [ServiceFilter(typeof(LogActionFilter))]
    public IActionResult Details(int id)
    {
        // The filter runs before and after this action.
        return Content($"Loan ID: {id}");
    }
}
```

**Example 3: Action Filter execution flow**

```text title="Flow: Action Filter Pipeline"
[Browser Request]
       |
       v
[Middleware Pipeline]
       |
       v
[Routing and Authorization]
       |
       v
[Action Filter: Before]
       |
       v
[Controller Action]
       |
       v
[Action Filter: After]
       |
       v
[Result Execution]
       |
       v
[HTTP Response]
```
