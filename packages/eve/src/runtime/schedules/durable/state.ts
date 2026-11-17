import { createHash } from "node:crypto";

import { Cron } from "#compiled/croner/index.js";
import type { ScheduleExpression } from "#public/schedules/subscription.js";

export const WORKFLOW_SCHEDULE_PROVIDER_KIND = "workflow";
export const WORKFLOW_SCHEDULE_TOKEN_PREFIX = "eve:schedule:";

export function workflowScheduleToken(input: {
  readonly collection: string;
  readonly name: string;
  readonly namespace: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.namespace, input.collection, input.name]))
    .digest("hex");
  return `${WORKFLOW_SCHEDULE_TOKEN_PREFIX}${digest}`;
}

export function nextScheduleOccurrence(expression: ScheduleExpression, after: Date): Date | null {
  const pattern =
    expression.type === "cron"
      ? expression.cron
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(expression.at)
        ? `${expression.at}:00`
        : expression.at;
  const options =
    expression.timezone === undefined
      ? { paused: true, timezone: "UTC" }
      : { paused: true, timezone: expression.timezone };
  return new Cron(pattern, options).nextRun(after);
}
