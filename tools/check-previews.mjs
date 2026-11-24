// Verifies the 30s preview lookup used by year-by-year.html against the real iTunes/Deezer APIs.
// Usage: node tools/check-previews.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(here, "..", "year-by-year.html");
const CACHE = path.join(here, ".cache", "previews");
const REPORT = path.join(here, "preview-report.json");
const UA = "one-shot-wonder-dev/0.1";
fs.mkdirSync(CACHE, { recursive: true });

// ---- extract BUILTIN ----
const html = fs.readFileSync(HTML, "utf8");
const line = html.split(/\r?\n/).find(l => l.startsWith("const BUILTIN="));
if (!line) throw new Error("BUILTIN not found");
const BUILTIN = new Function("return " + line.slice("const BUILTIN=".length).replace(/;\s*$/, ""))();
console.log("songs:", BUILTIN.length);

// ---- helpers copied verbatim from the page (lines 233-247), pick() returns the candidate ----
const norm=s=>s.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const cleanTitle=t=>(t.replace(/\([^)]*\)/g," ").replace(/^[.\s]+/,"").replace(/\s+/g," ").trim())||t;
const fullArtist=a=>a.split(/\s+(?:feat\.?|featuring)\s+/i)[0];
const firstArtist=a=>a.split(/,|&|\s+(?:and|feat\.?|featuring|with)\s+/i)[0].trim();
function pick(cands,song){
  const t=norm(cleanTitle(song[1])),a=norm(firstArtist(song[2]));let best=null,top=0;
  for(const c of cands){
    const n=norm(c.name),ar=norm(c.artist);let sc=0;
    if(a&&ar.includes(a))sc+=2;
    if(n.startsWith(t))sc+=2;else if(n.includes(t))sc+=1;
    if(/karaoke|tribute|made famous|cover version|instrumental|\blive\b|re-?recorded/i.test(c.name+" "+c.artist)&&!/live/i.test(song[1]))sc-=2;
    if(sc>top){top=sc;best=c}
  }
  return top>=3?best:null;
}
// same scoring, exposed for reporting candidates
function score(c,song){
  const t=norm(cleanTitle(song[1])),a=norm(firstArtist(song[2]));
  const n=norm(c.name),ar=norm(c.artist);let sc=0;
  if(a&&ar.includes(a))sc+=2;
  if(n.startsWith(t))sc+=2;else if(n.includes(t))sc+=1;
  if(/karaoke|tribute|made famous|cover version|instrumental|\blive\b|re-?recorded/i.test(c.name+" "+c.artist)&&!/live/i.test(song[1]))sc-=2;
  return sc;
}

// ---- http with cache + rate limiting ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = u => crypto.createHash("sha1").update(u).digest("hex");
let lastItunes = 0, lastDeezer = 0, lastCdn = 0;
const stats = { itunesFetched: 0, deezerFetched: 0, cdnFetched: 0, blocked: false };

async function gap(kind) {
  const [last, ms] = kind === "itunes" ? [lastItunes, 3200] : kind === "deezer" ? [lastDeezer, 220] : [lastCdn, 220];
  const wait = last + ms - Date.now();
  if (wait > 0) await sleep(wait);
  if (kind === "itunes") lastItunes = Date.now(); else if (kind === "deezer") lastDeezer = Date.now(); else lastCdn = Date.now();
}

async function cachedGet(url, kind) {
  const f = path.join(CACHE, hash(url) + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  for (let attempt = 0; attempt < 4; attempt++) {
    await gap(kind);
    let rec;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      const body = await r.text();
      rec = { url, status: r.status, contentType: r.headers.get("content-type"), finalUrl: r.url, body };
    } catch (e) {
      rec = { url, status: 0, error: String(e), body: "" };
    }
    kind === "itunes" ? stats.itunesFetched++ : stats.deezerFetched++;
    if (rec.status === 403 || rec.status === 429) {
      console.log(`  ${kind} HTTP ${rec.status}; backing off 60s (attempt ${attempt + 1}/4)`);
      await sleep(60000);
      continue;
    }
    if (rec.status === 0 || rec.status >= 500) { await sleep(5000); if (attempt < 2) continue; }
    fs.writeFileSync(f, JSON.stringify(rec));
    return rec;
  }
  stats.blocked = true;
  throw new Error(`${kind} blocked/unavailable after retries`);
}

