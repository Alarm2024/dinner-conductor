import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { findDishesByName, getDishById, typicalSummary } from "./dishes.js";
import { getPlan, rebuildFromToken, replacePlan, storePlan } from "./plans.js";
import { applyRunningLate, solveMeal, type DishOverride, type SolverInput, type TempUnits } from "./solver.js";

const SERVER_VERSION = "1.0.0";
const OUT_OF_SCOPE =
  "Out of scope: allergy, nutrition, diet, and food-safety questions. Check doneness with your recipe and a thermometer.";
const DONENESS = "Check doneness with your recipe and a thermometer.";

const overrideSchema = z
  .object({
    prep_min: z.number().nonnegative().optional(),
    cook_min: z.number().nonnegative().optional(),
    rest_min: z.number().nonnegative().optional(),
    hold_min: z.number().nonnegative().optional(),
    oven_temp_f: z.number().optional(),
    oven_temp_c: z.number().optional(),
    oven_units: z.number().int().min(1).max(2).optional(),
    burners: z.number().int().min(0).max(2).optional(),
  })
  .strict();

const dishRefSchema = z.object({
  id: z.string().min(1).max(64),
  overrides: overrideSchema.optional(),
});

const commonOut = {
  summary: z.string(),
  card: z.array(z.string()),
};

type ToolPayload = Record<string, unknown> & { summary: string; card: string[] };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolPayload;
  isError: boolean;
};

function toolResult(payload: ToolPayload, isError = false): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

