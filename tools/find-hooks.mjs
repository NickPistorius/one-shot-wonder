// Find the first chorus of each song from LRCLIB synced lyrics.
// Usage: node tools/find-hooks.mjs [--only "substring"] [--limit N] [--no-fetch]
// With --only/--limit it prints results and does not overwrite hooks.json / hooks-report.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseLrc, findChorus } from "./lib/chorus.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(here, "..", "year-by-year.html");
const CACHE = path.join(here, ".cache", "lrclib");
const INPUT = process.env.HOOKS_INPUT_DIR || path.join(here, "input");
const OUT_DIR = process.env.HOOKS_OUT_DIR || here;
const UA = "one-shot-wonder-hooks/0.1 (personal hobby project)";
const API = "https://lrclib.net/api";
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ONLY = opt("--only"), LIMIT = +opt("--limit") || Infinity, NOFETCH = args.includes("--no-fetch");

// ---- helpers copied from year-by-year.html (keyOf & friends) ----
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const cleanTitle = t => (t.replace(/\([^)]*\)/g, " ").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim()) || t;
const fullArtist = a => a.split(/\s+(?:feat\.?|featuring)\s+/i)[0];
const firstArtist = a => a.split(/,|&|\s+(?:and|feat\.?|featuring|with)\s+/i)[0].trim();
const keyOf = s => norm(s[1]) + "|" + norm(s[2]);

// ---- song list ----
function loadSongs() {
  const html = fs.readFileSync(HTML, "utf8");
  const m = html.match(/const BUILTIN=(\[\[[\s\S]*?\]\]);/);
  if (!m) throw new Error("BUILTIN not found");
  const songs = new Map();
  const add = (s, source, dur) => {
    const k = keyOf(s);
    let e = songs.get(k);
    if (!e) { e = { key: k, year: s[0], title: s[1], artist: s[2], sources: [], spotifyMs: null, altDurations: [] }; songs.set(k, e); }
    if (!e.sources.includes(source)) e.sources.push(source);
    if (dur && !e.spotifyMs) e.spotifyMs = dur;
    else if (dur && dur !== e.spotifyMs && !e.altDurations.includes(dur)) e.altDurations.push(dur);
  };
  for (const s of JSON.parse(m[1])) add(s, "builtin");
  if (fs.existsSync(INPUT)) {
    for (const f of fs.readdirSync(INPUT).filter(f => f.endsWith(".playlist.json")).sort()) {
      const pl = JSON.parse(fs.readFileSync(path.join(INPUT, f), "utf8"));
      for (const s of pl.songs || []) add(s, "playlist:" + (pl.name || f), s[5] || null);
    }
  }
  return [...songs.values()];
}

// ---- iTunes duration hints from preview-report.json (structure unknown: search generically) ----
function loadHints() {
  const hints = new Map();
  // Off unless asked for: the store preview is often a different cut from the one Spotify plays,
  // and the reviewed corrections were made against the recordings chosen without it.
  if (!process.argv.includes("--itunes-hints")) return new Map();
  const p = path.join(here, "preview-report.json");
  if (!fs.existsSync(p)) return hints;
  let data; try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return hints; }
  const durOf = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 3) return null;
    for (const k of ["trackTimeMillis", "durationMs", "durationMillis", "itunesDurationMs", "trackTimeMs"]) if (typeof o[k] === "number" && o[k] > 10000) return o[k];
    for (const v of Object.values(o)) { const d = durOf(v, depth + 1); if (d) return d; }
    return null;
  };
  const visit = (o, keyHint) => {
    if (!o || typeof o !== "object") return;
    const k = keyHint || (typeof o.key === "string" ? o.key : (o.title && o.artist ? norm(o.title) + "|" + norm(o.artist) : null));
    const d = k ? durOf(o) : null;
    if (k && d && !hints.has(k)) hints.set(k, d);
    if (Array.isArray(o)) o.forEach(v => visit(v)); else for (const [kk, v] of Object.entries(o)) visit(v, kk.includes("|") ? kk : null);
  };
  visit(data);
  return hints;
}

