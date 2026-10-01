import type { Dish, HandsOnSegment, OvenTemp } from "./dishes.js";
import { getDishById } from "./dishes.js";

export type TempUnits = "F" | "C";

export interface DishOverride {
  prep_min?: number;
  cook_min?: number;
  rest_min?: number;
  hold_min?: number;
  oven_temp_f?: number;
  oven_temp_c?: number;
  oven_units?: number;
  burners?: number;
}

export interface PlanDishInput {
  id: string;
  overrides?: DishOverride;
}

export interface SolverInput {
  dishes: PlanDishInput[];
  serve_at: string;
  timezone: string;
  ovens: number;
  burners: number;
  cooks: number;
  units: TempUnits;
}

export interface PlanStep {
  at: string;
  dish: string;
  dish_id: string;
  action: string;
  hands_on: boolean;
  appliance: string;
  temp: string | null;
}

export interface SolverResult {
  feasible: boolean;
  reason?: string;
  question?: string;
  steps: PlanStep[];
  warnings: string[];
  summary: string;
  card: string[];
  serve_at_local: string;
  timezone: string;
}

interface ResolvedDish {
  id: string;
  name: string;
  prep_min: number;
  cook_min: number;
  rest_min: number;
  hold_min: number;
  hands_on: HandsOnSegment[];
  appliance: Dish["appliance"];
  oven_temp: OvenTemp | null;
  oven_units: number;
  burners: number;
  total_min: number;
}

interface Placement {
  dish: ResolvedDish;
  /** Absolute ms when prep starts. */
  start_ms: number;
  /** Absolute ms when dish is ready (end of rest). */
  ready_ms: number;
  oven_index: number | null;
}

const DONENESS = "Check doneness with your recipe and a thermometer.";

function getZoneParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = getZoneParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/** Convert a civil local time in `timeZone` to UTC epoch ms. */
export function zonedLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  utc -= zoneOffsetMs(new Date(utc), timeZone);
  utc = Date.UTC(year, month - 1, day, hour, minute, 0) - zoneOffsetMs(new Date(utc), timeZone);
  return utc;
}

export function formatLocalTime(ms: number, timeZone: string): string {
  const p = getZoneParts(new Date(ms), timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export type ServeAtParse =
  | { ok: true; ms: number; hhmm: string; was_hhmm: boolean; past_today: boolean }
  | { ok: false; error: string };

/** Parse serve_at. HH:MM is always today in the timezone; past_today is set when that instant is before now. */
export function parseServeAtDetailed(serveAt: string, timeZone: string, nowMs = Date.now()): ServeAtParse {
  const trimmed = serveAt.trim();
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    const [hh, mm] = trimmed.split(":").map(Number);
    const hhmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const parts = getZoneParts(new Date(nowMs), timeZone);
    const ms = zonedLocalToUtcMs(parts.year, parts.month, parts.day, hh, mm, timeZone);
    return { ok: true, ms, hhmm, was_hhmm: true, past_today: ms < nowMs - 500 };
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, error: "bad_serve_at" };
  return {
    ok: true,
    ms: parsed,
    hhmm: formatLocalTime(parsed, timeZone),
    was_hhmm: false,
    past_today: parsed < nowMs - 500,
  };
}

/** Resolve HH:MM or ISO to epoch ms. Rolls HH:MM to tomorrow when already past (legacy helper for tests). */
export function parseServeAt(serveAt: string, timeZone: string, nowMs = Date.now()): number {
  const parsed = parseServeAtDetailed(serveAt, timeZone, nowMs);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.was_hhmm && parsed.past_today) {
    const parts = getZoneParts(new Date(parsed.ms), timeZone);
    const localTomorrow = new Date(zonedLocalToUtcMs(parts.year, parts.month, parts.day, 12, 0, timeZone) + 24 * 3600_000);
    const np = getZoneParts(localTomorrow, timeZone);
    const [hh, mm] = parsed.hhmm.split(":").map(Number);
    return zonedLocalToUtcMs(np.year, np.month, np.day, hh, mm, timeZone);
  }
  return parsed.ms;
}

