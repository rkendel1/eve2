import { isIP as nodeIsIP } from "node:net";
import { describe, expect, it } from "vitest";

import { BlockList, isIP } from "./net.ts";

const addresses = [
  "127.0.0.1",
  "0.0.0.0",
  "255.255.255.255",
  "10.1.2.3",
  "1.2.3",
  "1.2.3.4.5",
  "256.1.1.1",
  "01.2.3.4",
  "1.2.3.04",
  "",
  "::",
  "::1",
  "1::",
  "fe80::1",
  "2001:db8::8a2e:370:7334",
  "2001:0db8:0000:0000:0000:ff00:0042:8329",
  "::ffff:192.0.2.1",
  "64:ff9b::192.0.2.33",
  "1:2:3:4:5:6:7:8",
  "1:2:3:4:5:6:7:8:9",
  "1::2::3",
  ":::1",
  "1:2:3:4:5:6:7::",
  "::1:2:3:4:5:6:7",
  "gggg::1",
  "12345::1",
  "1:2:3:4:5:6:192.0.2.1",
  "1:2:3:4:5:6:7:192.0.2.1",
  "localhost",
  "example.com",
  "[::1]",
];

describe("neutral isIP", () => {
  it.each(addresses)("agrees with node:net for %j", (address) => {
    expect(isIP(address)).toBe(nodeIsIP(address));
  });
});

describe("neutral BlockList", () => {
  it("fails closed: a host without a network has no destination policy to apply", () => {
    expect(() => new BlockList()).toThrow(/Network destination checks run where the network is/);
  });
});
