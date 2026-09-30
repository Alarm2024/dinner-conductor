import { randomBytes } from "node:crypto";
import type { DishOverride, SolverInput, SolverResult, TempUnits } from "./solver.js";
import { solveMeal } from "./solver.js";

export const PLAN_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_PLANS = 1000;

export interface StoredPlan {
  plan_id: string;
  plan_token: string;
  created_ms: number;
  input: SolverInput;
  result: SolverResult;
}

/** Compact inputs encoded in plan_token — never the timeline, never free text. */
export interface PlanTokenPayload {
  dishes: Array<{ id: string; overrides?: DishOverride }>;
  serve_at: string;
  timezone: string;
  ovens: number;
  burners: number;
  cooks: number;
  units: TempUnits;
}

const plans = new Map<string, StoredPlan>();

function purgeExpired(now = Date.now()): void {
  for (const [id, plan] of plans) {
    if (now - plan.created_ms > PLAN_TTL_MS) plans.delete(id);
  }
}

export function clearPlansForTests(): void {
  plans.clear();
}

export function encodePlanToken(payload: PlanTokenPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodePlanToken(token: string): PlanTokenPayload | null {
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as PlanTokenPayload;
    if (!parsed || !Array.isArray(parsed.dishes) || typeof parsed.serve_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function makePlanId(): string {
  return randomBytes(16).toString("hex");
}

export function storePlan(input: SolverInput, result: SolverResult, now = Date.now()): StoredPlan {
  purgeExpired(now);
  while (plans.size >= MAX_PLANS) {
    // Drop the oldest plan.
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, p] of plans) {
      if (p.created_ms < oldest) {
        oldest = p.created_ms;
        oldestId = id;
      }
    }
    if (oldestId) plans.delete(oldestId);
    else break;
  }
  const payload: PlanTokenPayload = {
    dishes: input.dishes.map((d) => ({ id: d.id, overrides: d.overrides })),
    serve_at: input.serve_at,
    timezone: input.timezone,
    ovens: input.ovens,
    burners: input.burners,
    cooks: input.cooks,
    units: input.units,
  };
  const plan: StoredPlan = {
    plan_id: makePlanId(),
    plan_token: encodePlanToken(payload),
    created_ms: now,
    input,
    result,
  };
  plans.set(plan.plan_id, plan);
  return plan;
}

export function getPlan(planId: string, now = Date.now()): StoredPlan | null {
  purgeExpired(now);
  const plan = plans.get(planId);
  if (!plan) return null;
  if (now - plan.created_ms > PLAN_TTL_MS) {
    plans.delete(planId);
    return null;
  }
  return plan;
}

export function replacePlan(planId: string, input: SolverInput, result: SolverResult, now = Date.now()): StoredPlan | null {
  const existing = getPlan(planId, now);
  if (!existing) return null;
  const payload: PlanTokenPayload = {
    dishes: input.dishes.map((d) => ({ id: d.id, overrides: d.overrides })),
    serve_at: input.serve_at,
    timezone: input.timezone,
    ovens: input.ovens,
    burners: input.burners,
    cooks: input.cooks,
    units: input.units,
  };
  const updated: StoredPlan = {
    plan_id: planId,
    plan_token: encodePlanToken(payload),
    created_ms: existing.created_ms,
    input,
    result,
  };
  plans.set(planId, updated);
  return updated;
}

export function rebuildFromToken(token: string, now = Date.now()): StoredPlan | null {
  const payload = decodePlanToken(token);
  if (!payload) return null;
  const input: SolverInput = {
    dishes: payload.dishes,
    serve_at: payload.serve_at,
    timezone: payload.timezone,
    ovens: payload.ovens,
    burners: payload.burners,
    cooks: payload.cooks,
    units: payload.units,
  };
  const result = solveMeal(input, now);
  return storePlan(input, result, now);
}

export function planCount(): number {
  purgeExpired();
  return plans.size;
}
