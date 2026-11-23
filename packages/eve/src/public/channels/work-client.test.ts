import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createWorkClient, WorkClientError } from "./work-client.js";

function ndjson(records: readonly unknown[]): Response {
  return new Response(records.map((record) => `${JSON.stringify(record)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

const line = (n: number) => ({ at: "2026-11-23T00:00:00.000Z", facts: [{ n }] });

describe("createWorkClient", () => {
  it("sends the idempotency key and auth headers with a submission", async () => {
    const seen: Request[] = [];
    const client = createWorkClient({
      baseUrl: "https://agent.test",
      fetch: async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ deliveryId: "d1", replayed: false, sessionId: "wrun_1" });
      },
      headers: () => ({ authorization: "Bearer t" }),
    });
    await expect(
      client.submit({ objective: "Count the stock." }, { idempotencyKey: "order-1" }),
    ).resolves.toMatchObject({ sessionId: "wrun_1" });
    const [request] = seen;
    expect(request?.url).toBe("https://agent.test/eve/v1/work");
    expect(request?.headers.get("idempotency-key")).toBe("order-1");
    expect(request?.headers.get("authorization")).toBe("Bearer t");
    await expect(request?.json()).resolves.toEqual({ objective: "Count the stock." });
  });

  it("throws the API's code and message", async () => {
    const client = createWorkClient({
      baseUrl: "https://agent.test",
      fetch: async () =>
        Response.json(
          { code: "idempotency_key_reused", message: "Use a new key.", ok: false },
          { status: 409 },
        ),
    });
    const error = await client
      .submit({ objective: "x" }, { idempotencyKey: "k" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkClientError);
    expect(error).toMatchObject({ code: "idempotency_key_reused", status: 409 });
  });

  it("returns no result while the work runs", async () => {
    const client = createWorkClient({
      baseUrl: "https://agent.test",
      fetch: async () =>
        Response.json({ code: "work_not_settled", message: "", ok: false }, { status: 409 }),
    });
    await expect(client.result("wrun_1")).resolves.toBeUndefined();
  });

  it("resumes from its cursor after a lease ends and stops when the stream ends", async () => {
    const requested: string[] = [];
    const pages = [
      ndjson([{ $eve: "heartbeat" }, line(0), line(1), { $eve: "stream.lease-ended" }]),
      ndjson([line(2), { $eve: "stream.ended" }]),
    ];
    const client = createWorkClient({
      baseUrl: "https://agent.test",
      fetch: async (input) => {
        requested.push(new URL(String(input)).searchParams.get("startIndex") ?? "");
        return pages.shift() ?? ndjson([{ $eve: "stream.ended" }]);
      },
    });
    const events = [];
    for await (const event of client.events("wrun_1")) events.push(event);
    expect(requested).toEqual(["0", "2"]);
    expect(events.map((event) => [event.position, event.cursor])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("starts from a saved cursor and gives up after repeated disconnects", async () => {
    const requested: string[] = [];
    const client = createWorkClient({
      baseUrl: "https://agent.test",
      fetch: async (input) => {
        requested.push(new URL(String(input)).searchParams.get("startIndex") ?? "");
        return ndjson([{ $eve: "heartbeat" }]);
      },
    });
    const read = async () => {
      const events = [];
      for await (const event of client.events("wrun_1", { cursor: 7, maxReconnects: 1 })) {
        events.push(event);
      }
      return events;
    };
    await expect(read()).rejects.toMatchObject({ code: "stream_disconnected" });
    expect(requested).toEqual(["7", "7"]);
  });
});

describe("work client entry", () => {
  it("imports nothing at runtime, so Node.js 22 processes can load it", () => {
    const source = readFileSync(new URL("./work-client.ts", import.meta.url), "utf8");
    const imports = source.match(/^(?:import (?!type\b)|export (?:\*|\{)).*$/gmu) ?? [];
    expect(imports).toEqual([]);
  });
});
