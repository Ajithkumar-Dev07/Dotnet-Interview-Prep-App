---
title: Swagger / OpenAPI
description: Documenting ASP.NET Core APIs with OpenAPI - Swashbuckle, XML comments, JWT in Swagger UI, versioned docs and built-in OpenAPI
icon: "OAS"
color: "#65a30d"
---

## Setup

### Q: What are Swagger and OpenAPI, and how do you set up Swashbuckle in ASP.NET Core?
difficulty: Easy
tags: documentation, api, openapi, swagger
id: swagger-openapi-setup

#### Definition
**OpenAPI** is a vendor-neutral, machine-readable specification, in JSON or YAML, that describes an HTTP API.
It covers endpoints, parameters, request and response schemas, status codes and security schemes.
**Swagger** was the original name of the specification and is now the name of the SmartBear tooling around it, such as Swagger UI and Swagger Editor.
**Swashbuckle.AspNetCore** is a popular library that generates an OpenAPI document from ASP.NET Core endpoints.
It uses the ApiExplorer metadata to build the document.
It also hosts Swagger UI, an interactive page for exploring and testing the API.
The same document can generate client SDKs (NSwag, Kiota, OpenAPI Generator), drive contract tests and be imported into Azure API Management.

#### Answer
I'd first clarify the naming: **OpenAPI is the spec, Swagger is the tooling**. People often say "Swagger" for both.

Setup with Swashbuckle takes three steps:
- `AddEndpointsApiExplorer()`, which is needed for Minimal APIs. Controllers are discovered automatically.
- `AddSwaggerGen()` generates `/swagger/v1/swagger.json`.
- `UseSwagger()` + `UseSwaggerUI()` serve the document and the UI.

Making the document accurate:
- `[ProducesResponseType(typeof(OrderDto), 200)]` and `[ProducesResponseType(404)]`, or `TypedResults` / `.Produces<T>()` for Minimal APIs.
- `[Consumes]`/`[Produces]` for content types.
- Analyzers via `[ApiController]` conventions.

| Tool | Role |
|---|---|
| Swashbuckle | Generate doc + Swagger UI (most common) |
| NSwag | Generate doc + C#/TypeScript clients |
| Microsoft.AspNetCore.OpenApi | Built-in generator (.NET 9+) |
| Scalar / ReDoc | Alternative documentation UIs |

**Real-world:** In my experience, we expose Swagger UI only in Development or Staging. CI exports the `swagger.json` to generate a typed TypeScript client for the front end and to detect breaking contract changes.

**Pitfalls:**
- Exposing Swagger publicly in production when the API is internal, which reveals your attack surface.
- Undocumented responses, so clients only "see" 200.
- Duplicate schema IDs when two classes share a name in different namespaces. Fix this with `CustomSchemaIds(t => t.FullName)`.

**Follow-up:** "Why did the .NET 9 template drop Swashbuckle?" Microsoft moved to the built-in `Microsoft.AspNetCore.OpenApi` generator, and Swashbuckle remains a valid package you can add yourself.

#### Code
```csharp title="Swashbuckle setup with documented responses"
// dotnet add package Swashbuckle.AspNetCore
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();            // Minimal API discovery
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Orders API",
        Version = "v1",
        Description = "Create and track customer orders"
    });
    c.CustomSchemaIds(t => t.FullName);                 // avoid schema name clashes
});

var app = builder.Build();

if (!app.Environment.IsProduction())
{
    app.UseSwagger();                                   // /swagger/v1/swagger.json
    app.UseSwaggerUI(c =>
    {
        c.SwaggerEndpoint("/swagger/v1/swagger.json", "Orders API v1");
        c.RoutePrefix = "docs";                         // UI at /docs
    });
}

app.MapGet("/orders/{id:int}", async Task<Results<Ok<OrderDto>, NotFound>> (int id, IOrderService s) =>
        await s.FindAsync(id) is { } o ? TypedResults.Ok(o) : TypedResults.NotFound())
   .WithName("GetOrder")
   .WithSummary("Get an order by id")
   .WithTags("Orders");                                 // TypedResults => 200 + 404 documented

app.MapControllers();
app.Run();
```

### Q: How do you include XML comments in the Swagger documentation?
difficulty: Easy
tags: documentation, swagger, api
id: swagger-xml-comments