/** Tomorrow's civil date for the same HH:MM in a timezone. */
export function tomorrowServeMs(hhmm: string, timeZone: string, nowMs: number): number {
  const [hh, mm] = hhmm.split(":").map(Number);
  const parts = getZoneParts(new Date(nowMs), timeZone);
  const localTomorrow = new Date(zonedLocalToUtcMs(parts.year, parts.month, parts.day, 12, 0, timeZone) + 24 * 3600_000);
  const np = getZoneParts(localTomorrow, timeZone);
  return zonedLocalToUtcMs(np.year, np.month, np.day, hh, mm, timeZone);
}

function resolveDish(input: PlanDishInput): ResolvedDish {
  const base = getDishById(input.id);
  if (!base) throw new Error(`unknown_dish:${input.id}`);
  const o = input.overrides ?? {};
  const prep_min = o.prep_min ?? base.prep_min;
  const cook_min = o.cook_min ?? base.cook_min.typical;
  const rest_min = o.rest_min ?? base.rest_min;
  const hold_min = o.hold_min ?? base.hold_min;
  let oven_temp = base.oven_temp;
  if (o.oven_temp_f != null || o.oven_temp_c != null) {
    const f = o.oven_temp_f ?? (o.oven_temp_c != null ? Math.round((o.oven_temp_c * 9) / 5 + 32) : null);
    const c = o.oven_temp_c ?? (o.oven_temp_f != null ? Math.round(((o.oven_temp_f - 32) * 5) / 9) : null);
    if (f != null && c != null) oven_temp = { f, c };
  }
  return {
    id: base.id,
    name: base.names[0] ?? base.id,
    prep_min,
    cook_min,
    rest_min,
    hold_min,
    hands_on: base.hands_on.map((h) => ({ ...h })),
    appliance: base.appliance,
    oven_temp,
    oven_units: o.oven_units ?? base.oven_units,
    burners: o.burners ?? base.burners,
    total_min: prep_min + cook_min + rest_min,
  };
}

