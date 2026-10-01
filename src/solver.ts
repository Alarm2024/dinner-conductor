import type { Dish, HandsOnSegment, OvenTemp } from "./dishes.js";
import { getDishById } from "./dishes.js";

const RECIPE_COOK_QUESTION = "How long does your recipe say to roast it?";

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
  /** Racks available in each oven. Active racks at any moment stay within this. */
  rack_count?: number;
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

export type ConflictType = "hands_on" | "oven_temp" | "oven_racks" | "burners" | "hold" | "past_start" | "past_serve" | "serve_at";

export interface PlanConflict {
  type: ConflictType;
  dishes: string[];
}

export interface SolverResult {
  feasible: boolean;
  reason?: string;
  question?: string;
  /** Present when the plan does not fit; every detected conflict. */
  conflicts?: PlanConflict[];
  steps: PlanStep[];
  warnings: string[];
  summary: string;
  card: string[];
  serve_at_local: string;
  timezone: string;
}

const DRAFT_LABEL = "Draft - not workable yet";

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
  proof_min: number;
  total_min: number;
}

interface Placement {
  dish: ResolvedDish;
  /** Absolute ms when prep starts. */
  start_ms: number;
  /** Absolute ms when dish is ready (end of rest). */
  ready_ms: number;
  oven_index: number | null;
  /** Minutes the hands-on prep starts before the tight (just-in-time) start. Bounded by hold_min. */
  prep_lead_min: number;
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
  if (base.requires_recipe_cook_min && o.cook_min == null) {
    throw new Error(`needs_cook_min:${base.id}`);
  }
  const cook_min = o.cook_min ?? base.cook_min.typical;
  const rest_min = o.rest_min ?? base.rest_min;
  const hold_min = o.hold_min ?? base.hold_min;
  let oven_temp = base.oven_temp;
  if (o.oven_temp_f != null || o.oven_temp_c != null) {
    const f = o.oven_temp_f ?? (o.oven_temp_c != null ? Math.round((o.oven_temp_c * 9) / 5 + 32) : null);
    const c = o.oven_temp_c ?? (o.oven_temp_f != null ? Math.round(((o.oven_temp_f - 32) * 5) / 9) : null);
    if (f != null && c != null) oven_temp = { f, c };
  }
  const hands_on = base.hands_on.map((h) => ({ ...h }));
  const lastHands = Math.max(0, ...hands_on.map((h) => h.offset_min + h.minutes));
  const proof_min = base.proof_min ?? 0;
  const total_min = Math.max(prep_min + proof_min + cook_min + rest_min, lastHands);
  return {
    id: base.id,
    name: base.names[0] ?? base.id,
    prep_min,
    cook_min,
    rest_min,
    hold_min,
    hands_on,
    appliance: base.appliance,
    oven_temp,
    oven_units: o.oven_units ?? base.oven_units,
    burners: o.burners ?? base.burners,
    proof_min,
    total_min,
  };
}

function rackCount(input: SolverInput): number {
  return Math.max(1, Math.floor(input.rack_count ?? 2));
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
  const start = p.start_ms + (p.dish.prep_min + p.dish.proof_min) * 60_000;
  const end = start + p.dish.cook_min * 60_000;
  return { start, end };
}

function prepInterval(p: Placement): { start: number; end: number } {
  const start = p.start_ms - p.prep_lead_min * 60_000;
  return { start, end: start + p.dish.prep_min * 60_000 };
}

function handsOnIntervals(p: Placement): Interval[] {
  return p.dish.hands_on
    .filter((h) => h.minutes > 0)
    .map((h) => {
      // Offset 0 is the prep block and may slide earlier within the hold window.
      const origin = h.offset_min === 0 ? p.start_ms - p.prep_lead_min * 60_000 : p.start_ms;
      const offset = h.offset_min === 0 ? 0 : h.offset_min;
      return {
        start: origin + offset * 60_000,
        end: origin + (offset + h.minutes) * 60_000,
        dish_id: p.dish.id,
        kind: "hands_on",
      };
    });
}

interface PreheatSeg {
  oven_index: number;
  start: number;
  end: number;
  temp_f: number;
  action: string;
  /** Dish whose bake this preheat/cool prepares for. */
  dish_id: string;
}

