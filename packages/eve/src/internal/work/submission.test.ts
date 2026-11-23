import { describe, expect, it } from "vitest";

import { workContinuationToken, workSubmissionDigest } from "./identity.js";
import { parseIdempotencyKey, parseWorkSubmission } from "./submission.js";

const limits = { maxObjectiveLength: 100, repositoryHosts: ["github.com"] };

describe("parseWorkSubmission", () => {
  it("accepts an objective with context and an allowed repository", () => {
    expect(
      parseWorkSubmission(
        {
          context: ["Alice owns the release."],
          objective: "Prepare the release notes.",
          repository: { branch: "work/notes", ref: "main", url: "https://github.com/acme/app" },
        },
        limits,
      ),
    ).toEqual({
      ok: true,
      value: {
        context: ["Alice owns the release."],
        objective: "Prepare the release notes.",
        repository: { branch: "work/notes", ref: "main", url: "https://github.com/acme/app" },
      },
    });
  });

  it.each([
    [{ objective: "" }, "invalid_objective"],
    [{ objective: "x".repeat(101) }, "invalid_objective"],
    [{ objective: "ok", extra: 1 }, "invalid_body"],
    [{ context: [1], objective: "ok" }, "invalid_context"],
    [{ objective: "ok", repository: { url: "http://github.com/a/b" } }, "invalid_repository"],
    [
      { objective: "ok", repository: { url: "https://token@github.com/a/b" } },
      "invalid_repository",
    ],
    [{ objective: "ok", repository: { url: "https://gitlab.com/a/b" } }, "repository_not_allowed"],
    [
      { objective: "ok", repository: { ref: "--upload-pack=x", url: "https://github.com/a/b" } },
      "invalid_repository",
    ],
    [
      { objective: "ok", repository: { ref: "a..b", url: "https://github.com/a/b" } },
      "invalid_repository",
    ],
  ])("refuses %j with %s", (body, code) => {
    expect(parseWorkSubmission(body, limits)).toMatchObject({ code, ok: false });
  });

  it("refuses any repository when no host is allowed", () => {
    expect(
      parseWorkSubmission(
        { objective: "ok", repository: { url: "https://github.com/a/b" } },
        { ...limits, repositoryHosts: [] },
      ),
    ).toMatchObject({ code: "repository_not_allowed", ok: false });
  });
});

describe("work identity", () => {
  it("derives one token per owner and key", () => {
    const token = workContinuationToken("owner-a", "order-1");
    expect(token).toBe(workContinuationToken("owner-a", "order-1"));
    expect(token).not.toBe(workContinuationToken("owner-b", "order-1"));
    expect(token).not.toBe(workContinuationToken("owner-a", "order-2"));
    expect(token).toMatch(/^work:[0-9a-f]{40}$/u);
  });

  it("digests what the work asks for", () => {
    const digest = workSubmissionDigest({ objective: "Count the stock." });
    expect(digest).toBe(workSubmissionDigest({ objective: "Count the stock." }));
    expect(digest).not.toBe(workSubmissionDigest({ objective: "Count the stock again." }));
    expect(digest).not.toBe(
      workSubmissionDigest({
        objective: "Count the stock.",
        repository: { url: "https://github.com/a/b" },
      }),
    );
  });

  it("requires a bounded Idempotency-Key header", () => {
    const request = (key?: string) =>
      new Request("http://agent.test/eve/v1/work", {
        headers: key === undefined ? {} : { "idempotency-key": key },
      });
    expect(parseIdempotencyKey(request("order-1"))).toEqual({ ok: true, value: "order-1" });
    expect(parseIdempotencyKey(request())).toMatchObject({ ok: false });
    expect(parseIdempotencyKey(request("k".repeat(201)))).toMatchObject({ ok: false });
  });
});