// ---- fetching with cache, throttle, backoff ----
fs.mkdirSync(CACHE, { recursive: true });
let lastReq = 0, netCount = 0, cacheHits = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function lrclib(endpoint, params) {
  const url = `${API}/${endpoint}?` + new URLSearchParams(params).toString();
  const f = path.join(CACHE, crypto.createHash("sha1").update(url).digest("hex") + ".json");
  if (fs.existsSync(f)) { cacheHits++; return JSON.parse(fs.readFileSync(f, "utf8")).body; }
  if (NOFETCH) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastReq + 350 - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    let res;
    try { res = await fetch(url, { headers: { "User-Agent": UA } }); netCount++; }
    catch (e) { await sleep(2000 * 2 ** attempt); continue; }
    if (res.status === 429 || res.status >= 500) {
      const ra = +res.headers.get("retry-after");
      await sleep(Math.max(ra ? ra * 1000 : 0, 2000 * 2 ** attempt));
      continue;
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const val = res.ok ? body : null;
    fs.writeFileSync(f, JSON.stringify({ url, status: res.status, body: val }));
    return val;
  }
  return undefined; // gave up; not cached
}

// ---- candidate matching ----
const BAD = ["live", "karaoke", "instrumental", "remix", "acoustic", "demo"];
const stripSuffix = t => t.replace(/\s+-\s+.*$/, "");
// title used for LRCLIB lookup: drop "(feat. X)", "[2023 Remaster]", " - Radio Edit" etc.
const lookupTitle = t => cleanTitle(stripSuffix(t.replace(/\[[^\]]*\]/g, " ")));
const lookupArtist = a => a.includes(",") ? a.split(",")[0].trim() : fullArtist(a);
function acceptable(song, r) {
  if (!r || r.instrumental || !r.syncedLyrics || !String(r.syncedLyrics).trim()) return false;
  const st = norm(lookupTitle(song.title));
  const rt = [norm(cleanTitle(r.trackName || "")), norm(cleanTitle(stripSuffix(r.trackName || ""))), norm(r.trackName || "")];
  if (!rt.includes(st) && norm(song.title) !== norm(r.trackName || "")) return false;
  const sa = norm(firstArtist(song.artist)), ra = norm(firstArtist(r.artistName || ""));
  const saFull = norm(fullArtist(song.artist)), raFull = norm(r.artistName || "");
  if (!(sa === ra || (sa && ra && (raFull.includes(sa) || saFull.includes(ra))))) return false;
  const text = (r.trackName || "") + " " + (r.albumName || "");
  for (const w of BAD) {
    const re = new RegExp("\\b" + w + "\\b", "i");
    if (re.test(text) && !re.test(song.title)) return false;
  }
  return true;
}

function choose(song, cands, hintMs) {
  const target = song.spotifyMs || hintMs || null;
  const targetKind = song.spotifyMs ? "spotify" : hintMs ? "itunes" : null;
  let chosen, how, frac = 1;
  if (target) {
    chosen = [...cands].sort((a, b) => Math.abs(a.duration * 1000 - target) - Math.abs(b.duration * 1000 - target) || a.id - b.id)[0];
    how = targetKind === "spotify" ? "closest to Spotify duration" : "closest to iTunes duration hint (weaker than Spotify)";
  } else {
    const sorted = [...cands].sort((a, b) => a.duration - b.duration);
    let best = null;
    for (const c of sorted) {
      const cl = sorted.filter(d => Math.abs(d.duration - c.duration) <= 3);
      if (!best || cl.length > best.length) best = cl;
    }
    const med = best[Math.floor(best.length / 2)].duration;
    chosen = [...best].sort((a, b) => Math.abs(a.duration - med) - Math.abs(b.duration - med) || a.id - b.id)[0];
    frac = best.length / cands.length;
    how = `most common duration cluster (${best.length} of ${cands.length} candidates)`;
  }
  const ds = cands.map(c => c.duration);
  const spread = Math.max(...ds) - Math.min(...ds);
  const mismatchMs = target ? Math.abs(chosen.duration * 1000 - target) : null;
  return { chosen, how, target, targetKind, mismatchMs, spread, frac };
}

