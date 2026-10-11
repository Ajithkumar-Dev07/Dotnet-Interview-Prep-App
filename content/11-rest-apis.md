---
title: APIs & REST
description: REST architectural principles and practical HTTP API design - verbs, status codes, pagination and caching
icon: "REST"
color: "#0d9488"
---

## REST Principles

### Q: What is REST and what are its architectural constraints?
difficulty: Easy
tags: rest, api, http, architecture
id: rest-constraints

#### Definition
REST (Representational State Transfer) is an architectural style for distributed systems.
Roy Fielding defined it in his 2000 doctoral dissertation.
It models a system as **resources** identified by URIs and manipulated through **representations** such as JSON.
Clients use a uniform set of HTTP methods to work with these resources.
REST defines six constraints: client-server, statelessness, cacheability, uniform interface, layered system, and optional code-on-demand.
Statelessness means that each request carries all the information needed to process it, with no server-side session.
An API that follows these constraints is called "RESTful".
In practice, many "REST" APIs are really HTTP/JSON APIs that skip HATEOAS.

#### Answer
I'd explain REST through its constraints and *why* each one matters:

| Constraint | Meaning | Benefit |
|---|---|---|
| Client–server | UI separated from data/storage | Independent evolution |
| Stateless | No session; auth token on every request | Horizontal scaling, any node can serve |
| Cacheable | Responses label themselves cacheable or not | Fewer round trips, lower latency |
| Uniform interface | Resource URIs, standard verbs, self-descriptive messages, HATEOAS | Simplicity, decoupling |
| Layered system | Client can't tell if it talks to a proxy, CDN or the origin | Gateways, load balancers, caching |
| Code on demand (optional) | Server can send executable code | Rarely used |

Key design habits I follow:
- **Nouns, not verbs**, in URIs: `GET /orders/42`, not `/getOrder?id=42`.
- **Plural collections and nesting for ownership:** `/customers/7/orders`.
- **HTTP semantics do the work:** method for intent, status code for outcome, headers for metadata.

In my experience, interviewers often follow up with the **Richardson Maturity Model**:
- Level 0 is a single RPC endpoint.
- Level 1 adds resources.
- Level 2 adds HTTP verbs and status codes.
- Level 3 adds hypermedia (HATEOAS).

Most production APIs sit at Level 2, and I say so honestly.

**Pitfalls:**
- Storing session state on the server, which breaks scale-out.
- Returning `200 OK` with `{ "error": ... }` in the body.
- Using actions in URLs. For non-CRUD operations, I model them as sub-resources, e.g. `POST /orders/42/cancellation`.

**Follow-up:** "REST vs gRPC vs GraphQL?" REST suits public, cacheable resource APIs. gRPC suits fast internal service-to-service calls. GraphQL suits flexible client-driven queries.

#### Code
```http title="RESTful resource design"
GET    /api/customers/7/orders?status=open   HTTP/1.1   # list a sub-collection
GET    /api/orders/42                        HTTP/1.1   # read one
POST   /api/orders                           HTTP/1.1   # create -> 201 + Location
PUT    /api/orders/42                        HTTP/1.1   # full replace
PATCH  /api/orders/42                        HTTP/1.1   # partial update
DELETE /api/orders/42                        HTTP/1.1   # remove -> 204
POST   /api/orders/42/cancellation           HTTP/1.1   # non-CRUD action as a sub-resource

HTTP/1.1 201 Created
Location: /api/orders/43
Content-Type: application/json

{ "id": 43, "status": "Pending",
  "_links": { "self": { "href": "/api/orders/43" },
              "cancel": { "href": "/api/orders/43/cancellation", "method": "POST" } } }
```

### Q: Explain HTTP methods, safety and idempotency, and the key status codes.
difficulty: Medium
tags: http, rest, idempotency, api
id: http-verbs-idempotency

#### Definition
HTTP methods express the client's intent toward a resource.
A **safe** method does not change server state; GET, HEAD and OPTIONS are safe.
An **idempotent** method gives the same server state whether it is called once or many times.
GET, HEAD, OPTIONS, PUT and DELETE are idempotent.
POST is neither safe nor idempotent, and PATCH is not guaranteed to be idempotent.
Idempotency matters because networks fail, and clients, proxies and retry policies may resend requests.
Status codes tell the outcome: 2xx is success, 3xx is redirection, 4xx is a client error and 5xx is a server error.

#### Answer
I'd summarise the verbs in a table:

| Method | Safe | Idempotent | Typical success code |
|---|---|---|---|
| GET | Yes | Yes | 200 OK |
| POST | No | No | 201 Created (+ `Location`), 202 Accepted |
| PUT | No | Yes | 200 OK / 204 No Content (201 if created) |
| PATCH | No | Not guaranteed | 200 / 204 |
| DELETE | No | Yes | 204 (and 404 or 204 on repeat) |

