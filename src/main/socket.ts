import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_REF_LENGTH = 1024;

/** Where `beam-run` reaches the running instance. XDG_RUNTIME_DIR is private to the user. */
export function socketPath(): string | null {
  const dir = process.env.XDG_RUNTIME_DIR;
  return dir ? path.join(dir, "beam.sock") : null;
}

/** Runs the command ref sent on each connection. Call only while holding the single-instance lock. */
export function listenForRefs(run: (ref: string) => void): void {
  const file = socketPath();
  if (!file) return;
  // Holding the lock means any socket left here belongs to a Beam that crashed.
  fs.rmSync(file, { force: true });
  const server = net.createServer((conn) => {
    let data = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_REF_LENGTH) conn.destroy();
    });
    conn.on("end", () => {
      conn.end();
      const ref = data.trim();
      if (ref) run(ref);
    });
    conn.on("error", () => undefined);
  });
  server.on("error", (error) => console.error("beam: command socket failed:", error));
  server.listen(file, () => fs.chmodSync(file, 0o600));
}

export function closeSocket(): void {
  const file = socketPath();
  if (file) fs.rmSync(file, { force: true });
}