async function fetchCandidates(song) {
  const p = { track_name: lookupTitle(song.title), artist_name: lookupArtist(song.artist) };
  if (song.spotifyMs) {
    const r = await lrclib("get", { ...p, duration: Math.round(song.spotifyMs / 1000) });
    if (r && acceptable(song, r)) return [r];
  }
  let list = await lrclib("search", p);
  if (list === undefined) return undefined;
  let cands = (list || []).filter(r => acceptable(song, r));
  if (!cands.length) {
    list = await lrclib("search", { q: `${lookupTitle(song.title)} ${firstArtist(song.artist)}` });
    if (list === undefined) return undefined;
    cands = (list || []).filter(r => acceptable(song, r));
  }
  return cands;
}

const ts = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const sortObj = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));

async function main() {
  let songs = loadSongs();
  if (ONLY) songs = songs.filter(s => (s.title + " " + s.artist).toLowerCase().includes(ONLY.toLowerCase()));
  songs = songs.slice(0, LIMIT);
  const hints = loadHints();
  const hooks = {}, report = {};
  let i = 0;
  for (const song of songs) {
    i++;
    if (i % 25 === 0) console.error(`${i}/${songs.length} (net ${netCount}, cache ${cacheHits})`);
    const hintMs = song.spotifyMs ? null : hints.get(song.key) || null;
    const rep = {
      title: song.title, artist: song.artist, year: song.year, sources: song.sources,
      status: null, reason: null,
      durationHint: song.spotifyMs ? { kind: "spotify", ms: song.spotifyMs } : hintMs ? { kind: "itunes", ms: hintMs } : null,
      lrclib: null, durationMs: null, durationMismatchMs: null, candidateCount: 0, candidateSpreadSec: null,
      recordingChosenBy: null, otherSpotifyDurationsMs: song.altDurations, hook: null, review: false, reviewReasons: [],
    };
    report[song.key] = rep;
    const cands = await fetchCandidates(song);
    if (cands === undefined) { rep.status = "error"; rep.reason = "LRCLIB request failed after retries"; continue; }
    rep.candidateCount = cands.length;
    if (!cands.length) {
      rep.status = "no-recording";
      rep.reason = "no acceptable LRCLIB recording with synced lyrics (title/artist mismatch, none found, or only live/karaoke/remix/etc.)";
      continue;
    }
    const sel = choose(song, cands, hintMs);
    const r = sel.chosen;
    rep.lrclib = { id: r.id, trackName: r.trackName, artistName: r.artistName, albumName: r.albumName };
    rep.durationMs = Math.round(r.duration * 1000);
    rep.candidateSpreadSec = Math.round(sel.spread * 10) / 10;
    rep.durationMismatchMs = sel.mismatchMs;
    rep.recordingChosenBy = sel.how;
    const lines = parseLrc(r.syncedLyrics);
    const res = findChorus(lines, song.title);
    if (res.ms == null) {
      rep.status = res.reason === "too few lyric lines" ? "no-synced" : "no-repeat";
      rep.reason = res.reason;
      continue;
    }
    const why = res.reason + (sel.targetKind === "itunes" ? "; duration check used iTunes hint only" : "");
    rep.status = "hook";
    rep.reason = why;
    rep.hook = {
      ms: res.ms, time: ts(res.ms), confidence: res.confidence, blockStartMs: res.blockStart,
      lines: res.lines.map(l => ({ ms: l.ms, text: l.text })),
      before: res.before.map(l => ({ ms: l.ms, text: l.text })),
      repeatsAtMs: res.repeats,
    };
    const rv = rep.reviewReasons;
    if (res.confidence === "low") rv.push("low confidence");
    if (res.ms < 5000) rv.push("hook in first 5 seconds");
    if (res.blockStart > rep.durationMs / 2) rv.push("hook past halfway point");
    if (sel.mismatchMs != null && sel.mismatchMs > 3000) rv.push(`duration mismatch ${(sel.mismatchMs / 1000).toFixed(1)}s vs ${sel.targetKind}`);
    if (!sel.target && sel.spread > 3 && sel.frac < 0.7) rv.push(`duration unknown and candidates disagree by ${sel.spread.toFixed(1)}s`);
    if (!res.titleInBlock) rv.push("title not in hook block");
    rep.review = rv.length > 0;
    hooks[song.key] = { ms: res.ms, dur: rep.durationMs, conf: res.confidence, why };
  }
  if (!ONLY && LIMIT === Infinity) {
    // Reviewed corrections: tools/hook-overrides.json is { key: { lineMs: <ms of a real lyric line> | null, note } }.
    // lineMs must be the timestamp of a line in the chosen recording; null drops the hook.
    const ovFile = path.join(OUT_DIR, "hook-overrides.json");
    // Hooks set by ear in the app ("Save my hooks as a file"), dropped into tools/input/ as *.hooks.json.
    // These are exact start positions and win over everything; dur 0 tells the page not to check the length.
    const manual = {};
    for (const f of fs.readdirSync(path.join(here, "input")).filter(f => f.endsWith(".hooks.json")).sort())
      Object.assign(manual, JSON.parse(fs.readFileSync(path.join(here, "input", f), "utf8")).hooks || {});
    if (fs.existsSync(ovFile)) {
      for (const [key, ov] of Object.entries(JSON.parse(fs.readFileSync(ovFile, "utf8")))) {
        const rep = report[key];
        if (!rep) { console.error("override for unknown song: " + key); continue; }
        if (ov.id && rep.lrclib && rep.lrclib.id !== ov.id) { console.error("override skipped, recording changed: " + key); continue; }
        if (ov.lineMs == null) { delete hooks[key]; rep.override = { dropped: true, note: ov.note }; continue; }
        if (!rep.durationMs) { console.error("override for a song with no recording: " + key); continue; }
        hooks[key] = { ms: Math.max(0, ov.lineMs - 1500), dur: rep.durationMs, conf: "reviewed", why: ov.note || "set in review" };
        rep.override = { lineMs: ov.lineMs, note: ov.note };
      }
    }
    for (const [key, ms] of Object.entries(manual)) if (typeof ms === "number" && ms >= 0) hooks[key] = { ms: Math.round(ms), dur: 0, conf: "manual", why: "set by ear in the app" };
    fs.writeFileSync(path.join(OUT_DIR, "hooks.json"), JSON.stringify(sortObj(hooks), null, 2) + "\n");
    fs.writeFileSync(path.join(OUT_DIR, "hooks-report.json"), JSON.stringify(sortObj(report), null, 2) + "\n");
  } else {
    for (const v of Object.values(report)) {
      console.log(`${v.title} - ${v.artist} [${v.status}] ${v.hook ? v.hook.time + " " + v.hook.confidence : ""} ${v.reason}${v.reviewReasons.length ? " REVIEW: " + v.reviewReasons.join("; ") : ""}`);
      if (v.hook) {
        for (const l of v.hook.before) console.log("   . " + ts(l.ms) + " " + l.text);
        for (const l of v.hook.lines) console.log("   > " + ts(l.ms) + " " + l.text);
      }
    }
  }
  const grp = p => Object.values(report).filter(v => v.sources.some(x => x.startsWith(p)));
  const bySource = {};
  for (const g of ["builtin", "playlist"]) {
    const vs = grp(g);
    bySource[g] = {
      songs: vs.length, hooks: vs.filter(v => v.hook).length,
      high: vs.filter(v => v.hook?.confidence === "high").length, medium: vs.filter(v => v.hook?.confidence === "medium").length,
      low: vs.filter(v => v.hook?.confidence === "low").length,
      noRecording: vs.filter(v => v.status === "no-recording").length, noSynced: vs.filter(v => v.status === "no-synced").length,
      noRepeat: vs.filter(v => v.status === "no-repeat").length, review: vs.filter(v => v.review).length,
    };
  }
  console.error(JSON.stringify({ bySource, inBoth: Object.values(report).filter(v => v.sources.length > 1).length }, null, 1));
  const st = {}, conf = {}, rev = {};
  for (const v of Object.values(report)) {
    st[v.status] = (st[v.status] || 0) + 1;
    if (v.hook) conf[v.hook.confidence] = (conf[v.hook.confidence] || 0) + 1;
    for (const r of v.reviewReasons) { const k = r.replace(/[\d.]+s/g, "Ns"); rev[k] = (rev[k] || 0) + 1; }
  }
  const vals = Object.values(report);
  console.error(JSON.stringify({
    songs: songs.length, status: st, confidence: conf, reviewFlagged: vals.filter(v => v.review).length, reviewReasons: rev,
    itunesHints: vals.filter(v => v.durationHint?.kind === "itunes").length,
    spotify: vals.filter(v => v.durationHint?.kind === "spotify").length, network: netCount, cacheHits,
  }, null, 1));
}
main();