#### Definition
XML documentation comments (`///`) let you describe controllers, actions, parameters, models and responses directly in C# code.
When `GenerateDocumentationFile` is enabled in the `.csproj`, the compiler writes these comments to an XML file next to the assembly.
Swashbuckle reads that file through `IncludeXmlComments()`.
It maps `<summary>`, `<remarks>`, `<param>`, `<response code="...">` and `<example>` into the OpenAPI document.
The descriptions then appear in Swagger UI for every operation and schema property.
.NET 9's built-in OpenAPI does not read XML comments.
.NET 10 adds XML comment support for the built-in generator through a source generator.

#### Answer
In my experience, XML comments are the cheapest way to get a **self-documenting** API, because the docs live next to the code and are reviewed in the same PR.

Steps:
1. Set `<GenerateDocumentationFile>true</GenerateDocumentationFile>` in the csproj.
2. Suppress warning **CS1591** ("missing XML comment") with `<NoWarn>$(NoWarn);1591</NoWarn>`. Otherwise every public member without a comment raises a warning, and with warnings-as-errors the build breaks.
3. Call `IncludeXmlComments(path)` in `AddSwaggerGen`. If DTOs live in another project, I include that project's XML file too; this is a common gotcha.

What maps where:

| XML tag | OpenAPI field |
|---|---|
| `<summary>` | Operation/schema summary |
| `<remarks>` | Operation description (markdown allowed) |
| `<param name="id">` | Parameter description |
| `<response code="404">` | Response description |
| `<example>` on a property | Schema example |

**Tips:**
- Combine XML comments with `[ProducesResponseType]`. The attribute declares the response type and status code, and the XML gives the human-readable description.
- `IncludeXmlComments(path, includeControllerXmlComments: true)` also uses the controller `<summary>` as the tag description.
- Annotations (`Swashbuckle.AspNetCore.Annotations` with `[SwaggerOperation]`) are an alternative, but I find XML comments cleaner.

**Pitfalls:**
- The XML file is not copied in Docker or publish output when the path is hard-coded wrongly. I build the path from `AppContext.BaseDirectory`.
- Comments drift out of date, so treat them as code during review.

#### Code
```xml title="Orders.Api.csproj"
<PropertyGroup>
  <TargetFramework>net9.0</TargetFramework>
  <GenerateDocumentationFile>true</GenerateDocumentationFile>
  <NoWarn>$(NoWarn);1591</NoWarn> <!-- don't warn on every undocumented member -->
</PropertyGroup>
```

```csharp title="XML comments mapped into Swagger"
builder.Services.AddSwaggerGen(c =>
{
    var xml = Path.Combine(AppContext.BaseDirectory, $"{Assembly.GetExecutingAssembly().GetName().Name}.xml");
    c.IncludeXmlComments(xml, includeControllerXmlComments: true);
    // DTOs in a separate project? include its XML file too
    c.IncludeXmlComments(Path.Combine(AppContext.BaseDirectory, "Orders.Contracts.xml"));
});

/// <summary>Manage customer orders.</summary>
[ApiController, Route("api/orders")]
public class OrdersController(IOrderService orders) : ControllerBase
{
    /// <summary>Gets a single order.</summary>
    /// <remarks>Returns the order with its line items. Cancelled orders are included.</remarks>
    /// <param name="id">The order identifier.</param>
    /// <response code="200">The order was found.</response>
    /// <response code="404">No order exists with this id.</response>
    [HttpGet("{id:int}")]
    [ProducesResponseType<OrderDto>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<OrderDto>> Get(int id)
        => await orders.FindAsync(id) is { } o ? Ok(o) : NotFound();
}
```

## Customization

### Q: How do you enable JWT authentication in Swagger UI?
difficulty: Medium
tags: swagger, security, jwt, documentation
id: swagger-jwt-auth

#### Definition
To call protected endpoints from Swagger UI, the OpenAPI document must declare a **security scheme**.
For JWT this is usually an HTTP `bearer` scheme with `bearerFormat: JWT`.
The document also needs a **security requirement**, either globally or per operation, that references the scheme.
With both in place, Swagger UI shows an **Authorize** button where the user pastes a token.
After that, Swagger UI sends `Authorization: Bearer <token>` on every request.
In Swashbuckle this is done with `AddSecurityDefinition` and `AddSecurityRequirement`, or with an `IOperationFilter` that adds requirements only to `[Authorize]` endpoints.
For identity providers, an OAuth2 or OpenID Connect scheme with PKCE can let users sign in directly from the UI.

