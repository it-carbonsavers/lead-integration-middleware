import { describe, expect, it } from "vitest";
import { createPool } from "../src/client.js";

describe("database pool", () => {
  it("survives an idle connection being dropped (does not crash the process)", async () => {
    const pool = createPool({
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/none",
      DATABASE_POOL_MAX: 1,
      DATABASE_SSL: "disable",
    });
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    // Without a listener, Node throws on an unhandled 'error' event and the process exits.
    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(pool.options.keepAlive).toBe(true);
    await pool.end();
  });
});
