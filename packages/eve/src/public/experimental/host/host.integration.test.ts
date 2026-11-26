import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineAgent } from "#public/definitions/agent.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

import { createEveHost, type EveModelReference } from "./index.ts";

const reports: string[] = [];

const scripted = () =>
  markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [`${part.toolName}:${part.output.type}`] : [],
              )
            : [],
        );
        const asked = prompt.flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [],
        );
        if (asked.some((text) => text.includes("Investigate"))) {
          const delivered = asked.find((text) => text.includes("<task_result"));
          if (delivered !== undefined) {
            const report = `Report: ${/Root cause: [^<]*/.exec(delivered)?.[0] ?? "missing"}`;
            reports.push(report);
            return textStreamResult(report);
          }
          return results.length > 0
            ? textStreamResult("Investigation started.")
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "Find the root cause of the outage." }),
                  toolCallId: "call-research",
                  toolName: "agent",
                },
              ]);
        }
        if (asked.some((text) => text.includes("Find the root cause"))) {
          return textStreamResult("Root cause: a configuration change at 09:14.");
        }
        if (asked.some((text) => text.includes("Deploy"))) {
          return results.length > 0
            ? textStreamResult(`Done: ${results.sort().join(", ")}.`)
            : toolCallsStreamResult([
                { input: "{}", toolCallId: "call-deploy", toolName: "deploy_change" },
                { input: "{}", toolCallId: "call-publish", toolName: "publish_change" },
              ]);
        }
        return textStreamResult(`Heard: ${asked.at(-1)}`);
      },
      modelId: "host-scripted",
      provider: "eve-test",
    }),
  );

const approvedTool = (name: string, ran: string[]) => ({
  loadNamespace: async () => ({
    default: defineTool({
      approval: always(),
      description: `Run ${name}.`,
      execute: async () => {
        ran.push(name);
        return { ran: name };
      },
      inputSchema: {},
    }),
  }),
  logicalPath: `tools/${name}.ts`,
});

const agentModelNeverUsed = defineAgent({
  model: defineDynamic(() => {
    throw new Error(
      "Under a host, the host resolves the model; the agent's own definition must not run.",
    );
  }),
});

describe("eve/experimental/host on Node", () => {
  it("runs one organization's agent for two applications, each in its own sessions, with the host's model", async () => {
    const ran: string[] = [];
    const references: EveModelReference[] = [];
    const test = await createTestRuntime({
      agent: { definition: agentModelNeverUsed, name: "org-agent" },
      modules: [approvedTool("deploy_change", ran), approvedTool("publish_change", ran)],
    });
    await test.run(async () => {
      const host = createEveHost({
        agent: readBundledCompiledArtifacts()!,
        models: {
          resolve: (reference) => {
            references.push(reference);
            return scripted();
          },
        },
      });
      try {
        const meetings = host.connect({ application: "meetings", conversation: "weekly-sync" });
        const incidents = host.connect({ application: "incidents", conversation: "inc-42" });

        const heardInMeeting = await (
          await meetings.send("Alice asks for the summary.", { auth: null })
        ).result();
        const heardInIncident = await (
          await incidents.send("Bob reports the outage.", { auth: null })
        ).result();
        const again = await meetings.send("Alice asks again.", { auth: null });
        const heardAgain = await again.result();

        expect(heardInMeeting.reply).toBe("Heard: Alice asks for the summary.");
        expect(heardInIncident.reply).toBe("Heard: Bob reports the outage.");
        expect(heardAgain.reply).toBe("Heard: Alice asks again.");
        expect(heardInMeeting.sessionId).not.toBe(heardInIncident.sessionId);
        expect(again.sessionId).toBe(heardInMeeting.sessionId);
        expect(references.length).toBeGreaterThan(0);
      } finally {
        await host.dispose();
      }
    });
  });

  it("asks for approval, runs the approved call, refuses the denied one, and finishes the turn", async () => {
    const ran: string[] = [];
    const test = await createTestRuntime({
      agent: { definition: agentModelNeverUsed, name: "org-agent-approvals" },
      modules: [approvedTool("deploy_change", ran), approvedTool("publish_change", ran)],
    });
    await test.run(async () => {
      const host = createEveHost({
        agent: readBundledCompiledArtifacts()!,
        models: { resolve: () => scripted() },
      });
      try {
        const alice = host.connect({ application: "meetings", conversation: "release" });
        const asked = await (await alice.send("Deploy and publish.", { auth: null })).result();
        expect(asked.interactions).toHaveLength(2);
        const answers = asked.interactions.map((interaction) => ({
          interactionId: interaction.interactionId,
          optionId: interaction.call?.callId === "call-deploy" ? "approve" : "deny",
        }));
        const answered = await (await alice.deliver({ answers }, { auth: null })).result();
        expect(ran).toEqual(["deploy_change"]);
        expect(answered.reply).toBe("Done: deploy_change:json, publish_change:execution-denied.");
      } finally {
        await host.dispose();
      }
    });
  });

  it("delegates to a subagent, waits for it to finish, and reports its answer", async () => {
    const test = await createTestRuntime({
      agent: { definition: agentModelNeverUsed, name: "org-agent-subagents" },
    });
    await test.run(async () => {
      const references: EveModelReference[] = [];
      const host = createEveHost({
        agent: readBundledCompiledArtifacts()!,
        models: {
          resolve: (reference) => {
            references.push(reference);
            return scripted();
          },
        },
      });
      try {
        const bob = host.connect({ application: "incidents", conversation: "inc-43" });
        const result = await (await bob.send("Investigate the outage.", { auth: null })).result();
        expect(result.status).toBe("completed");
        expect(result.reply).toBe("Report: Root cause: a configuration change at 09:14.");
        await host.idle();
        expect(reports).toEqual(["Report: Root cause: a configuration change at 09:14."]);
        expect(references.length).toBeGreaterThanOrEqual(3);
      } finally {
        await host.dispose();
      }
    });
  });

  it("fails the turn, not the host, when the host's model fails", async () => {
    const test = await createTestRuntime({
      agent: { definition: agentModelNeverUsed, name: "org-agent-failure" },
    });
    await test.run(async () => {
      const failing = markMockModel(
        new MockLanguageModelV4({
          doStream: async () => {
            throw new Error("the provider is unavailable");
          },
          modelId: "host-failing",
          provider: "eve-test",
        }),
      );
      const host = createEveHost({
        agent: readBundledCompiledArtifacts()!,
        models: { resolve: () => failing },
      });
      try {
        const result = await (
          await host
            .connect({ application: "meetings", conversation: "down" })
            .send("Hello.", { auth: null })
        ).result();
        expect(result.status).not.toBe("completed");
        const after = await (
          await host
            .connect({ application: "incidents", conversation: "fine" })
            .send("Still here?", { auth: null })
        ).result();
        expect(after.status).not.toBe("completed");
      } finally {
        await host.dispose();
      }
    });
  });
});
