// web-tree-sitter only touches node:module / fs/promises when it believes it runs
// in Node. Workers without nodejs_compat never take that branch; this stub only
// keeps the bundler (and workerd's module registry) from needing the real modules.
const unavailable = (): never => {
  throw new Error("node builtins are not available in this child");
};
export const createRequire = unavailable;
export const readFile = unavailable;
export default {};
