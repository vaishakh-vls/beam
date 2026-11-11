// Bundles the Electron main and preload scripts into dist/main, and each file
// in src/main/lazy/ into dist/main/lazy/, loaded on first use (src/main/lazy.ts).
import fs from "node:fs";
import { build } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [
    "src/main/main.ts",
    "src/main/preload.ts",
    ...fs.readdirSync("src/main/lazy").map((file) => `src/main/lazy/${file}`),
  ],
  outbase: "src/main",
  outdir: "dist/main",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  sourcemap: watch,
  logLevel: "info",
};

if (watch) {
  const { context } = await import("esbuild");
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
