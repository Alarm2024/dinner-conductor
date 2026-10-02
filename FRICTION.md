# FRICTION

Dated log of real snags hit while building dinner-conductor.

## 2026-09-30 — HTTP body returns SSE even with `responseMode: "json"`

The Streamable HTTP adapter still answers with `text/event-stream` frames (`event: message` / `data: {...}`). Protocol tests that `assert.match` on the body keep working, but clients that call `response.json()` break. The simulated page and tool tests parse the `data:` line.

## 2026-09-30 — Hands-on conflict thrashing

Early solver passes alternated which dish to shift earlier by a fixed 5 minutes, so two prep windows stayed overlapped until both hold budgets ran out. Fix: compute the exact minutes needed so the mover's hands-on ends before the peer segment starts, and try the next hold-capable dish when one cannot move.

## 2026-09-30 — MCP Inspector Node engine warning

`@modelcontextprotocol/inspector@2.9` wants Node `>=22.19.0`; the environment is `22.14.0`. The CLI still ran for smoke. Watch for future inspector releases that hard-fail on the engine check.

## 2026-09-30 — Banned word false positive on ARIA attribute

`scripts/banned-words.sh` uses whole-word grep. An ARIA politeness attribute name matched a banned token, so the sim page uses `role="status"` instead.

## 2026-09-30 — desk-alexa-mcp HTTP layer copy target

Hardened `/mcp` checks were copied from Alarm2024/desk-alexa-mcp PR #2 (`src/http.ts` on branch `cursor/iris-alexa-hardening-07bb`), then renamed to dinner-conductor and pointed at `sim/index.html`.

## 2026-09-30 — `outputSchema` rejected plan fields

MCP Inspector `tools/call` for `plan_meal` failed with "data must NOT have additional properties" until `serve_at_local`, `timezone`, and related fields were added to each tool `outputSchema`, and undefined keys were omitted from `structuredContent`.