function tempLabel(temp: OvenTemp | null, units: TempUnits): string | null {
  if (!temp) return null;
  return units === "C" ? `${temp.c} C` : `${temp.f} F`;
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

interface Interval {
  start: number;
  end: number;
  dish_id: string;
  kind: string;
  temp_f?: number;
  units?: number;
  burners?: number;
}

function cookInterval(p: Placement): { start: number; end: number } {
  const start = p.start_ms + p.dish.prep_min * 60_000;
  const end = start + p.dish.cook_min * 60_000;
  return { start, end };
}

function prepInterval(p: Placement): { start: number; end: number } {
  return { start: p.start_ms, end: p.start_ms + p.dish.prep_min * 60_000 };
}

function handsOnIntervals(p: Placement): Interval[] {
  return p.dish.hands_on
    .filter((h) => h.minutes > 0)
    .map((h) => ({
      start: p.start_ms + h.offset_min * 60_000,
      end: p.start_ms + (h.offset_min + h.minutes) * 60_000,
      dish_id: p.dish.id,
      kind: "hands_on",
    }));
}

interface Conflict {
  type: "hands_on" | "oven_temp" | "oven_racks" | "burners" | "hold";
  dish_ids: string[];
  detail: string;
}

function findConflicts(placements: Placement[], serveMs: number, input: SolverInput): Conflict[] {
  const out: Conflict[] = [];

  for (const p of placements) {
    const earliest = serveMs - p.dish.hold_min * 60_000;
    if (p.ready_ms < earliest - 500 || p.ready_ms > serveMs + 500) {
      out.push({
        type: "hold",
        dish_ids: [p.dish.id],
        detail: `${p.dish.name} finishes outside its hold window.`,
      });
    }
  }

  // Hands-on concurrency
  const hands = placements.flatMap(handsOnIntervals).sort((a, b) => a.start - b.start || a.dish_id.localeCompare(b.dish_id));
  const events: Array<{ t: number; delta: number; id: string }> = [];
  for (const h of hands) {
    events.push({ t: h.start, delta: 1, id: h.dish_id });
    events.push({ t: h.end, delta: -1, id: h.dish_id });
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta || a.id.localeCompare(b.id));
  let active = 0;
  const activeIds = new Set<string>();
  for (const ev of events) {
    if (ev.delta > 0) {
      active += 1;
      activeIds.add(ev.id);
      if (active > input.cooks) {
        out.push({
          type: "hands_on",
          dish_ids: [...activeIds].sort(),
          detail: `Need more than ${input.cooks} cook${input.cooks === 1 ? "" : "s"} for hands-on work at the same time.`,
        });
        break;
      }
    } else {
      active -= 1;
      activeIds.delete(ev.id);
    }
  }

  // Burners
  type BurnerUse = { start: number; end: number; n: number; id: string };
  const burnerUses: BurnerUse[] = [];
  for (const p of placements) {
    if (p.dish.burners <= 0) continue;
    if (p.dish.appliance === "stovetop") {
      const c = cookInterval(p);
      if (c.end > c.start) burnerUses.push({ start: c.start, end: c.end, n: p.dish.burners, id: p.dish.id });
    } else {
      const pr = prepInterval(p);
      if (pr.end > pr.start) burnerUses.push({ start: pr.start, end: pr.end, n: p.dish.burners, id: p.dish.id });
    }
  }
  const bEvents: Array<{ t: number; delta: number; id: string }> = [];
  for (const b of burnerUses) {
    bEvents.push({ t: b.start, delta: b.n, id: b.id });
    bEvents.push({ t: b.end, delta: -b.n, id: b.id });
  }
  bEvents.sort((a, b) => a.t - b.t || a.delta - b.delta || a.id.localeCompare(b.id));
  let burnersOn = 0;
  const burnerIds = new Set<string>();
  for (const ev of bEvents) {
    if (ev.delta > 0) burnerIds.add(ev.id);
    burnersOn += ev.delta;
    if (ev.delta < 0) burnerIds.delete(ev.id);
    if (burnersOn > input.burners) {
      out.push({
        type: "burners",
        dish_ids: [...burnerIds].sort(),
        detail: `Need more than ${input.burners} burners at the same time.`,
      });
      break;
    }
  }

  // Ovens: per oven index, temp must be unique at a time; units <= 2
  for (let oi = 0; oi < input.ovens; oi++) {
    const onOven = placements.filter((p) => p.oven_index === oi && p.dish.appliance === "oven" && p.dish.cook_min > 0);
    const oEvents: Array<{ t: number; deltaUnits: number; temp: number; id: string; open: boolean }> = [];
    for (const p of onOven) {
      const c = cookInterval(p);
      const temp = p.dish.oven_temp?.f ?? 0;
      oEvents.push({ t: c.start, deltaUnits: p.dish.oven_units, temp, id: p.dish.id, open: true });
      oEvents.push({ t: c.end, deltaUnits: -p.dish.oven_units, temp, id: p.dish.id, open: false });
    }
    oEvents.sort((a, b) => a.t - b.t || Number(a.open) - Number(b.open) || a.id.localeCompare(b.id));
    let units = 0;
    const temps = new Map<string, number>();
    for (const ev of oEvents) {
      if (ev.open) {
        temps.set(ev.id, ev.temp);
        units += ev.deltaUnits;
      } else {
        temps.delete(ev.id);
        units += ev.deltaUnits;
      }
      const distinct = new Set(temps.values());
      if (distinct.size > 1) {
        const ids = [...temps.keys()].sort();
        const names = ids.map((id) => placements.find((p) => p.dish.id === id)?.dish.name ?? id);
        out.push({
          type: "oven_temp",
          dish_ids: ids,
          detail: `${names.join(" and ")} need different oven temperatures at the same time.`,
        });
        break;
      }
      if (units > 2) {
        out.push({
          type: "oven_racks",
          dish_ids: [...temps.keys()].sort(),
          detail: `Oven ${oi + 1} needs more than 2 rack units at the same time.`,
        });
        break;
      }
    }
  }

  // Deduplicate similar conflicts
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.type}:${c.dish_ids.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignOvens(placements: Placement[], ovens: number): void {
  // Clear and greedily assign oven indices for oven dishes.
  for (const p of placements) {
    if (p.dish.appliance !== "oven" || p.dish.cook_min <= 0) {
      p.oven_index = null;
      continue;
    }
    const c = cookInterval(p);
    const temp = p.dish.oven_temp?.f ?? 0;
    let best: number | null = null;
    for (let oi = 0; oi < ovens; oi++) {
      const others = placements.filter(
        (q) => q !== p && q.oven_index === oi && q.dish.appliance === "oven" && q.dish.cook_min > 0,
      );
      let units = p.dish.oven_units;
      let tempOk = true;
      for (const q of others) {
        const qc = cookInterval(q);
        if (!overlaps(c.start, c.end, qc.start, qc.end)) continue;
        units += q.dish.oven_units;
        if ((q.dish.oven_temp?.f ?? 0) !== temp) tempOk = false;
      }
      if (tempOk && units <= 2) {
        best = oi;
        break;
      }
    }
    if (best === null) {
      // Leave unassigned index 0 as fallback so conflict detection still sees overlap on oven 0.
      // Try any oven with free time even if temp differs (conflict will surface).
      for (let oi = 0; oi < ovens; oi++) {
        const others = placements.filter(
          (q) => q !== p && q.oven_index === oi && q.dish.appliance === "oven" && q.dish.cook_min > 0,
        );
        let units = p.dish.oven_units;
        for (const q of others) {
          const qc = cookInterval(q);
          if (overlaps(c.start, c.end, qc.start, qc.end)) units += q.dish.oven_units;
        }
        if (units <= 2) {
          best = oi;
          break;
        }
      }
    }
    p.oven_index = best ?? 0;
  }
}

function shiftEarlier(p: Placement, minutes: number): void {
  const delta = minutes * 60_000;
  p.start_ms -= delta;
  p.ready_ms -= delta;
}

function remainingHold(p: Placement, serveMs: number): number {
  const earliest = serveMs - p.dish.hold_min * 60_000;
  return Math.floor((p.ready_ms - earliest) / 60_000);
}

function conflictQuestion(conflict: Conflict, placements: Placement[]): string {
  const names = conflict.dish_ids.map((id) => placements.find((p) => p.dish.id === id)?.dish.name ?? id);
  if (conflict.type === "oven_temp" && names.length >= 2) {
    const a = placements.find((p) => p.dish.id === conflict.dish_ids[0])!;
    const b = placements.find((p) => p.dish.id === conflict.dish_ids[1])!;
    const holdable = [a, b].sort((x, y) => y.dish.hold_min - x.dish.hold_min || x.dish.id.localeCompare(y.dish.id))[0];
    const other = holdable === a ? b : a;
    return `${names[0]} and ${names[1]} need different oven temperatures at the same time. ${holdable.dish.name} can bake while ${other.dish.name} rests. Is that OK?`;
  }
  if (conflict.type === "hands_on") {
    return `${names.join(" and ")} need hands-on work at the same time. Can one dish wait, or is a second cook available?`;
  }
  if (conflict.type === "burners") {
    return `${names.join(" and ")} need more burners than are free. Can one dish start earlier?`;
  }
  if (conflict.type === "oven_racks") {
    return `${names.join(" and ")} need more oven rack space than is free. Can one dish bake earlier?`;
  }
  return `${conflict.detail} What should change?`;
}

function buildSteps(placements: Placement[], serveMs: number, input: SolverInput): PlanStep[] {
  const steps: PlanStep[] = [];
  const sorted = [...placements].sort((a, b) => a.start_ms - b.start_ms || a.dish.id.localeCompare(b.dish.id));

  for (const p of sorted) {
    if (p.dish.prep_min > 0 || p.dish.hands_on.some((h) => h.offset_min === 0 && h.minutes > 0)) {
      const label = p.dish.hands_on.find((h) => h.offset_min === 0)?.label ?? "prep";
      steps.push({
        at: formatLocalTime(p.start_ms, input.timezone),
        dish: p.dish.name,
        dish_id: p.dish.id,
        action: `Start ${label}`,
        hands_on: true,
        appliance: p.dish.appliance === "none" ? "counter" : p.dish.appliance,
        temp: null,
      });
    }

    if (p.dish.cook_min > 0) {
      const c = cookInterval(p);
      const action =
        p.dish.appliance === "oven"
          ? `Bake ${p.dish.name}`
          : p.dish.appliance === "stovetop"
            ? `Cook ${p.dish.name}`
            : `Finish ${p.dish.name}`;
      steps.push({
        at: formatLocalTime(c.start, input.timezone),
        dish: p.dish.name,
        dish_id: p.dish.id,
        action,
        hands_on: false,
        appliance: p.dish.appliance,
        temp: tempLabel(p.dish.oven_temp, input.units),
      });
    }

    for (const h of p.dish.hands_on) {
      if (h.offset_min === 0) continue;
      if (h.minutes <= 0) continue;
      steps.push({
        at: formatLocalTime(p.start_ms + h.offset_min * 60_000, input.timezone),
        dish: p.dish.name,
        dish_id: p.dish.id,
        action: h.label,
        hands_on: true,
        appliance: p.dish.appliance === "none" ? "counter" : p.dish.appliance,
        temp: null,
      });
    }

    if (p.dish.rest_min > 0) {
      const restStart = p.ready_ms - p.dish.rest_min * 60_000;
      steps.push({
        at: formatLocalTime(restStart, input.timezone),
        dish: p.dish.name,
        dish_id: p.dish.id,
        action: `Rest ${p.dish.name}`,
        hands_on: false,
        appliance: "none",
        temp: null,
      });
    }

    steps.push({
      at: formatLocalTime(p.ready_ms, input.timezone),
      dish: p.dish.name,
      dish_id: p.dish.id,
      action: p.ready_ms < serveMs - 30_000 ? `Hold ${p.dish.name} warm` : `${p.dish.name} ready`,
      hands_on: false,
      appliance: "none",
      temp: null,
    });
  }

  steps.push({
    at: formatLocalTime(serveMs, input.timezone),
    dish: "meal",
    dish_id: "meal",
    action: "Serve",
    hands_on: false,
    appliance: "none",
    temp: null,
  });

  steps.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.dish_id.localeCompare(b.dish_id) || a.action.localeCompare(b.action);
  });
  return steps;
}

