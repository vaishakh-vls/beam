import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config";

/** Stores with a save still waiting, written at once when Beam quits. */
const pending = new Set<{ saveNow(): void }>();

/** Writes every store's waiting changes now, as Beam quits (it may be logging out). */
export function flushStores(): void {
  for (const store of [...pending]) store.saveNow();
}

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
        // Kept aside rather than overwritten, so pinned entries and the like can be recovered.
        const aside = `${this.file}.unreadable-${Date.now()}`;
        console.error(`beam: could not read ${this.file}, starting fresh; the old file is ${aside}:`, error);
        try {
          fs.renameSync(this.file, aside);
        } catch {
          // Gone already.
        }
      }
    } else {
      this.saveNow();
    }
  }

  /** Save shortly after the last change, so bursts of updates write once. */
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
    pending.add(this);
  }

  saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    pending.delete(this);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    // Written in full and synced before it replaces the old file, so a power cut leaves one or the other.
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