/** 15 min before first bake; 10 min before each temp increase; 10 min door-open before each decrease. */
function computePreheatSegments(placements: Placement[], ovens: number, units: TempUnits): PreheatSeg[] {
  const out: PreheatSeg[] = [];
  for (let oi = 0; oi < ovens; oi++) {
    const bakes = placements
      .filter((p) => p.oven_index === oi && p.dish.appliance === "oven" && p.dish.cook_min > 0)
      .map((p) => {
        const c = cookInterval(p);
        return { start: c.start, end: c.end, temp_f: p.dish.oven_temp?.f ?? 0, dish_id: p.dish.id, dish: p.dish };
      })
      .sort((a, b) => a.start - b.start || a.dish_id.localeCompare(b.dish_id));
    if (bakes.length === 0) continue;
    const first = bakes[0]!;
    const firstLabel = tempLabel(first.dish.oven_temp, units) ?? `${first.temp_f} F`;
    out.push({
      oven_index: oi,
      start: first.start - 15 * 60_000,
      end: first.start,
      temp_f: first.temp_f,
      action: `Preheat to ${firstLabel}`,
      dish_id: first.dish_id,
    });
    for (let i = 1; i < bakes.length; i++) {
      const prev = bakes[i - 1]!;
      const cur = bakes[i]!;
      if (cur.temp_f === prev.temp_f) continue;
      const label = tempLabel(cur.dish.oven_temp, units) ?? `${cur.temp_f} F`;
      if (cur.temp_f > prev.temp_f) {
        out.push({
          oven_index: oi,
          start: cur.start - 10 * 60_000,
          end: cur.start,
          temp_f: cur.temp_f,
          action: `Preheat to ${label}`,
          dish_id: cur.dish_id,
        });
      } else {
        out.push({
          oven_index: oi,
          start: cur.start - 10 * 60_000,
          end: cur.start,
          temp_f: cur.temp_f,
          action: `Open door to cool to ${label}`,
          dish_id: cur.dish_id,
        });
      }
    }
  }
  return out;
}

interface Conflict {
  type: Exclude<ConflictType, "past_start" | "past_serve" | "serve_at">;
  dish_ids: string[];
  detail: string;
}

function toPlanConflicts(conflicts: Conflict[]): PlanConflict[] {
  return conflicts.map((c) => ({ type: c.type, dishes: [...c.dish_ids].sort() }));
}

