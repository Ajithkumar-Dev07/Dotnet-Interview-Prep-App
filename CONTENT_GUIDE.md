# Content Guide

All interview content lives in the **`content/`** folder. One file = one topic.
Push a new file to GitHub → the GitHub Action rebuilds the index → the topic appears on the site.

Supported formats: **Markdown (`.md`)** (recommended) and **JSON (`.json`)**.

## File naming

```
content/
  01-csharp.md            → topic "Csharp" (order 1) unless `title:` is set
  02-csharp-advanced.md
  azure-services.json
  microservices.md        ← an EMPTY file is fine: shows as "Coming soon"
```

- An optional numeric prefix (`01-`) sets the display order. Without one, `order:` in front‑matter is used, otherwise alphabetical.
- The file name (minus prefix/extension) becomes the topic **slug** used in URLs, so keep it lowercase‑kebab‑case.
- If no `title` is given, the title is derived from the file name (`azure-service-bus` → "Azure Service Bus").
- Files or folders starting with `_` are ignored (use for drafts / templates).

---

## Markdown format

```markdown
---
title: C#
description: Core C# language fundamentals
icon: "C#"
color: "#7c3aed"
---

## Types and Memory            ← a HEADING (section) inside the topic

### Q: What is the difference between a value type and a reference type?
difficulty: Easy               ← optional: Easy | Medium | Hard
tags: memory, stack, heap      ← optional, comma separated
related: csharp-advanced/boxing-and-unboxing   ← optional, comma separated topic/question-id
id: value-vs-reference         ← optional; generated from the question text if missing

#### Definition
Short 6–10 line definition. This is what you say in the first 30 seconds.

#### Answer
Detailed, interview‑style answer in Markdown. Lists, **bold**, tables,
> blockquotes and `inline code` all work.

#### Code
```csharp title="Value vs reference semantics"
int a = 5; int b = a; b++;   // a is still 5
```

```sql title="Optional second snippet"
SELECT 1;
```
```

Rules:
- `##` = heading/section, `### Q:` (or just `###`) = a question.
- The metadata lines (`difficulty:`, `tags:`, `related:`, `id:`) must come directly after the question line.
- `#### Definition`, `#### Answer`, `#### Code` are the three blocks. Any fenced code block anywhere in the question becomes a **code card**.
- Code fence info string: ```` ```csharp title="My title" ````. Supported highlighting: `csharp`, `sql`, `json`, `js`/`ts`, `xml`/`html`, `bash`/`powershell`, `yaml`, `http`. Anything else renders as plain text.
- If there is no `#### Definition` / `#### Answer`, all text is treated as the answer.

---

## JSON format

```json
{
  "title": "Azure Services",
  "description": "Cloud services commonly used with .NET",
  "icon": "Az",
  "color": "#0ea5e9",
  "sections": [
    {
      "heading": "Messaging",
      "questions": [
        {
          "id": "service-bus-vs-queue",
          "question": "Azure Service Bus vs Storage Queue?",
          "difficulty": "Medium",
          "tags": ["messaging", "queues"],
          "related": ["web-api/background-jobs"],
          "definition": "Short definition (markdown allowed)",
          "answer": "Detailed markdown answer",
          "code": [
            { "language": "csharp", "title": "Send a message", "code": "await sender.SendMessageAsync(msg);" }
          ]
        }
      ]
    }
  ]
}
```

An empty JSON file (0 bytes) or `{}` is also valid and shows as "Coming soon".

---

## How "related" works

Each question gets related items automatically (shared tags + similar wording, across all topics).
Anything you list in `related:` is always shown first.
