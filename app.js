import { readParts, matKey, suggestMaterial, suggestTape, resolve, checks, exportRows, description, roundedCount, TAPES, EDGE_NAMES, XLSX_HEADERS } from "./core.js";

const MAPS_KEY = "cwc-maps-v2";
const CAT_KEY = "cwc-catalogue-v1";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- state ---------- */
let catalogue = [], catByCode = new Map();
let parts = [], jobName = "";
let maps = store.get(MAPS_KEY, { mat: {}, edge: {} });
let job = { over: {}, ignored: [] };
const selected = new Set();
let lastIssues = [];

const ctx = () => ({ maps, job, catByCode });
const saveMaps = () => store.set(MAPS_KEY, maps);
const saveJob = () => jobName && store.set("cwc-job:" + jobName, job);

/* ---------- catalogue ---------- */
function setCatalogue(list, fetchedAt, stale) {
  catalogue = list;
  catByCode = new Map(list.map(d => [d.code.toUpperCase(), d]));
  $("catList").innerHTML = list.map(d => `<option value="${esc(d.code)} — ${esc(d.name)} (${esc(d.brand)}, ${esc(d.core)})">`).join("");
  const when = fetchedAt ? new Date(fetchedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  $("catStatus").textContent = `CWorkshop catalogue: ${list.length} boards${when ? ", updated " + when : ""}${stale ? " (saved copy: couldn't reach CWorkshop just now)" : ""}.`;
  if (parts.length) { autoMatch(); render(); }
}
async function loadCatalogue() {
  const cached = store.get(CAT_KEY, null);
  if (cached?.decors?.length) setCatalogue(cached.decors, cached.fetchedAt, false);
  try {
    const r = await fetch("/api/decors");
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (!data.decors?.length) throw new Error("empty");
    store.set(CAT_KEY, data);
    setCatalogue(data.decors, data.fetchedAt, false);
  } catch {
    if (cached?.decors?.length) setCatalogue(cached.decors, cached.fetchedAt, true);
    else $("catStatus").textContent = "Couldn't load the CWorkshop catalogue. You can still type board codes by hand.";
  }
}

/* ---------- loading a CSV ---------- */
function loadText(text, fileName) {
  try {
    parts = readParts(text);
  } catch (err) { toast(err.message); return; }
  jobName = parts.find(p => p.model)?.model || fileName.replace(/\.csv$/i, "").replace(/-CutlistPlus$/i, "");
  job = store.get("cwc-job:" + jobName, { over: {}, ignored: [] });
  selected.clear();
  autoMatch();
  $("job").textContent = jobName;
  $("empty").hidden = true; $("work").hidden = false;
  render();
  window.scrollTo({ top: 0 });
}
function loadFile(f) {
  if (!f) return;
  const r = new FileReader();
  r.onload = () => loadText(r.result, f.name);
  r.onerror = () => toast("Couldn't read that file.");
  r.readAsText(f);
}
function autoMatch() {
  for (const p of parts) {
    const k = matKey(p);
    if (maps.mat[k]?.code || maps.mat[k]?.skip) continue;
    const s = catalogue.length ? suggestMaterial(p.mat, catalogue) : null;
    maps.mat[k] = { code: s ? s.code : "", auto: !!s, skip: false };
  }
  saveMaps();
}

/* ---------- rendering ---------- */
function render() {
  if (!parts.length) return;
  lastIssues = checks(parts, ctx()).filter(i => !job.ignored.includes(i.id));
  renderMaterials(); renderEdges(); renderChecks(); renderParts(); renderSummary(); renderBulk();
}

function renderMaterials() {
  const mats = new Map();
  for (const p of parts) { const k = matKey(p); const m = mats.get(k) || { name: p.mat, t: p.t, n: 0 }; m.n += p.qty; mats.set(k, m); }
  let missing = 0;
  $("matBody").innerHTML = [...mats].map(([k, m], i) => {
    const mm = maps.mat[k] || {};
    const d = catByCode.get((mm.code || "").toUpperCase());
    if (!mm.skip && !mm.code) missing++;
    const status = mm.skip ? `<span class="sub">Not ordering from CWorkshop</span>`
      : !mm.code ? `<span class="pill bad">Choose a board</span>`
      : d ? `<span class="sub">${esc(d.name)} · ${esc(d.brand)} · ${esc(d.core)}${mm.auto ? ' · <span class="pill muted">matched automatically</span>' : ""}</span>`
      : `<span class="pill warn">Not in the CWorkshop catalogue. Check the code.</span>`;
    return `<tr class="${mm.skip ? "off" : ""}">
      <td><input type="checkbox" id="mo${i}" class="mOrder" data-k="${esc(k)}" ${mm.skip ? "" : "checked"} aria-label="Order ${esc(m.name)}"></td>
      <td>${esc(m.name || "(no material)")}</td><td class="num">${m.t}</td><td class="num">${m.n}</td>
      <td><div class="matcell"><input type="text" id="mc${i}" class="mCode ${!mm.skip && !mm.code ? "missing" : ""}" data-k="${esc(k)}" list="catList" value="${esc(mm.code || "")}" placeholder="Search code or name" ${mm.skip ? "disabled" : ""} aria-label="CWorkshop board for ${esc(m.name)}">${status}</div></td>
    </tr>`;
  }).join("");
  $("matHint").textContent = missing ? `${missing} to choose` : "All matched";
}

function renderEdges() {
  const combos = new Map();
  for (const p of parts) {
    const r = resolve(p, ctx()); if (r.skip || !r.code) continue;
    p.letters.forEach(l => { if (!l) return; const k = r.code + "|" + l; const c = combos.get(k) || { code: r.code, letter: l, n: 0, decor: r.decor }; c.n += p.qty; combos.set(k, c); });
  }
  if (!combos.size) { $("edgeBody").innerHTML = `<tr><td colspan="4" class="hint">Edges appear here once boards are matched.</td></tr>`; return; }
  $("edgeBody").innerHTML = [...combos.values()].sort((a, b) => a.code.localeCompare(b.code) || a.letter.localeCompare(b.letter)).map((c, i) => {
    const k = c.code + "|" + c.letter;
    const rule = maps.edge[k];
    const sugg = suggestTape(c.decor, c.letter);
    const val = rule ?? sugg ?? "";
    return `<tr><td><span class="mono">${esc(c.code)}</span> <span class="sub">${esc(c.decor?.name || "")}</span></td>
      <td class="mono"><strong>${esc(c.letter)}</strong>${c.letter === "X" ? ' <span class="sub">scribe</span>' : ""}</td>
      <td class="num">${c.n}</td>
      <td><select id="er${i}" class="eRule ${val === "" ? "missing" : ""}" data-k="${esc(k)}">
        ${val === "" ? '<option value="" selected>Choose tape</option>' : ""}
        ${TAPES.map(t => `<option value="${t.v}" ${val === t.v ? "selected" : ""}>${t.label}</option>`).join("")}
      </select> ${rule == null && sugg != null ? '<span class="pill muted">suggested</span>' : ""}</td></tr>`;
  }).join("");
}

function renderChecks() {
  const ignoredCount = job.ignored.length;
  if (!lastIssues.length) {
    $("issues").innerHTML = `<li class="ok"><span class="txt">No problems found.</span></li>`;
  } else {
    $("issues").innerHTML = lastIssues.map(i => `<li class="${i.level}"><span class="txt">${esc(i.text)}${i.detail ? ` <span class="sub">${esc(i.detail)}</span>` : ""}</span>
      ${i.parts?.length ? `<button class="btn small" data-show="${esc(i.parts.join(","))}" type="button">Show</button>` : ""}
      ${i.canMarkNone ? `<button class="btn small" data-none="${esc(i.parts[0])}" type="button">No banding is right</button>` : ""}
      ${i.level !== "bad" ? `<button class="btn small ghost" data-ignore="${esc(i.id)}" type="button">Ignore</button>` : ""}</li>`).join("");
  }
  const bad = lastIssues.filter(i => i.level === "bad").length, warn = lastIssues.filter(i => i.level === "warn").length;
  $("checkHint").innerHTML = `${bad ? `${bad} to fix before download` : "Nothing blocking download"}${warn ? ` · ${warn} to check` : ""}${ignoredCount ? ` · ${ignoredCount} ignored <button class="btn small ghost" id="unignore" type="button">Show again</button>` : ""}`;
}

function renderParts() {
  const issueByPart = new Map();
  for (const i of lastIssues) for (const id of i.parts || []) { const a = issueByPart.get(id) || []; a.push(i); issueByPart.set(id, a); }
  const groups = new Map();
  for (const p of parts) { const g = p.cab || "Individual parts"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  const order = [...groups.keys()].sort((a, b) => (a === "Individual parts") - (b === "Individual parts") || a.localeCompare(b, undefined, { numeric: true }));
  let html = "";
  for (const g of order) {
    const ps = groups.get(g);
    const allSel = ps.every(p => selected.has(p.id));
    html += `<tr class="group"><td class="chk"><input type="checkbox" class="gSel" data-g="${esc(g)}" ${allSel ? "checked" : ""} aria-label="Select ${esc(g)}"></td><td colspan="11">${esc(g)}<span class="sub">${ps.length} part${ps.length > 1 ? "s" : ""}</span></td></tr>`;
    for (const p of ps) {
      const r = resolve(p, ctx());
      const iss = issueByPart.get(p.id) || [];
      const ov = job.over[p.id] || {};
      html += `<tr class="part ${selected.has(p.id) ? "sel" : ""} ${r.skip ? "skip" : ""}" id="row-${p.id}">
        <td class="chk"><input type="checkbox" class="pSel" data-id="${p.id}" ${selected.has(p.id) ? "checked" : ""} aria-label="Select ${esc(p.name)}"></td>
        <td>${esc(p.name)}${description(p).cut ? ' <span class="pill muted" title="Description will be cut to 30 characters">30+</span>' : ""}</td>
        <td><span class="mono">${esc(r.skip ? "not ordered" : r.code || "—")}</span>${ov.code ? ' <span class="pill muted">changed</span>' : ""}</td>
        <td class="num">${p.t}</td><td class="num">${p.l}${p.grain ? '<span class="grain" title="Grain direction matters">↕</span>' : ""}</td><td class="num">${p.w}</td><td class="num">${p.qty}</td>
        ${r.edges.map((e, i) => {
          const cls = e.src === "missing" ? "missing" : e.src === "edit" ? "edit" : e.src === "suggest" ? "suggest" : e.src === "rule" ? "rule" : "";
          const v = e.v == null ? "?" : e.v === "0" ? "–" : e.v;
          return `<td class="edge"><button type="button" class="ecell ${cls} ${e.v === "0" ? "none" : ""}" data-id="${p.id}" data-i="${i}" title="${EDGE_NAMES[i]}${e.letter ? " · CabinetSense " + e.letter : ""}">${v}${e.letter ? `<sup>${esc(e.letter)}</sup>` : ""}</button></td>`;
        }).join("")}
        <td><div class="flags">${ov.none ? '<span class="pill ok">no banding OK</span>' : ""}${iss.map(i => `<span class="pill ${i.level}" title="${esc(i.text)}">${i.level === "bad" ? "fix" : i.level === "warn" ? "check" : "note"}</span>`).join("")}</div></td>
      </tr>`;
    }
  }
  $("partBody").innerHTML = html;
  $("selAll").checked = parts.length > 0 && parts.every(p => selected.has(p.id));
}

function renderSummary() {
  const rows = exportRows(parts, ctx());
  const bad = lastIssues.filter(i => i.level === "bad").length, warn = lastIssues.filter(i => i.level === "warn").length;
  const rounded = roundedCount(parts);
  $("summary").innerHTML = `<span class="pill ok">${parts.length} parts → ${rows.length} rows for CWorkshop</span>`
    + (bad ? `<span class="pill bad">${bad} to fix</span>` : `<span class="pill ok">Ready to download</span>`)
    + (warn ? `<span class="pill warn">${warn} to check</span>` : "")
    + (rounded ? `<span class="pill muted">${rounded} dimension${rounded > 1 ? "s" : ""} rounded to whole mm</span>` : "");
  $("dlBtn").disabled = bad > 0 || !rows.length;
  $("dlBtn").title = bad ? "Fix the red items in Checks first" : "";
}

function renderBulk() {
  $("bulk").hidden = selected.size === 0;
  $("bulkCount").textContent = `${selected.size} part${selected.size === 1 ? "" : "s"} selected`;
}

/* ---------- actions ---------- */
function setOver(id, fn) { const o = job.over[id] || {}; fn(o); if (!o.code && !o.edges && !o.none) delete job.over[id]; else job.over[id] = o; }

function cycleEdge(id, i) {
  const p = parts.find(x => x.id === id); const r = resolve(p, ctx());
  const order = TAPES.map(t => t.v);
  const next = order[(order.indexOf(r.edges[i].v) + 1) % order.length];
  setOver(id, o => { o.edges = o.edges || [null, null, null, null]; o.edges[i] = next; });
  saveJob(); render();
}

function codeFromInput(v) { return v.split(" — ")[0].trim().toUpperCase(); }

document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-show]");
  if (!t) return;
  if (t.classList.contains("ecell")) cycleEdge(t.dataset.id, +t.dataset.i);
  else if (t.dataset.show) showParts(t.dataset.show.split(","));
  else if (t.dataset.none) { setOver(t.dataset.none, o => { o.none = true; }); saveJob(); render(); }
  else if (t.dataset.ignore) { job.ignored.push(t.dataset.ignore); saveJob(); render(); }
  else if (t.id === "unignore") { job.ignored = []; saveJob(); render(); }
});

