const ERRORS = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const dataCloneError = (what) => new DOMException(`${what} could not be cloned.`, "DataCloneError");

export function structuredClone(value) {
  const seen = new Map();
  const clone = (input) => {
    if (input === null || (typeof input !== "object" && typeof input !== "function")) {
      if (typeof input === "symbol") throw dataCloneError("Symbol()");
      return input;
    }
    if (typeof input === "function") throw dataCloneError(String(input).slice(0, 40));
    if (seen.has(input)) return seen.get(input);
    const tag = Object.prototype.toString.call(input).slice(8, -1);
    let out;
    switch (tag) {
      case "Boolean":
      case "Number":
      case "String":
      case "BigInt":
        out = Object(input.valueOf());
        seen.set(input, out);
        return out;
      case "Date":
        out = new Date(input.getTime());
        seen.set(input, out);
        return out;
      case "RegExp":
        out = new RegExp(input.source, input.flags);
        seen.set(input, out);
        return out;
      case "ArrayBuffer":
        out = input.slice(0);
        seen.set(input, out);
        return out;
      case "DataView": {
        out = new DataView(clone(input.buffer), input.byteOffset, input.byteLength);
        seen.set(input, out);
        return out;
      }
      case "Map": {
        out = new Map();
        seen.set(input, out);
        for (const [k, v] of input) out.set(clone(k), clone(v));
        return out;
      }
      case "Set": {
        out = new Set();
        seen.set(input, out);
        for (const v of input) out.add(clone(v));
        return out;
      }
      case "Array": {
        out = new Array(input.length);
        seen.set(input, out);
        for (const key of Object.keys(input)) out[key] = clone(input[key]);
        return out;
      }
      case "Error": {
        const Ctor = ERRORS[input.name] ?? Error;
        out = Object.create(Ctor.prototype);
        seen.set(input, out);
        out.message = String(input.message);
        if (input.stack !== undefined) out.stack = String(input.stack);
        if ("cause" in input) out.cause = clone(input.cause);
        Object.defineProperty(out, "name", {
          value: ERRORS[input.name] ? input.name : "Error",
          writable: true,
          configurable: true,
          enumerable: false,
        });
        return out;
      }
      case "Object": {
        out = {};
        seen.set(input, out);
        for (const key of Object.keys(input)) out[key] = clone(input[key]);
        return out;
      }
      default:
        if (ArrayBuffer.isView(input)) {
          out = new input.constructor(clone(input.buffer), input.byteOffset, input.length);
          seen.set(input, out);
          return out;
        }
        throw dataCloneError(tag);
    }
  };
  return clone(value);
}
