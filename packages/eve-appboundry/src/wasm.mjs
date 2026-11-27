export const PROGRAM_SECTION = "appboundry.program";
const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function readUleb(bytes, offset) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, offset];
    shift += 7;
  }
}

function assertModule(bytes) {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b))
    throw new Error("not a WebAssembly 1.0 module");
}

export function customSections(module) {
  assertModule(module);
  const found = [];
  let offset = 8;
  while (offset < module.length) {
    const id = module[offset++];
    const [size, start] = readUleb(module, offset);
    const end = start + size;
    if (end > module.length) throw new Error("truncated section");
    if (id === 0) {
      const [nameLength, nameStart] = readUleb(module, start);
      found.push({
        name: new TextDecoder().decode(module.subarray(nameStart, nameStart + nameLength)),
        payload: module.subarray(nameStart + nameLength, end),
      });
    }
    offset = end;
  }
  return found;
}

export function appendCustomSection(module, name, payload) {
  assertModule(module);
  if (customSections(module).some((section) => section.name === name))
    throw new Error(`the module already has a "${name}" section`);
  const encodedName = new TextEncoder().encode(name);
  const content = [...uleb(encodedName.length), ...encodedName];
  const header = new Uint8Array([0x00, ...uleb(content.length + payload.length), ...content]);
  const out = new Uint8Array(module.length + header.length + payload.length);
  out.set(module, 0);
  out.set(header, module.length);
  out.set(payload, module.length + header.length);
  return out;
}
