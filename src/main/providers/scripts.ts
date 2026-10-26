import fs from "node:fs";
import path from "node:path";
import { SCRIPTS_DIR } from "../config";
import { HIDE, type Entry } from "../entry";
import { showForm } from "../forms";
import { launchDetached, notify, openPath, revealInFolder, runCapture, truncate } from "../system";
import type { FormField, RunResult } from "../../shared/types";

type Mode = "fullOutput" | "compact" | "silent" | "inline";

interface ScriptArgument {
  placeholder: string;
  optional: boolean;
  secure: boolean;
}

interface ScriptCommand {
  file: string;
  title: string;
  description: string;
  packageName: string;
  icon: string;
  mode: Mode;
  args: ScriptArgument[];
}

/** Reads `# @raycast.key value` (or `@beam.key`) metadata from a script header. */
function parseScript(file: string): ScriptCommand | null {
  let head: string;
  try {
    head = fs.readFileSync(file, "utf8").slice(0, 8192);
  } catch {
    return null;
  }
  const meta: Record<string, string> = {};
  for (const match of head.matchAll(/@(?:raycast|beam)\.(\w+)[ \t]+(.+)/g)) {
    meta[match[1]] = match[2].trim();
  }
  if (!meta.title) return null;
  const args: ScriptArgument[] = [];
  for (let i = 1; i <= 3; i++) {
    const raw = meta[`argument${i}`];
    if (!raw) break;
    try {
      const parsed = JSON.parse(raw);
      args.push({
        placeholder: String(parsed.placeholder ?? `Argument ${i}`),
        optional: Boolean(parsed.optional),
        secure: Boolean(parsed.secure) || parsed.type === "password",
      });
    } catch {
      args.push({ placeholder: `Argument ${i}`, optional: false, secure: false });
    }
  }
  const icon = meta.icon && [...meta.icon].length <= 4 ? meta.icon : "⚡";
  return {
    file,
    title: meta.title,
    description: meta.description ?? "",
    packageName: meta.packageName ?? "Script Command",
    icon,
    mode: (["fullOutput", "compact", "silent", "inline"].includes(meta.mode) ? meta.mode : "compact") as Mode,
    args,
  };
}

