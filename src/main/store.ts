import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config";

/** A JSON file in the config folder, loaded once and saved after changes. */
export class JsonStore<T> {
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  data: T;

  constructor(name: string, defaults: () => T) {
    this.file = path.join(CONFIG_DIR, name);
    this.data = defaults();
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch (error) {
        console.error(`beam: could not read ${this.file}, starting fresh:`, error);
      }
    } else {
      this.saveNow();
    }
  }

  /** Save shortly after the last change, so bursts of updates write once. */
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
