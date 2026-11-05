// Packs chrome-extension/ into a signed CRX in release/browser-tabs/, with the
// external-extension file that tells Chrome on Linux to install it. The .deb
// copies that file to /usr/share/google-chrome/extensions, so Browser Tabs
// works after one Chrome restart, without Developer mode.
//
// Needs the private key matching manifest.json's "key" (it fixes the
// extension ID): $BEAM_EXTENSION_KEY or ~/.config/beam-signing/chrome-extension.pem.
// It is never committed. Without it this only warns, and users load the
// extension folder by hand instead.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "chrome-extension");
const out = path.join(root, "release", "browser-tabs");
/** Where electron-builder's extraResources puts `out` in the installed app. */
const INSTALLED = "/opt/Beam/resources/browser-tabs";
const keyFile = process.env.BEAM_EXTENSION_KEY || path.join(os.homedir(), ".config", "beam-signing", "chrome-extension.pem");
const chrome = process.env.BEAM_CHROME || "google-chrome";

const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
// Always leave the folder, so the extraResources entry has something to copy.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (!fs.existsSync(keyFile)) {
  console.warn(`pack-chrome-extension: no key at ${keyFile}; skipping. Users will load the extension by hand.`);
  process.exit(0);
}
const publicKey = crypto.createPublicKey(fs.readFileSync(keyFile)).export({ type: "spki", format: "der" });
if (publicKey.toString("base64") !== manifest.key) {
  // A different key would give a different extension ID, which the native host manifest would not allow.
  console.error(`pack-chrome-extension: ${keyFile} does not match the "key" in chrome-extension/manifest.json`);
  process.exit(1);
}
const id = [...crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32)]
  .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
  .join("");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "beam-crx-"));
try {
  const dir = path.join(work, "beam-browser-tabs");
  fs.cpSync(source, dir, { recursive: true });
  // A throwaway profile, so packing never touches (or waits on) the Chrome you are running.
  execFileSync(
    chrome,
    [`--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", `--pack-extension=${dir}`, `--pack-extension-key=${keyFile}`],
    { stdio: "ignore", timeout: 60_000 },
  );
  const crx = fs.readFileSync(`${dir}.crx`);
  if (crx.subarray(0, 4).toString("latin1") !== "Cr24" || crx.readUInt32LE(4) !== 3) {
    throw new Error("Chrome did not write a CRX3 file");
  }
  fs.writeFileSync(path.join(out, "beam-browser-tabs.crx"), crx);
  // Chrome installs, updates (when external_version grows) and, once this file is gone, removes the extension.
  fs.writeFileSync(
    path.join(out, `${id}.json`),
    JSON.stringify({ external_crx: `${INSTALLED}/beam-browser-tabs.crx`, external_version: manifest.version }, null, 2) + "\n",
  );
  console.log(`pack-chrome-extension: ${id} version ${manifest.version} -> ${path.relative(root, out)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
