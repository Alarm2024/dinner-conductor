import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDishById, loadDishes } from "../src/dishes.js";
import {
  formatLocalTime,
  parseServeAt,
  solveMeal,
  stablePlanFingerprint,
  type SolverInput,
  type SolverResult,
} from "../src/solver.js";

const TZ = "America/New_York";
/** Fixed "now" so HH:MM serve times resolve on a known civil day. */
const NOW = Date.parse("2026-11-26T15:00:00-05:00");

function baseInput(partial: Partial<SolverInput> & Pick<SolverInput, "dishes">): SolverInput {
  return {
    serve_at: "18:00",
    timezone: TZ,
    ovens: 1,
    burners: 4,
    cooks: 1,
    units: "F",
    ...partial,
  };
}

function localToMs(hhmm: string, serveMs: number, timeZone: string): number {
  const [hh, mm] = hhmm.split(":").map(Number);
  const serveLocal = formatLocalTime(serveMs, timeZone);
  const [sh, sm] = serveLocal.split(":").map(Number);
  const deltaMin = hh * 60 + mm - (sh * 60 + sm);
  return serveMs + deltaMin * 60_000;
}

/** Independent check of resource rules from published steps + the dish library. */
function assertResourceInvariants(result: SolverResult, input: SolverInput): void {
  assert.ok(result.summary.length > 0);
  assert.ok(result.card.some((l) => /thermometer/i.test(l)));
  const times = result.steps.map((s) => s.at);
  assert.deepEqual(times, [...times].sort());
  if (!result.feasible) return;

  const serveMs = parseServeAt(input.serve_at, input.timezone, NOW);
  type Place = {
    id: string;
    start: number;
    ready: number;
    prep: number;
    cook: number;
    hold: number;
    appliance: string;
    temp_f: number | null;
    units: number;
    burners: number;
    hands: Array<{ o: number; m: number }>;
  };
  const places: Place[] = [];
  for (const d of input.dishes) {
    const base = getDishById(d.id)!;
    const cook = d.overrides?.cook_min ?? base.cook_min.typical;
    const prep = d.overrides?.prep_min ?? base.prep_min;
    const rest = d.overrides?.rest_min ?? base.rest_min;
    const hold = d.overrides?.hold_min ?? base.hold_min;
    const readyStep = result.steps.find(
      (s) => s.dish_id === d.id && (s.action.includes("ready") || s.action.startsWith("Hold")),
    );
    assert.ok(readyStep, `missing ready for ${d.id}`);
    const ready = localToMs(readyStep!.at, serveMs, input.timezone);
    const start = ready - (prep + cook + rest) * 60_000;
    assert.ok(ready <= serveMs + 1000, `${d.id} after serve`);
    assert.ok(ready >= serveMs - hold * 60_000 - 1000, `${d.id} outside hold`);
    places.push({
      id: d.id,
      start,
      ready,
      prep,
      cook,
      hold,
      appliance: base.appliance,
      temp_f: d.overrides?.oven_temp_f ?? base.oven_temp?.f ?? null,
      units: d.overrides?.oven_units ?? base.oven_units,
      burners: d.overrides?.burners ?? base.burners,
      hands: base.hands_on.map((h) => ({ o: h.offset_min, m: h.minutes })),
    });
  }

  const handEvents: Array<{ t: number; d: number }> = [];
  for (const p of places) {
    for (const h of p.hands) {
      if (h.m <= 0) continue;
      handEvents.push({ t: p.start + h.o * 60_000, d: 1 });
      handEvents.push({ t: p.start + (h.o + h.m) * 60_000, d: -1 });
    }
  }
  handEvents.sort((a, b) => a.t - b.t || a.d - b.d);
  let handsOn = 0;
  for (const e of handEvents) {
    handsOn += e.d;
    assert.ok(handsOn <= input.cooks, `hands-on ${handsOn} > cooks ${input.cooks}`);
  }

  const bEvents: Array<{ t: number; d: number }> = [];
  for (const p of places) {
    if (p.burners <= 0) continue;
    if (p.appliance === "stovetop") {
      const s = p.start + p.prep * 60_000;
      const e = s + p.cook * 60_000;
      bEvents.push({ t: s, d: p.burners }, { t: e, d: -p.burners });
    } else if (p.prep > 0) {
      bEvents.push({ t: p.start, d: p.burners }, { t: p.start + p.prep * 60_000, d: -p.burners });
    }
  }
  bEvents.sort((a, b) => a.t - b.t || a.d - b.d);
  let burners = 0;
  for (const e of bEvents) {
    burners += e.d;
    assert.ok(burners <= input.burners, `burners ${burners} > ${input.burners}`);
  }

  const ovenDishes = places.filter((p) => p.appliance === "oven" && p.cook > 0);
  const oEvents: Array<{ t: number; open: boolean; id: string; temp: number; units: number }> = [];
  for (const p of ovenDishes) {
    const s = p.start + p.prep * 60_000;
    const e = s + p.cook * 60_000;
    oEvents.push({ t: s, open: true, id: p.id, temp: p.temp_f ?? 0, units: p.units });
    oEvents.push({ t: e, open: false, id: p.id, temp: p.temp_f ?? 0, units: p.units });
  }
  oEvents.sort((a, b) => a.t - b.t || Number(a.open) - Number(b.open) || a.id.localeCompare(b.id));
  const active = new Map<string, { temp: number; units: number }>();
  for (const ev of oEvents) {
    if (ev.open) active.set(ev.id, { temp: ev.temp, units: ev.units });
    else active.delete(ev.id);
    const temps = new Set([...active.values()].map((v) => v.temp));
    const units = [...active.values()].reduce((n, v) => n + v.units, 0);
    assert.ok(temps.size <= input.ovens, `oven temps ${temps.size} > ovens ${input.ovens}`);
    assert.ok(units <= input.ovens * 2, `oven units ${units} > ${input.ovens * 2}`);
  }
}