// JSONP wrapper strip. Same URL as page incl. callback param.
const CB = "ybyCbtest";
function parseJsonp(rec) {
  const b = rec.body || "";
  const i = b.indexOf("("), j = b.lastIndexOf(")");
  if (i < 0 || j < i) return { err: "not jsonp", raw: b.slice(0, 200) };
  try { return { data: JSON.parse(b.slice(i + 1, j)), prefix: b.slice(0, i + 1) }; }
  catch (e) { return { err: "json parse: " + e.message, raw: b.slice(0, 200) }; }
}

const itunesCand = r => ({ name: r.trackName || "", artist: r.artistName || "", album: r.collectionName || "", durationMs: r.trackTimeMillis ?? null, val: r.previewUrl, kind: r.kind });
const deezerCand = r => ({ name: r.title || "", artist: (r.artist && r.artist.name) || "", album: (r.album && r.album.title) || "", durationMs: r.duration != null ? r.duration * 1000 : null, val: r.preview, title_short: r.title_short, title_version: r.title_version });

const notes = { itunesShapes: new Set(), deezerErrors: [], itunesErrors: [], jsonpPrefixes: new Set(), contentTypes: new Set(), noPreviewCount: 0, redirects: [] };

async function lookup(song) {
  const term = encodeURIComponent(cleanTitle(song[1]) + " " + fullArtist(song[2]));
  const out = { service: "none", match: null, candidates: { itunes: [], deezer: [] }, errors: [] };

  const iu = "https://itunes.apple.com/search?media=music&entity=song&limit=10&term=" + term + "&callback=" + CB;
  try {
    const rec = await cachedGet(iu, "itunes");
    if (rec.finalUrl && rec.finalUrl !== iu) notes.redirects.push([iu, rec.finalUrl]);
    notes.contentTypes.add("itunes:" + rec.contentType);
    const p = parseJsonp(rec);
    if (p.err) { out.errors.push("itunes " + rec.status + " " + p.err + " " + p.raw); notes.itunesErrors.push([song[1], rec.status, p.raw]); }
    else {
      notes.jsonpPrefixes.add(p.prefix);
      const rs = p.data.results || [];
      const noPrev = rs.filter(r => !r.previewUrl).length; notes.noPreviewCount += noPrev;
      const cands = rs.filter(r => r.previewUrl).map(itunesCand);
      out.candidates.itunes = cands.map(c => ({ ...c, score: score(c, song) }));
      const best = pick(cands, song);
      if (best) { out.service = "itunes"; out.match = best; }
    }
  } catch (e) { if (stats.blocked) throw e; out.errors.push("itunes " + e.message); }

  if (!out.match) {
    const du = "https://api.deezer.com/search?output=jsonp&limit=10&q=" + term + "&callback=" + CB;
    try {
      const rec = await cachedGet(du, "deezer");
      notes.contentTypes.add("deezer:" + rec.contentType);
      const p = parseJsonp(rec);
      if (p.err) out.errors.push("deezer " + rec.status + " " + p.err + " " + p.raw);
      else {
        notes.jsonpPrefixes.add("deezer:" + p.prefix);
        if (p.data.error) { notes.deezerErrors.push([song[1], p.data.error]); out.errors.push("deezer error " + JSON.stringify(p.data.error)); }
        const cands = (p.data.data || []).filter(r => r.preview).map(deezerCand);
        out.candidates.deezer = cands.map(c => ({ ...c, score: score(c, song) }));
        const best = pick(cands, song);
        if (best) { out.service = "deezer"; out.match = best; }
      }
    } catch (e) { out.errors.push("deezer " + e.message); }
  }
  return out;
}

