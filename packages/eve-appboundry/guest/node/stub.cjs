module.exports = function stub(name) {
  const fail = (p) => {
    const f = function () {
      throw new Error(`${name}.${String(p)} is not available in the AppBoundry guest`);
    };
    return new Proxy(f, {
      get: (_t, q) => (q === "prototype" ? {} : fail(`${String(p)}.${String(q)}`)),
      construct: () => {
        throw new Error(`new ${name}.${String(p)} is not available in the AppBoundry guest`);
      },
    });
  };
  return new Proxy(
    {},
    { get: (_t, p) => (p === "__esModule" ? false : p === "default" ? stub(name) : fail(p)) },
  );
};
