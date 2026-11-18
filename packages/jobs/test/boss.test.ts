import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEAD_LETTER_QUEUE, QUEUES } from "@lim/core";
import { createBoss, ensureQueues } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../../../test/helpers.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.destroy();
});

describe("pg-boss wiring", () => {
  it("creates queues with retry and dead-letter policies, idempotently", async () => {
    const boss = createBoss(t.config, { poolMax: 2 });
    await boss.start();
    try {
      await ensureQueues(boss);
      await ensureQueues(boss); // second run updates, does not fail

      const q = await boss.getQueue(QUEUES.deliverLead.name);
      expect(q).toMatchObject({
        retryLimit: 8,
        retryDelay: 60,
        retryBackoff: true,
        deadLetter: DEAD_LETTER_QUEUE,
      });
      expect(await boss.getQueue(DEAD_LETTER_QUEUE)).not.toBeNull();
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  });

  it("persists jobs so they survive a restart", async () => {
    const first = createBoss(t.config, { poolMax: 2 });
    await first.start();
    await ensureQueues(first);
    const id = await first.send(QUEUES.heartbeat.name, { probe: true });
    await first.stop({ graceful: false, close: true });

    const second = createBoss(t.config, { poolMax: 2 });
    await second.start();
    try {
      const jobs = await second.fetch<{ probe: boolean }>(QUEUES.heartbeat.name);
      expect(jobs.map((j) => j.id)).toContain(id);
    } finally {
      await second.stop({ graceful: false, close: true });
    }
  });
});
