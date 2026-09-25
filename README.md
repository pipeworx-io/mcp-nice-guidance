# @pipeworx/nice-guidance

NICE guidance for England — technology appraisals (which decide whether the NHS funds a medicine), NICE and clinical guidelines, diagnostics and interventional procedures guidance, and quality standards.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `nice_search_guidance(query, guidance_type?, sort?, page?, limit?)` — search by drug, device, procedure or condition. Returns reference number, title, programme, dates and summary.
- `nice_guidance(id)` — the record for one reference number (TA1040, NG101, CG81, QS12, …): programme, dates, overview, chapters, condition area, and whether it is current, withdrawn, terminated or replaced.
- `nice_recommendations(id)` — the numbered recommendation paragraphs in full text. Answers "did NICE recommend this treatment, and for whom".
- `nice_guidance_by_topic(topic?, limit?)` — everything NICE has filed under a condition area, the complete curated list rather than a relevance ranking. Call with no topic to list the condition areas.
- `nice_recent_guidance(guidance_type?, limit?)` — newest guidance first, optionally one programme.

## Auth

Keyless.

NICE's own **Syndication API** (`api.nice.org.uk`) is not usable without arrangement: `/services` answers 401, and access requires an application form plus a signed licence agreement (<https://www.nice.org.uk/reusing-our-content/nice-syndication-api>). These tools read the public pages instead. NICE content is NICE copyright; the tools return metadata, summaries and recommendation text with the source URL on every result.

## Data sources

- `https://www.nice.org.uk/search?q=…` — the searchable index, server-rendered HTML. Accepts `q` (may be empty), `s=Date`, `ndt` (document type), `ngt` (guidance type), `pa` (page), `ps` (page size).
- `https://www.nice.org.uk/guidance/<id>` and `…/chapter/<slug>` — the guidance record and its chapters.
- `https://www.nice.org.uk/guidance/conditions-and-diseases[/…]/products` — the complete list for a condition area.

### Things worth knowing before you touch this

- **Withdrawn, terminated and replaced guidance stays published at its original URL.** TA762 still resolves, still looks like a recommendation, and is dead — the only marker is one sentence in the body naming TA1040 as its replacement. Every tool here returns `status` and `superseded_by` for that reason; recommending a replaced appraisal is a confidently wrong answer with clinical weight.
- **A query string on `/guidance/published` or on a topic `/products` page is refused** — HTTP 403 with a "Temporary Service Interruption" page, from any client, including one carrying a browser User-Agent and the site's own cookies. The same paths *without* a query string answer 200 and return the complete list, so nothing is lost; the pack only ever requests the query-free form of those two. `/search` is not affected and takes all its parameters normally.
- **`/search` also returns guidance still in development** (`/guidance/indevelopment/gid-ta11340`), which has no recommendation yet. Those rows come back with `status: "in development"` and `expected_publication`, never as published guidance.
- **The date labels are separated from their values by `&nbsp;`**, so a `\s*` bridge between "Published:" and the `<time>` element silently yields null rather than failing.
- **Recommendations are `<article class="numbered-paragraph">` blocks** with the number in its own heading. A plain `<p>` sweep loses the "1.1" numbering and mixes the "why these recommendations were made" rationale in with the recommendations themselves.
- **Reference-number prefixes are the programme**: TA technology appraisal, NG NICE guideline, CG clinical guideline, QS quality standard, DG diagnostics, IPG interventional procedures, MTG medical technologies, HST highly specialised technologies, HTE/HTG health technology evaluation.
- **This is England.** Scotland (SMC), Wales (AWMSG) and Northern Ireland make their own reimbursement decisions and are not in here.
- robots.txt allows everything with a 1-second crawl delay.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nice-guidance": {
      "url": "https://gateway.pipeworx.io/nice-guidance/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nice-guidance/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nice_search_guidance \
  -H 'Content-Type: application/json' \
  -d '{"query":"olaparib","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nice_search_guidance`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nice-guidance": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nice-guidance"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nice-guidance
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nice Guidance data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
