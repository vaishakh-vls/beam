// The `beam --run <ref>` command line that GNOME hotkeys use to reach the running instance.

const RUN = "--run";

/** The arguments that run `ref`. One `--run=<ref>` token, so nothing can be inserted between them. */
export function runArgs(ref: string): string[] {
  return [`${RUN}=${ref}`];
}

/**
 * The ref from `--run=<ref>` or `--run <ref>`. Chromium places the switches it
 * adds (such as --allow-file-access-from-files) before positional arguments, so
 * in a second instance's argv the ref may not directly follow `--run`.
 */
export function parseRunArg(argv: string[]): string | null {
  const inline = argv.find((arg) => arg.startsWith(`${RUN}=`));
  if (inline) return inline.slice(RUN.length + 1) || null;
  const index = argv.indexOf(RUN);
  if (index < 0) return null;
  return argv.slice(index + 1).find((arg) => !arg.startsWith("-")) ?? null;
}