Status codes I use deliberately:
- **400** for malformed requests or validation errors (with Problem Details), and **422** for semantically invalid input if the team prefers it.
- **401** means "not authenticated" and **403** means "authenticated but not allowed". Mixing these up is a classic interview trap.
- **404** for not found, **409 Conflict** for duplicates or state conflicts, and **412 Precondition Failed** for ETag mismatches.
- **429 Too Many Requests** with `Retry-After` for rate limiting.
- **500** for unexpected errors and **503** for temporary unavailability.

Idempotency here means the effect on the server, not the response. A second DELETE may return 404, but the state is the same.

**Making POST safe to retry:** In my experience with payments and orders, I use an **`Idempotency-Key` header**. The server stores the key with the response, and a retry with the same key returns the stored response instead of creating a duplicate. This is how Stripe does it.

**Pitfalls:** GET endpoints that change data (crawlers and prefetchers will trigger them), and returning 200 for everything.

**Follow-up:** "Is PATCH idempotent?" It depends on the payload. `{ "op": "increment" }` is not idempotent, while setting a field is.

#### Code
```csharp title="Idempotency-Key for safe POST retries (Minimal API)"
app.MapPost("/payments", async (
    [FromHeader(Name = "Idempotency-Key")] string? key,
    CreatePayment cmd, IPaymentService payments, IDistributedCache cache) =>
{
    if (string.IsNullOrWhiteSpace(key))
        return Results.Problem("Idempotency-Key header is required.", statusCode: 400);

    // Replay: same key -> same stored response, no second charge
    var cached = await cache.GetStringAsync($"idem:{key}");
    if (cached is not null)
        return Results.Content(cached, "application/json", statusCode: 201);

    var payment = await payments.ChargeAsync(cmd);
    var json = JsonSerializer.Serialize(payment);

    await cache.SetStringAsync($"idem:{key}", json,
        new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(24) });

    return Results.Created($"/payments/{payment.Id}", payment);  // 201 + Location
});
```

## API Design

### Q: What is the difference between PUT and PATCH?
difficulty: Easy
tags: http, rest, api, json-patch
id: put-vs-patch

#### Definition
PUT and PATCH are both HTTP methods for updating a resource, but they have different semantics.
**PUT** replaces the entire resource at the target URI with the representation in the request body.
Any field omitted from a PUT request is reset to its default or removed.
PUT is idempotent, and it can also create a resource when the client chooses the URI.
**PATCH** applies a partial modification described by a patch document.
The two standard patch formats are JSON Patch (RFC 6902, `application/json-patch+json`) and JSON Merge Patch (RFC 7396).
PATCH is not guaranteed to be idempotent, and it is usually more bandwidth-efficient for small changes.

#### Answer
I'd explain it with an example. A user has `name`, `email` and `phone`. A `PUT` with only `name` and `email` **clears** `phone`, while a `PATCH` with only `name` changes just the name.

| | PUT | PATCH |
|---|---|---|
| Semantics | Full replacement | Partial update |
| Body | Complete resource | Patch document (diff) |
| Idempotent | Yes | Not guaranteed |
| Missing fields | Reset/removed | Untouched |
| Concurrency | Lost-update risk on whole resource | Smaller, but still use ETags |

**The two PATCH formats:**
- **JSON Merge Patch** sends a partial object, and `null` means "remove". It is simple, but it cannot tell "set to null" apart from "remove", and it cannot edit individual array elements.
- **JSON Patch** sends a list of operations (`add`, `remove`, `replace`, `move`, `copy`, `test`). It is precise and supports conditional updates via `test`.

**In .NET:** `JsonPatchDocument<T>` historically required `Microsoft.AspNetCore.Mvc.NewtonsoftJson`. .NET 10 adds System.Text.Json-based JSON Patch support. In my experience, many teams instead use a PATCH DTO with nullable properties, which is effectively merge-patch, because it is simpler to validate.

**Pitfalls:**
- Applying a patch directly to an EF entity, which allows over-posting of fields like `isAdmin`. I patch a DTO, validate it, then map it.
- Forgetting `If-Match` / ETag checks, which leads to lost updates.

**Follow-up:** "Can PUT create a resource?" Yes, if the client controls the ID; return 201 in that case.

#### Code
```http title="PUT vs JSON Patch vs Merge Patch"
PUT /api/users/7 HTTP/1.1
Content-Type: application/json
If-Match: "a1b2c3"

{ "name": "Ana", "email": "ana@contoso.com", "phone": null }

PATCH /api/users/7 HTTP/1.1
Content-Type: application/json-patch+json

[
  { "op": "test",    "path": "/email", "value": "ana@contoso.com" },
  { "op": "replace", "path": "/name",  "value": "Ana Silva" },
  { "op": "remove",  "path": "/phone" }
]

PATCH /api/users/7 HTTP/1.1
Content-Type: application/merge-patch+json

{ "name": "Ana Silva" }
```

