import { BlockList, isIP } from "node:net";

/**
 * Checks a client IP against a platform's CIDR allow-list.
 * An empty list means "no IP restriction" for that platform.
 */
export function isIpAllowed(ip: string, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return true;
  const family = isIP(ip);
  if (family === 0) return false;

  const list = new BlockList();
  for (const cidr of cidrs) {
    const [addr, bitsRaw] = cidr.split("/");
    if (!addr) continue;
    const type = isIP(addr) === 6 ? "ipv6" : "ipv4";
    const bits = bitsRaw === undefined ? (type === "ipv6" ? 128 : 32) : Number(bitsRaw);
    list.addSubnet(addr, bits, type);
  }

  // Normalise IPv4-mapped IPv6 (::ffff:1.2.3.4) so IPv4 rules still match.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return list.check(mapped[1]!, "ipv4");
  return list.check(ip, family === 6 ? "ipv6" : "ipv4");
}