// ---- preview liveness ----
async function checkUrl(url) {
  const f = path.join(CACHE, "head-" + hash(url) + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  let res;
  for (const method of ["HEAD", "GET"]) {
    await gap("cdn");
    try {
      const h = { "User-Agent": UA }; if (method === "GET") h.Range = "bytes=0-1023";
      const r = await fetch(url, { method, headers: h, redirect: "follow" });
      if (method === "GET") await r.arrayBuffer().catch(() => {});
      const ct = r.headers.get("content-type") || "";
      res = { method, status: r.status, contentType: ct, length: r.headers.get("content-length"), finalUrl: r.url !== url ? r.url : undefined };
      res.ok = (r.status === 200 || r.status === 206) && /^audio\//i.test(ct) || (r.status === 200 || r.status === 206) && /mpeg|mp4|octet-stream/i.test(ct);
      if (res.ok) break;
    } catch (e) { res = { method, error: String(e), ok: false }; }
  }
  stats.cdnFetched++;
  fs.writeFileSync(f, JSON.stringify(res));
  return res;
}

// ---- suspicion flags ----
const VARIANT = /remaster|re-?record|\blive\b|karaoke|tribute|cover|version|edit|mix|acoustic|demo|instrumental/i;
const COMPILATION = /karaoke|tribute|hits|made famous|originally performed|party|workout|cover|sound[- ]?alike|best of the|top \d|\bnow\b/i;
function flags(song, o) {
  const f = [];
  const mt = o.match; if (!mt) return f;
  const title = song[1], t = norm(cleanTitle(title));
  const mv = (mt.name + " " + mt.album);
  const vm = mv.match(VARIANT);
  const sv = title.match(VARIANT);
  if (vm && !sv) {
    const onlyRemaster = /^remaster(ed)?$/i.test(vm[0]) || (/remaster/i.test(mv) && !new RegExp(VARIANT.source.replace("remaster|", ""), "i").test(mv));
    f.push({ type: onlyRemaster ? "remaster" : "variant-word", word: vm[0] });
  }
  if (!norm(mt.artist).includes(norm(firstArtist(song[2])))) f.push({ type: "artist-mismatch" });
  const mn = norm(mt.name);
  if (!mn.startsWith(t)) f.push({ type: "title-not-prefix" });
  else if (mn !== t) {
    // prefix match with extra text; mild unless extra is not a bracketed/dash suffix
    const rawExtra = mt.name.replace(/\s*[\(\[-].*$/, "");
    if (norm(rawExtra) !== t) f.push({ type: "title-extra-text" });
  }
  if (COMPILATION.test(mt.album) && !COMPILATION.test(song[1])) f.push({ type: "compilation-album" });
  return f;
}

// ---- main ----
const results = [];
const t0 = Date.now();
for (let i = 0; i < BUILTIN.length; i++) {
  const song = BUILTIN[i];
  let o;
  try { o = await lookup(song); }
  catch (e) {
    console.log("ABORT:", e.message);
    fs.writeFileSync(REPORT, JSON.stringify({ aborted: e.message, stats, doneSongs: i, results }, null, 1));
    process.exit(2);
  }
  const rec = { index: i, year: song[0], title: song[1], artist: song[2], genre: song[3], term: cleanTitle(song[1]) + " " + fullArtist(song[2]), service: o.service, errors: o.errors };
  if (o.match) {
    rec.match = { name: o.match.name, artist: o.match.artist, album: o.match.album, durationMs: o.match.durationMs, previewUrl: o.match.val };
    rec.preview = await checkUrl(o.match.val);
    rec.flags = flags(song, o);
  } else {
    rec.candidates = o.candidates;
  }
  results.push(rec);
  if ((i + 1) % 10 === 0 || i === BUILTIN.length - 1)
    console.log(`${i + 1}/${BUILTIN.length} ${((Date.now() - t0) / 60000).toFixed(1)}min  last: ${song[1]} -> ${o.service}`);
}

const by = s => results.filter(r => r.service === s);
const dead = results.filter(r => r.match && !r.preview.ok);
const suspicious = results.filter(r => r.flags && r.flags.some(x => x.type !== "remaster"));
const remasterOnly = results.filter(r => r.flags && r.flags.length && r.flags.every(x => x.type === "remaster"));
const summary = { total: results.length, itunes: by("itunes").length, deezer: by("deezer").length, none: by("none").length, deadPreviews: dead.length, suspicious: suspicious.length, remasterOnly: remasterOnly.length };
fs.writeFileSync(REPORT, JSON.stringify({
  generated: new Date().toISOString(), summary, stats,
  apiNotes: { jsonpPrefixes: [...notes.jsonpPrefixes], contentTypes: [...notes.contentTypes], itunesErrors: notes.itunesErrors, deezerErrors: notes.deezerErrors, itunesCandidatesWithoutPreview: notes.noPreviewCount, redirects: notes.redirects },
  results,
}, null, 1));

console.log("\n=== SUMMARY ===", summary);
console.log("\n--- no match ---");
for (const r of by("none")) console.log(`${r.year} | ${r.title} | ${r.artist}${r.errors.length ? "  ERR:" + r.errors.join(";").slice(0, 100) : ""}`);
console.log("\n--- dead previews ---");
for (const r of dead) console.log(r.year, r.title, r.match.previewUrl, JSON.stringify(r.preview));
console.log("\n--- suspicious ---");
for (const r of suspicious) console.log(`${r.year} | ${r.title} | ${r.artist}  =>  [${r.service}] ${r.match.name} / ${r.match.artist} / ${r.match.album}  {${r.flags.map(x => x.type + (x.word ? ":" + x.word : "")).join(",")}}`);
console.log("report:", REPORT);
