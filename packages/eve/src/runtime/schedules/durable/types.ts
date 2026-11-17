import type { ScheduleRecord } from "#public/schedules/subscription.js";

export interface WorkflowScheduleVersion {
  readonly collection: string;
  readonly createOperationId: string;
  readonly lastOperationId: string;
  readonly lastScheduledAt?: string;
  readonly namespace: string;
  readonly payload: unknown;
  readonly record: ScheduleRecord;
  readonly serializedContext: Record<string, unknown>;
  readonly token: string;
}

export type WorkflowScheduleMetadata = Omit<WorkflowScheduleVersion, "serializedContext">;

export type WorkflowScheduleMessage =
  | { readonly kind: "delete" }
  | { readonly kind: "replace"; readonly version: WorkflowScheduleVersion };
