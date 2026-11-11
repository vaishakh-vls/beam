// Optional bundles that load the first time they are needed. A Beam that
// never does a sum or opens the emoji picker never reads mathjs or the emoji
// list, and doesn't keep them in memory. scripts/build-main.mjs builds each
// file in src/main/lazy/ next to main.js; import only its types elsewhere.
import path from "node:path";

export function lazyBundle<T>(name: string): () => T {
  let loaded: T | null = null;
  return () => (loaded ??= require(path.join(__dirname, "lazy", `${name}.js`)) as T);
}
