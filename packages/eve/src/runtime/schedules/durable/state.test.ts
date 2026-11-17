import { describe, expect, it } from "vitest";

import { nextScheduleOccurrence, workflowScheduleToken } from "./state.js";

describe("nextScheduleOccurrence", () => {
  it("computes the next cron occurrence in the schedule's timezone", () => {
    expect(
      nextScheduleOccurrence(
        { cron: "0 9 * * *", timezone: "America/New_York", type: "cron" },
        new Date("2026-11-17T20:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-11-18T14:00:00.000Z");
  });

  it("treats a cron schedule without a timezone as UTC", () => {
    expect(
      nextScheduleOccurrence(
        { cron: "30 6 * * *", type: "cron" },
        new Date("2026-11-17T07:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-11-18T06:30:00.000Z");
  });

  it("fires a single schedule once and never after it", () => {
    const at = { at: "2026-12-01T10:00", timezone: "Europe/Berlin", type: "single" } as const;

    expect(nextScheduleOccurrence(at, new Date("2026-11-17T00:00:00Z"))?.toISOString()).toBe(
      "2026-12-01T09:00:00.000Z",
    );
    expect(nextScheduleOccurrence(at, new Date("2026-12-02T00:00:00Z"))).toBeNull();
  });

  it("rejects an invalid cron expression", () => {
    expect(() =>
      nextScheduleOccurrence({ cron: "not a cron", type: "cron" }, new Date()),
    ).toThrow();
  });
});

describe("workflowScheduleToken", () => {
  it("partitions schedules by namespace and collection", () => {
    const base = { collection: "reminders", name: "daily", namespace: "eve-a" };

    expect(workflowScheduleToken(base)).toBe(workflowScheduleToken({ ...base }));
    expect(workflowScheduleToken(base)).not.toBe(
      workflowScheduleToken({ ...base, namespace: "eve-b" }),
    );
    expect(workflowScheduleToken(base)).not.toBe(
      workflowScheduleToken({ ...base, collection: "other" }),
    );
    expect(workflowScheduleToken(base)).toMatch(/^eve:schedule:[0-9a-f]{64}$/u);
  });
});
