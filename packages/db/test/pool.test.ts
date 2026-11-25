import { EventEmitter } from "node:events";
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

  it("survives a connection dropped while checked out (does not crash the process)", async () => {
    const pool = createPool({
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/none",
      DATABASE_POOL_MAX: 1,
      DATABASE_SSL: "disable",
    });
    // A new connection, as the pool announces it. While a query or transaction holds it, the pool's
    // own idle listener is removed, so ours must be the one still listening.
    const client = new EventEmitter();
    pool.emit("connect", client as never);
    expect(client.listenerCount("error")).toBe(1);
    expect(() =>
      client.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    ).not.toThrow();
    await pool.end();
  });
});
