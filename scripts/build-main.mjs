// Bundles the Electron main and preload scripts into dist/main.
import { build } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main/main.ts", "src/main/preload.ts"],
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