function buildCard(steps: PlanStep[], feasible: boolean, warnings: string[]): string[] {
  const lines = steps.filter((s) => s.action !== "Serve" || true).map((s) => {
    const temp = s.temp ? ` (${s.temp})` : "";
    return `${s.at} — ${s.action}${temp}`;
  });
  if (!feasible) lines.unshift("Plan does not fit as requested.");
  for (const w of warnings) lines.push(`Note: ${w}`);
  lines.push(DONENESS);
  return lines;
}

function spokenSummary(placements: Placement[], serveMs: number, input: SolverInput, feasible: boolean, question?: string): string {
  if (!feasible && question) {
    return question;
  }
  if (!feasible) {
    return "This meal plan does not fit with the ovens and cooks available.";
  }
  const names = placements.map((p) => p.dish.name);
  const list =
    names.length <= 1
      ? names[0] ?? "dinner"
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const start = Math.min(...placements.map((p) => p.start_ms));
  return `For ${list} at ${formatLocalTime(serveMs, input.timezone)}, start at ${formatLocalTime(start, input.timezone)}. ${DONENESS}`;
}

/**
 * Pure deterministic meal timing solver. Same input always yields the same plan.
 * Never changes a dish's temperature or cook time; if the plan does not fit, returns a reason and one question.
 */
