const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const HEXTET = /^[0-9a-f]{1,4}$/iu;

function isIPv6(address: string): boolean {
  if (address.length === 0 || address.includes(":::")) return false;
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const all = [...head, ...tail];
  let width = 0;
  for (const [index, group] of all.entries()) {
    if (index === all.length - 1 && group.includes(".")) {
      if (!IPV4.test(group)) return false;
      width += 2;
    } else if (HEXTET.test(group)) {
      width += 1;
    } else {
      return false;
    }
  }
  return halves.length === 2 ? width < 8 : width === 8;
}

export function isIP(address: string): 0 | 4 | 6 {
  if (IPV4.test(address)) return 4;
  return isIPv6(address) ? 6 : 0;
}

export class BlockList {
  constructor() {
    throw new Error(
      "Network destination checks run where the network is: this host gives eve no network, so it has no destination policy to apply.",
    );
  }

  addAddress(_address: string, _family?: "ipv4" | "ipv6"): void {}

  addSubnet(_network: string, _prefix: number, _family?: "ipv4" | "ipv6"): void {}

  check(_address: string, _family?: "ipv4" | "ipv6"): boolean {
    return true;
  }
}
