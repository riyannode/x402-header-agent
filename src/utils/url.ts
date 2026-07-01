import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PolicyViolation } from "../core/errors.js";

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function ipv4ToNumber(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value < 0 || value > 255) return undefined;
    out = (out << 8) + value;
  }
  return out >>> 0;
}

function inRange(value: number, base: string, prefix: number): boolean {
  const baseNum = ipv4ToNumber(base);
  if (baseNum === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseNum & mask);
}

function isBlockedIpv4(host: string): boolean {
  const value = ipv4ToNumber(host);
  if (value === undefined) return false;
  const ranges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return ranges.some(([base, prefix]) => inRange(value, base, prefix));
}

function parseIpv4MappedIpv6(host: string): string | undefined {
  const h = stripIpv6Brackets(host).toLowerCase();
  const marker = "::ffff:";
  if (!h.startsWith(marker)) return undefined;
  const tail = h.slice(marker.length);
  if (tail.includes(".")) return tail;
  const parts = tail.split(":");
  if (parts.length !== 2 || !parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const high = parseInt(parts[0]!, 16);
  const low = parseInt(parts[1]!, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isPrivateIpv6(host: string): boolean {
  const h = stripIpv6Brackets(host).toLowerCase();
  const mapped = parseIpv4MappedIpv6(h);
  if (mapped) return isBlockedIpv4(mapped);
  return h === "::1"
    || h === "::"
    || h.startsWith("fc")
    || h.startsWith("fd")
    || h.startsWith("fe80:")
    || h.startsWith("fec0:");
}

export function parsePaymentUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PolicyViolation(`Invalid URL: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new PolicyViolation("URL credentials are not allowed");
  }
  if (!parsed.hostname) {
    throw new PolicyViolation("URL host is required");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new PolicyViolation(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed;
}

export function isLocalhost(host: string): boolean {
  const h = stripIpv6Brackets(host.toLowerCase());
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export function isPrivateHost(host: string): boolean {
  const h = stripIpv6Brackets(host.toLowerCase());
  if (isLocalhost(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIP(h) === 6) return isPrivateIpv6(h);
  return isBlockedIpv4(h);
}

export async function resolvesToPrivateHost(host: string): Promise<boolean> {
  const h = stripIpv6Brackets(host.toLowerCase());
  if (isPrivateHost(h)) return true;
  if (isIP(h) !== 0) return false;
  const rows = await lookup(h, { all: true, verbatim: true });
  return rows.some((row) => isPrivateHost(row.address));
}

export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  if (allowlist.includes("*")) return true;
  const h = stripIpv6Brackets(host.toLowerCase());
  return allowlist.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule === h) return true;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1);
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return false;
  });
}
