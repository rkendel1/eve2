function sha256(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const l = bytes.length;
  const n = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n);
  m.set(bytes);
  m[l] = 0x80;
  const bits = l * 8;
  for (let i = 0; i < 8; i++) m[n - 1 - i] = Math.floor(bits / 2 ** (8 * i)) & 0xff;
  const w = new Uint32Array(64);
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++)
      w[i] =
        (m[o + 4 * i] << 24) |
        (m[o + 4 * i + 1] << 16) |
        (m[o + 4 * i + 2] << 8) |
        m[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H = [H[0] + a, H[1] + b, H[2] + c, H[3] + d, H[4] + e, H[5] + f, H[6] + g, H[7] + h].map(
      (x) => x | 0,
    );
  }
  const out = new Uint8Array(32);
  H.forEach((x, i) => {
    out[4 * i] = x >>> 24;
    out[4 * i + 1] = (x >>> 16) & 0xff;
    out[4 * i + 2] = (x >>> 8) & 0xff;
    out[4 * i + 3] = x & 0xff;
  });
  return out;
}
const toBytes = (d) =>
  typeof d === "string"
    ? new TextEncoder().encode(d)
    : d instanceof Uint8Array
      ? d
      : new Uint8Array(d);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
function createHash(alg) {
  if (!/^sha-?256$/i.test(alg)) throw new Error(`hash ${alg} not available in the guest`);
  const parts = [];
  return {
    update(d) {
      parts.push(toBytes(d));
      return this;
    },
    digest(enc) {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      const r = sha256(all);
      return enc === "hex"
        ? hex(r)
        : enc === "base64"
          ? b64(r)
          : enc === "base64url"
            ? b64(r).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
            : r;
    },
  };
}
const randomBytes = (n) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
};
const randomUUID = () => {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const stub = require("./stub.cjs")("node:crypto");
module.exports = new Proxy(
  {
    createHash,
    randomBytes,
    randomUUID,
    webcrypto: {
      getRandomValues: (a) => {
        a.set(randomBytes(a.length));
        return a;
      },
    },
    getRandomValues: (a) => {
      a.set(randomBytes(a.length));
      return a;
    },
  },
  { get: (t, p) => (p in t ? t[p] : stub[p]) },
);
