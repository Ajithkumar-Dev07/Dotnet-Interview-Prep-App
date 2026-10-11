# .NET Interview Prep

A fast, searchable, front-end-only interview preparation site for .NET developers.
All content lives as **Markdown or JSON files in `content/`** — GitHub is the source of truth.
Push a file → GitHub Actions rebuilds → GitHub Pages serves the new version.

**Features**
- Search by heading/question title (default) or full text (answers + code), with autocomplete suggestions grouped into Topics / Headings / Questions, keyboard navigation and `/` shortcut
- Topic → Heading → Q&A navigation (sidebar tree, topic pages, per-heading jump links)
- Filters: topics, difficulty, tags, bookmarked, and **related-to** (connected questions across topics), shown as removable chips
- Each question: a short **Definition** card, a detailed **Interview answer**, and separate **code cards** (syntax highlighted, copy button)
- Bookmarks (saved in the browser, with export/import), shareable question links, dark mode, mobile layout
- Zero runtime dependencies, zero npm install

---

## 1. Put it on GitHub Pages (one time)

1. Create a new GitHub repository and push this folder to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. In the repo go to **Settings → Pages → Build and deployment → Source** and pick **GitHub Actions**.
3. Open the **Actions** tab — the "Build & deploy to GitHub Pages" run will publish the site to
   `https://<you>.github.io/<repo>/` (the workflow can also be re-run manually).

The site uses relative paths and hash URLs, so it works under any repo name with no configuration.

## 2. Add or update content

| You want to… | Do this |
|---|---|
| Add a new topic | Add `content/15-my-topic.md` (or `.json`) and push. **Even an empty file works** — it appears as "Coming soon". |
| Add questions | Edit the topic file and push. |
| Reorder topics | Change the number prefix in the file name (`03-…`). |
| Draft privately | Start the file name with `_` (ignored by the build). |

The full format (front-matter, `##` headings, `### Q:` questions, `#### Definition / Answer / Code`, JSON schema) is in **[CONTENT_GUIDE.md](CONTENT_GUIDE.md)**. Copy `content/_template.md` to start.

Build warnings (e.g. a `related:` id that doesn't exist, invalid JSON) are printed in the Actions log; a bad file never breaks the deploy — it just shows as empty.

## 3. Run locally (optional)

Requires Node 18+.

```bash
npm run dev        # = node scripts/serve.mjs → http://localhost:5173, rebuilds when files change
npm run build      # = node scripts/build.mjs → static site in dist/
```

Opening `index.html` straight from disk won't work (browsers block `fetch` from `file://`); use the dev server.

## How it works

```
content/*.md|*.json ──► scripts/build.mjs ──► dist/
                         • parses Markdown/JSON        index.html, assets/      (copied from site/)
                         • renders Markdown → HTML     data/manifest.json       topics → headings → question ids
                         • highlights code             data/search.json         question list + heading index
                         • computes related questions  data/search-body.json    full-text index (loaded on demand)
                         • builds inverted indexes     data/topics/<slug>.json  full answers (loaded per topic)
```

- **Fast as content grows**: the browser downloads only a small manifest + heading index up front; full answers load per topic on first open, and the full-text index loads only when "Full text" search is used. Search is a binary-searched prefix lookup over a prebuilt inverted index — no scanning of answer text in the browser.
- **Related content**: computed at build time from shared tags and TF-IDF similarity of titles/headings/definitions; anything listed in `related:` is always shown first.
- **Maintainable**: plain HTML/CSS/ES modules in `site/`, and two small Node scripts. No framework, bundler or packages to update.

```
.github/workflows/deploy.yml   CI: build + deploy to Pages on every push to main
content/                       ← your data (Markdown / JSON)
scripts/build.mjs              content → dist (parser, indexer, related)
scripts/serve.mjs              local preview with auto-rebuild
scripts/lib/markdown.mjs       Markdown renderer
scripts/lib/highlight.mjs      syntax highlighter (C#, SQL, JSON, JS/TS, XML, Bash, YAML, HTTP)
site/index.html                app shell
site/assets/js/app.js          UI: routing, views, filters, bookmarks
site/assets/js/search.js       search + autocomplete scoring
site/assets/js/tokenize.js     tokenizer shared by build and browser
site/assets/css/styles.css     styles (light/dark, responsive)
```
