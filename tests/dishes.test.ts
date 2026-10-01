import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findDishesByName, loadDishes, typicalSummary } from "../src/dishes.js";

describe("dish library", () => {
  it("loads about forty common home dishes", () => {
    const dishes = loadDishes();
    assert.ok(dishes.length >= 40, `expected >= 40, got ${dishes.length}`);
    const ids = new Set(dishes.map((d) => d.id));
    assert.equal(ids.size, dishes.length);
    for (const required of [
      "roast_chicken",
      "turkey_breast",
      "whole_turkey",
      "standing_rib_roast",
      "roast_potatoes",
      "mashed_potatoes",
      "rice",
      "pasta",
      "green_beans",
      "roast_vegetables",
      "stuffing",
      "dinner_rolls",
      "gravy",
      "salad",
      "garlic_bread",
      "baked_salmon",
      "meatloaf",
      "lasagna",
      "apple_pie",
    ]) {
      assert.ok(ids.has(required), `missing ${required}`);
    }
  });

  it("has required fields on every dish", () => {
    for (const dish of loadDishes()) {
      assert.ok(dish.id);
      assert.ok(dish.names.length >= 1);
      assert.ok(Number.isFinite(dish.prep_min));
      assert.ok(Array.isArray(dish.hands_on));
      assert.ok(Number.isFinite(dish.cook_min.typical));
      assert.ok(["oven", "stovetop", "none"].includes(dish.appliance));
      if (dish.appliance === "oven") {
        assert.ok(dish.oven_temp);
        assert.ok(dish.oven_units >= 1 && dish.oven_units <= 2);
      }
      assert.ok(dish.burners >= 0 && dish.burners <= 2);
      assert.ok(Number.isFinite(dish.rest_min));
      assert.ok(Number.isFinite(dish.hold_min));
    }
  });

  it("finds dishes by spoken alias", () => {
    const turkey = findDishesByName("turkey breast");
    assert.equal(turkey[0]?.dish.id, "turkey_breast");
    const mash = findDishesByName("mashed potatoes");
    assert.equal(mash[0]?.dish.id, "mashed_potatoes");
    const summary = typicalSummary(mash[0]!.dish);
    assert.match(summary, /Your recipe's times win/);
  });

  it("every hands_on segment ends within prep+cook+rest", () => {
    for (const dish of loadDishes()) {
      if (dish.requires_recipe_cook_min) continue;
      const total = dish.prep_min + dish.cook_min.typical + dish.rest_min;
      for (const h of dish.hands_on) {
        const end = h.offset_min + h.minutes;
        assert.ok(
          end <= total,
          `${dish.id}: hands_on "${h.label}" ends at ${end} > total ${total}`,
        );
      }
    }
  });

  it('find_dish("turkey") is ambiguous between turkey breast and whole turkey', () => {
    const matches = findDishesByName("turkey");
    const ids = matches.map((m) => m.dish.id);
    assert.ok(ids.includes("turkey_breast"), "expected turkey_breast");
    assert.ok(ids.includes("whole_turkey"), "expected whole_turkey");
    assert.ok(matches.length >= 2);
    assert.ok(!loadDishes().find((d) => d.id === "turkey_breast")!.names.includes("turkey"));
  });

  it("splits standing rib roast from roast beef", () => {
    const rib = findDishesByName("standing rib roast");
    assert.equal(rib[0]?.dish.id, "standing_rib_roast");
    assert.ok(rib[0]?.dish.requires_recipe_cook_min);
    assert.ok(!loadDishes().find((d) => d.id === "roast_beef")!.names.some((n) => /standing rib/i.test(n)));
  });

  it("whole_turkey uses 2 oven units and requires recipe cook time", () => {
    const whole = loadDishes().find((d) => d.id === "whole_turkey");
    assert.ok(whole);
    assert.equal(whole!.oven_units, 2);
    assert.equal(whole!.requires_recipe_cook_min, true);
  });
});
