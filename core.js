// Pure logic: CSV parsing, material matching, edge resolution, checks, export rows.
// No DOM access, so it can be tested in Node.

export const EDGE_NAMES = ["L1", "L2", "W1", "W2"];
// CabinetSense banding order is Bottom, Top, Left, Right -> L1, L2, W1, W2
export const TAPES = [
  { v: "0", label: "None" },
  { v: "0.4", label: "0.4 prep tape" },
  { v: "0.6", label: "0.6 veneer" },
  { v: "1", label: "1 ABS" },
  { v: "2", label: "2 ABS" },
];
export const XLSX_HEADERS = ["Decor code", "Thickness", "Length", "Width", "Quantity", "Description", "L1", "L2", "W1", "W2", "Edge finish", "Customer note"];
const HIDDEN_PART = /\b(back|support|suport|rail|batten|cleat|noggin|stretcher|spacer|filler support)\b/i;

/* ---------- CSV ---------- */
export function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}

export function readParts(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error("The file is empty.");
  const h = rows[0].map(s => s.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = h.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
  const C = {
    sub: col("Sub-Assembly"), desc: col("Description"), qty: col("Copies", "Quantity", "Qty"),
    t: col("Thickness"), w: col("Width"), l: col("Length(w/Grain)", "Length"),
    mat: col("Material Name"), rot: col("Can Rotate"), model: col("Model"),
    eb: [col("EB Bottom"), col("EB Top"), col("EB Left"), col("EB Right")], band: col("Banding"),
  };
  const need = { Description: C.desc, Thickness: C.t, Width: C.w, "Length(w/Grain)": C.l, "Material Name": C.mat };
  const miss = Object.entries(need).filter(([, i]) => i < 0).map(([n]) => n);
  if (miss.length) throw new Error("This doesn't look like a CabinetSense cutlist. Missing column: " + miss.join(", ") + ".");

  const parts = [];
  rows.slice(1).forEach((r, idx) => {
    const g = i => (i >= 0 ? (r[i] ?? "").trim() : "");
    let letters;
    if (C.eb.every(i => i >= 0)) letters = C.eb.map(i => g(i));
    else if (C.band >= 0) letters = g(C.band).split("-").map(s => s.trim()).concat(["", "", "", ""]).slice(0, 4);
    else letters = ["", "", "", ""];
    letters = letters.map(e => (e === "0" || e === "-" || e === "*" ? "" : e.toUpperCase()));
    const raw = { t: parseFloat(g(C.t)), l: parseFloat(g(C.l)), w: parseFloat(g(C.w)) };
    const sub = g(C.sub), desc = g(C.desc);
    parts.push({
      id: "p" + (idx + 1),
      cab: sub && sub !== desc ? sub : "",
      name: desc || sub || "Part",
      qty: parseInt(g(C.qty)) || 1,
      raw,
      t: round(raw.t), l: round(raw.l), w: round(raw.w),
      mat: g(C.mat),
      grain: g(C.rot).toLowerCase() === "no",
      letters,
      model: g(C.model),
    });
  });
  return parts;
}
const round = n => (isFinite(n) ? Math.round(n) : NaN);
export const roundedCount = parts => parts.reduce((n, p) => n + ["t", "l", "w"].filter(k => isFinite(p.raw[k]) && Math.abs(p.raw[k] - p[k]) > 0.001).length, 0);

export const matKey = p => p.mat + "|" + p.t;

/* ---------- Material matching ---------- */
const norm = s => s.toUpperCase().replace(/[\s_]+/g, "-").replace(/[^A-Z0-9-]/g, "");
// Suggest a catalogue code for a CabinetSense material name: the longest catalogue
// code that the normalised name starts with, ending at a separator.
export function suggestMaterial(name, catalogue) {
  const n = norm(name);
  if (!n) return null;
  let best = null;
  for (const d of catalogue) {
    const c = norm(d.code);
    if (c.length < 3) continue;
    if (n === c || n.startsWith(c + "-")) { if (!best || c.length > norm(best.code).length) best = d; }
  }
  return best;
}

/* ---------- Edges ---------- */
// Suggested tape for a board + CabinetSense edge letter.
export function suggestTape(decor, letter) {
  if (!letter) return "0";
  if (letter === "X") return "0"; // scribe edge
  if (!decor) return null;
  const b = (decor.brand || "").toLowerCase();
  if (b === "mdf boards") return "0.4";
  if (b === "veneered boards" || b === "shinnoki") return "0.6";
  if (b === "plywood") return "0";
  return "1";
}

export function resolve(p, ctx) {
  const { maps, job, catByCode } = ctx;
  const mm = maps.mat[matKey(p)] || {};
  const ov = job.over[p.id] || {};
  const code = (ov.code || mm.code || "").toUpperCase();
  const decor = catByCode.get(code) || null;
  const edges = p.letters.map((letter, i) => {
    if (ov.edges && ov.edges[i] != null) return { v: ov.edges[i], src: "edit", letter };
    if (!letter) return { v: "0", src: "csv", letter };
    const rule = maps.edge[code + "|" + letter];
    if (rule != null) return { v: rule, src: "rule", letter };
    const s = suggestTape(decor, letter);
    return { v: s, src: s == null ? "missing" : "suggest", letter };
  });
  return { code, decor, skip: !!mm.skip && !ov.code, edges, noneOk: !!ov.none };
}

/* ---------- Description ---------- */
export function description(p) {
  const raw = p.cab ? p.cab + " " + p.name : p.name;
  const clean = raw.replace(/[^A-Za-z0-9 \-+.&]/g, " ").replace(/\s+/g, " ").trim();
  return { text: clean.slice(0, 30).trim(), cut: clean.length > 30 };
}

/* ---------- Checks ---------- */
export function checks(parts, ctx) {
  const out = [];
  const R = new Map(parts.map(p => [p.id, resolve(p, ctx)]));
  const live = parts.filter(p => !R.get(p.id).skip);

  // 1. Materials with no CWorkshop code
  const noCode = new Map();
  for (const p of live) if (!R.get(p.id).code) { const k = matKey(p); noCode.set(k, (noCode.get(k) || 0) + p.qty); }
  for (const [k, n] of noCode) { const [m, t] = k.split("|"); out.push({ id: "mat:" + k, level: "bad", kind: "material", text: `"${m}" (${t} mm) has no CWorkshop code`, detail: `${n} part${n > 1 ? "s" : ""}`, parts: live.filter(p => matKey(p) === k).map(p => p.id) }); }

  // 2. Edges with no tape decided (unknown board)
  for (const p of live) if (R.get(p.id).edges.some(e => e.src === "missing") && R.get(p.id).code)
    out.push({ id: "edge:" + p.id, level: "bad", kind: "edge", text: `${label(p)}: edge tape not set`, parts: [p.id] });

  // 3. Left/Right pairs that don't match
  const done = new Set();
  for (const p of live) {
    if (!/\bleft\b/i.test(p.name)) continue;
    const twinName = p.name.replace(/\bleft\b/i, m => (m[0] === "L" ? "Right" : "right"));
    const twin = live.find(q => q.cab === p.cab && q.name === twinName && !done.has(q.id) && sameSize(p, q));
    if (!twin) continue;
    done.add(twin.id);
    const a = pattern(R.get(p.id)), b = pattern(R.get(twin.id));
    const mirrored = [b[0], b[1], b[3], b[2]];
    if (a.join() !== b.join() && a.join() !== mirrored.join())
      out.push({ id: "pair:" + p.id, level: "warn", kind: "pair", text: `${label(p)} and ${twin.name} have different banding`, parts: [p.id, twin.id] });
  }

  // 4. Three edges banded the same, one empty (not a scribe)
  for (const p of live) {
    const r = R.get(p.id); if (r.noneOk || r.edges.some(e => e.src === "edit")) continue;
    const vals = r.edges.map(e => e.v);
    const banded = vals.filter(v => v && v !== "0");
    const emptyIdx = vals.findIndex(v => v === "0");
    if (banded.length === 3 && new Set(banded).size === 1 && p.letters[emptyIdx] !== "X" && r.edges[emptyIdx].src === "csv")
      out.push({ id: "partial:" + p.id, level: "warn", kind: "partial", text: `${label(p)}: ${EDGE_NAMES[emptyIdx]} has no banding, the other three do`, parts: [p.id] });
  }

  // 5. No banding at all on a part that doesn't look hidden
  for (const p of live) {
    const r = R.get(p.id); if (r.noneOk) continue;
    if (r.edges.every(e => e.v === "0") && !HIDDEN_PART.test(p.name) && !p.letters.includes("X"))
      out.push({ id: "none:" + p.id, level: "warn", kind: "none", text: `${label(p)} has no banding`, parts: [p.id], canMarkNone: true });
  }

  // 6. Descriptions over 30 characters
  for (const p of live) if (description(p).cut) out.push({ id: "desc:" + p.id, level: "info", kind: "desc", text: `${label(p)}: description cut to 30 characters`, parts: [p.id] });

  // 7. Parts bigger than the sheet
  for (const p of live) {
    const d = R.get(p.id).decor; if (!d || !d.length) continue;
    const big = Math.max(p.l, p.w), small = Math.min(p.l, p.w);
    const fits = p.grain ? p.l <= d.length && p.w <= d.width : big <= Math.max(d.length, d.width) && small <= Math.min(d.length, d.width);
    if (!fits) out.push({ id: "size:" + p.id, level: "bad", kind: "size", text: `${label(p)} (${p.l} × ${p.w}) is bigger than a ${d.length} × ${d.width} sheet`, parts: [p.id] });
  }
  return out;
}
const label = p => (p.cab ? p.cab + " " : "") + p.name;
const sameSize = (a, b) => a.t === b.t && ((a.l === b.l && a.w === b.w) || (a.l === b.w && a.w === b.l));
const pattern = r => r.edges.map(e => e.v);

/* ---------- Export ---------- */
export function exportRows(parts, ctx) {
  const rows = [];
  for (const p of parts) {
    const r = resolve(p, ctx);
    if (r.skip) continue;
    const e = r.edges.map(x => (x.v && x.v !== "0" ? parseFloat(x.v) : ""));
    rows.push([r.code, p.t, p.l, p.w, p.qty, description(p).text, ...e, e.some(v => v !== "") ? "RD" : "", ""]);
  }
  // merge identical rows
  const m = new Map();
  for (const row of rows) {
    const k = [...row.slice(0, 4), ...row.slice(5)].join("|");
    if (m.has(k)) m.get(k)[4] += row[4]; else m.set(k, [...row]);
  }
  return [...m.values()];
}
