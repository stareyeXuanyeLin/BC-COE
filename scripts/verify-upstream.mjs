import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = resolve(root, "..", "COE-Echo");
const manifest = join(root, "docs", "upstream-coe-echo-v1.6.2.sha256");
const failed = [];
let total = 0;
for (const raw of readFileSync(manifest, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^([0-9a-f]{64})\s+(.+)$/i);
  if (!match) throw new Error(`Malformed manifest line: ${line}`);
  const [, expected, relative] = match;
  total++;
  const target = join(base, relative);
  const actual = existsSync(target) ? createHash("sha256").update(readFileSync(target)).digest("hex") : "MISSING";
  if (actual.toLowerCase() !== expected.toLowerCase()) failed.push({ relative, expected, actual });
}
console.log(`verified=${total - failed.length}/${total}`);
for (const item of failed) console.error("mismatch", item);
process.exitCode = failed.length ? 1 : 0;
