// Writes review packets (full timed lyrics for each song that needs a second look)
// to tools/.cache/review/batch-N.txt. Usage: node tools/make-review-packets.mjs [batches]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLrc } from "./lib/chorus.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, ".cache", "lrclib"), OUT = path.join(here, ".cache", "review");
const report = JSON.parse(fs.readFileSync(path.join(here, "hooks-report.json"), "utf8"));
const byId = new Map();
for (const f of fs.readdirSync(CACHE)) {
  const body = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")).body;
  for (const r of Array.isArray(body) ? body : body ? [body] : []) if (r && r.id && r.syncedLyrics) byId.set(r.id, r);
}
const ts = ms => Math.floor(ms / 60000) + ":" + String(Math.floor(ms / 1000) % 60).padStart(2, "0");
const picks = [];
for (const [key, v] of Object.entries(report)) {
  const reasons = (v.reviewReasons || []).filter(r => !r.startsWith("duration unknown"));
  if (v.status === "no-repeat") reasons.push("no hook found: no clear repeat");
  if (!reasons.length) continue;
  const rec = v.lrclib && byId.get(v.lrclib.id);
  if (!rec) continue;
  picks.push({ key, v, reasons, rec });
}
const n = Number(process.argv[2]) || 6;
fs.mkdirSync(OUT, { recursive: true });
for (let b = 0; b < n; b++) {
  let out = "";
  picks.filter((p, i) => i % n === b).forEach(({ key, v, reasons, rec }) => {
    out += `\n===== KEY: ${key}\nTitle: ${v.title} | Artist: ${v.artist} | Lyric record length: ${ts(rec.duration * 1000)}\n`;
    out += `Why flagged: ${reasons.join("; ")}\n`;
    out += v.hook ? `Chosen chorus start: lineMs=${v.hook.blockStartMs} (${ts(v.hook.blockStartMs)}) — ${v.reason}\n` : "Chosen chorus start: none\n";
    for (const l of parseLrc(rec.syncedLyrics)) out += `${l.ms === v.hook?.blockStartMs ? ">>" : "  "} ${l.ms}\t${ts(l.ms)}\t${l.text}\n`;
  });
  fs.writeFileSync(path.join(OUT, `batch-${b + 1}.txt`), out);
}
console.log(picks.length + " songs in " + n + " batches -> " + OUT);
