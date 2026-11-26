import { BlockList, isIP } from "#platform/net.js";

import { z } from "#compiled/zod/index.js";

export const httpServerUrlSchema = z.url({ protocol: /^https?$/ });

let reserved: BlockList | undefined;
let loopback: BlockList | undefined;

function reservedRanges(): BlockList {
  if (reserved !== undefined) return reserved;
  const ranges = new BlockList();
  ranges.addSubnet("0.0.0.0", 8, "ipv4");
  ranges.addSubnet("10.0.0.0", 8, "ipv4");
  ranges.addSubnet("100.64.0.0", 10, "ipv4");
  ranges.addSubnet("169.254.0.0", 16, "ipv4");
  ranges.addSubnet("172.16.0.0", 12, "ipv4");
  ranges.addSubnet("192.0.0.0", 24, "ipv4");
  ranges.addSubnet("192.0.2.0", 24, "ipv4");
  ranges.addSubnet("192.88.99.0", 24, "ipv4");
  ranges.addSubnet("192.168.0.0", 16, "ipv4");
  ranges.addSubnet("198.18.0.0", 15, "ipv4");
  ranges.addSubnet("198.51.100.0", 24, "ipv4");
  ranges.addSubnet("203.0.113.0", 24, "ipv4");
  ranges.addSubnet("224.0.0.0", 4, "ipv4");
  ranges.addSubnet("240.0.0.0", 4, "ipv4");
  ranges.addAddress("::", "ipv6");
  ranges.addSubnet("::", 96, "ipv6");
  ranges.addSubnet("64:ff9b::", 96, "ipv6");
  ranges.addSubnet("64:ff9b:1::", 48, "ipv6");
  ranges.addSubnet("100::", 64, "ipv6");
  ranges.addSubnet("2001::", 23, "ipv6");
  ranges.addSubnet("2001:db8::", 32, "ipv6");
  ranges.addSubnet("2002::", 16, "ipv6");
  ranges.addSubnet("fc00::", 7, "ipv6");
  ranges.addSubnet("fe80::", 10, "ipv6");
  ranges.addSubnet("ff00::", 8, "ipv6");
  reserved = ranges;
  return ranges;
}

function loopbackRanges(): BlockList {
  if (loopback !== undefined) return loopback;
  const ranges = new BlockList();
  ranges.addSubnet("127.0.0.0", 8, "ipv4");
  ranges.addAddress("::1", "ipv6");
  loopback = ranges;
  return ranges;
}

function normalizeAddress(host: string): string {
  const withoutBrackets = host.trim().replace(/^\[(.*)\]$/u, "$1");
  const zoneIndex = withoutBrackets.indexOf("%");
  const withoutZone = zoneIndex === -1 ? withoutBrackets : withoutBrackets.slice(0, zoneIndex);

  if (withoutZone.toLowerCase().startsWith("::ffff:")) {
    const candidate = withoutZone.slice("::ffff:".length);
    if (isIP(candidate) === 4) {
      return candidate;
    }
  }

  return withoutZone;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeAddress(hostname).toLowerCase().replace(/\.$/u, "");

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const family = isIP(normalized);
  return family !== 0 && loopbackRanges().check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export function isLoopbackServerUrl(urlText: string): boolean {
  const parsed = httpServerUrlSchema.safeParse(urlText);
  return parsed.success && isLoopbackHostname(new URL(parsed.data).hostname);
}

export function isReservedIpAddress(host: string): boolean {
  const normalized = normalizeAddress(host);

  if (isLoopbackHostname(normalized)) {
    return false;
  }

  const family = isIP(normalized);
  if (family === 0) {
    return false;
  }
  return reservedRanges().check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export function isPrivateOrReservedIpAddress(host: string): boolean {
  return isLoopbackHostname(host) || isReservedIpAddress(host);
}

export function isBlockedDestinationHost(
  host: string,
  options: { readonly allowLoopback: boolean },
): boolean {
  return options.allowLoopback ? isReservedIpAddress(host) : isPrivateOrReservedIpAddress(host);
}
