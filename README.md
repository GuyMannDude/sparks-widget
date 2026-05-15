# Sparks Widget

Configurable chat widget engine for Sparks-stack storefronts. One repo, many personas.

## What this is

A small Node/Express backend (~265 LOC) + a vanilla-JS embeddable widget. Drops onto any static site as a `<script>` tag, talks to an OpenAI-compatible LLM endpoint, optionally persists per-visitor conversation memory to [Mnemo Cortex](https://github.com/GuyMannDude/mnemo-cortex) so the chat picks up where it left off across sessions.

## Engine vs persona

The widget is a **generic engine**. The customer-facing personality is **configuration**:

- **Engine** (this repo): server.js, the embed JS, the routing, the Mnemo recall/save plumbing, the chat-log writer, the memory toggle UI.
- **Persona** (per-customer): assistant name, avatar, system prompt, product knowledge file, AGENT_ID for Mnemo isolation.

Today the persona for the `peter-customer` instance lives partially in `server.js` (the `SYSTEM_PROMPT` constant) and partially in `~/peter-customer/knowledge/products.md`. **The externalization to a full per-customer config file is roadmap work** (see TODO below) — current shape ships as one bound instance.

## Deployed instances

| Instance | Persona | Site | AGENT_ID | Service unit |
|---|---|---|---|---|
| `peter-customer` | Peter (cartoon lobster, Project Sparks mascot) | projectsparks.ai | `peter-widget` | `peter-widget.service` (user) |

When a new customer comes online (e.g. Rocky's Gallery on Shopify, master-todo #15), expect a new row here, **not** a new repo.

## Architecture notes

### The two-copy trap (live wire format)

The embed JS exists in **two places**:
1. **This repo** — `rocky-widget.js` (filename kept for compat). Backend serves it at `/rocky-widget.js` as a fallback.
2. **`projectsparks-site/rocky-widget.js`** — Firebase-served, the version visitors actually load.

The site's copy is the **live wire format**. Its CSS class names (`#rocky-widget-bubble`, `.rw-msg.rocky`), localStorage keys (`rocky_visitor_id`, `rocky_widget_memory_on`, `rocky_widget_state`), and global (`window.ROCKY_WIDGET_API`) are baked into visitor browsers and the static site embed. Don't rename them in either copy without a coordinated site deploy. Drift between the two copies is a recurring footgun — fix one, fix both.

### What the backend serves

Production only uses the `/api/*` routes:
- `POST /api/chat` — main chat completion (with optional Mnemo recall)
- `POST /api/save-visitor` — store conversation snippet
- `GET  /api/recall/:visitor_id` — fetch prior memory
- `POST /api/wipe-visitor` — delete visitor's Mnemo data
- `POST /api/log-question` — log unanswered question

The `/rocky-widget.js` and `/rocky-icon.svg` routes are unused in production (site has its own copies). Kept as fallback for direct-access debugging.

### Memory toggle

Default OFF. Visitor opts INTO memory via the segmented control in the footer. When ON, the widget passes `visitor_id` to the backend, which recalls semantic context from Mnemo and saves the conversation snippet every 3 visitor messages. When OFF, the conversation is stateless — nothing is sent to Mnemo.

### Chat log

Every exchange is appended to `~/peter-customer/logs/chat-YYYY-MM-DD.log` as JSONL with `recalled_memory_preview` for debugging. Tail:

```bash
tail -f ~/peter-customer/logs/chat-$(date -u +%Y-%m-%d).log | jq .
```

## Deploy / operate

```bash
npm install
node server.js   # or via systemd: systemctl --user start peter-widget.service
```

Reads `~/.rockys-switch/keys.json` for the OpenRouter API key (relays via Rocky's Switch on `127.0.0.1:8100`). Mnemo bridge on `127.0.0.1:50002`.

## Roadmap

- **Persona externalization** — pull `SYSTEM_PROMPT`, `AGENT_ID`, `KNOWLEDGE_DIR`, header name/avatar, system-prompt persona strings out of `server.js` and into per-customer `~/<customer>-customer/config.json`. One systemd template (`sparks-widget@<customer>.service`) per instance. Required before adding a second persona.
- **Wire-format generification** — eventually rename `rocky-widget.js` / CSS classes / localStorage keys / global API var to neutral names (`widget.js`, `sw-*`, `sparks_widget_*`, `SPARKS_WIDGET_API`). Requires coordinated site deploy + visitor-state migration. Not urgent.
- **Multi-tenant routing** — when there are 2+ customers, route by host header or path prefix so one process serves multiple personas.

## License

MIT.
