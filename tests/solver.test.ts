import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDishById, loadDishes } from "../src/dishes.js";
import {
  applyRunningLate,
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
    prepStart: number;
    proof: number;
  };
  const places: Place[] = [];
  for (const d of input.dishes) {
    const base = getDishById(d.id)!;
    const cook = d.overrides?.cook_min ?? base.cook_min.typical;
    const prep = d.overrides?.prep_min ?? base.prep_min;
    const rest = d.overrides?.rest_min ?? base.rest_min;
    const hold = d.overrides?.hold_min ?? base.hold_min;
    const proof = base.proof_min ?? 0;
    const readyStep = result.steps.find(
      (s) => s.dish_id === d.id && (s.action.includes("ready") || s.action.startsWith("Hold")),
    );
    assert.ok(readyStep, `missing ready for ${d.id}`);
    const ready = localToMs(readyStep!.at, serveMs, input.timezone);
    const lastHands = Math.max(0, ...base.hands_on.map((h) => h.offset_min + h.minutes));
    const total = Math.max(prep + proof + cook + rest, lastHands);
    const start = ready - total * 60_000;
    const startStep = result.steps.find((s) => s.dish_id === d.id && s.action.startsWith("Start "));
    const prepStart = startStep ? localToMs(startStep.at, serveMs, input.timezone) : start;
    assert.ok(start <= ready + 1000, `${d.id} start after finish`);
    assert.ok(prepStart <= ready + 1000, `${d.id} prep after ready`);
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
      prepStart,
      proof,
    });
  }

  const handEvents: Array<{ t: number; d: number }> = [];
  for (const p of places) {
    for (const h of p.hands) {
      if (h.m <= 0) continue;
      const t0 = h.o === 0 ? p.prepStart : p.start + h.o * 60_000;
      handEvents.push({ t: t0, d: 1 });
      handEvents.push({ t: t0 + h.m * 60_000, d: -1 });
      assert.ok(t0 + h.m * 60_000 <= p.ready + 1000, `${p.id} hands finish after ready`);
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
    const s = p.start + (p.prep + p.proof) * 60_000;
    const e = s + p.cook * 60_000;
    assert.ok(e <= p.ready + 1000, `${p.id} cook finishes after ready`);
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
    const racks = input.rack_count ?? 2;
    assert.ok(units <= input.ovens * racks, `oven units ${units} > ${input.ovens * racks}`);
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

  it("plans a 6-dish holiday meal with 1 oven by sequencing temp groups", () => {
    // Morning "now" so the afternoon turkey prep is not refused as past-start.
    const holidayNow = Date.parse("2026-11-26T10:00:00-05:00");
    const core = baseInput({
      dishes: [
        { id: "turkey_breast" },
        { id: "stuffing" },
        { id: "mashed_potatoes" },
        { id: "green_bean_casserole" },
        { id: "gravy" },
      ],
      ovens: 1,
      cooks: 2,
      burners: 4,
      serve_at: "16:00",
    });
    const plan = solveMeal(core, holidayNow);
    assert.equal(plan.feasible, true, plan.question ?? plan.reason ?? plan.summary);
    assert.ok(plan.steps.some((s) => s.dish_id === "turkey_breast"));
    assert.ok(plan.steps.some((s) => s.dish_id === "stuffing"));
    assertResourceInvariants(plan, core);
    // Stuffing and casserole bake while the breast rests on the counter.
    const serveMs = parseServeAt(core.serve_at, core.timezone, holidayNow);
    const rest = plan.steps.find((s) => s.dish_id === "turkey_breast" && s.action.startsWith("Rest"));
    const turkeyReady = plan.steps.find(
      (s) => s.dish_id === "turkey_breast" && (s.action.includes("ready") || s.action.startsWith("Hold")),
    );
    assert.ok(rest && turkeyReady);
    const restStart = localToMs(rest!.at, serveMs, core.timezone);
    const restEnd = localToMs(turkeyReady!.at, serveMs, core.timezone);
    for (const id of ["stuffing", "green_bean_casserole"]) {
      const bake = plan.steps.find((s) => s.dish_id === id && s.action.startsWith("Bake"));
      assert.ok(bake, id);
      const bakeStart = localToMs(bake!.at, serveMs, core.timezone);
      const cook = getDishById(id)!.cook_min.typical;
      const bakeEnd = bakeStart + cook * 60_000;
      assert.ok(
        bakeStart < restEnd + 1000 && bakeEnd > restStart - 1000,
        `${id} should bake while turkey rests (bake ${bake!.at}+${cook}m, rest ${rest!.at}-${turkeyReady!.at})`,
      );
    }
    assert.equal(stablePlanFingerprint(plan), stablePlanFingerprint(solveMeal(core, holidayNow)));

    // Dinner rolls stay at 375 F, so they cannot share the 350 F side bake.
    // Sequencing is attempted; the hold windows do not cover a third oven block.
    const withRolls = solveMeal(
      baseInput({
        dishes: [...core.dishes, { id: "dinner_rolls" }],
        ovens: 1,
        cooks: 2,
        burners: 4,
        serve_at: "16:00",
      }),
      holidayNow,
    );
    assert.equal(getDishById("dinner_rolls")!.oven_temp!.f, 375);
    assert.equal(withRolls.feasible, false);
    assert.equal(withRolls.steps.length, 0);
    assert.ok(withRolls.conflicts?.some((c) => c.type === "oven_temp" || c.type === "oven_racks"));
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

  it("hits the 2-rack limit when whole turkey shares the oven with another dish", () => {
    const earlyNow = Date.parse("2026-11-26T10:00:00-05:00");
    const input = baseInput({
      dishes: [
        { id: "whole_turkey", overrides: { cook_min: 180 } },
        { id: "stuffing", overrides: { hold_min: 0 } },
      ],
      ovens: 1,
      cooks: 1,
      serve_at: "18:00",
    });
    const plan = solveMeal(input, earlyNow);
    // Whole turkey occupies both racks; stuffing must bake after or the plan asks about racks.
    if (plan.feasible) {
      const serveMs = parseServeAt(input.serve_at, input.timezone, earlyNow);
      const turkeyBake = plan.steps.find((s) => s.dish_id === "whole_turkey" && s.action.startsWith("Bake"))!;
      const stuffBake = plan.steps.find((s) => s.dish_id === "stuffing" && s.action.startsWith("Bake"))!;
      const t0 = localToMs(turkeyBake.at, serveMs, input.timezone);
      const t1 = t0 + 180 * 60_000;
      const s0 = localToMs(stuffBake.at, serveMs, input.timezone);
      const s1 = s0 + getDishById("stuffing")!.cook_min.typical * 60_000;
      assert.ok(s0 >= t1 - 1000 || t0 >= s1 - 1000, "stuffing must not share racks with whole turkey");
      assertResourceInvariants(plan, input);
    } else {
      assert.ok(plan.conflicts?.some((c) => c.type === "oven_racks"));
      assert.ok(plan.question);
      assert.match(plan.summary, /Draft - not workable yet/);
    }
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

  it("returns conflicts[] and Draft label when the plan does not fit", () => {
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
    assert.equal(plan.feasible, false);
    assert.ok(plan.conflicts && plan.conflicts.length >= 1, "expected conflicts[]");
    for (const c of plan.conflicts!) {
      assert.ok(c.type, "conflict type");
      assert.ok(Array.isArray(c.dishes) && c.dishes.length >= 1, "conflict dishes");
    }
    assert.ok(plan.question?.endsWith("?"));
    assert.equal((plan.question!.match(/\?/g) ?? []).length, 1);
    assert.match(plan.summary, /Draft - not workable yet/);
    assert.ok(plan.card.some((line) => line.includes("Draft - not workable yet")));
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
        assert.ok(a.steps[0]!.at >= formatLocalTime(NOW, TZ), `seed ${seed} starts before now`);
        for (const id of picked) {
          assert.ok(a.steps.some((s) => s.dish_id === id), `seed ${seed} missing ${id}`);
        }
      } else {
        assert.ok(a.question, `seed ${seed} infeasible without question`);
        assert.equal((a.question.match(/\?/g) ?? []).length, 1, `seed ${seed}`);
        assert.equal(a.steps.length, 0, `seed ${seed} infeasible plan still has a timeline`);
      }
    }
    assert.ok(feasibleCount > 50, `expected many feasible plans, got ${feasibleCount}`);
  });

  it("no hands-on work ends after serve_at when feasible", () => {
    const library = loadDishes();
    for (let seed = 0; seed < 100; seed++) {
      let state = (seed * 1103515245 + 12345) >>> 0;
      const rand = () => {
        state = (state * 1103515245 + 12345) >>> 0;
        return state / 0x100000000;
      };
      const n = 2 + Math.floor(rand() * 4);
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
        ovens: 2,
        cooks: 2,
        serve_at: "19:00",
      });
      const plan = solveMeal(input, NOW);
      if (!plan.feasible) continue;
      const serveMs = parseServeAt(input.serve_at, input.timezone, NOW);
      for (const d of input.dishes) {
        const base = getDishById(d.id)!;
        const readyStep = plan.steps.find(
          (s) => s.dish_id === d.id && (s.action.includes("ready") || s.action.startsWith("Hold")),
        );
        assert.ok(readyStep, d.id);
        const ready = localToMs(readyStep!.at, serveMs, input.timezone);
        const prep = d.overrides?.prep_min ?? base.prep_min;
        const cook = d.overrides?.cook_min ?? base.cook_min.typical;
        const rest = d.overrides?.rest_min ?? base.rest_min;
        const proof = base.proof_min ?? 0;
        const lastHands = Math.max(0, ...base.hands_on.map((h) => h.offset_min + h.minutes));
        const total = Math.max(prep + proof + cook + rest, lastHands);
        const start = ready - total * 60_000;
        for (const h of base.hands_on) {
          const end = start + (h.offset_min + h.minutes) * 60_000;
          assert.ok(end <= serveMs + 1000, `seed ${seed} ${d.id} hands-on after serve`);
        }
      }
    }
  });
});

