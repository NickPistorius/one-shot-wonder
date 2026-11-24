// Pure chorus ("hook") finder. No I/O, no Node-only APIs: can be pasted into a browser.

export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      const ms = Math.round((parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(":", "."))) * 1000);
      out.push({ ms, text: body });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

const FILLER = new Set(["oh", "ooh", "oooh", "ohh", "yeah", "yea", "yeh", "ah", "ahh", "hey", "uh", "whoa", "woah", "woo", "na", "la", "mm", "mmm", "ha", "ay", "ayy", "ooo", "oo", "huh", "ya"]);

const tokens = (s) =>
  String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length, 1));

function cleanTitle(t) {
  return (t.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/^[.\s]+/, "").replace(/\s+-\s+.*$/, "").replace(/\s+/g, " ").trim()) || t;
}

const isTag = (t) => /^[\[(][^\])]*[\])]$/.test(t.trim());

function hasTitle(key, titleToks) {
  if (!titleToks.length) return false;
  const lt = key.split(" ");
  const n = titleToks.length;
  const tj = titleToks.join(" ");
  if (lt.length < n) return false;
  for (let i = 0; i + n <= lt.length; i++) {
    const w = lt.slice(i, i + n).join(" ");
    if (w === tj || (tj.length >= 8 && sim(w, tj) >= 0.85)) return true;
  }
  return false;
}

/**
 * @param {{ms:number,text:string}[]} rawLines parsed LRC lines
 * @param {string} title song title
 * @returns {{ms,confidence,reason,lines,repeats,before,blockStart,titleInBlock,titleInLyrics}|{ms:null,reason:string}}
 */
