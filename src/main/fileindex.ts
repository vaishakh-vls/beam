// The file-name index behind file search, kept small. As one object per file
// with its full path, 80,000 files took about 35 MB of the main process: Node's
// path.join leaves each path as a chain of string pieces. Here they take a few
// MB: each folder's path is stored once, all names sit in one UTF-8 buffer,
// and all lowercase names in another that a search scans with indexOf. As
// JavaScript strings, one name outside Latin-1 would double their size.
// No Electron here, so it can be tested.

export interface FileHit {
  name: string;
  path: string;
  isDir: boolean;
}

/** Collects folders and names while walking, then packs them into a FileIndex. */
export class FileIndexBuilder {
  private readonly dirs: string[] = [];
  private readonly names: string[] = [];
  private readonly dirOf: number[] = [];
  private readonly dirFlags: boolean[] = [];

  get size(): number {
    return this.names.length;
  }

  /** Registers a folder whose entries follow; returns its id for add(). */
  addFolder(folderPath: string): number {
    this.dirs.push(folderPath);
    return this.dirs.length - 1;
  }

  add(folder: number, name: string, isDir: boolean): void {
    this.names.push(name);
    this.dirOf.push(folder);
    this.dirFlags.push(isDir);
  }

  build(): FileIndex {
    return new FileIndex(this.dirs, this.names, Uint32Array.from(this.dirOf), Uint8Array.from(this.dirFlags, Number));
  }
}

export class FileIndex {
  private readonly dirs: string[];
  private readonly dirOf: Uint32Array;
  private readonly dirFlags: Uint8Array;
  private readonly text: Buffer;
  private readonly lower: Buffer;
  /** Byte offset of each name in `text` and in `lower`; one extra entry marks the end. */
  private readonly textStarts: Uint32Array;
  private readonly lowerStarts: Uint32Array;

  constructor(dirs: string[], names: string[], dirOf: Uint32Array, dirFlags: Uint8Array) {
    this.dirs = dirs;
    this.dirOf = dirOf;
    this.dirFlags = dirFlags;
    const lowered = names.map((name) => name.toLowerCase());
    this.textStarts = starts(names);
    // Lowercasing can change a name's length ("İ"), so it keeps its own offsets.
    this.lowerStarts = starts(lowered);
    this.text = Buffer.from(names.join("\n"));
    this.lower = Buffer.from(lowered.join("\n"));
  }

  static empty(): FileIndex {
    return new FileIndex([], [], new Uint32Array(0), new Uint8Array(0));
  }

  get size(): number {
    return this.dirOf.length;
  }

  name(i: number): string {
    return this.text.toString("utf8", this.textStarts[i], this.textStarts[i + 1] - 1);
  }

  hit(i: number): FileHit {
    const dir = this.dirs[this.dirOf[i]];
    const name = this.name(i);
    return { name, path: dir.endsWith("/") ? dir + name : `${dir}/${name}`, isDir: this.dirFlags[i] === 1 };
  }

  /** Ids of the names that contain `lowerQuery`, which must already be lowercase. */
  *containing(lowerQuery: string): Generator<number> {
    if (!lowerQuery || lowerQuery.includes("\n")) return;
    // UTF-8 never matches part of a character, so bytes match where text would.
    const needle = Buffer.from(lowerQuery);
    let from = 0;
    for (;;) {
      if (from >= this.lower.length) return;
      const at = this.lower.indexOf(needle, from);
      if (at === -1) return;
      const i = this.idAt(at);
      yield i;
      // One hit per name is enough: carry on from the next name.
      from = this.lowerStarts[i + 1];
    }
  }

  /** The name whose lowercase bytes cover offset `at`: the last start at or before it. */
  private idAt(at: number): number {
    let lo = 0;
    let hi = this.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lowerStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/** Byte offsets of each string in strings.join("\n") as UTF-8, plus the end, one past the last separator. */
function starts(strings: string[]): Uint32Array {
  const out = new Uint32Array(strings.length + 1);
  let at = 0;
  for (let i = 0; i < strings.length; i++) {
    out[i] = at;
    at += Buffer.byteLength(strings[i]) + 1;
  }
  out[strings.length] = at;
  return out;
}