function draftSummary(question: string): string {
  return `${DRAFT_LABEL}. ${question}`;
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

  // Ovens first (before hands-on): per oven index, temp must be unique at a time; units <= 2.
  // Preheat / cool-down occupies the oven at its target temperature.
  const preheats = computePreheatSegments(placements, input.ovens, input.units);
  for (let oi = 0; oi < input.ovens; oi++) {
    const onOven = placements.filter((p) => p.oven_index === oi && p.dish.appliance === "oven" && p.dish.cook_min > 0);
    const oEvents: Array<{ t: number; deltaUnits: number; temp: number; id: string; open: boolean }> = [];
    for (const p of onOven) {
      const c = cookInterval(p);
      const temp = p.dish.oven_temp?.f ?? 0;
      oEvents.push({ t: c.start, deltaUnits: p.dish.oven_units, temp, id: p.dish.id, open: true });
      oEvents.push({ t: c.end, deltaUnits: -p.dish.oven_units, temp, id: p.dish.id, open: false });
      // A roast that fills the oven keeps those racks through its rest. Search has to
      // keep going and place the next dish after that, instead of stopping on the first clash.
      if (p.dish.rest_min > 0 && p.dish.oven_units >= rackCount(input)) {
        const id = `${p.dish.id}:rest`;
        oEvents.push({ t: c.end, deltaUnits: p.dish.oven_units, temp, id, open: true });
        oEvents.push({
          t: c.end + p.dish.rest_min * 60_000,
          deltaUnits: -p.dish.oven_units,
          temp,
          id,
          open: false,
        });
      }
    }
    for (const ph of preheats.filter((p) => p.oven_index === oi)) {
      // Preheat / cool takes the whole oven for its duration.
      const id = `preheat:${ph.dish_id}`;
      const racks = rackCount(input);
      oEvents.push({ t: ph.start, deltaUnits: racks, temp: ph.temp_f, id, open: true });
      oEvents.push({ t: ph.end, deltaUnits: -racks, temp: ph.temp_f, id, open: false });
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
      const realIds = [
        ...new Set(
          [...temps.keys()]
            .filter((id) => !id.startsWith("preheat:"))
            .map((id) => (id.endsWith(":rest") ? id.slice(0, -":rest".length) : id)),
        ),
      ].sort();
      const distinct = new Set(temps.values());
      if (distinct.size > 1) {
        const ids =
          realIds.length >= 2
            ? realIds
            : [...new Set([...realIds, ...[...temps.keys()].filter((id) => id.startsWith("preheat:")).map((id) => id.slice("preheat:".length))])].sort();
        const names = ids.map((id) => placements.find((p) => p.dish.id === id)?.dish.name ?? id);
        out.push({
          type: "oven_temp",
          dish_ids: ids,
          detail: `${names.join(" and ")} need different oven temperatures at the same time.`,
        });
        break;
      }
      if (units > rackCount(input)) {
        const ids =
          realIds.length > 0
            ? realIds
            : [...temps.keys()].map((id) => (id.startsWith("preheat:") ? id.slice("preheat:".length) : id)).sort();
        out.push({
          type: "oven_racks",
          dish_ids: [...new Set(ids)].sort(),
          detail: `Oven ${oi + 1} needs more than ${rackCount(input)} rack units at the same time.`,
        });
        break;
      }
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

  // Deduplicate similar conflicts
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.type}:${c.dish_ids.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignOvens(placements: Placement[], ovens: number, racks = 2): void {
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
      if (tempOk && units <= racks) {
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
        if (units <= racks) {
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

  for (const ph of computePreheatSegments(placements, input.ovens, input.units)) {
    const ovenLabel = `oven ${ph.oven_index + 1}`;
    steps.push({
      at: formatLocalTime(ph.start, input.timezone),
      dish: ovenLabel,
      dish_id: `oven_${ph.oven_index + 1}`,
      action: ph.action,
      hands_on: false,
      appliance: "oven",
      temp: tempLabel(
        placements.find((p) => p.dish.id === ph.dish_id)?.dish.oven_temp ?? { f: ph.temp_f, c: Math.round(((ph.temp_f - 32) * 5) / 9) },
        input.units,
      ),
    });
  }

  for (const p of sorted) {
    if (p.dish.prep_min > 0 || p.dish.hands_on.some((h) => h.offset_min === 0 && h.minutes > 0)) {
      const label = p.dish.hands_on.find((h) => h.offset_min === 0)?.label ?? "prep";
      steps.push({
        at: formatLocalTime(prepInterval(p).start, input.timezone),
        dish: p.dish.name,
        dish_id: p.dish.id,
        action: `Start ${label}`,
        hands_on: true,
        appliance: p.dish.appliance === "none" ? "counter" : p.dish.appliance,
        temp: null,
      });
    }

    if (p.dish.proof_min > 0 && p.dish.cook_min > 0) {
      const proofStart = cookInterval(p).start - p.dish.proof_min * 60_000;
      steps.push({
        at: formatLocalTime(proofStart, input.timezone),
        dish: p.dish.name,
        dish_id: p.dish.id,
        action: `Proof ${p.dish.name}`,
        hands_on: false,
        appliance: "counter",
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

    const held = p.ready_ms < serveMs - 30_000;
    const action = !held
      ? `${p.dish.name} ready`
      : p.dish.appliance === "none"
        ? `Hold ${p.dish.name}`
        : `Hold ${p.dish.name} warm`;
    steps.push({
      at: formatLocalTime(p.ready_ms, input.timezone),
      dish: p.dish.name,
      dish_id: p.dish.id,
      action,
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
  if (!feasible) lines.unshift(DRAFT_LABEL);
  for (const w of warnings) lines.push(`Note: ${w}`);
  lines.push(DONENESS);
  return lines;
}

function spokenSummary(placements: Placement[], serveMs: number, input: SolverInput, feasible: boolean, question?: string): string {
  if (!feasible && question) {
    return draftSummary(question);
  }
  if (!feasible) {
    return draftSummary("This meal plan does not fit with the ovens and cooks available.");
  }
  const names = placements.map((p) => p.dish.name);
  const list =
    names.length <= 1
      ? names[0] ?? "dinner"
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const start = earliestPlanStart(placements, input);
  return `For ${list} at ${formatLocalTime(serveMs, input.timezone)}, start at ${formatLocalTime(start, input.timezone)}. ${DONENESS}`;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

function clonePlacements(placements: Placement[]): Placement[] {
  return placements.map((p) => ({
    dish: p.dish,
    start_ms: p.start_ms,
    ready_ms: p.ready_ms,
    oven_index: p.oven_index,
    prep_lead_min: p.prep_lead_min,
  }));
}

function resetPlacements(placements: Placement[], serveMs: number): void {
  for (const p of placements) {
    p.ready_ms = serveMs;
    p.start_ms = serveMs - p.dish.total_min * 60_000;
    p.oven_index = null;
    p.prep_lead_min = 0;
  }
}

function placementSortKey(placements: Placement[]): string {
  return placements
    .map((p) => `${p.dish.id}:${p.start_ms}:${p.ready_ms}:${p.oven_index ?? -1}:${p.prep_lead_min}`)
    .sort()
    .join("|");
}

function earliestPlanStart(placements: Placement[], input: SolverInput): number {
  const preheatStarts = computePreheatSegments(placements, input.ovens, input.units).map((p) => p.start);
  const anchors = placements.map((p) => p.start_ms - p.prep_lead_min * 60_000);
  return Math.min(...anchors, ...preheatStarts);
}

/** Enforce bake gaps for a temp-group order without resetting placements. */
function enforceTempGroupGaps(
  placements: Placement[],
  order: number[],
  serveMs: number,
  input: SolverInput,
): boolean {
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let oi = 0; oi < input.ovens; oi++) {
      const seq = order.filter((temp) =>
        placements.some(
          (p) => p.oven_index === oi && p.dish.appliance === "oven" && (p.dish.oven_temp?.f ?? 0) === temp,
        ),
      );
      for (let i = 0; i < seq.length - 1; i++) {
        const tA = seq[i]!;
        const tB = seq[i + 1]!;
        const earlier = placements.filter(
          (p) => p.oven_index === oi && p.dish.appliance === "oven" && (p.dish.oven_temp?.f ?? 0) === tA,
        );
        const later = placements.filter(
          (p) => p.oven_index === oi && p.dish.appliance === "oven" && (p.dish.oven_temp?.f ?? 0) === tB,
        );
        if (!earlier.length || !later.length) continue;
        const earlierEnd = Math.max(...earlier.map((p) => cookInterval(p).end));
        const laterStart = Math.min(...later.map((p) => cookInterval(p).start));
        const gapMin = tA === tB ? 0 : 10;
        const needStart = earlierEnd + gapMin * 60_000;
        if (laterStart + 500 >= needStart) continue;
        // Shift the earlier group earlier so its cook ends before later's preheat/bake.
        const shiftMin = Math.ceil((needStart - laterStart) / 60_000);
        for (const p of earlier) {
          const hold = remainingHold(p, serveMs);
          if (hold < shiftMin) return false;
          shiftEarlier(p, shiftMin);
          moved = true;
        }
      }
    }
    if (!moved) break;
    assignOvens(placements, input.ovens, rackCount(input));
  }
  return true;
}

/**
 * Pack hold-capable dishes of each later temp group to start right after the prior
 * group's gap (so sides bake while a roast rests). Fill up to rack_count with the
 * longest cooks first; leave remaining same-temp dishes near serve.
 */
function packGroupsAfterPrior(
  placements: Placement[],
  order: number[],
  serveMs: number,
  input: SolverInput,
): void {
  for (let oi = 0; oi < input.ovens; oi++) {
    const seq = order.filter((temp) =>
      placements.some(
        (p) => p.oven_index === oi && p.dish.appliance === "oven" && (p.dish.oven_temp?.f ?? 0) === temp,
      ),
    );
    for (let i = 0; i < seq.length - 1; i++) {
      const tA = seq[i]!;
      const tB = seq[i + 1]!;
      const earlier = placements.filter(
        (p) => p.oven_index === oi && p.dish.appliance === "oven" && (p.dish.oven_temp?.f ?? 0) === tA,
      );
      const later = placements.filter(
        (p) => p.oven_index === oi && p.dish.appliance === "oven" && (p.dish.oven_temp?.f ?? 0) === tB,
      );
      if (!earlier.length || !later.length) continue;
      const earlierEnd = Math.max(...earlier.map((p) => cookInterval(p).end));
      const gapMin = tA === tB ? 0 : 10;
      const targetStart = earlierEnd + gapMin * 60_000;
      const packable = [...later].sort(
        (a, b) => b.dish.cook_min - a.dish.cook_min || a.dish.id.localeCompare(b.dish.id),
      );
      let units = 0;
      for (const p of packable) {
        if (units + p.dish.oven_units > rackCount(input)) continue;
        const c = cookInterval(p);
        if (c.start > targetStart + 500) {
          const shiftMin = Math.floor((c.start - targetStart) / 60_000);
          const hold = remainingHold(p, serveMs);
          if (shiftMin > 0 && hold >= shiftMin) shiftEarlier(p, shiftMin);
          else continue;
        }
        units += p.dish.oven_units;
      }
    }
  }
  assignOvens(placements, input.ovens, rackCount(input));
}

/** Reset to ready-at-serve, then push earlier temp groups so bakes follow `order`. */
function applyTempGroupOrder(placements: Placement[], order: number[], serveMs: number, input: SolverInput): boolean {
  resetPlacements(placements, serveMs);
  assignOvens(placements, input.ovens, rackCount(input));
  if (!enforceTempGroupGaps(placements, order, serveMs, input)) return false;
  packGroupsAfterPrior(placements, order, serveMs, input);
  return enforceTempGroupGaps(placements, order, serveMs, input);
}

/**
 * Slide the prep block earlier without moving the cook. The slack is the dish's
 * hold window, and prep may not start before now. Returns true when a prep moved.
 */
function advancePrepLead(placements: Placement[], nowMs: number): boolean {
  const blockers = placements.flatMap(handsOnIntervals);
  const movers = placements
    .filter((p) => p.dish.hands_on.some((h) => h.offset_min === 0 && h.minutes > 0))
    .map((p) => {
      const hands = p.dish.hands_on.find((h) => h.offset_min === 0 && h.minutes > 0)!;
      const start = p.start_ms - p.prep_lead_min * 60_000;
      return { p, start, end: start + hands.minutes * 60_000 };
    })
    .sort(
      (a, b) =>
        b.p.dish.hold_min - b.p.prep_lead_min - (a.p.dish.hold_min - a.p.prep_lead_min) ||
        a.p.dish.id.localeCompare(b.p.dish.id),
    );

  for (const mover of movers) {
    const roomHold = mover.p.dish.hold_min - mover.p.prep_lead_min;
    const roomNow = Math.floor((mover.start - nowMs) / 60_000);
    const room = Math.min(roomHold, Math.max(0, roomNow));
    if (room <= 0) continue;
    let need = 0;
    for (const block of blockers) {
      if (block.dish_id === mover.p.dish.id) continue;
      if (!overlaps(mover.start, mover.end, block.start, block.end)) continue;
      const clear = Math.ceil((mover.end - block.start) / 60_000);
      if (clear > need) need = clear;
    }
    if (need <= 0) continue;
    const jump = Math.min(need, room);
    if (jump <= 0) continue;
    mover.p.prep_lead_min += jump;
    return true;
  }
  return false;
}

/**
 * List-scheduling for hands-on (and other) conflicts: repeatedly shift the
 * hold-capable dish that clears the first conflict, deterministic tie-break by id.
 * Hands-on prep slides earlier inside the hold window before a whole-dish shift.
 * When `order` is set, re-enforce temperature-group gaps after each shift.
 * A failed gap does not stop the search.
 */
function resolveByShifting(
  placements: Placement[],
  serveMs: number,
  input: SolverInput,
  order: number[] | null = null,
  nowMs = 0,
): Conflict[] {
  let activeOrder = order;
  const maxPasses = 500;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (activeOrder && !enforceTempGroupGaps(placements, activeOrder, serveMs, input)) {
      // This order cannot keep its gaps. Keep searching without it.
      activeOrder = null;
    }
    const conflicts = findConflicts(placements, serveMs, input);
    if (conflicts.length === 0) return [];

    const conflict = conflicts[0]!;
    if (conflict.type === "hands_on" && advancePrepLead(placements, nowMs)) {
      continue;
    }
    // For oven conflicts, prefer shifting the earlier-finishing dish (usually the one that should move forward).
    const candidates = placements
      .filter((p) => conflict.dish_ids.includes(p.dish.id) && remainingHold(p, serveMs) > 0)
      .sort((a, b) => {
        if (conflict.type === "oven_temp" || conflict.type === "oven_racks") {
          return cookInterval(a).end - cookInterval(b).end || a.dish.id.localeCompare(b.dish.id);
        }
        return remainingHold(b, serveMs) - remainingHold(a, serveMs) || a.dish.id.localeCompare(b.dish.id);
      });
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
          // Clear mover's cook before other's cook starts (move mover earlier).
          const need = Math.ceil((mc.end - oc.start) / 60_000);
          if (need > 0) jump = Math.min(need, remainingHold(mover, serveMs));
        }
      } else if (conflict.type === "hands_on") {
        const mine = handsOnIntervals(mover);
        const peers = placements
          .filter((p) => p !== mover && conflict.dish_ids.includes(p.dish.id))
          .flatMap(handsOnIntervals);
        let need = 1;
        for (const m of mine) {
          for (const peer of peers) {
            if (!overlaps(m.start, m.end, peer.start, peer.end)) continue;
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
      // Snapshot to reject hands-on shifts that cannot be repaired by group gaps.
      const before = clonePlacements(placements);
      shiftEarlier(mover, jump);
      assignOvens(placements, input.ovens, rackCount(input));
      if (activeOrder && !enforceTempGroupGaps(placements, activeOrder, serveMs, input)) {
        // Revert this mover and try another.
        for (let i = 0; i < placements.length; i++) {
          placements[i]!.start_ms = before[i]!.start_ms;
          placements[i]!.ready_ms = before[i]!.ready_ms;
          placements[i]!.oven_index = before[i]!.oven_index;
          placements[i]!.prep_lead_min = before[i]!.prep_lead_min;
        }
        continue;
      }
      moved = true;
      break;
    }
    if (!moved) return conflicts;
  }
  return findConflicts(placements, serveMs, input);
}

/**
 * Deterministic search: permute oven temperature groups (≤24 orders), place with
 * list scheduling, keep the feasible plan that starts latest (tie-break by dish id).
 */
function searchSequencing(
  base: Placement[],
  serveMs: number,
  input: SolverInput,
  nowMs: number,
): { placements: Placement[]; conflicts: Conflict[] } {
  const temps = [
    ...new Set(
      base
        .filter((p) => p.dish.appliance === "oven" && p.dish.cook_min > 0)
        .map((p) => p.dish.oven_temp?.f ?? 0),
    ),
  ].sort((a, b) => a - b);

  let orders: number[][];
  if (temps.length === 0) {
    orders = [[]];
  } else if (temps.length <= 4) {
    orders = permutations(temps);
  } else {
    // Cap at 4! = 24 by permuting the four longest-hold groups; append the rest stably.
    const byHold = temps
      .map((t) => ({
        t,
        hold: Math.max(
          0,
          ...base.filter((p) => (p.dish.oven_temp?.f ?? 0) === t).map((p) => p.dish.hold_min),
        ),
      }))
      .sort((a, b) => b.hold - a.hold || a.t - b.t);
    const head = byHold.slice(0, 4).map((x) => x.t).sort((a, b) => a - b);
    const tail = byHold.slice(4).map((x) => x.t);
    orders = permutations(head).map((p) => p.concat(tail));
  }

  let best: Placement[] | null = null;
  let bestStart = -Infinity;
  let bestKey = "";
  let bestFail: { placements: Placement[]; conflicts: Conflict[] } | null = null;

  for (const order of orders) {
    const placements = clonePlacements(base);
    const ordered = applyTempGroupOrder(placements, order, serveMs, input);
    if (!ordered) {
      // Gap enforcement failed for this order. Keep going with list scheduling.
      resetPlacements(placements, serveMs);
      assignOvens(placements, input.ovens, rackCount(input));
    }
    const activeOrder = ordered ? order : null;
    let conflicts = resolveByShifting(placements, serveMs, input, activeOrder, nowMs);
    // Re-pack sides into rest windows after shifts, then resolve again.
    if (ordered && (conflicts.length === 0 || conflicts.every((c) => c.type !== "hold"))) {
      packGroupsAfterPrior(placements, order, serveMs, input);
      conflicts = resolveByShifting(placements, serveMs, input, order, nowMs);
    }
    if (conflicts.length === 0) {
      const start = earliestPlanStart(placements, input);
      const key = placementSortKey(placements);
      if (start > bestStart || (start === bestStart && (best === null || key < bestKey))) {
        best = placements;
        bestStart = start;
        bestKey = key;
      }
    } else if (!bestFail || conflicts.length < bestFail.conflicts.length) {
      bestFail = { placements: clonePlacements(placements), conflicts };
    }
  }

  if (best) return { placements: best, conflicts: [] };

  // Fallback: no group order, plain list scheduling from ready-at-serve.
  const fallback = clonePlacements(base);
  resetPlacements(fallback, serveMs);
  assignOvens(fallback, input.ovens, rackCount(input));
  let conflicts = resolveByShifting(fallback, serveMs, input, null, nowMs);
  if (conflicts.length === 0) return { placements: fallback, conflicts: [] };

  // Before giving up on hands-on overlap, slide prep earlier inside each hold window.
  const last = bestFail?.placements ?? fallback;
  for (let i = 0; i < 100 && conflicts.some((c) => c.type === "hands_on"); i++) {
    if (!advancePrepLead(last, nowMs)) break;
    assignOvens(last, input.ovens, rackCount(input));
    conflicts = findConflicts(last, serveMs, input);
  }
  if (!conflicts.some((c) => c.type === "hands_on")) {
    conflicts = resolveByShifting(last, serveMs, input, null, nowMs);
  }
  if (conflicts.length === 0) return { placements: last, conflicts: [] };
  return { placements: last, conflicts };
}

/**
 * Pure deterministic meal timing solver. Same input always yields the same plan.
 * Never changes a dish's temperature or cook time; if the plan does not fit, returns a reason and one question.
 */
export function solveMeal(
  raw: SolverInput,
  nowMs = Date.now(),
  options?: { keepDraftSteps?: boolean },
): SolverResult {
  const input: SolverInput = {
    dishes: [...raw.dishes].sort((a, b) => a.id.localeCompare(b.id)),
    serve_at: raw.serve_at,
    timezone: raw.timezone,
    ovens: Math.max(1, Math.min(2, raw.ovens)),
    burners: Math.max(1, raw.burners),
    cooks: Math.max(1, Math.min(2, raw.cooks)),
    rack_count: rackCount(raw),
    units: raw.units === "C" ? "C" : "F",
  };
  const keepDraftSteps = options?.keepDraftSteps === true;

  const parsedServe = parseServeAtDetailed(input.serve_at, input.timezone, nowMs);
  if (!parsedServe.ok) {
    const q = "What time should dinner be served?";
    return {
      feasible: false,
      reason: "Could not read serve time. Use HH:MM or an ISO timestamp.",
      question: q,
      conflicts: [{ type: "serve_at", dishes: [] }],
      steps: [],
      warnings: [],
      summary: draftSummary(q),
      card: [DRAFT_LABEL, "Could not read serve time.", DONENESS],
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
      conflicts: [{ type: "past_serve", dishes: input.dishes.map((d) => d.id).sort() }],
      steps: [],
      warnings: [],
      summary: draftSummary(q),
      card: [DRAFT_LABEL, q, DONENESS],
      serve_at_local: parsedServe.hhmm,
      timezone: input.timezone,
    };
  }

  const serveMs = parsedServe.ms;

  for (const d of input.dishes) {
    const base = getDishById(d.id);
    if (base?.requires_recipe_cook_min && d.overrides?.cook_min == null) {
      const q = RECIPE_COOK_QUESTION;
      return {
        feasible: false,
        reason: `${base.names[0]} needs a cook time from your recipe.`,
        question: q,
        conflicts: [{ type: "hold", dishes: [d.id] }],
        steps: [],
        warnings: ["Your recipe's times win over these typical times."],
        summary: draftSummary(q),
        card: [DRAFT_LABEL, q, DONENESS],
        serve_at_local: formatLocalTime(serveMs, input.timezone),
        timezone: input.timezone,
      };
    }
  }

  const resolved = input.dishes.map(resolveDish);
  // Stable order: longer total first, then id (already sorted ids in input, re-sort by duration).
  resolved.sort((a, b) => b.total_min - a.total_min || a.id.localeCompare(b.id));

  const basePlacements: Placement[] = resolved.map((dish) => {
    const ready_ms = serveMs;
    const start_ms = ready_ms - dish.total_min * 60_000;
    return { dish, start_ms, ready_ms, oven_index: null, prep_lead_min: 0 };
  });

  const warnings: string[] = ["Your recipe's times win over these typical times."];

  // Deterministic search over temperature-group orders + list scheduling.
  const searched = searchSequencing(basePlacements, serveMs, input, nowMs);
  let placements = searched.placements;

  if (searched.conflicts.length > 0) {
    const allConflicts = findConflicts(placements, serveMs, input);
    const conflicts = allConflicts.length > 0 ? allConflicts : searched.conflicts;
    const conflict = conflicts[0]!;
    const question = conflictQuestion(conflict, placements);
    const timeline = buildSteps(placements, serveMs, input);
    const steps = keepDraftSteps ? timeline : [];
    return {
      feasible: false,
      reason: conflict.detail,
      question,
      conflicts: toPlanConflicts(conflicts),
      steps,
      warnings,
      summary: draftSummary(question),
      card: buildCard(steps, false, warnings),
      serve_at_local: formatLocalTime(serveMs, input.timezone),
      timezone: input.timezone,
    };
  }

  // Never plan in the past: if the first step (including preheat) starts before now, ask to push serve time.
  const earliestStart = earliestPlanStart(placements, input);
  if (earliestStart < nowMs - 500) {
    const shiftMs = nowMs - earliestStart;
    const earliestServeMs = serveMs + shiftMs;
    const earliestLocal = formatLocalTime(earliestServeMs, input.timezone);
    const q = `The earliest this menu can be ready is ${earliestLocal}. Serve then?`;
    const timeline = buildSteps(placements, serveMs, input);
    const steps = keepDraftSteps ? timeline : [];
    return {
      feasible: false,
      reason: "The plan would start before now.",
      question: q,
      conflicts: [{ type: "past_start", dishes: placements.map((p) => p.dish.id).sort() }],
      steps,
      warnings,
      summary: draftSummary(q),
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

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** How long a timeline step occupies, in minutes. Zero means a point on the clock. */
function stepDurationMin(step: PlanStep, steps: PlanStep[]): number {
  if (step.action.startsWith("Preheat") || step.action.startsWith("Open door")) {
    const earlier = steps.some(
      (s) =>
        s.dish_id === step.dish_id &&
        s.at < step.at &&
        (s.action.startsWith("Preheat") || s.action.startsWith("Open door")),
    );
    return earlier ? 10 : 15;
  }
  const dish = getDishById(step.dish_id);
  if (!dish) return 0;
  if (step.action.startsWith("Proof")) return dish.proof_min ?? 0;
  if (step.action.startsWith("Rest")) return dish.rest_min;
  if (step.action.startsWith("Bake") || step.action.startsWith("Cook") || step.action.startsWith("Finish")) {
    return dish.cook_min.typical;
  }
  if (step.hands_on) {
    const label = step.action.replace(/^In progress: /, "").replace(/^Start /, "");
    return dish.hands_on.find((h) => h.label === label)?.minutes ?? 0;
  }
  return 0;
}

/** Drop steps that are already done. A step still underway is shown at now, never before it. */
function clipStepsAtNow(steps: PlanStep[], nowMs: number, timeZone: string): PlanStep[] {
  const nowLocal = formatLocalTime(nowMs, timeZone);
  const nowMin = hhmmToMinutes(nowLocal);
  const sorted = [...steps].sort(
    (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.dish_id.localeCompare(b.dish_id) || a.action.localeCompare(b.action)),
  );
  const out: PlanStep[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const step = sorted[i]!;
    if (step.at >= nowLocal) {
      out.push(step);
      continue;
    }
    const duration = stepDurationMin(step, sorted);
    const endMin = hhmmToMinutes(step.at) + duration;
    const nextLater = sorted.slice(i + 1).find((s) => s.at > step.at);
    const stillGoing = endMin > nowMin || (duration === 0 && (!nextLater || nextLater.at > nowLocal));
    if (!stillGoing) continue;
    out.push({
      ...step,
      at: nowLocal,
      action: step.action.startsWith("In progress: ") ? step.action : `In progress: ${step.action}`,
    });
  }
  out.sort(
    (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.dish_id.localeCompare(b.dish_id) || a.action.localeCompare(b.action)),
  );
  return out;
}

/**
 * Apply a running-late delay: push serve_at forward by N minutes.
 * Steps before now are done, or in progress at now. Nothing is shown before now.
 * Never shortens a cook time. A plan that still does not fit has no timeline.
 */
export function applyRunningLate(
  raw: SolverInput,
  dishId: string,
  minutes: number,
  nowMs = Date.now(),
): SolverResult {
  const warnings = ["Your recipe's times win over these typical times."];
  const parsedServe = parseServeAtDetailed(raw.serve_at, raw.timezone, nowMs);
  if (!parsedServe.ok || parsedServe.past_today) {
    const refused = solveMeal(raw, nowMs);
    return { ...refused, steps: [] };
  }
  const proposedServeMs = parsedServe.ms + minutes * 60_000;
  const proposedLocal = formatLocalTime(proposedServeMs, raw.timezone);
  const name = getDishById(dishId)?.names[0] ?? dishId;
  const pushed: SolverInput = {
    ...raw,
    serve_at: new Date(proposedServeMs).toISOString(),
  };
  const plan = solveMeal(pushed, nowMs, { keepDraftSteps: true });
  const blocking = (plan.conflicts ?? []).filter((c) => c.type !== "past_start");
  if (plan.feasible || blocking.length === 0) {
    const steps = clipStepsAtNow(plan.steps, nowMs, raw.timezone);
    const q = `Push dinner to ${proposedLocal}?`;
    const noteWarnings = plan.warnings.length ? plan.warnings : warnings;
    return {
      ...plan,
      feasible: false,
      reason: `${name} is ${minutes} minutes late.`,
      question: q,
      conflicts: undefined,
      steps,
      warnings: noteWarnings,
      summary: draftSummary(q),
      card: buildCard(steps, false, noteWarnings),
      serve_at_local: proposedLocal,
      timezone: raw.timezone,
    };
  }
  const q = `${name} is ${minutes} minutes late and the rest of the menu may not fit. Push dinner to ${proposedLocal}, or drop a dish?`;
  return {
    feasible: false,
    reason: `${name} is ${minutes} minutes late.`,
    question: q,
    conflicts: blocking,
    steps: [],
    warnings,
    summary: draftSummary(q),
    card: [DRAFT_LABEL, q, DONENESS],
    serve_at_local: proposedLocal,
    timezone: raw.timezone,
  };
}

/** Deep-stable JSON clone for equality checks in tests. */
export function stablePlanFingerprint(result: SolverResult): string {
  return JSON.stringify({
    feasible: result.feasible,
    reason: result.reason ?? null,
    question: result.question ?? null,
    conflicts: result.conflicts ?? null,
    steps: result.steps,
    warnings: result.warnings,
    summary: result.summary,
    card: result.card,
    serve_at_local: result.serve_at_local,
    timezone: result.timezone,
  });
}