export function findChorus(rawLines, title) {
  // keep stanza breaks: a blank/tag line before a kept line marks it as a stanza start
  const L = [];
  let pendingBrk = true;
  for (const l of rawLines) {
    if (!l.text || !l.text.trim() || isTag(l.text)) { pendingBrk = true; continue; }
    L.push({ ms: l.ms, text: l.text, brk: pendingBrk });
    pendingBrk = false;
  }
  if (L.length < 8) return { ms: null, reason: "too few lyric lines" };
  const dropFiller = (tk) => { const f = tk.filter((w) => !FILLER.has(w)); return f.length ? f : tk; };
  const titleToks = dropFiller(tokens(cleanTitle(title)));
  const fullTitleToks = dropFiller(tokens(title));
  const keys = L.map((l) => {
    const tk = tokens(l.text);
    const f = tk.filter((w) => !FILLER.has(w));
    return (f.length ? f : tk).join(" ");
  });
  const n = L.length;
  const titleIn = keys.map((k) => hasTitle(k, titleToks) || (fullTitleToks.length && hasTitle(k, fullTitleToks)));
  const titleInLyrics = titleIn.some(Boolean);
  // match matrix computed lazily
  const memo = new Map();
  const match = (i, j) => {
    if (i < 0 || j < 0 || i >= n || j >= n || !keys[i] || !keys[j]) return false;
    const id = i * n + j;
    let v = memo.get(id);
    if (v === undefined) { v = sim(keys[i], keys[j]) >= 0.8; memo.set(id, v); }
    return v;
  };

  const cands = [];
  for (let i = 0; i < n - 3; i++) {
    const js = [];
    let bestRun = 0, validStart = false;
    for (let j = i + 2; j < n - 1; j++) {
      if (!match(i, j) || !match(i + 1, j + 1)) continue;
      let r = 2;
      while (j + r < n && r < j - i && match(i + r, j + r)) r++;
      // skip if this is just a shifted view of a block starting earlier
      if (!match(i - 1, j - 1) || L[i].brk) validStart = true;
      // dedupe overlapping occurrences
      if (js.length && j < js[js.length - 1].j + Math.min(js[js.length - 1].r, r)) continue;
      js.push({ j, r });
      bestRun = Math.max(bestRun, r);
    }
    if (!js.length || !validStart) continue;
    // clip the repeating run to the end of its stanza (if the lyrics have stanza breaks)
    let run = bestRun;
    for (let k = 1; k < bestRun; k++) if (L[i + k].brk) { run = k; break; }
    if (run < 2) continue;
    let len = Math.min(run, 8);
    let start = i;
    // pre-chorus trimming: start at the title line when the title sits deep inside the block
    let ti = -1;
    for (let k = 0; k < run; k++) if (titleIn[i + k]) { ti = k; break; }
    let trimmed = false;
    if (ti >= 2) {
      if (run >= ti + 2) { start = i + ti; len = Math.min(run - ti, 8); trimmed = true; }
      else if (run > 4) { start = i + Math.max(0, ti - 3); len = ti - Math.max(0, ti - 3) + 1; trimmed = true; }
    }
    const blockKeys = keys.slice(start, start + len);
    const distinct = new Set(blockKeys).size;
    const withTitle = ti >= 0;
    cands.push({
      i: start, len, count: js.length + 1, withTitle, trimmed,
      chant: distinct === 1 && !withTitle,
      repeats: js.map((o) => o.j + (start - i)),
    });
  }

  let pick = null, kind = "";
  const t1 = cands.filter((c) => c.withTitle && !c.chant);
  if (t1.length) {
    // prefer the earliest title block that repeats 3+ times, else earliest that repeats
    pick = t1.find((c) => c.count >= 3) || t1[0];
    kind = "title";
    // title block only shows up late: an earlier block that repeats 3+ times is probably the real chorus (title phrase differs)
    if (L[pick.i].ms > 100000) {
      const early = cands.find((c) => !c.chant && !c.withTitle && c.count >= 3 && c.len >= 3 && L[c.i].ms < L[pick.i].ms - 30000);
      if (early) { pick = early; kind = "strong"; }
    }
  }
  if (!pick) {
    const titleLines = keys.map((_, i) => i).filter((i) => titleIn[i]);
    // a single repeated title line (at least 3 occurrences, not just a verbatim stutter inside one place)
    if (titleLines.length >= 3) {
      const first = titleLines[0];
      pick = { i: first, len: 1, count: titleLines.length, withTitle: true, single: true, repeats: titleLines.slice(1) };
      kind = "single";
    }
  }
  if (!pick) {
    const s = cands.filter((c) => !c.chant && c.count >= 3);
    if (s.length) { pick = s[0]; kind = "strong"; }
  }
  if (!pick) {
    const w = cands.filter((c) => !c.chant);
    if (w.length) { pick = w[0]; kind = "weak"; }
  }
  if (!pick) return { ms: null, reason: "no clear repeating block", titleInLyrics };

  const lines = L.slice(pick.i, pick.i + pick.len);
  const times = pick.count;
  const what = pick.single ? "single line" : `${pick.len}-line block`;
  let confidence, reason;
  if (kind === "title") {
    confidence = times >= 3 ? "high" : "medium";
    reason = `${what} repeats ${times} times and contains the title`;
  } else if (kind === "single") {
    confidence = "medium";
    reason = `title line appears ${times} times but not inside a repeating multi-line block`;
  } else if (kind === "strong") {
    confidence = titleInLyrics ? "low" : "medium";
    reason = `${what} repeats ${times} times` + (titleInLyrics ? " but does not contain the title" : "; title never appears in the lyrics");
  } else {
    confidence = "low";
    reason = `${what} repeats only ${times} times` + (titleInLyrics ? " and does not contain the title" : "; title never appears in the lyrics");
  }
  if (pick.trimmed) reason += " (started at the title line, skipping a pre-chorus)";
  return {
    ms: Math.max(0, lines[0].ms - 1500),
    confidence,
    reason,
    lines,
    repeats: pick.repeats.filter((j) => j >= 0 && j < n).map((j) => L[j].ms),
    before: L.slice(Math.max(0, pick.i - 2), pick.i),
    blockStart: lines[0].ms,
    titleInBlock: pick.withTitle,
    titleInLyrics,
  };
}