const GENERIC_FAILURE = toolResult(
  {
    summary: "Something went wrong while planning. Nothing was stored. Try again.",
    card: ["Tool failed.", DONENESS],
    error: "tool_failed",
  },
  true,
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function guarded<A>(run: (args: A, ctx: any) => ToolResult | Promise<ToolResult>): (args: A, ctx: any) => Promise<ToolResult> {
  return async (args: A, ctx: any) => {
    try {
      return await run(args, ctx);
    } catch (error) {
      console.error(`tool error name=${error instanceof Error ? error.name : "Error"}`);
      return GENERIC_FAILURE;
    }
  };
}

type ElicitCtx = {
  mcpReq?: {
    elicitInput?: (params: {
      message: string;
      requestedSchema: {
        type: "object";
        properties: Record<string, object>;
        required: string[];
      };
    }) => Promise<{ action: string; content?: Record<string, unknown> }>;
  };
};

async function elicitMissing(
  ctx: ElicitCtx,
  fields: Array<"serve_at" | "ovens">,
): Promise<{ serve_at?: string; ovens?: number } | "needs" | "declined"> {
  const message =
    fields.includes("serve_at") && fields.includes("ovens")
      ? "What time is serve time, and how many ovens do you have (1 or 2)?"
      : fields.includes("serve_at")
        ? "What time should dinner be served? Use HH:MM."
        : "How many ovens do you have (1 or 2)?";

  if (typeof ctx.mcpReq?.elicitInput !== "function") return "needs";

  const properties: Record<string, object> = {};
  const required: string[] = [];
  if (fields.includes("serve_at")) {
    properties.serve_at = { type: "string", description: "Serve time as HH:MM or ISO timestamp" };
    required.push("serve_at");
  }
  if (fields.includes("ovens")) {
    properties.ovens = { type: "integer", minimum: 1, maximum: 2, description: "Number of ovens (1 or 2)" };
    required.push("ovens");
  }

  try {
    const elicited = await ctx.mcpReq.elicitInput({
      message,
      requestedSchema: { type: "object", properties, required },
    });
    if (elicited.action !== "accept" || !elicited.content) return "declined";
    return {
      serve_at: typeof elicited.content.serve_at === "string" ? elicited.content.serve_at : undefined,
      ovens: typeof elicited.content.ovens === "number" ? elicited.content.ovens : undefined,
    };
  } catch {
    // Client did not declare elicitation — fall back to needs.
    return "needs";
  }
}

function parseDishList(
  dishes: Array<{ id?: string; name?: string; overrides?: DishOverride } | string>,
): { ok: true; dishes: SolverInput["dishes"] } | { ok: false; summary: string; card: string[] } {
  const resolved: SolverInput["dishes"] = [];
  for (const item of dishes) {
    if (typeof item === "string") {
      const matches = findDishesByName(item);
      if (matches.length === 0) {
        return {
          ok: false,
          summary: `I could not find a dish matching "${item}". Try another name.`,
          card: [`No match for ${item}.`, DONENESS],
        };
      }
      const tiedTop =
        matches.length > 1 &&
        (matches[0]!.score < 100 || matches[0]!.score === matches[1]!.score);
      if (tiedTop && matches[0]!.score === matches[1]!.score) {
        const names = matches.slice(0, 3).map((m) => m.dish.names[0]);
        return {
          ok: false,
          summary: `Did you mean ${names.join(", or ")}? Say the dish id to confirm.`,
          card: [`Ambiguous: ${names.join(", ")}`, DONENESS],
        };
      }
      resolved.push({ id: matches[0]!.dish.id });
      continue;
    }
    const id = item.id ?? (item.name ? findDishesByName(item.name)[0]?.dish.id : undefined);
    if (!id || !getDishById(id)) {
      return {
        ok: false,
        summary: `I could not match that dish. Try find_dish first.`,
        card: ["Unknown dish.", DONENESS],
      };
    }
    resolved.push({ id, overrides: item.overrides });
  }
  if (resolved.length === 0) {
    return { ok: false, summary: "Add at least one dish to plan a meal.", card: ["No dishes.", DONENESS] };
  }
  return { ok: true, dishes: resolved };
}

/** Dish ids that require a user-supplied cook_min (big roasts). */
function dishesNeedingRecipeCookMin(dishes: SolverInput["dishes"]): string[] {
  const needs: string[] = [];
  for (const d of dishes) {
    const base = getDishById(d.id);
    if (base?.requires_recipe_cook_min && d.overrides?.cook_min == null) {
      needs.push(`cook_min:${d.id}`);
    }
  }
  return needs;
}

function planPayload(plan: { plan_id: string; plan_token: string; result: import("./solver.js").SolverResult }) {
  const r = plan.result;
  const payload: ToolPayload = {
    plan_id: plan.plan_id,
    plan_token: plan.plan_token,
    feasible: r.feasible,
    steps: r.steps,
    warnings: r.warnings,
    summary: r.summary,
    card: r.card,
    serve_at_local: r.serve_at_local,
    timezone: r.timezone,
  };
  if (r.reason) payload.reason = r.reason;
  if (r.question) payload.question = r.question;
  if (r.conflicts) payload.conflicts = r.conflicts;
  return payload;
}

function stepMinutesUntil(at: string, nowLocal: string): number {
  const [ah, am] = at.split(":").map(Number);
  const [nh, nm] = nowLocal.split(":").map(Number);
  return ah * 60 + am - (nh * 60 + nm);
}

/** Resolve tool `now` (ISO preferred) to epoch ms; default = server clock. */
function resolveNowMs(now?: string): number {
  if (!now) return Date.now();
  const ms = Date.parse(now);
  return Number.isFinite(ms) ? ms : Date.now();
}

export function createDinnerConductorServer(): McpServer {
  const server = new McpServer(
    { name: "dinner-conductor", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "dinner-conductor plans multi-dish meal timing so every dish is ready at serve time. Plans stay in memory (plan_id), expire after 8 hours, and are not written to disk. Your recipe's times win. " +
        OUT_OF_SCOPE,
    },
  );

  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const MUTABLE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "find_dish",
    {
      title: "Find a dish by spoken name",
      description: `Look up a common home dish by name and return typical prep, cook, rest, and hold times. Ask to confirm when more than one dish matches. Your recipe's times win. ${OUT_OF_SCOPE}`,
      inputSchema: z.object({
        name: z.string().min(1).max(128).describe("Spoken dish name or alias"),
      }),
      outputSchema: z.object({
        matches: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            score: z.number(),
            typical: z.string(),
          }),
        ),
        ambiguous: z.boolean(),
        ...commonOut,
      }),
      annotations: READ_ONLY,
    },
    guarded(({ name }) => {
      const matches = findDishesByName(name).slice(0, 5);
      if (matches.length === 0) {
        return toolResult({
          matches: [],
          ambiguous: false,
          summary: `No dish matched "${name}". Try a simpler name like chicken or potatoes.`,
          card: [`No match for ${name}.`, DONENESS],
        });
      }
      const ambiguous =
        matches.length > 1 &&
        (matches[0]!.score < 100 || matches[0]!.score === matches[1]!.score);
      const rows = matches.map((m) => ({
        id: m.dish.id,
        name: m.matched_name,
        score: m.score,
        typical: typicalSummary(m.dish),
      }));
      const summary = ambiguous
        ? `I found ${rows.map((r) => r.name).join(", ")}. Which one did you mean?`
        : rows[0]!.typical;
      return toolResult({
        matches: rows,
        ambiguous,
        summary,
        card: rows.map((r) => `${r.id}: ${r.typical}`).concat([DONENESS]),
      });
    }),
  );

  server.registerTool(
    "plan_meal",
    {
      title: "Plan a multi-dish meal timeline",
      description: `Build a timing plan so every dish is ready at serve time. Pass dish ids from find_dish. If serve_at or ovens are missing, asks via elicitation when the client supports it; otherwise returns needs with one question. Does not change a dish's temperature or cook time on its own. ${OUT_OF_SCOPE}`,
      inputSchema: z.object({
        dishes: z
          .array(
            z.union([
              z.string(),
              z.object({
                id: z.string().optional(),
                name: z.string().optional(),
                overrides: overrideSchema.optional(),
              }),
            ]),
          )
          .min(1)
          .max(20),
        serve_at: z.string().min(1).max(64).optional().describe("Local HH:MM or ISO timestamp"),
        timezone: z.string().min(1).max(64).optional().describe("IANA timezone"),
        ovens: z.number().int().min(1).max(2).optional(),
        burners: z.number().int().min(1).max(8).optional(),
        cooks: z.number().int().min(1).max(2).optional(),
        units: z.enum(["F", "C"]).optional(),
        now: z.string().min(1).max(64).optional().describe("ISO timestamp for 'now'; defaults to the server clock"),
      }),
      outputSchema: z.object({
        plan_id: z.string().optional(),
        plan_token: z.string().optional(),
        feasible: z.boolean().optional(),
        needs: z.array(z.string()).optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
        warnings: z.array(z.string()).optional(),
        question: z.string().optional(),
        reason: z.string().optional(),
        conflicts: z
          .array(z.object({ type: z.string(), dishes: z.array(z.string()) }))
          .optional(),
        serve_at_local: z.string().optional(),
        timezone: z.string().optional(),
        changed: z.string().optional(),
        ...commonOut,
      }),
      annotations: MUTABLE,
    },
    guarded(async (args, ctx) => {
      let serve_at = args.serve_at;
      let ovens = args.ovens;
      const missing: Array<"serve_at" | "ovens"> = [];
      if (!serve_at) missing.push("serve_at");
      if (ovens == null) missing.push("ovens");

      if (missing.length) {
        const elicited = await elicitMissing(ctx as ElicitCtx, missing);
        if (elicited === "needs" || elicited === "declined") {
          const question =
            missing[0] === "serve_at"
              ? "What time should dinner be served?"
              : "How many ovens do you have, 1 or 2?";
          return toolResult({
            needs: missing,
            summary: question,
            card: [question, DONENESS],
          });
        }
        if (!serve_at && elicited.serve_at) serve_at = elicited.serve_at;
        if (ovens == null && elicited.ovens != null) ovens = elicited.ovens;
        if (!serve_at || ovens == null) {
          const still: string[] = [];
          if (!serve_at) still.push("serve_at");
          if (ovens == null) still.push("ovens");
          const question =
            still[0] === "serve_at"
              ? "What time should dinner be served?"
              : "How many ovens do you have, 1 or 2?";
          return toolResult({ needs: still, summary: question, card: [question, DONENESS] });
        }
      }

      const parsed = parseDishList(args.dishes as Array<{ id?: string; name?: string; overrides?: DishOverride } | string>);
      if (!parsed.ok) return toolResult({ summary: parsed.summary, card: parsed.card }, true);

      const cookNeeds = dishesNeedingRecipeCookMin(parsed.dishes);
      if (cookNeeds.length > 0) {
        const question = "How long does your recipe say to roast it?";
        return toolResult({
          needs: cookNeeds,
          summary: question,
          card: [question, DONENESS],
        });
      }

      const input: SolverInput = {
        dishes: parsed.dishes,
        serve_at: serve_at!,
        timezone: args.timezone ?? "America/New_York",
        ovens: ovens!,
        burners: args.burners ?? 4,
        cooks: args.cooks ?? 1,
        units: (args.units ?? "F") as TempUnits,
      };
      const result = solveMeal(input, resolveNowMs(args.now));
      const plan = storePlan(input, result);
      return toolResult(planPayload(plan));
    }),
  );

  server.registerTool(
    "whats_next",
    {
      title: "Current and next step for a plan",
      description: `Return the current step, the next step, and minutes until the next one for a plan_id. ${OUT_OF_SCOPE}`,
      inputSchema: z.object({
        plan_id: z.string().min(1).max(64),
        now: z.string().min(1).max(64).optional().describe("ISO timestamp for 'now'; defaults to the server clock"),
      }),
      outputSchema: z.object({
        current: z.record(z.string(), z.unknown()).nullable(),
        next: z.record(z.string(), z.unknown()).nullable(),
        minutes_until_next: z.number().nullable(),
        ...commonOut,
      }),
      annotations: READ_ONLY,
    },
    guarded(({ plan_id, now }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolResult({
          current: null,
          next: null,
          minutes_until_next: null,
          summary: "I could not find that plan. It may have expired. Use resume_plan with your plan_token.",
          card: ["Plan not found.", DONENESS],
        });
      }
      const tz = plan.input.timezone;
      const nowMs = resolveNowMs(now);
      const nowLocal = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(nowMs));
      const steps = plan.result.steps;
      let current = null;
      let next = null;
      for (const step of steps) {
        if (step.at <= nowLocal) current = step;
        if (step.at > nowLocal) {
          next = step;
          break;
        }
      }
      const minutes_until_next = next ? stepMinutesUntil(next.at, nowLocal) : null;
      const summary = next
        ? `Now: ${current ? current.action : "waiting"}. Next: ${next.action} at ${next.at}, in ${minutes_until_next} minutes.`
        : `All steps are done or it is serve time. ${DONENESS}`;
      return toolResult({
        current,
        next,
        minutes_until_next,
        summary,
        card: [
          current ? `Current: ${current.at} ${current.action}` : "Current: none",
          next ? `Next: ${next.at} ${next.action} (${minutes_until_next} min)` : "Next: none",
          DONENESS,
        ],
      });
    }),
  );

  server.registerTool(
    "running_late",
    {
      title: "Replan when a dish is behind",
      description: `Mark a dish as running late by a number of minutes and replan looking forward from now. Moves that dish's ready time later; never shortens a cook time. May ask to push serve time. ${OUT_OF_SCOPE}`,
      inputSchema: z.object({
        plan_id: z.string().min(1).max(64),
        dish: z.string().min(1).max(64).describe("Dish id or name"),
        minutes: z.number().positive().max(180),
        now: z.string().min(1).max(64).optional().describe("ISO timestamp for 'now'; defaults to the server clock"),
      }),
      outputSchema: z.object({
        plan_id: z.string().optional(),
        plan_token: z.string().optional(),
        changed: z.string().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
        warnings: z.array(z.string()).optional(),
        feasible: z.boolean().optional(),
        reason: z.string().optional(),
        question: z.string().optional(),
        serve_at_local: z.string().optional(),
        timezone: z.string().optional(),
        ...commonOut,
      }),
      annotations: MUTABLE,
    },
    guarded(({ plan_id, dish, minutes, now }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolResult({
          summary: "I could not find that plan. Use resume_plan with your plan_token.",
          card: ["Plan not found.", DONENESS],
        });
      }
      const matches = findDishesByName(dish);
      const byId = getDishById(dish);
      const dishId = byId?.id ?? matches[0]?.dish.id;
      if (!dishId || !plan.input.dishes.some((d) => d.id === dishId)) {
        return toolResult({
          summary: "That dish is not on this plan. Name a dish from the menu.",
          card: ["Dish not on plan.", DONENESS],
        });
      }
      const nowMs = resolveNowMs(now);
      const result = applyRunningLate(plan.input, dishId, minutes, nowMs);
      const name = getDishById(dishId)!.names[0];
      // Persist the proposed serve time when we ask to push dinner.
      const pushedServe = result.serve_at_local || plan.input.serve_at;
      const input: SolverInput = { ...plan.input, serve_at: pushedServe };
      const updated = replacePlan(plan_id, input, result)!;
      const changed = result.question
        ? `${name} is ${minutes} minutes late. ${result.question}`
        : `${name} is ${minutes} minutes late; cook times were left as set.`;
      return toolResult({
        ...planPayload(updated),
        changed,
        summary: result.summary,
      });
    }),
  );

  server.registerTool(
    "change_menu",
    {
      title: "Add or remove dishes and replan",
      description: `Change the menu for an existing plan_id: add dishes, remove dishes, or apply time overrides, then replan. Does not invent new cook times. ${OUT_OF_SCOPE}`,
      inputSchema: z.object({
        plan_id: z.string().min(1).max(64),
        add: z.array(z.union([z.string(), dishRefSchema])).optional(),
        remove: z.array(z.string()).optional(),
        overrides: z.record(z.string(), overrideSchema).optional(),
        now: z.string().min(1).max(64).optional().describe("ISO timestamp for 'now'; defaults to the server clock"),
      }),
      outputSchema: z.object({
        plan_id: z.string().optional(),
        plan_token: z.string().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
        warnings: z.array(z.string()).optional(),
        feasible: z.boolean().optional(),
        reason: z.string().optional(),
        question: z.string().optional(),
        serve_at_local: z.string().optional(),
        timezone: z.string().optional(),
        ...commonOut,
      }),
      annotations: MUTABLE,
    },
    guarded(({ plan_id, add, remove, overrides, now }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolResult({
          summary: "I could not find that plan. Use resume_plan with your plan_token.",
          card: ["Plan not found.", DONENESS],
        });
      }
      let dishes = [...plan.input.dishes];
      if (remove?.length) {
        const removeIds = new Set(
          remove.map((r) => getDishById(r)?.id ?? findDishesByName(r)[0]?.dish.id).filter(Boolean) as string[],
        );
        dishes = dishes.filter((d) => !removeIds.has(d.id));
      }
      if (add?.length) {
        const parsed = parseDishList(add as Array<{ id?: string; name?: string; overrides?: DishOverride } | string>);
        if (!parsed.ok) return toolResult({ summary: parsed.summary, card: parsed.card }, true);
        for (const d of parsed.dishes) {
          if (!dishes.some((x) => x.id === d.id)) dishes.push(d);
        }
      }
      if (overrides) {
        dishes = dishes.map((d) => {
          const o = overrides[d.id];
          if (!o) return d;
          return { id: d.id, overrides: { ...d.overrides, ...o } };
        });
      }
      if (dishes.length === 0) {
        return toolResult({
          summary: "The menu is empty after those changes. Add a dish to replan.",
          card: ["Empty menu.", DONENESS],
        });
      }
      const cookNeeds = dishesNeedingRecipeCookMin(dishes);
      if (cookNeeds.length > 0) {
        const question = "How long does your recipe say to roast it?";
        return toolResult({
          needs: cookNeeds,
          summary: question,
          card: [question, DONENESS],
        });
      }
      const input: SolverInput = { ...plan.input, dishes };
      const result = solveMeal(input, resolveNowMs(now));
      const updated = replacePlan(plan_id, input, result)!;
      return toolResult(planPayload(updated));
    }),
  );

  server.registerTool(
    "read_plan",
    {
      title: "Read the full plan card",
      description: `Return the full screen card and summary for a plan_id. ${OUT_OF_SCOPE}`,
      inputSchema: z.object({
        plan_id: z.string().min(1).max(64),
      }),
      outputSchema: z.object({
        plan_id: z.string().optional(),
        plan_token: z.string().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
        warnings: z.array(z.string()).optional(),
        feasible: z.boolean().optional(),
        reason: z.string().optional(),
        question: z.string().optional(),
        serve_at_local: z.string().optional(),
        timezone: z.string().optional(),
        ...commonOut,
      }),
      annotations: READ_ONLY,
    },
    guarded(({ plan_id }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolResult({
          summary: "I could not find that plan. Use resume_plan with your plan_token.",
          card: ["Plan not found.", DONENESS],
        });
      }
      return toolResult(planPayload(plan));
    }),
  );

  server.registerTool(
    "resume_plan",
    {
      title: "Resume a plan from plan_token after restart",
      description: `Rebuild a plan from plan_token after a server restart. The token holds dish ids, overrides, serve time, timezone, ovens, burners, cooks, and units — not the timeline and not free text. ${OUT_OF_SCOPE}`,
      inputSchema: z.object({
        plan_token: z.string().min(1).max(4096),
      }),
      outputSchema: z.object({
        plan_id: z.string().optional(),
        plan_token: z.string().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
        warnings: z.array(z.string()).optional(),
        feasible: z.boolean().optional(),
        reason: z.string().optional(),
        question: z.string().optional(),
        serve_at_local: z.string().optional(),
        timezone: z.string().optional(),
        ...commonOut,
      }),
      annotations: MUTABLE,
    },
    guarded(({ plan_token }) => {
      const plan = rebuildFromToken(plan_token);
      if (!plan) {
        return toolResult({
          summary: "That plan_token could not be read. Plan a meal again.",
          card: ["Bad plan_token.", DONENESS],
        });
      }
      return toolResult({
        ...planPayload(plan),
        summary: `Resumed your meal plan. ${plan.result.summary}`,
      });
    }),
  );

  return server;
}
