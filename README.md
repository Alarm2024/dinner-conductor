# dinner-conductor

MCP server for Alexa+ that plans the timing of a multi-dish home meal so every dish is ready at serve time.

Protocol **2025-11-25** over Streamable HTTP. Plans stay in memory (random `plan_id`, expire after 8 hours, max 1000). Nothing about a request is written to disk. No deploy hooks, no API keys, no telemetry.

## What it does

- Looks up common home dishes and their typical prep / cook / rest / hold times
- Builds a backward schedule from serve time around cooks, oven temperature and rack space, and burners
- Answers what is next on the timeline, handles running late, and changes the menu
- Resumes a plan after a restart from a compact `plan_token` (dish ids and settings, not the timeline)

**Your recipe's times win.** Typical times in the dish library are starting points you can override.

## What it will not answer

Out of scope on every tool: allergy, nutrition, diet, and food-safety questions.

Fixed doneness line: **Check doneness with your recipe and a thermometer.**

It never changes a dish's temperature or cook time on its own. If a plan does not fit, it says why and asks one question.

## Demo phrases (simulated page)

Use these on `/sim` (scripted router):

- Plan dinner with chicken thighs, roast potatoes, and green beans at 6
- Plan a holiday meal with turkey breast, stuffing, mashed potatoes, green bean casserole, dinner rolls, and gravy at 4 with 1 oven
- What's next?
- Read the plan
- Running late on roast potatoes by 10 minutes
- Add salad and remove green beans
- Find dish lasagna

## Run from a fresh clone (Node 22)

```bash
git clone https://github.com/Alarm2024/dinner-conductor.git
cd dinner-conductor
npm ci
npm start
```

Then open:

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Simulated page: [http://127.0.0.1:3000/sim](http://127.0.0.1:3000/sim)

Optional `.env`:

```
PORT=3000
HOST=0.0.0.0
ALLOWED_HOSTS=example.com
```

`ALLOWED_HOSTS` adds Host/Origin names beyond localhost / 127.0.0.1 / ::1.

## Tools

| Tool | Role |
|------|------|
| `find_dish` | Match a spoken name to typical times |
| `plan_meal` | Build a plan; asks for `serve_at` / `ovens` when missing |
| `whats_next` | Current and next step |
| `running_late` | Replan with delay on one dish (does not shorten cook time) |
| `change_menu` | Add / remove / override and replan |
| `read_plan` | Full card |
| `resume_plan` | Rebuild from `plan_token` after restart |

## How it was tested

- `npm test` (protocol hardening, dish library, solver goldens + 500 random property runs, tool calls)
- `npm run typecheck`
- MCP Inspector CLI (`tools/list` and one `tools/call` per tool) via `scripts/smoke.sh`
- Simulated page at `/sim` (not a real Alexa device)

```bash
sh scripts/smoke.sh
```

## Known limits

- Dish library is a small set of common home dishes, not a full cookbook
- One cook and one oven constrain busy holiday menus; the solver sequences hold-capable dishes or asks
- Plans are in-process memory: a process restart drops them unless you keep `plan_token`
- Timezone handling uses IANA names via `Intl`
- Scripted router on `/sim` covers the demo phrases above, not free-form chat

## License

MIT

Docs and images: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), © elghaly. Third-party fonts, logos and screenshots of other services keep their own licenses.