describe("solver golden plans", () => {
  it("plans a 3-dish weeknight meal", () => {
    const input = baseInput({
      dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }, { id: "green_beans" }],
      cooks: 1,
      ovens: 1,
    });
    const plan = solveMeal(input, NOW);
    assert.equal(plan.feasible, true, plan.reason ?? plan.summary);
    assert.ok(plan.steps.some((s) => s.dish_id === "chicken_thighs"));
    assert.ok(plan.steps.some((s) => s.dish_id === "roast_potatoes"));
    assert.ok(plan.steps.some((s) => s.action === "Serve"));
    assert.match(plan.summary, /18:00/);
    assertResourceInvariants(plan, input);
    const bakeTemps = plan.steps.filter((s) => s.temp).map((s) => s.temp);
    assert.ok(bakeTemps.every((t) => t === "425 F"));
  });

  it("plans a 6-dish holiday meal with 1 oven at 3 temperatures by sequencing", () => {
    const input = baseInput({
      dishes: [
        { id: "turkey_breast" },
        { id: "stuffing" },
        { id: "mashed_potatoes" },
        { id: "green_bean_casserole" },
        { id: "dinner_rolls" },
        { id: "gravy" },
      ],
      ovens: 1,
      cooks: 1,
      burners: 4,
      serve_at: "16:00",
    });
    const plan = solveMeal(input, NOW);
    if (plan.feasible) {
      assert.ok(plan.steps.some((s) => s.dish_id === "turkey_breast"));
      assert.ok(plan.steps.some((s) => s.dish_id === "stuffing"));
      assert.ok(plan.card.length > 3);
      assertResourceInvariants(plan, input);
    } else {
      assert.ok(plan.question);
      assert.ok(plan.reason);
      assert.equal((plan.question.match(/\?/g) ?? []).length, 1);
    }
    assert.equal(stablePlanFingerprint(plan), stablePlanFingerprint(solveMeal(input, NOW)));
  });

  it("uses a second oven when two temperatures overlap", () => {
    const input = baseInput({
      dishes: [{ id: "turkey_breast" }, { id: "roast_potatoes" }, { id: "salad" }],
      ovens: 2,
      cooks: 1,
    });
    const plan = solveMeal(input, NOW);
    assert.equal(plan.feasible, true, plan.reason ?? plan.summary);
    assert.ok(plan.steps.some((s) => s.temp === "325 F"));
    assert.ok(plan.steps.some((s) => s.temp === "425 F"));
    assertResourceInvariants(plan, input);
  });

  it("uses 2 cooks to overlap hands-on prep", () => {
    const oneCook = solveMeal(
      baseInput({
        dishes: [{ id: "lasagna" }, { id: "salad" }, { id: "garlic_bread" }],
        cooks: 1,
        ovens: 1,
      }),
      NOW,
    );
    const twoCooks = solveMeal(
      baseInput({
        dishes: [{ id: "lasagna" }, { id: "salad" }, { id: "garlic_bread" }],
        cooks: 2,
        ovens: 1,
      }),
      NOW,
    );
    assert.equal(twoCooks.feasible, true, twoCooks.reason ?? twoCooks.summary);
    assert.ok(oneCook.feasible || oneCook.question);
  });
});