describe("oven preheat", () => {
  it("adds a 15-minute Preheat before the first bake on each oven", () => {
    const input = baseInput({
      dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }, { id: "green_beans" }],
      cooks: 1,
      ovens: 1,
    });
    const plan = solveMeal(input, NOW);
    assert.equal(plan.feasible, true, plan.reason ?? plan.summary);
    const preheat = plan.steps.find((s) => s.action.startsWith("Preheat to"));
    assert.ok(preheat, "expected a Preheat step");
    assert.match(preheat!.action, /425 F/);
    assert.equal(preheat!.appliance, "oven");
    assert.equal(preheat!.hands_on, false);
    const firstBake = plan.steps
      .filter((s) => s.temp && s.action.startsWith("Bake"))
      .sort((a, b) => a.at.localeCompare(b.at) || a.dish_id.localeCompare(b.dish_id))[0];
    assert.ok(firstBake);
    const serveMs = parseServeAt(input.serve_at, input.timezone, NOW);
    const preheatMs = localToMs(preheat!.at, serveMs, input.timezone);
    const bakeMs = localToMs(firstBake!.at, serveMs, input.timezone);
    assert.equal(bakeMs - preheatMs, 15 * 60_000);
  });

  it("uses 10 minutes before a temperature increase and door-open cool on a decrease", () => {
    // Force cool-then-hot then hot-then-cool by pinning cook windows with hold.
    const upInput = baseInput({
      dishes: [
        { id: "turkey_breast", overrides: { hold_min: 90 } },
        { id: "roast_potatoes", overrides: { hold_min: 0 } },
      ],
      ovens: 1,
      cooks: 1,
      serve_at: "20:00",
    });
    const up = solveMeal(upInput, NOW);
    assert.equal(up.feasible, true, up.reason ?? up.summary);
    const serveUp = parseServeAt(upInput.serve_at, upInput.timezone, NOW);
    const potatoBake = up.steps.find((s) => s.dish_id === "roast_potatoes" && s.action.startsWith("Bake"))!;
    const turkeyBake = up.steps.find((s) => s.dish_id === "turkey_breast" && s.action.startsWith("Bake"))!;
    const potatoStart = localToMs(potatoBake.at, serveUp, upInput.timezone);
    const turkeyStart = localToMs(turkeyBake.at, serveUp, upInput.timezone);
    assert.ok(turkeyStart < potatoStart, "cooler turkey should bake before hotter potatoes");
    const bump = up.steps.find((s) => s.action === "Preheat to 425 F");
    assert.ok(bump, "expected Preheat to 425 F before temperature increase");
    // Not the initial 15-min preheat: this one ends at the potato bake start and is 10 min.
    assert.equal(potatoStart - localToMs(bump!.at, serveUp, upInput.timezone), 10 * 60_000);

    const downInput = baseInput({
      dishes: [
        { id: "roast_potatoes", overrides: { hold_min: 90 } },
        { id: "stuffing", overrides: { hold_min: 0 } },
      ],
      ovens: 1,
      cooks: 1,
      serve_at: "20:00",
    });
    const down = solveMeal(downInput, NOW);
    assert.equal(down.feasible, true, down.reason ?? down.summary);
    const serveDown = parseServeAt(downInput.serve_at, downInput.timezone, NOW);
    const hotBake = down.steps.find((s) => s.dish_id === "roast_potatoes" && s.action.startsWith("Bake"))!;
    const stuffBake = down.steps.find((s) => s.dish_id === "stuffing" && s.action.startsWith("Bake"))!;
    const hotStart = localToMs(hotBake.at, serveDown, downInput.timezone);
    const coolStart = localToMs(stuffBake.at, serveDown, downInput.timezone);
    assert.ok(hotStart < coolStart, "hotter potatoes should bake before cooler stuffing");
    const cool = down.steps.find((s) => /^Open door to cool to 350 F$/.test(s.action));
    assert.ok(cool, "expected Open door to cool before temperature decrease");
    assert.equal(coolStart - localToMs(cool!.at, serveDown, downInput.timezone), 10 * 60_000);
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

describe("running late looks forward", () => {
  it("at 16:30 for an 18:00 dinner, chicken +15 proposes 18:15 with no step before 16:30", () => {
    const now1630 = Date.parse("2026-11-26T16:30:00-05:00");
    const base = solveMeal(
      baseInput({
        dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }, { id: "green_beans" }],
        serve_at: "18:00",
      }),
      Date.parse("2026-11-26T15:00:00-05:00"),
    );
    assert.equal(base.feasible, true, base.reason ?? base.summary);
    const late = applyRunningLate(
      baseInput({
        dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }, { id: "green_beans" }],
        serve_at: "18:00",
      }),
      "chicken_thighs",
      15,
      now1630,
    );
    assert.match(late.question ?? late.summary, /Push dinner to 18:15\?/);
    assert.equal(late.serve_at_local, "18:15");
    for (const step of late.steps) {
      assert.ok(step.at >= "16:30", `step ${step.at} ${step.action} is before 16:30`);
    }
  });

  it("at 17:10, +15 still pushes serve to 18:15 and shows no step before now", () => {
    const now1710 = Date.parse("2026-11-26T17:10:00-05:00");
    const late = applyRunningLate(
      baseInput({
        dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }, { id: "green_beans" }],
        serve_at: "18:00",
      }),
      "chicken_thighs",
      15,
      now1710,
    );
    assert.equal(late.serve_at_local, "18:15");
    assert.match(late.question ?? "", /Push dinner to 18:15\?/);
    for (const step of late.steps) {
      assert.ok(step.at >= "17:10", `draft step ${step.at} ${step.action} is before now`);
    }
    assert.ok(
      late.steps.some((s) => s.at === "17:10" && s.action.startsWith("In progress:")),
      "work already started is in progress at now",
    );
  });
});