```csharp title="JsonPatchDocument on a DTO (with validation)"
[HttpPatch("{id:int}")]
public async Task<IActionResult> Patch(int id, [FromBody] JsonPatchDocument<UserUpdateDto> patch)
{
    var user = await db.Users.FindAsync(id);
    if (user is null) return NotFound();

    var dto = UserUpdateDto.From(user);          // patch the DTO, never the entity
    patch.ApplyTo(dto, ModelState);              // invalid ops -> ModelState errors
    if (!TryValidateModel(dto)) return ValidationProblem(ModelState);

    dto.MapTo(user);                             // copy only allowed fields
    await db.SaveChangesAsync();
    return NoContent();                          // 204
}
```

### Q: How do you design pagination and HTTP caching with ETags for a REST API?
difficulty: Hard
tags: api, performance, caching, pagination
id: pagination-and-etags

#### Definition
Pagination splits a large collection into pages, which keeps responses small and queries fast.
The two main styles are **offset pagination** (`?page=3&pageSize=20`) and **cursor (keyset) pagination** (`?after=<cursor>&limit=20`).
HTTP caching lets clients and proxies reuse responses using the `Cache-Control`, `ETag` and `Last-Modified` headers.
An **ETag** is an opaque version identifier for a representation.
Clients send it back in `If-None-Match` for conditional GETs, and the server answers `304 Not Modified` if nothing changed.
Clients also send it in `If-Match` for conditional updates, and the server answers `412 Precondition Failed` on a mismatch.
Together, pagination and caching reduce bandwidth, database load and lost-update bugs.

#### Answer
**Pagination.** I'd compare the two styles:

| | Offset (`Skip/Take`) | Cursor / keyset |
|---|---|---|
| Jump to page N | Yes | No (next/prev only) |
| Deep-page performance | Degrades (`OFFSET 100000`) | Constant (index seek) |
| Stable with inserts | No (duplicates/skips) | Yes |
| Total count | Easy but costly | Usually omitted |

In my experience, offset pagination is fine for admin grids, and **cursor pagination** is right for feeds, large tables and public APIs. I always:
- **Cap `pageSize`** (e.g. at 100) and use a deterministic `ORDER BY` with a unique tiebreaker such as `Id`.
- Return metadata such as `nextCursor` and links in the body or in the `Link` header.

**Caching with ETags:**
- **Conditional GET:** the server returns an `ETag`, and the client later sends `If-None-Match`. If the data is unchanged, the server returns `304` with no body, which saves bandwidth.
- **Optimistic concurrency:** the client sends `If-Match` on PUT or PATCH, and the server returns `412` if someone else changed the resource. With EF Core and SQL Server, I derive the ETag from the `rowversion` column.
- Use `Cache-Control: private, max-age=60` for per-user data and `public` for shared data. Output caching (`AddOutputCache`) adds server-side caching.

**Pitfalls:**
- Computing an ETag by hashing the full response still costs the database query; a version column is cheaper.
- Weak (`W/"..."`) vs strong ETags.
- Caching authenticated responses as `public` on a CDN.

**Follow-up:** "How do you return the total count cheaply?" Make it optional (`?includeTotal=true`) or approximate.

#### Code
```csharp title="Keyset pagination + ETag conditional GET"
app.MapGet("/api/products", async (int? afterId, int limit, AppDbContext db) =>
{
    limit = Math.Clamp(limit == 0 ? 20 : limit, 1, 100);       // cap page size

    var items = await db.Products.AsNoTracking()
        .Where(p => afterId == null || p.Id > afterId)          // index seek, no OFFSET
        .OrderBy(p => p.Id)
        .Take(limit + 1)                                        // +1 to detect "has more"
        .Select(p => new ProductDto(p.Id, p.Name, p.Price))
        .ToListAsync();

    var hasMore = items.Count > limit;
    if (hasMore) items.RemoveAt(limit);
    return Results.Ok(new { items, nextCursor = hasMore ? items[^1].Id : (int?)null });
});

app.MapGet("/api/products/{id:int}", async (int id, HttpContext http, AppDbContext db) =>
{
    var p = await db.Products.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
    if (p is null) return Results.NotFound();

    var etag = $"\"{Convert.ToBase64String(p.RowVersion)}\"";   // from SQL rowversion
    if (http.Request.Headers.IfNoneMatch == etag)
        return Results.StatusCode(StatusCodes.Status304NotModified);

    http.Response.Headers.ETag = etag;
    http.Response.Headers.CacheControl = "private, max-age=60";
    return Results.Ok(new ProductDto(p.Id, p.Name, p.Price));
});
```

```http title="Conditional GET and conditional update"
GET /api/products/42 HTTP/1.1
If-None-Match: "AAAAAAAAB9E="

HTTP/1.1 304 Not Modified

PUT /api/products/42 HTTP/1.1
If-Match: "AAAAAAAAB9E="
Content-Type: application/json

{ "name": "Keyboard", "price": 49.99 }

HTTP/1.1 412 Precondition Failed
```