document.addEventListener("change", e => {
  const t = e.target;
  if (t.classList.contains("mOrder")) { maps.mat[t.dataset.k] = { ...(maps.mat[t.dataset.k] || {}), skip: !t.checked }; saveMaps(); render(); }
  else if (t.classList.contains("mCode")) { maps.mat[t.dataset.k] = { ...(maps.mat[t.dataset.k] || {}), code: codeFromInput(t.value), auto: false }; saveMaps(); render(); }
  else if (t.classList.contains("eRule")) { if (t.value === "") delete maps.edge[t.dataset.k]; else maps.edge[t.dataset.k] = t.value; saveMaps(); render(); }
  else if (t.classList.contains("pSel")) { t.checked ? selected.add(t.dataset.id) : selected.delete(t.dataset.id); render(); }
  else if (t.classList.contains("gSel")) { const g = t.dataset.g; parts.filter(p => (p.cab || "Individual parts") === g).forEach(p => t.checked ? selected.add(p.id) : selected.delete(p.id)); render(); }
  else if (t.id === "selAll") { parts.forEach(p => t.checked ? selected.add(p.id) : selected.delete(p.id)); render(); }
  else if (t.id === "file") { loadFile(t.files[0]); t.value = ""; }
});

$("bkTape").innerHTML = TAPES.map(t => `<option value="${t.v}" ${t.v === "1" ? "selected" : ""}>${t.label}</option>`).join("");
$("bkSetEdges").onclick = () => {
  const which = ["bkL1", "bkL2", "bkW1", "bkW2"].map(id => $(id).checked);
  if (!which.some(Boolean)) { toast("Tick at least one edge."); return; }
  const v = $("bkTape").value;
  selected.forEach(id => setOver(id, o => { o.edges = o.edges || [null, null, null, null]; which.forEach((w, i) => { if (w) o.edges[i] = v; }); }));
  saveJob(); render(); toast(`Edges set on ${selected.size} part${selected.size > 1 ? "s" : ""}.`);
};
$("bkSetBoard").onclick = () => {
  const code = codeFromInput($("bkBoard").value);
  if (!code) { toast("Choose a board first."); return; }
  if (catalogue.length && !catByCode.has(code)) toast(`${code} isn't in the CWorkshop catalogue. Set anyway.`);
  selected.forEach(id => setOver(id, o => { o.code = code; }));
  saveJob(); render();
};
$("bkNone").onclick = () => { selected.forEach(id => setOver(id, o => { o.none = true; })); saveJob(); render(); };
$("bkReset").onclick = () => { selected.forEach(id => delete job.over[id]); saveJob(); render(); toast("Selected parts reset to the CSV."); };
$("bkClear").onclick = () => { selected.clear(); render(); };

