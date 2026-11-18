import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverHostKeyFingerprints } from "../src/index.js";

const ed25519 = ssh2.utils.generateKeyPairSync("ed25519");
const rsa = ssh2.utils.generateKeyPairSync("rsa", { bits: 2048 });
const fp = (pub: string) => {
  const k = ssh2.utils.parseKey(pub);
  const key = Array.isArray(k) ? k[0] : k;
  if (!key || key instanceof Error) throw new Error("bad key");
  return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
};

let server: InstanceType<typeof ssh2.Server>;
let port: number;

beforeAll(async () => {
  server = new ssh2.Server({ hostKeys: [ed25519.private, rsa.private] }, (client) => {
    client.on("authentication", (ctx) => ctx.reject());
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server?.close());

describe("SFTP server fingerprints", () => {
  it("reports every host key the server offers, labelled by type", async () => {
    const keys = await serverHostKeyFingerprints("127.0.0.1", port, 5_000);
    expect(keys).toEqual([
      { type: "ED25519", fingerprint: fp(ed25519.public) },
      { type: "RSA", fingerprint: fp(rsa.public) },
    ]);
  });

  it("returns nothing when the server is unreachable", async () => {
    expect(await serverHostKeyFingerprints("127.0.0.1", 1, 2_000)).toEqual([]);
  });
});
