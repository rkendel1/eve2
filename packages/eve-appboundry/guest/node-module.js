export function createRequire() {
  return (id) => {
    throw new Error(
      `require(${JSON.stringify(String(id))}) is not available in the AppBoundry guest`,
    );
  };
}
export const builtinModules = [];
export const isBuiltin = () => false;
export default { createRequire, builtinModules, isBuiltin };