#### Answer
I'd explain the two parts: the **definition** says *how* to authenticate, and the **requirement** says *where* it applies.

Options:

| Scheme type | When I use it |
|---|---|
| `http` + `bearer` | Paste a token you obtained elsewhere (simplest) |
| `apiKey` in header | Legacy pattern: user must type `Bearer ` prefix manually |
| `oauth2` (auth code + PKCE) | Entra ID/Auth0: users log in inside Swagger UI |
| `openIdConnect` | Discovery URL-based, supported by newer UIs |

Key points:
- Use `SecuritySchemeType.Http` with `Scheme = "bearer"` so the UI adds the `Bearer ` prefix automatically. A common mistake is `ApiKey`, which forces users to type the prefix.
- A **global** requirement shows a padlock on every endpoint, including anonymous ones. For accuracy, I prefer an `IOperationFilter` that adds the requirement only when the endpoint has `[Authorize]` metadata and also documents 401 and 403.
- For OAuth2 with Entra ID, configure `c.OAuthClientId(...)` and `c.OAuthUsePkce()` in `UseSwaggerUI`, with a **public SPA client registration**. Never put a client secret in the UI.

**Version note:** Swashbuckle 10 moved to Microsoft.OpenApi 2.x. In that version, references use `OpenApiSecuritySchemeReference`, and `AddSecurityRequirement` takes a factory `document => new OpenApiSecurityRequirement { ... }`. The sample below uses the 6.x–9.x API, which is still very common.

**Pitfall:** the padlock in the UI is only documentation. The API must still enforce `[Authorize]`.

#### Code
```csharp title="Bearer scheme + operation filter (Swashbuckle 6.x-9.x API)"
builder.Services.AddSwaggerGen(c =>
{
    c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Type = SecuritySchemeType.Http,       // UI adds the "Bearer " prefix
        Scheme = "bearer",
        BearerFormat = "JWT",
        Description = "Paste an access token (without the 'Bearer ' prefix)."
    });
    c.OperationFilter<AuthorizeOperationFilter>();   // only on [Authorize] endpoints
});

public sealed class AuthorizeOperationFilter : IOperationFilter
{
    public void Apply(OpenApiOperation op, OperationFilterContext ctx)
    {
        var metadata = ctx.ApiDescription.ActionDescriptor.EndpointMetadata;
        var requiresAuth = metadata.OfType<IAuthorizeData>().Any()
                        && !metadata.OfType<IAllowAnonymous>().Any();
        if (!requiresAuth) return;

        op.Responses.TryAdd("401", new OpenApiResponse { Description = "Unauthorized" });
        op.Responses.TryAdd("403", new OpenApiResponse { Description = "Forbidden" });

        var scheme = new OpenApiSecurityScheme
        {
            Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" }
        };
        op.Security = [new OpenApiSecurityRequirement { [scheme] = Array.Empty<string>() }];
    }
}
```

### Q: How do you generate versioned OpenAPI documents, and what changed with built-in OpenAPI in .NET 9?
difficulty: Hard
tags: documentation, versioning, openapi, api
id: versioned-docs-dotnet9-openapi

#### Definition
A versioned API should publish one OpenAPI document per version, so each client sees only the contract it targets.
With Swashbuckle, this is usually done by combining `Asp.Versioning.Mvc.ApiExplorer` with one `SwaggerDoc` per version.
`IApiVersionDescriptionProvider` reports the available versions.
.NET 9 introduced built-in document generation in the `Microsoft.AspNetCore.OpenApi` package.
It is registered with `AddOpenApi("v1")` and served with `MapOpenApi()` at `/openapi/{documentName}.json`.
The built-in generator is customised through document, operation and schema **transformers**.
It does not ship a UI, so teams pair it with Scalar, Swagger UI or ReDoc.