describe("solver regressions", () => {
  const morning = Date.parse("2026-11-26T10:00:00-05:00");

  it("keeps start <= finish, ready after every finish, plan start >= now, and no timeline when infeasible", () => {
    const input = baseInput({
      dishes: [{ id: "meatloaf" }, { id: "mashed_potatoes" }, { id: "salad" }],
      serve_at: "19:00",
    });
    const plan = solveMeal(input, morning);
    assert.equal(plan.feasible, true, plan.reason ?? plan.summary);
    assert.ok(plan.steps[0]!.at >= formatLocalTime(morning, TZ));
    const serveMs = parseServeAt(input.serve_at, input.timezone, morning);
    for (const id of ["meatloaf", "mashed_potatoes", "salad"]) {
      const ready = plan.steps.find((s) => s.dish_id === id && (s.action.includes("ready") || s.action.startsWith("Hold")))!;
      const start = plan.steps.find((s) => s.dish_id === id && s.action.startsWith("Start"))!;
      assert.ok(start.at <= ready.at, `${id} starts after it finishes`);
      for (const step of plan.steps.filter((s) => s.dish_id === id)) {
        assert.ok(step.at <= ready.at, `${id} step ${step.action} finishes after ready`);
      }
    }
    assert.ok(serveMs > 0);

    const blocked = solveMeal(
      baseInput({
        dishes: [
          { id: "turkey_breast", overrides: { hold_min: 0 } },
          { id: "roast_potatoes", overrides: { hold_min: 0, cook_min: 90 } },
          { id: "dinner_rolls", overrides: { hold_min: 0 } },
        ],
        ovens: 1,
      }),
      NOW,
    );
    assert.equal(blocked.feasible, false);
    assert.equal(blocked.steps.length, 0);
  });

  it("moves running_late forward by pushing serve_at + N", () => {
    const late = applyRunningLate(
      baseInput({ dishes: [{ id: "rice" }, { id: "green_beans" }], serve_at: "18:00" }),
      "rice",
      20,
      NOW,
    );
    assert.equal(late.serve_at_local, "18:20");
    assert.match(late.question ?? "", /18:20/);
  });

  it("keeps turkey_breast and whole_turkey explicit", () => {
    const breast = solveMeal(baseInput({ dishes: [{ id: "turkey_breast" }], serve_at: "18:00" }), morning);
    const whole = solveMeal(
      baseInput({
        dishes: [{ id: "whole_turkey", overrides: { cook_min: 180 } }],
        serve_at: "18:00",
      }),
      morning,
    );
    assert.equal(breast.feasible, true, breast.reason);
    assert.equal(whole.feasible, true, whole.reason);
    assert.ok(breast.steps.some((s) => s.dish_id === "turkey_breast"));
    assert.ok(whole.steps.some((s) => s.dish_id === "whole_turkey"));
    assert.equal(breast.steps.some((s) => s.dish_id === "whole_turkey"), false);
    assert.equal(getDishById("turkey_breast")!.oven_units, 1);
    assert.equal(getDishById("whole_turkey")!.oven_units, 2);
    assert.equal(getDishById("whole_turkey")!.names.includes("turkey"), false);
    assert.equal(getDishById("turkey_breast")!.names.includes("turkey"), false);
  });

  it("returns feasible=false with no executable timeline", () => {
    const plan = solveMeal(
      baseInput({
        dishes: [
          { id: "baked_salmon" },
          { id: "roast_potatoes" },
        ],
        ovens: 1,
        cooks: 1,
      }),
      NOW,
    );
    assert.equal(plan.feasible, false);
    assert.equal(plan.steps.length, 0);
    assert.ok(plan.conflicts && plan.conflicts.length > 0);
    assert.match(plan.summary, /Draft - not workable yet/);
  });

  it("keeps searching so turkey rest is checked against rack capacity", () => {
    // Whole turkey fills both racks and keeps them through the rest.
    // Search must place stuffing after that rest instead of stopping on the clash.
    const input = baseInput({
      dishes: [
        { id: "whole_turkey", overrides: { cook_min: 180 } },
        { id: "stuffing" },
      ],
      ovens: 1,
      cooks: 1,
      rack_count: 2,
      serve_at: "18:00",
    });
    const plan = solveMeal(input, morning);
    assert.equal(plan.feasible, true, plan.question ?? plan.reason ?? plan.summary);
    const serveMs = parseServeAt(input.serve_at, input.timezone, morning);
    const turkeyBake = plan.steps.find((s) => s.dish_id === "whole_turkey" && s.action.startsWith("Bake"))!;
    const rest = plan.steps.find((s) => s.dish_id === "whole_turkey" && s.action.startsWith("Rest"))!;
    const held = plan.steps.find(
      (s) => s.dish_id === "whole_turkey" && (s.action.startsWith("Hold") || s.action.includes("ready")),
    )!;
    const stuff = plan.steps.find((s) => s.dish_id === "stuffing" && s.action.startsWith("Bake"))!;
    const cookEnd = localToMs(turkeyBake.at, serveMs, input.timezone) + 180 * 60_000;
    const restStart = localToMs(rest.at, serveMs, input.timezone);
    const restEnd = localToMs(held.at, serveMs, input.timezone);
    const stuffStart = localToMs(stuff.at, serveMs, input.timezone);
    const stuffEnd = stuffStart + getDishById("stuffing")!.cook_min.typical * 60_000;
    assert.equal(restStart, cookEnd);
    assert.ok(restEnd > restStart);
    const overlapsRest = stuffStart < restEnd && stuffEnd > restStart;
    assert.equal(overlapsRest, false, "stuffing bakes while the whole turkey still occupies the oven");
    assertResourceInvariants(plan, input);
  });

  it("models preheat as a step that takes time", () => {
    const input = baseInput({
      dishes: [{ id: "baked_salmon" }],
      serve_at: "19:00",
    });
    const plan = solveMeal(input, morning);
    assert.equal(plan.feasible, true, plan.reason ?? plan.summary);
    const preheat = plan.steps.find((s) => s.action.startsWith("Preheat to"))!;
    const bake = plan.steps.find((s) => s.dish_id === "baked_salmon" && s.action.startsWith("Bake"))!;
    const serveMs = parseServeAt(input.serve_at, input.timezone, morning);
    const gap = localToMs(bake.at, serveMs, input.timezone) - localToMs(preheat.at, serveMs, input.timezone);
    assert.equal(gap, 15 * 60_000);
    assert.ok(gap > 0);
  });

  it("enforces a configurable rack count", () => {
    const tight = solveMeal(
      baseInput({
        dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }],
        ovens: 1,
        rack_count: 1,
        serve_at: "19:00",
      }),
      morning,
    );
    assert.equal(tight.feasible, false);
    assert.equal(tight.steps.length, 0);
    assert.ok(tight.conflicts?.some((c) => c.type === "oven_racks"));

    const wide = solveMeal(
      baseInput({
        dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }],
        ovens: 1,
        rack_count: 2,
        serve_at: "19:00",
      }),
      morning,
    );
    assert.equal(wide.feasible, true, wide.reason ?? wide.summary);
    assertResourceInvariants(wide, { ...baseInput({ dishes: wide.steps.length ? [] : [] }), rack_count: 2, dishes: [{ id: "chicken_thighs" }, { id: "roast_potatoes" }], serve_at: "19:00" });
  });

  it("slides prep earlier inside the hold window before a hands-on refusal", () => {
    const holiday = solveMeal(
      baseInput({
        dishes: [
          { id: "turkey_breast" },
          { id: "stuffing" },
          { id: "mashed_potatoes" },
          { id: "green_bean_casserole" },
          { id: "gravy" },
        ],
        ovens: 1,
        cooks: 1,
        serve_at: "16:00",
      }),
      morning,
    );
    assert.equal(holiday.feasible, true, holiday.question ?? holiday.reason ?? holiday.summary);
    assertResourceInvariants(holiday, baseInput({
      dishes: [
        { id: "turkey_breast" },
        { id: "stuffing" },
        { id: "mashed_potatoes" },
        { id: "green_bean_casserole" },
        { id: "gravy" },
      ],
      ovens: 1,
      cooks: 1,
      serve_at: "16:00",
    }));

    const salmon = solveMeal(
      baseInput({
        dishes: [{ id: "baked_salmon" }, { id: "roast_potatoes" }],
        ovens: 1,
        cooks: 1,
        serve_at: "18:00",
      }),
      NOW,
    );
    // Different oven temperatures, and the hold windows do not cover a sequenced bake.
    assert.equal(salmon.feasible, false);
    assert.equal(salmon.steps.length, 0);
    assert.ok(salmon.conflicts?.some((c) => c.type === "oven_temp" || c.type === "hands_on"));
  });

  it("counts the spoken start from the first step, including preheat", () => {
    const plan = solveMeal(
      baseInput({ dishes: [{ id: "chicken_thighs" }], serve_at: "19:00" }),
      morning,
    );
    assert.equal(plan.feasible, true, plan.reason ?? plan.summary);
    assert.equal(plan.steps[0]!.at, "18:00");
    assert.match(plan.steps[0]!.action, /Preheat/);
    assert.ok(plan.steps.some((s) => s.at === "18:05"));
    assert.match(plan.summary, /start at 18:00/);
    assert.equal(plan.summary.includes("start at 18:05"), false);
  });

  it("sequences 375 F dinner rolls instead of sharing the 350 F bake", () => {
    const rolls = getDishById("dinner_rolls")!;
    assert.equal(rolls.oven_temp!.f, 375);
    assert.equal(rolls.oven_temp!.c, 190);
    const plan = solveMeal(
      baseInput({
        dishes: [{ id: "stuffing" }, { id: "dinner_rolls" }, { id: "gravy" }],
        ovens: 1,
        cooks: 1,
        serve_at: "18:00",
      }),
      morning,
    );
    assert.equal(plan.feasible, true, plan.question ?? plan.reason ?? plan.summary);
    const rollBake = plan.steps.find((s) => s.dish_id === "dinner_rolls" && s.action.startsWith("Bake"))!;
    const stuffBake = plan.steps.find((s) => s.dish_id === "stuffing" && s.action.startsWith("Bake"))!;
    assert.equal(rollBake.temp, "375 F");
    assert.equal(stuffBake.temp, "350 F");
    const serveMs = parseServeAt("18:00", TZ, morning);
    const r0 = localToMs(rollBake.at, serveMs, TZ);
    const s0 = localToMs(stuffBake.at, serveMs, TZ);
    const r1 = r0 + rolls.cook_min.typical * 60_000;
    const s1 = s0 + getDishById("stuffing")!.cook_min.typical * 60_000;
    assert.ok(r0 >= s1 - 1000 || s0 >= r1 - 1000, "rolls and stuffing share the oven");
    const proof = plan.steps.find((s) => s.dish_id === "dinner_rolls" && s.action.startsWith("Proof"))!;
    assert.ok(proof.at < rollBake.at);
  });

  it("labels ovens and does not hold salad warm", () => {
    const two = solveMeal(
      baseInput({
        dishes: [{ id: "turkey_breast" }, { id: "roast_potatoes" }, { id: "salad" }],
        ovens: 2,
        cooks: 1,
        serve_at: "19:00",
      }),
      morning,
    );
    assert.equal(two.feasible, true, two.reason ?? two.summary);
    const ovenNames = two.steps.filter((s) => s.action.startsWith("Preheat") || s.action.startsWith("Open door")).map((s) => s.dish);
    assert.ok(ovenNames.includes("oven 1"), ovenNames.join(","));
    assert.ok(ovenNames.includes("oven 2"), ovenNames.join(","));
    assert.equal(two.steps.some((s) => /hold salad warm/i.test(s.action)), false);

    const salad = solveMeal(
      baseInput({
        dishes: [{ id: "lasagna" }, { id: "salad" }, { id: "garlic_bread" }],
        ovens: 1,
        cooks: 1,
      }),
      NOW,
    );
    assert.equal(salad.feasible, true, salad.reason ?? salad.summary);
    assert.equal(salad.steps.some((s) => /hold salad warm/i.test(s.action)), false);
    const held = salad.steps.find((s) => s.dish_id === "salad" && s.action.startsWith("Hold"));
    if (held) assert.equal(held.action, "Hold salad");
  });
});