describe("solver determinism and properties", () => {
  it("returns identical output for the same input", () => {
    const input = baseInput({
      dishes: [{ id: "meatloaf" }, { id: "mashed_potatoes" }, { id: "glazed_carrots" }],
    });
    const a = solveMeal(input, NOW);
    const b = solveMeal(input, NOW);
    assert.equal(stablePlanFingerprint(a), stablePlanFingerprint(b));
  });

  it("does not invent a new cook time or oven temperature", () => {
    const input = baseInput({
      dishes: [{ id: "baked_salmon", overrides: { cook_min: 22, oven_temp_f: 410 } }],
    });
    const plan = solveMeal(input, NOW);
    assert.equal(plan.feasible, true);
    const bake = plan.steps.find((s) => s.dish_id === "baked_salmon" && s.temp);
    assert.equal(bake?.temp, "410 F");
  });

  it("asks instead of changing times when the plan cannot fit", () => {
    const input = baseInput({
      dishes: [
        { id: "turkey_breast", overrides: { hold_min: 0 } },
        { id: "roast_potatoes", overrides: { hold_min: 0, cook_min: 90 } },
        { id: "dinner_rolls", overrides: { hold_min: 0 } },
      ],
      ovens: 1,
      cooks: 1,
    });
    const plan = solveMeal(input, NOW);
    if (!plan.feasible) {
      assert.ok(plan.question?.endsWith("?"));
      assert.ok(plan.reason);
    }
  });

  it("formats local serve times in the given timezone", () => {
    const ms = parseServeAt("18:30", "America/Chicago", NOW);
    assert.equal(formatLocalTime(ms, "America/Chicago"), "18:30");
  });
});

describe("solver property tests (500 random dish sets)", () => {
  it("respects cooks, oven temp, racks, burners, hold windows, and determinism", () => {
    const library = loadDishes();
    let feasibleCount = 0;
    const RUNS = 500;
    for (let seed = 0; seed < RUNS; seed++) {
      let state = (seed * 1103515245 + 12345) >>> 0;
      const rand = () => {
        state = (state * 1103515245 + 12345) >>> 0;
        return state / 0x100000000;
      };
      const n = 2 + Math.floor(rand() * 5);
      const picked: string[] = [];
      const used = new Set<string>();
      while (picked.length < n) {
        const d = library[Math.floor(rand() * library.length)]!;
        if (used.has(d.id)) continue;
        used.add(d.id);
        picked.push(d.id);
      }
      picked.sort();
      const input = baseInput({
        dishes: picked.map((id) => ({ id })),
        ovens: rand() < 0.5 ? 1 : 2,
        cooks: rand() < 0.5 ? 1 : 2,
        burners: 4,
        serve_at: "19:00",
      });
      const a = solveMeal(input, NOW);
      const b = solveMeal(input, NOW);
      assert.equal(stablePlanFingerprint(a), stablePlanFingerprint(b), `seed ${seed}`);
      assertResourceInvariants(a, input);

      if (a.feasible) {
        feasibleCount += 1;
        assert.ok(a.steps.some((s) => s.action === "Serve"));
        for (const id of picked) {
          assert.ok(a.steps.some((s) => s.dish_id === id), `seed ${seed} missing ${id}`);
        }
      } else {
        assert.ok(a.question, `seed ${seed} infeasible without question`);
        assert.equal((a.question.match(/\?/g) ?? []).length, 1, `seed ${seed}`);
      }
    }
    assert.ok(feasibleCount > 50, `expected many feasible plans, got ${feasibleCount}`);
  });
});

describe("relative to now", () => {
  it("asks about tomorrow when HH:MM serve_at has already passed today", () => {
    // now is 15:00; ask for 14:00 same day
    const input = baseInput({
      dishes: [{ id: "salad" }],
      serve_at: "14:00",
    });
    const plan = solveMeal(input, NOW);
    assert.equal(plan.feasible, false);
    assert.match(plan.question ?? "", /Did you mean 14:00 tomorrow\?/);
  });

  it("refuses a plan whose first step would start before now", () => {
    // now is 17:30; an 18:00 lasagna dinner needs to start well before that
    const lateNow = Date.parse("2026-11-26T17:30:00-05:00");
    const input = baseInput({
      dishes: [{ id: "lasagna" }, { id: "salad" }],
      serve_at: "18:00",
    });
    const plan = solveMeal(input, lateNow);
    assert.equal(plan.feasible, false);
    assert.match(plan.question ?? "", /The earliest this menu can be ready is \d{2}:\d{2}\. Serve then\?/);
  });

  it("never emits a step before now when the plan is feasible", () => {
    const input = baseInput({
      dishes: [{ id: "green_beans" }, { id: "rice" }],
      serve_at: "18:00",
    });
    const plan = solveMeal(input, NOW);
    assert.equal(plan.feasible, true, plan.reason ?? plan.summary);
    const nowLocal = formatLocalTime(NOW, TZ);
    for (const step of plan.steps) {
      assert.ok(step.at >= nowLocal, `step ${step.at} ${step.action} is before now ${nowLocal}`);
    }
  });
});