export function loadScripts(): ScriptCommand[] {
  let names: string[];
  try {
    names = fs.readdirSync(SCRIPTS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith(".") && !n.endsWith("~"))
    .map((n) => parseScript(path.join(SCRIPTS_DIR, n)))
    .filter((s): s is ScriptCommand => s !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function execute(script: ScriptCommand, args: string[]): Promise<RunResult> {
  const executable = isExecutable(script.file);
  const command = executable ? script.file : interpreterFor(script.file);
  const commandArgs = executable ? args : [script.file, ...args];
  if (script.mode === "silent" || script.mode === "compact" || script.mode === "inline") {
    void runCapture(command, commandArgs, { cwd: SCRIPTS_DIR }).then(({ code, stdout, stderr }) => {
      const lastLine = (code === 0 ? stdout : stderr || stdout).trim().split("\n").pop() ?? "";
      if (script.mode !== "silent" || code !== 0) {
        notify(code === 0 ? script.title : `${script.title} failed`, truncate(lastLine, 200));
      }
    });
    return HIDE;
  }
  const { code, stdout, stderr } = await runCapture(command, commandArgs, { cwd: SCRIPTS_DIR });
  const text = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
  return { type: "output", title: code === 0 ? script.title : `${script.title} (exit code ${code})`, text };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function interpreterFor(file: string): string {
  const firstLine = fs.readFileSync(file, "utf8").split("\n")[0];
  if (firstLine.startsWith("#!")) return firstLine.slice(2).trim().split(/\s+/).pop() ?? "sh";
  if (file.endsWith(".py")) return "python3";
  if (file.endsWith(".js")) return "node";
  return "bash";
}

function start(script: ScriptCommand): RunResult | Promise<RunResult> {
  if (!script.args.length) return execute(script, []);
  const fields: FormField[] = script.args.map((arg, i) => ({
    name: `arg${i}`,
    label: arg.placeholder,
    type: arg.secure ? "password" : "text",
    optional: arg.optional,
    placeholder: arg.placeholder,
  }));
  return showForm({ title: script.title, submitLabel: "Run Script", fields }, (values) => {
    const missing = script.args.find((arg, i) => !arg.optional && !values[`arg${i}`]?.trim());
    if (missing) return { type: "error", message: `"${missing.placeholder}" is required.` };
    return execute(script, script.args.map((_, i) => values[`arg${i}`] ?? ""));
  });
}

export function scriptEntries(): Entry[] {
  return loadScripts().map((script) => {
    const name = path.basename(script.file);
    return {
      id: `script:${name}`,
      ref: `script:${name}`,
      title: script.title,
      subtitle: script.description || script.packageName,
      icon: script.icon,
      accessory: "Script",
      keywords: [script.packageName, name],
      actions: [
        { id: "run", title: "Run Script", shortcut: "↵", run: () => start(script) },
        {
          id: "edit",
          title: "Edit Script",
          shortcut: "Ctrl+E",
          run: () => {
            editFile(script.file);
            return HIDE;
          },
        },
        {
          id: "reveal",
          title: "Show in Folder",
          shortcut: "Ctrl+↵",
          run: () => {
            revealInFolder(script.file);
            return HIDE;
          },
        },
      ],
    };
  });
}

export function runScriptByName(name: string): RunResult | Promise<RunResult> | null {
  const script = loadScripts().find((s) => path.basename(s.file) === name);
  return script ? start(script) : null;
}

function editFile(file: string): void {
  // Prefer a code editor when one is installed; fall back to the default app.
  for (const editor of ["zed", "code"]) {
    const candidate = process.env.PATH?.split(":").map((dir) => path.join(dir, editor)).find((p) => fs.existsSync(p));
    if (candidate) {
      launchDetached(candidate, [file]);
      return;
    }
  }
  openPath(file);
}

const TEMPLATES: Record<string, { ext: string; shebang: string; body: string }> = {
  bash: { ext: "sh", shebang: "#!/bin/bash", body: 'echo "Hello from Beam"' },
  python: { ext: "py", shebang: "#!/usr/bin/env python3", body: 'print("Hello from Beam")' },
  node: { ext: "js", shebang: "#!/usr/bin/env node", body: 'console.log("Hello from Beam");' },
};

export function openCreateScriptForm(): RunResult {
  return showForm(
    {
      title: "Create Script Command",
      submitLabel: "Create Script",
      fields: [
        { name: "title", label: "Title", type: "text", placeholder: "Open Today's Standup Notes" },
        { name: "description", label: "Description", type: "text", optional: true },
        { name: "icon", label: "Icon", type: "text", placeholder: "⚡", optional: true },
        {
          name: "mode",
          label: "Mode",
          type: "text",
          value: "fullOutput",
          hint: "fullOutput (show output in Beam), compact (notification), or silent",
        },
        { name: "language", label: "Language", type: "text", value: "bash", hint: "bash, python or node" },
      ],
    },
    (values) => {
      const title = values.title.trim();
      const template = TEMPLATES[values.language.trim().toLowerCase()];
      if (!title) return { type: "error", message: "Title is required." };
      if (!template) return { type: "error", message: "Language must be bash, python or node." };
      const mode = ["fullOutput", "compact", "silent"].includes(values.mode.trim()) ? values.mode.trim() : "fullOutput";
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "script";
      const file = path.join(SCRIPTS_DIR, `${slug}.${template.ext}`);
      if (fs.existsSync(file)) return { type: "error", message: `${path.basename(file)} already exists.` };
      const comment = template.ext === "js" ? "//" : "#";
      const lines = [
        template.shebang,
        "",
        `${comment} @raycast.schemaVersion 1`,
        `${comment} @raycast.title ${title}`,
        `${comment} @raycast.mode ${mode}`,
        `${comment} @raycast.icon ${values.icon.trim() || "⚡"}`,
        values.description.trim() ? `${comment} @raycast.description ${values.description.trim()}` : null,
        `${comment} @raycast.argument1 { "type": "text", "placeholder": "Optional input", "optional": true }`,
        "",
        template.body,
        "",
      ].filter((line): line is string => line !== null);
      fs.writeFileSync(file, lines.join("\n"), { mode: 0o755 });
      editFile(file);
      return HIDE;
    },
  );
}
