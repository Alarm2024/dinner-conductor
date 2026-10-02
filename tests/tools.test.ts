import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { startServer } from "../src/http.js";
import { clearPlansForTests } from "../src/plans.js";

interface Reply {
  status: number;
  body: string;
}

function send(port: number, body: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          host: "127.0.0.1",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function toolCall(id: number, name: string, args: Record<string, unknown>): string {
  return rpc(id, "tools/call", { name, arguments: args });
}

function parseResult(body: string): Record<string, unknown> {
  let jsonText = body;
  if (body.includes("data:")) {
    const dataLine = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("data:"));
    assert.ok(dataLine, body);
    jsonText = dataLine!.slice("data:".length).trim();
  }
  const msg = JSON.parse(jsonText) as {
    result?: { content?: Array<{ text?: string }>; structuredContent?: unknown };
    error?: unknown;
  };
  assert.ok(msg.result, jsonText);
  if (msg.result?.structuredContent && typeof msg.result.structuredContent === "object") {
    return msg.result.structuredContent as Record<string, unknown>;
  }
  const text = msg.result?.content?.[0]?.text;
  assert.ok(text, jsonText);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("MCP tools", () => {
  let server: Server;
  let port = 0;

  before(async () => {
    clearPlansForTests();
    server = await startServer({ host: "127.0.0.1", port: 0 });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
    await send(
      port,
      rpc(0, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "tools-test", version: "0.0.0" },
      }),
    );
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("lists all seven tools", async () => {
    const reply = await send(port, rpc(1, "tools/list"));
    assert.equal(reply.status, 200, reply.body);
    for (const name of [
      "find_dish",
      "plan_meal",
      "whats_next",
      "running_late",
      "change_menu",
      "read_plan",
      "resume_plan",
    ]) {
      assert.match(reply.body, new RegExp(`"name":"${name}"`));
    }
    assert.match(reply.body, /Out of scope: allergy/);
  });

  it("find_dish returns typical times", async () => {
    const reply = await send(port, toolCall(2, "find_dish", { name: "roast chicken" }));
    const payload = parseResult(reply.body);
    assert.equal(payload.ambiguous, false);
    assert.match(String(payload.summary), /recipe's times win/i);
  });

  it("plan_meal returns needs when serve_at is missing", async () => {
    const reply = await send(
      port,
      toolCall(3, "plan_meal", { dishes: ["chicken_thighs", "rice"], ovens: 1 }),
    );
    const payload = parseResult(reply.body);
    assert.deepEqual(payload.needs, ["serve_at"]);
    assert.match(String(payload.summary), /\?/);
  });

  it("plan_meal asks for whole turkey roast time when cook_min is missing", async () => {
    const reply = await send(
      port,
      toolCall(31, "plan_meal", {
        dishes: ["whole_turkey"],
        serve_at: "18:00",
        ovens: 1,
        now: "2026-11-26T10:00:00-05:00",
      }),
    );
    const payload = parseResult(reply.body);
    assert.ok(payload.needs);
    assert.ok((payload.needs as string[]).some((n) => /cook_min/i.test(n)));
    assert.match(String(payload.summary), /How long does your recipe say to roast it\?/);
  });

  it("plan_meal uses the request's now, not the server clock (sim at 16:00, dinner at 19:00 today)", async () => {
    const reply = await send(
      port,
      toolCall(90, "plan_meal", {
        dishes: ["roast_chicken", "roast_potatoes", "green_beans"],
        serve_at: "19:00",
        timezone: "America/New_York",
        ovens: 1,
        cooks: 1,
        burners: 4,
        units: "F",
        now: "2026-11-26T16:00:00-05:00",
      }),
    );
    const payload = parseResult(reply.body);
    assert.equal(payload.feasible, true, String(payload.summary));
    assert.doesNotMatch(String(payload.summary), /tomorrow/i);
  });

  it("whats_next refuses an unreadable now instead of using the server clock", async () => {
    const planned = parseResult(
      (
        await send(
          port,
          toolCall(91, "plan_meal", {
            dishes: ["pasta"],
            serve_at: "19:00",
            timezone: "America/New_York",
            ovens: 1,
            now: "2026-11-26T16:00:00-05:00",
          }),
        )
      ).body,
    );
    const reply = await send(port, toolCall(92, "whats_next", { plan_id: planned.plan_id, now: "16:00" }));
    assert.match(reply.body, /"isError":true/);
  });

  it("plan_meal uses the request's now", async () => {
    const late = parseResult(
      (
        await send(
          port,
          toolCall(40, "plan_meal", {
            dishes: ["lasagna"],
            serve_at: "18:00",
            timezone: "America/New_York",
            ovens: 1,
            now: "2026-11-26T17:30:00-05:00",
          }),
        )
      ).body,
    );
    assert.equal(late.feasible, false);
    assert.match(String(late.question ?? late.summary), /The earliest this menu can be ready is \d{2}:\d{2}/);

    const early = parseResult(
      (
        await send(
          port,
          toolCall(41, "plan_meal", {
            dishes: ["lasagna"],
            serve_at: "18:00",
            timezone: "America/New_York",
            ovens: 1,
            now: "2026-11-26T10:00:00-05:00",
          }),
        )
      ).body,
    );
    assert.equal(early.feasible, true, String(early.reason ?? early.summary));
  });

  it("whats_next refuses an unreadable now", async () => {
    const planned = parseResult(
      (
        await send(
          port,
          toolCall(42, "plan_meal", {
            dishes: ["salad"],
            serve_at: "18:00",
            timezone: "America/New_York",
            ovens: 1,
            now: "2026-11-26T15:00:00-05:00",
          }),
        )
      ).body,
    );
    assert.ok(planned.plan_id);
    const refused = parseResult(
      (
        await send(
          port,
          toolCall(43, "whats_next", { plan_id: planned.plan_id, now: "not-a-timestamp" }),
        )
      ).body,
    );
    assert.match(String(refused.summary), /now must be an ISO timestamp/);
  });

  it("running_late and change_menu accept now", async () => {
    const reply = await send(port, rpc(44, "tools/list"));
    const msg = JSON.parse(
      reply.body.includes("data:")
        ? reply.body
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("data:"))!
            .slice("data:".length)
            .trim()
        : reply.body,
    ) as { result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
    const tools = msg.result?.tools ?? [];
    for (const name of ["running_late", "change_menu", "plan_meal", "whats_next"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, name);
      assert.ok(tool!.inputSchema?.properties && "now" in tool!.inputSchema.properties, `${name} schema accepts now`);
    }
  });

  it("(b) whats_next after a refused plan says there is no workable plan yet", async () => {
    const planned = parseResult(
      (
        await send(
          port,
          toolCall(40, "plan_meal", {
            dishes: ["turkey_breast", "stuffing", "mashed_potatoes", "green_bean_casserole", "dinner_rolls", "gravy"],
            serve_at: "19:00",
            timezone: "America/New_York",
            ovens: 1,
            cooks: 1,
            now: "2026-11-26T16:00:00-05:00",
          }),
        )
      ).body,
    );
    assert.equal(planned.feasible, false);
    assert.ok(planned.plan_id);
    const next = parseResult(
      (
        await send(port, toolCall(41, "whats_next", { plan_id: planned.plan_id, now: "2026-11-26T16:00:00-05:00" }))
      ).body,
    );
    assert.equal(next.next, null);
    assert.equal(next.current, null);
    assert.match(String(next.summary), /^There is no workable plan yet\. One oven cannot bake/);
    assert.doesNotMatch(String(next.summary), /All steps are done/);
    assert.equal((next.card as string[])[0], "No workable plan yet.");
    assert.equal((next.card as string[]).includes("Next: none"), false);
  });

  it("plan_meal stores a plan and read_plan / whats_next / resume_plan work", async () => {
    const planned = await send(
      port,
      toolCall(4, "plan_meal", {
        dishes: ["chicken_thighs", "roast_potatoes", "green_beans"],
        serve_at: "18:00",
        timezone: "America/New_York",
        ovens: 1,
        cooks: 1,
        now: "2026-11-26T15:00:00-05:00",
      }),
    );
    const plan = parseResult(planned.body);
    assert.ok(plan.plan_id);
    assert.ok(plan.plan_token);
    assert.equal(plan.feasible, true, String(plan.reason ?? plan.summary));

    const read = parseResult((await send(port, toolCall(5, "read_plan", { plan_id: plan.plan_id }))).body);
    assert.equal(read.plan_id, plan.plan_id);
    assert.ok(Array.isArray(read.card));

    const next = parseResult(
      (
        await send(
          port,
          toolCall(6, "whats_next", { plan_id: plan.plan_id, now: "2026-11-26T17:00:00-05:00" }),
        )
      ).body,
    );
    assert.ok(next.summary);

    const resumed = parseResult(
      (await send(port, toolCall(7, "resume_plan", { plan_token: plan.plan_token }))).body,
    );
    assert.ok(resumed.plan_id);
    assert.ok(resumed.steps);

    const late = parseResult(
      (
        await send(
          port,
          toolCall(8, "running_late", {
            plan_id: plan.plan_id,
            dish: "roast_potatoes",
            minutes: 10,
            now: "2026-11-26T15:00:00-05:00",
          }),
        )
      ).body,
    );
    assert.match(String(late.changed ?? late.summary), /10 minutes/);
    assert.equal(late.feasible, true);
    assert.match(String(late.summary), /Dinner moves to 18:10\./);

    const changed = parseResult(
      (
        await send(
          port,
          toolCall(9, "change_menu", {
            plan_id: plan.plan_id,
            add: ["salad"],
            remove: ["green_beans"],
            now: "2026-11-26T15:00:00-05:00",
          }),
        )
      ).body,
    );
    assert.ok(changed.plan_id);
    const steps = JSON.stringify(changed.steps);
    assert.match(steps, /salad/);
    assert.equal(steps.includes("green_beans"), false);
  });
});
