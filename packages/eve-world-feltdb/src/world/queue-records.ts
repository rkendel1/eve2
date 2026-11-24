import { COLLECTIONS, type FeltRecord, keyPart, type WorldDatabase } from "./database.js";

export interface StoredMessage {
  messageId: string;
  queueName: string;
  body: string;
  headers: Record<string, string>;
  idempotencyKey: string | null;
  createdAt: string;
  deliveryCount: number;
  visibleAt: number;
  runId: string | null;
}

export class QueueRecords {
  readonly #database: WorldDatabase;

  constructor(database: WorldDatabase) {
    this.#database = database;
  }

  async create(message: StoredMessage): Promise<{ messageId: string; created: boolean }> {
    return this.#database.transact(async (unit) => {
      if (message.idempotencyKey !== null) {
        const key = keyPart(`${message.queueName}\u0000${message.idempotencyKey}`);
        const existing = await unit.get(COLLECTIONS.messageKeys, key);
        if (
          existing &&
          (await unit.get(COLLECTIONS.messages, keyPart(String(existing.messageId))))
        ) {
          return { messageId: String(existing.messageId), created: false };
        }
        unit.set(COLLECTIONS.messageKeys, key, {
          queueName: message.queueName,
          idempotencyKey: message.idempotencyKey,
          messageId: message.messageId,
        });
      }
      unit.set(COLLECTIONS.messages, keyPart(message.messageId), {
        ...message,
        state: "ready",
        data: message.body,
        body: undefined,
      });
      return { messageId: message.messageId, created: true };
    });
  }

  async attempt(messageId: string, deliveryCount: number): Promise<void> {
    await this.#database.transact(async (unit) => {
      const record = await unit.get(COLLECTIONS.messages, keyPart(messageId));
      if (!record) return;
      unit.set(COLLECTIONS.messages, keyPart(messageId), {
        ...record,
        deliveryCount: Math.max(Number(record.deliveryCount ?? 0), deliveryCount),
      });
    });
  }

  async schedule(messageId: string, visibleAt: number): Promise<void> {
    await this.#database.transact(async (unit) => {
      const record = await unit.get(COLLECTIONS.messages, keyPart(messageId));
      if (!record) return;
      unit.set(COLLECTIONS.messages, keyPart(messageId), { ...record, visibleAt });
    });
  }

  async remove(messageId: string): Promise<void> {
    await this.#database.transact(async (unit) => {
      const record = await unit.get(COLLECTIONS.messages, keyPart(messageId));
      if (!record) return;
      unit.delete(COLLECTIONS.messages, keyPart(messageId));
      if (typeof record.idempotencyKey === "string") {
        const key = keyPart(`${String(record.queueName)}\u0000${record.idempotencyKey}`);
        const owner = await unit.get(COLLECTIONS.messageKeys, key);
        if (owner && owner.messageId === messageId) unit.delete(COLLECTIONS.messageKeys, key);
      }
    });
  }

  async get(messageId: string): Promise<StoredMessage | null> {
    const record = await this.#database.read(COLLECTIONS.messages, keyPart(messageId));
    return record ? this.#message(record) : null;
  }

  async *all(): AsyncIterable<StoredMessage> {
    for await (const record of this.#database.scan(
      COLLECTIONS.messages,
      [{ field: "state", eq: "ready" }],
      [{ field: "visibleAt", direction: "asc" }],
    )) {
      yield await this.#message(record);
    }
  }

  async #message(record: FeltRecord): Promise<StoredMessage> {
    return {
      messageId: String(record.messageId),
      queueName: String(record.queueName),
      body: (await this.#database.internalize(record, "data")) ?? "",
      headers: (record.headers as Record<string, string> | undefined) ?? {},
      idempotencyKey: typeof record.idempotencyKey === "string" ? record.idempotencyKey : null,
      createdAt: String(record.createdAt),
      deliveryCount: Number(record.deliveryCount ?? 0),
      visibleAt: Number(record.visibleAt ?? 0),
      runId: typeof record.runId === "string" ? record.runId : null,
    };
  }
}