function showParts(ids) {
  const row = $("row-" + ids[0]); if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  ids.forEach(id => { const r = $("row-" + id); if (r) { r.classList.add("hl"); setTimeout(() => r.classList.remove("hl"), 2200); } });
}

/* ---------- export ---------- */
$("dlBtn").onclick = () => {
  if (typeof XLSX === "undefined") { toast("The spreadsheet library didn't load. Check your connection and try again."); return; }
  const rows = exportRows(parts, ctx());
  const ws = XLSX.utils.aoa_to_sheet([XLSX_HEADERS, ...rows]);
  ws["!cols"] = [14, 10, 9, 9, 9, 32, 6, 6, 6, 6, 11, 30].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Cutting list");
  const name = (jobName.replace(/[^A-Za-z0-9 \-+.&]/g, " ").replace(/\s+/g, " ").trim() || "Cutting list") + " - CWorkshop.xlsx";
  XLSX.writeFile(wb, name);
  toast(`Downloaded ${name}`);
};

/* ---------- drag & drop ---------- */
let dragDepth = 0;
window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging"); loadFile(e.dataTransfer.files[0]); });

let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 3500); }

loadCatalogue();
// expose for testing
window.__cwc = { loadText, setCatalogue, get parts() { return parts; }, rows: () => exportRows(parts, ctx()) };