export function solveMeal(raw: SolverInput, nowMs = Date.now()): SolverResult {
  const input: SolverInput = {
    dishes: [...raw.dishes].sort((a, b) => a.id.localeCompare(b.id)),
    serve_at: raw.serve_at,
    timezone: raw.timezone,
    ovens: Math.max(1, Math.min(2, raw.ovens)),
    burners: Math.max(1, raw.burners),
    cooks: Math.max(1, Math.min(2, raw.cooks)),
    units: raw.units === "C" ? "C" : "F",
  };

  const parsedServe = parseServeAtDetailed(input.serve_at, input.timezone, nowMs);
  if (!parsedServe.ok) {
    return {
      feasible: false,
      reason: "Could not read serve time. Use HH:MM or an ISO timestamp.",
      question: "What time should dinner be served?",
      steps: [],
      warnings: [],
      summary: "What time should dinner be served?",
      card: ["Could not read serve time.", DONENESS],
      serve_at_local: input.serve_at,
      timezone: input.timezone,
    };
  }

  if (parsedServe.past_today) {
    const q = `Did you mean ${parsedServe.hhmm} tomorrow?`;
    return {
      feasible: false,
      reason: `Serve time ${parsedServe.hhmm} has already passed today.`,
      question: q,
      steps: [],
      warnings: [],
      summary: q,
      card: [q, DONENESS],
      serve_at_local: parsedServe.hhmm,
      timezone: input.timezone,
    };
  }

  const serveMs = parsedServe.ms;

  const resolved = input.dishes.map(resolveDish);
  // Stable order: longer total first, then id (already sorted ids in input, re-sort by duration).
  resolved.sort((a, b) => b.total_min - a.total_min || a.id.localeCompare(b.id));

  let placements: Placement[] = resolved.map((dish) => {
    const ready_ms = serveMs;
    const start_ms = ready_ms - dish.total_min * 60_000;
    return { dish, start_ms, ready_ms, oven_index: null };
  });
  assignOvens(placements, input.ovens);

  const warnings: string[] = ["Your recipe's times win over these typical times."];

  // Resolve conflicts by shifting hold-capable dishes earlier (sequencing).
  const maxPasses = 500;
  for (let pass = 0; pass < maxPasses; pass++) {
    const conflicts = findConflicts(placements, serveMs, input);
    if (conflicts.length === 0) break;

    // Prefer oven_temp / racks / hands_on / burners — shift a dish that still has hold room.
    const conflict = conflicts[0]!;
    const candidates = placements
      .filter((p) => conflict.dish_ids.includes(p.dish.id) && remainingHold(p, serveMs) > 0)
      .sort((a, b) => remainingHold(b, serveMs) - remainingHold(a, serveMs) || a.dish.id.localeCompare(b.dish.id));

    // If none of the conflicting dishes can move, try any dish with hold room.
    const fallback = placements
      .filter((p) => remainingHold(p, serveMs) > 0)
      .sort((a, b) => remainingHold(b, serveMs) - remainingHold(a, serveMs) || a.dish.id.localeCompare(b.dish.id));
    const orderedMovers = candidates.length > 0 ? candidates : fallback;

    let moved = false;
    for (const mover of orderedMovers) {
      let jump = 1;
      if (conflict.type === "oven_temp" || conflict.type === "oven_racks") {
        const others = placements.filter((p) => p !== mover && conflict.dish_ids.includes(p.dish.id));
        if (others.length) {
          const other = others.sort((a, b) => a.dish.id.localeCompare(b.dish.id))[0]!;
          const oc = cookInterval(other);
          const mc = cookInterval(mover);
          const need = Math.ceil((mc.end - oc.start) / 60_000);
          if (need > 0) jump = Math.min(need, remainingHold(mover, serveMs));
        }
      } else if (conflict.type === "hands_on") {
        // Shift mover just enough that its hands-on ends before the earliest overlapping peer segment.
        const mine = handsOnIntervals(mover);
        const peers = placements
          .filter((p) => p !== mover && conflict.dish_ids.includes(p.dish.id))
          .flatMap(handsOnIntervals);
        let need = 1;
        for (const m of mine) {
          for (const peer of peers) {
            if (!overlaps(m.start, m.end, peer.start, peer.end)) continue;
            // Move mover earlier so m.end <= peer.start.
            const clear = Math.ceil((m.end - peer.start) / 60_000);
            if (clear > need) need = clear;
          }
        }
        jump = Math.min(need, remainingHold(mover, serveMs));
      } else if (conflict.type === "burners") {
        jump = Math.min(5, remainingHold(mover, serveMs));
      }
      jump = Math.min(Math.max(jump, 1), remainingHold(mover, serveMs));
      if (jump <= 0) continue;
      shiftEarlier(mover, jump);
      assignOvens(placements, input.ovens);
      moved = true;
      break;
    }
    if (!moved) {
      const question = conflictQuestion(conflict, placements);
      const steps = buildSteps(placements, serveMs, input);
      return {
        feasible: false,
        reason: conflict.detail,
        question,
        steps,
        warnings,
        summary: question,
        card: buildCard(steps, false, warnings),
        serve_at_local: formatLocalTime(serveMs, input.timezone),
        timezone: input.timezone,
      };
    }
  }

  const finalConflicts = findConflicts(placements, serveMs, input);
  if (finalConflicts.length > 0) {
    const conflict = finalConflicts[0]!;
    const question = conflictQuestion(conflict, placements);
    const steps = buildSteps(placements, serveMs, input);
    return {
      feasible: false,
      reason: conflict.detail,
      question,
      steps,
      warnings,
      summary: question,
      card: buildCard(steps, false, warnings),
      serve_at_local: formatLocalTime(serveMs, input.timezone),
      timezone: input.timezone,
    };
  }

  // Never plan in the past: if the first step starts before now, ask to push serve time.
  const earliestStart = Math.min(...placements.map((p) => p.start_ms));
  if (earliestStart < nowMs - 500) {
    const shiftMs = nowMs - earliestStart;
    const earliestServeMs = serveMs + shiftMs;
    const earliestLocal = formatLocalTime(earliestServeMs, input.timezone);
    const q = `The earliest this menu can be ready is ${earliestLocal}. Serve then?`;
    const steps = buildSteps(placements, serveMs, input);
    return {
      feasible: false,
      reason: "The plan would start before now.",
      question: q,
      steps,
      warnings,
      summary: q,
      card: buildCard(steps, false, warnings),
      serve_at_local: formatLocalTime(serveMs, input.timezone),
      timezone: input.timezone,
    };
  }

  // Stable output order for placements in summary
  placements = [...placements].sort((a, b) => a.dish.id.localeCompare(b.dish.id));
  const steps = buildSteps(placements, serveMs, input);
  const summary = spokenSummary(placements, serveMs, input, true);
  return {
    feasible: true,
    steps,
    warnings,
    summary,
    card: buildCard(steps, true, warnings),
    serve_at_local: formatLocalTime(serveMs, input.timezone),
    timezone: input.timezone,
  };
}

/** Deep-stable JSON clone for equality checks in tests. */
export function stablePlanFingerprint(result: SolverResult): string {
  return JSON.stringify({
    feasible: result.feasible,
    reason: result.reason ?? null,
    question: result.question ?? null,
    steps: result.steps,
    warnings: result.warnings,
    summary: result.summary,
    card: result.card,
    serve_at_local: result.serve_at_local,
    timezone: result.timezone,
  });
}
