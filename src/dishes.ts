import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Appliance = "oven" | "stovetop" | "none";

export interface HandsOnSegment {
  offset_min: number;
  minutes: number;
  label: string;
}

export interface CookRange {
  typical: number;
  low: number;
  high: number;
}

export interface OvenTemp {
  f: number;
  c: number;
}

export interface Dish {
  id: string;
  names: string[];
  prep_min: number;
  hands_on: HandsOnSegment[];
  cook_min: CookRange;
  appliance: Appliance;
  oven_temp: OvenTemp | null;
  oven_units: number;
  burners: number;
  rest_min: number;
  hold_min: number;
}

interface DishFile {
  dishes: Dish[];
}

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../data/dishes.json");

let cached: Dish[] | null = null;

export function loadDishes(): Dish[] {
  if (cached) return cached;
  const raw = readFileSync(DATA_PATH, "utf8");
  const parsed = JSON.parse(raw) as DishFile;
  cached = parsed.dishes;
  return cached;
}

export function getDishById(id: string): Dish | undefined {
  return loadDishes().find((d) => d.id === id);
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface DishMatch {
  dish: Dish;
  score: number;
  matched_name: string;
}

/** Rank dishes by spoken name. Exact alias wins; then starts-with; then includes. */
export function findDishesByName(name: string): DishMatch[] {
  const q = normalize(name);
  if (!q) return [];
  const matches: DishMatch[] = [];
  for (const dish of loadDishes()) {
    let best = 0;
    let matched = dish.names[0] ?? dish.id;
    for (const alias of dish.names) {
      const a = normalize(alias);
      let score = 0;
      if (a === q || dish.id === q.replace(/\s+/g, "_")) score = 100;
      else if (a.startsWith(q) || q.startsWith(a)) score = 80;
      else if (a.includes(q) || q.includes(a)) score = 50;
      else {
        const qTokens = q.split(" ");
        const aTokens = a.split(" ");
        const overlap = qTokens.filter((t) => aTokens.includes(t)).length;
        if (overlap > 0) score = 30 + overlap * 10;
      }
      if (score > best) {
        best = score;
        matched = alias;
      }
    }
    if (best > 0) matches.push({ dish, score: best, matched_name: matched });
  }
  matches.sort((a, b) => b.score - a.score || a.dish.id.localeCompare(b.dish.id));
  return matches;
}

export function typicalSummary(dish: Dish): string {
  const cook = dish.cook_min.typical;
  const temp = dish.oven_temp ? ` at ${dish.oven_temp.f} F / ${dish.oven_temp.c} C` : "";
  const appliance = dish.appliance === "none" ? "no cook" : dish.appliance;
  return `${dish.names[0]}: prep ${dish.prep_min} min, cook ${cook} min (${appliance}${temp}), rest ${dish.rest_min} min, hold up to ${dish.hold_min} min. Your recipe's times win.`;
}