#### Answer
**Versioned docs with Swashbuckle:** `AddApiExplorer(o => o.GroupNameFormat = "'v'VVV")` puts each endpoint into a group (`v1`, `v2`). An `IConfigureOptions<SwaggerGenOptions>` then loops over `IApiVersionDescriptionProvider.ApiVersionDescriptions` to register one `SwaggerDoc` per version. Deprecated versions get a note in the description. In `UseSwaggerUI`, I add one `SwaggerEndpoint` per version so the UI shows a version dropdown.

**Built-in OpenAPI (.NET 9+):**

| | Swashbuckle | Microsoft.AspNetCore.OpenApi |
|---|---|---|
| Registration | `AddSwaggerGen` | `AddOpenApi("v1")` per document |
| Endpoint | `/swagger/v1/swagger.json` | `MapOpenApi()` → `/openapi/v1.json` |
| Customization | Document/operation/schema **filters** | Document/operation/schema **transformers** |
| UI | Swagger UI included | None (add Scalar, Swagger UI) |
| Build-time generation | CLI tool | `Microsoft.Extensions.ApiDescription.Server` |
| AOT friendly | No | Yes |

In my experience, new .NET 9 projects use the built-in generator plus **Scalar**, and existing projects stay on Swashbuckle unless they need Native AOT. Since .NET 10, the built-in generator also produces **OpenAPI 3.1** and supports XML comments.

**Pitfalls:**
- With the built-in generator, each version needs its own `AddOpenApi("v2")` call. The `ShouldInclude` option (or the default group-name matching) decides which endpoints go into which document.
- Forgetting `SubstituteApiVersionInUrl`, which makes routes show `{version}` instead of `v1`.
- Serving the docs in production unintentionally.

**Follow-up:** "How do you add JWT to the built-in doc?" I'd write an `IOpenApiDocumentTransformer` that adds the bearer security scheme to `document.Components`.

#### Code
```csharp title=".NET 9 built-in OpenAPI: per-version documents + transformer + Scalar"
// dotnet add package Microsoft.AspNetCore.OpenApi
// dotnet add package Scalar.AspNetCore
builder.Services.AddOpenApi("v1", o =>
{
    o.AddDocumentTransformer((doc, ctx, ct) =>
    {
        doc.Info.Title = "Orders API";
        doc.Info.Version = "1.0";
        doc.Info.Description = "Deprecated - migrate to v2.";
        return Task.CompletedTask;
    });
});
builder.Services.AddOpenApi("v2", o =>
    o.AddDocumentTransformer<BearerSecuritySchemeTransformer>());  // adds JWT scheme

var app = builder.Build();

app.MapOpenApi();                    // /openapi/v1.json and /openapi/v2.json
if (app.Environment.IsDevelopment())
    app.MapScalarApiReference();     // interactive UI at /scalar/v1

var v1 = app.MapGroup("/api/v1/orders").WithGroupName("v1");  // group name -> document
var v2 = app.MapGroup("/api/v2/orders").WithGroupName("v2");

v1.MapGet("/{id:int}", (int id) => TypedResults.Ok(new OrderV1(id, "Pending")));
v2.MapGet("/{id:int}", (int id) => TypedResults.Ok(new OrderV2(id, "Pending", "EUR", [])));
```

```csharp title="Swashbuckle: one SwaggerDoc per discovered API version"
public sealed class ConfigureSwaggerVersions(IApiVersionDescriptionProvider provider)
    : IConfigureOptions<SwaggerGenOptions>
{
    public void Configure(SwaggerGenOptions options)
    {
        foreach (var d in provider.ApiVersionDescriptions)     // v1, v2, ...
        {
            options.SwaggerDoc(d.GroupName, new OpenApiInfo
            {
                Title = "Orders API",
                Version = d.ApiVersion.ToString(),
                Description = d.IsDeprecated ? "This version is deprecated." : null
            });
        }
    }
}

// Program.cs
builder.Services.AddTransient<IConfigureOptions<SwaggerGenOptions>, ConfigureSwaggerVersions>();
builder.Services.AddSwaggerGen();

app.UseSwagger();
app.UseSwaggerUI(ui =>
{
    foreach (var d in app.DescribeApiVersions())                // Asp.Versioning extension
        ui.SwaggerEndpoint($"/swagger/{d.GroupName}/swagger.json", d.GroupName.ToUpperInvariant());
});
```
