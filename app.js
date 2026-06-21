/* WC·26 companion — vanilla JS, no build step */
(() => {
"use strict";

/* ---------------- state ---------------- */
const S = {
  matches: [], teams: {}, results: { matches: {} }, details: { matches: {} }, matchData: {},
  reports: { matches: {} }, commentary: {}, buzz: null, efi: {}, wc22: null,   // reports.json, lazy commentary, buzz.json, efi.json (FIFA EFI), wc2022.json (last World Cup)
  tz: localStorage.getItem("wc26.tz") || "auto",
  fav: localStorage.getItem("wc26.fav") || null,
  view: null,   // set by boot's nav() — null until then so the pre-first-paint refreshResults() doesn't double-render
  filters: { stage: "all", team: "", saved: false },
  saved: new Set(JSON.parse(localStorage.getItem("wc26.saved") || "[]")),
  simBox: null, sim: null, simView: "dash",   // simBox = the 3 saved brackets; sim points at the active one; simView = dash|edit
  _lastResults: null, _lastDetails: null, lastChecked: null,
};
const SIM_SLOTS = 3;
const SIM_SLOT_NAMES = ["Scenario A", "Scenario B", "Scenario C"];
const SIM_OLD_NAMES = ["Bracket A", "Bracket B", "Bracket C"];   // migrate the previous default names so existing users see "Scenario"
// the three saved scenarios, with one-time migration from the legacy single-bracket key (wc26.sim).
function loadSimBox() {
  const blank = i => ({ name: SIM_SLOT_NAMES[i] || ("Scenario " + (i + 1)), order: {}, thirds: [], ko: {} });
  const clean = (s, i) => ({
    name: typeof s?.name === "string" && s.name.trim() && SIM_OLD_NAMES.indexOf(s.name.trim()) < 0 ? s.name.slice(0, 24) : (SIM_SLOT_NAMES[i] || "Scenario " + (i + 1)),
    order: s?.order && typeof s.order === "object" ? s.order : {},
    thirds: Array.isArray(s?.thirds) ? s.thirds : [],
    ko: s?.ko && typeof s.ko === "object" ? s.ko : {},
  });
  const pad = box => {
    const slots = (box.slots || []).slice(0, SIM_SLOTS).map(clean);
    while (slots.length < SIM_SLOTS) slots.push(blank(slots.length));
    return { v: 2, active: Math.max(0, Math.min(SIM_SLOTS - 1, box.active | 0)), slots };
  };
  try { const raw = JSON.parse(localStorage.getItem("wc26.predict") || "null"); if (raw && Array.isArray(raw.slots) && raw.slots.length) return pad(raw); } catch { /* corrupt → migrate/fresh */ }
  let legacy = null; try { legacy = JSON.parse(localStorage.getItem("wc26.sim") || "null"); } catch { /* */ }
  const first = legacy && typeof legacy === "object" ? clean({ ...legacy, name: SIM_SLOT_NAMES[0] }, 0) : blank(0);
  return pad({ v: 2, active: 0, slots: [first] });
}
S.simBox = loadSimBox();
S.sim = S.simBox.slots[S.simBox.active];
function setActiveSlot(i) {
  if (i < 0 || i >= S.simBox.slots.length) return;
  S.simBox.active = i; S.sim = S.simBox.slots[i]; saveSim();
}
// a committed match report (reports.json), keyed by openfootball match number; null until the Action writes one
const report = m => (S.reports.matches || {})[m.num] || null;
const isSaved = id => S.saved.has(id);
function toggleSave(id) {
  S.saved.has(id) ? S.saved.delete(id) : S.saved.add(id);
  localStorage.setItem("wc26.saved", JSON.stringify([...S.saved]));
  RENDER[S.view]();
  const md = document.getElementById("matchDialog");
  if (md && md.open && md.dataset.openMid === id) {
    const b = md.querySelector(".md-save"), on = S.saved.has(id);
    if (b) { b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on); b.textContent = on ? "★" : "☆"; b.title = on ? "Remove from saved" : "Save match"; b.setAttribute("aria-label", on ? "Remove from saved" : "Save match"); }
  }
}
const AUTO_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const tz = () => (S.tz === "auto" ? AUTO_TZ : S.tz);
const GROUPS = "ABCDEFGHIJKL".split("");
const BUILD = "329";  // shown in footer; bump with the ?v= asset version

const ZONES = [
  ["auto", "Auto (device)"],
  ["Asia/Dubai", "Dubai, UAE"], ["Asia/Riyadh", "Riyadh, Saudi Arabia"], ["Asia/Karachi", "Karachi, Pakistan"],
  ["Asia/Kolkata", "Mumbai, India"], ["Asia/Singapore", "Singapore"], ["Asia/Tokyo", "Tokyo, Japan"],
  ["Australia/Sydney", "Sydney, Australia"], ["Europe/London", "London, UK"], ["Europe/Paris", "Paris, France"],
  ["Europe/Istanbul", "Istanbul, Türkiye"], ["Africa/Cairo", "Cairo, Egypt"], ["Africa/Lagos", "Lagos, Nigeria"],
  ["Africa/Johannesburg", "Johannesburg, South Africa"], ["America/Sao_Paulo", "São Paulo, Brazil"],
  ["America/New_York", "New York, USA"], ["America/Toronto", "Toronto, Canada"], ["America/Chicago", "Chicago, USA"],
  ["America/Denver", "Denver, USA"], ["America/Mexico_City", "Mexico City, Mexico"],
  ["America/Los_Angeles", "Los Angeles, USA"], ["America/Vancouver", "Vancouver, Canada"],
];

/* ---------------- utils ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
// open a <dialog> modally — closing first if it's already open (re-entering the same sheet from a
// stacked context would otherwise throw InvalidStateError on Safari/Firefox, or silently update the
// hidden dialog underneath on Chromium). Brings the sheet to the front with its fresh content.
let _sheetOpenAt = 0;
// Modal sheet stack: opening a sheet while another is open pushes it on top instead of swapping.
// The X button / back pops the topmost sheet, revealing the one below.
// Clicking outside the topmost sheet (its backdrop) collapses everything.
let _sheetStack = [];
const _closeAll = () => [..._sheetStack].reverse().forEach(s => s.close());
const showSheet = d => {
  if (!d) return;
  // If already open, close silently (bypass our patched close) and remove from stack so the showModal patch re-adds it at the top
  if (d.open) { _origClose.call(d); _sheetStack = _sheetStack.filter(s => s !== d); }
  d.showModal();  // patched below: marks existing sheets as behind, pushes d to top
  d.querySelectorAll(".sheet-body").forEach(b => b.scrollTop = 0);
  _sheetOpenAt = Date.now();
};
// Modal history: make the hardware/gesture Back button DISMISS the open sheet instead of backgrounding/exiting the
// installed PWA (phones have no Esc, so Back is the instinctive dismiss). One history entry covers the whole modal
// session (sheets swap, not stack); it is popped when the last sheet closes. Routing uses hashchange, not popstate,
// so the two never collide. Patched on the prototype so every dialog (sheets, settings, search, picker) is covered.
let _inModal = false, _popClosing = false;
// Briefly kill card transitions on the dismiss frame: when a centred sheet closes, the cursor can land back on the
// card it opened from and :hover re-fires — without this its lift would animate in, reading as a flicker.
let _flickT = 0;
const _flickGuard = () => { const h = document.documentElement; h.classList.add("sheet-dismiss"); clearTimeout(_flickT); _flickT = setTimeout(() => h.classList.remove("sheet-dismiss"), 240); };
addEventListener("popstate", () => {
  if (!_inModal) return;
  _inModal = false; _popClosing = true; _sheetStack = [];
  document.querySelectorAll("dialog[open]").forEach(d => { d.classList.remove("is-stack-behind"); d.close(); });
  _popClosing = false; _flickGuard();
});
const _dlgProto = HTMLDialogElement.prototype, _origShowModal = _dlgProto.showModal, _origClose = _dlgProto.close;
_dlgProto.showModal = function () {
  if (this.classList.contains("sheet")) {
    // mark everything currently in the stack as behind (their backdrops will be hidden)
    _sheetStack.forEach(s => s.classList.add("is-stack-behind"));
    _sheetStack.push(this);
    this.classList.remove("is-stack-behind");
  }
  _origShowModal.call(this);
  if (!_inModal) { _inModal = true; history.pushState({ modal: 1 }, ""); }
};
_dlgProto.close = function (v) {
  _origClose.call(this, v);
  if (this.classList.contains("sheet")) {
    _sheetStack = _sheetStack.filter(s => s !== this);
    if (_sheetStack.length > 0) _sheetStack[_sheetStack.length - 1].classList.remove("is-stack-behind");
  }
  if (_popClosing || !_inModal) return;
  queueMicrotask(() => { if (_inModal && !document.querySelector("dialog[open]")) { _inModal = false; _flickGuard(); if (history.state && history.state.modal) history.back(); } });
};
// A collapsible section the USER opens off-screen feels like nothing happened — scroll it into view. But a
// <details open> fires `toggle` on initial render in current Chromium, which would yank a freshly-opened sheet
// down to it (e.g. the live-commentary fold). Suppress the scroll briefly after a sheet opens so only genuine taps move it.
document.addEventListener("toggle", e => {
  const d = e.target;
  if (d.tagName === "DETAILS" && d.open && d.closest(".sheet-body") && Date.now() - _sheetOpenAt > 500)
    requestAnimationFrame(() => d.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}, true);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// ---------- flicker-free view updates ----------
// Replacing a view's innerHTML on every poll tears down and rebuilds every node, so flags/photos re-decode and the
// layout jumps — on a live match that's a visible flash every minute, and it would wipe a focused filter input or a
// section the user just expanded. paint() instead diffs the new HTML against what's on screen and mutates only what
// actually changed. Fast-path: byte-identical HTML → do nothing. It deliberately never touches the `open` attribute
// (so an expanded <details> stays open) nor anything under a [data-keep] node (so loaded commentary survives). Safe
// because every view interaction is delegated to one document-level listener — morphing nodes never drops a handler.
// Each top-level view gets a stable, visually-hidden <h2> so the heading outline reads h1 (page) -> h2 (section)
// instead of jumping straight to the cards' h4. Injected here (every render funnels through paint with its view el)
// so it survives poll re-renders too. Keyed by section id; non-view paints (cards, popups) are untouched.
// groups/sim set el.innerHTML directly (not via paint), so they prepend viewH2() themselves.
const VIEW_H2 = { "view-matches": "Matches", "view-teams": "Teams", "view-players": "Players", "view-groups": "Tables", "view-sim": "Predict", "view-stats": "Statistics", "view-pulse": "News" };
const viewH2 = id => VIEW_H2[id] ? `<h2 class="vh">${VIEW_H2[id]}</h2>` : "";
function paint(el, html) {
  if (!el) return;
  html = viewH2(el.id) + html;            // view sections get a hidden h2; "" for everything else
  if (el.__sig === html) return;          // nothing changed since last paint → no work, no repaint
  el.__sig = html;
  const tpl = document.createElement("template"); tpl.innerHTML = html;
  morphKids(el, tpl.content);
}
function morphKids(from, to) {
  let f = from.firstChild, t = to.firstChild;
  while (t) {
    const tNext = t.nextSibling;
    if (!f) { from.appendChild(document.importNode(t, true)); t = tNext; continue; }
    const fNext = f.nextSibling;
    if (f.nodeType !== t.nodeType || (f.nodeType === 1 && f.nodeName !== t.nodeName)) {
      from.replaceChild(document.importNode(t, true), f);              // shape diverged → swap this node wholesale
    } else if (f.nodeType === 3 || f.nodeType === 8) {                 // text / comment
      if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue;
    } else if (f.nodeType === 1 && !f.hasAttribute("data-keep")) {     // element (skip keep-subtrees entirely)
      morphAttrs(f, t);
      morphKids(f, t);
    }
    f = fNext; t = tNext;
  }
  while (f) { const fNext = f.nextSibling; from.removeChild(f); f = fNext; }   // drop any trailing leftovers
}
function morphAttrs(f, t) {
  for (let i = f.attributes.length - 1; i >= 0; i--) { const n = f.attributes[i].name; if (n !== "open" && !t.hasAttribute(n)) f.removeAttribute(n); }
  for (let i = 0; i < t.attributes.length; i++) { const a = t.attributes[i]; if (a.name !== "open" && f.getAttribute(a.name) !== a.value) f.setAttribute(a.name, a.value); }
}
// Standard competition ranking ("1224"): rows showing the same value share a rank, the next distinct value skips ahead
// by the size of the tie group. keyOf returns the value to compare (use the DISPLAYED value so equal-looking rows tie).
const compRanks = (rows, keyOf) => { const r = []; for (let i = 0; i < rows.length; i++) r[i] = (i && keyOf(rows[i]) === keyOf(rows[i - 1])) ? r[i - 1] : i + 1; return r; };
// Player names arrive mixed: the FIFA feed UPPERCASEs the surname ("Julian QUINONES", "MOKOENA", "J. GALLARDO")
// and often drops the accent ("QUIÑONES" → "QUINONES"); squads.json carries the proper accented Title-Case form.
// pName() Title-Cases the feed name and RESTORES ACCENTS from a per-team accent dictionary (built from squads.json),
// word by word. It deliberately does NOT swap in a different name, so a player known by a short form ("RODRI",
// "Havertz") keeps it and a same-surname team-mate can't hijack it. DISPLAY ONLY — data-player keys keep the raw
// feed name so the openPlayer/photo joins still resolve. Cached; squads load before any render.
// The feed sometimes glues an initial to the surname with no space ("E.ASHOUR", "J.GALLARDO"); split it so the
// surname title-cases properly ("E. Ashour", not "E.ashour"). Then title-case every all-caps token.
const _splitInitials = s => (s || "").replace(/([A-ZÀ-Ý])\.(?=[A-ZÀ-Ý])/g, "$1. ");
const _titleCase = s => _splitInitials(s).replace(/\S+/g, w => /^[A-ZÀ-Ý][A-ZÀ-Ý.'’-]*$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w);
const _deburr = w => (w || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const _accentCache = new Map();   // team code → { deburred word: its accented spelling } (only words that carry an accent)
const _accentDict = code => {
  let d = _accentCache.get(code); if (d) return d;
  d = {};
  for (const p of (S.squads?.[code]?.players || [])) for (const w of (p.name || "").split(/\s+/)) {
    const k = _deburr(w); if (k && k !== w.toLowerCase() && !(k in d)) d[k] = w;   // this word carries an accent → remember it
  }
  _accentCache.set(code, d); return d;
};
const _nameCache = new Map();
const pName = (s, code) => {
  const key = (s || "") + "|" + (code || "");
  const hit = _nameCache.get(key); if (hit !== undefined) return hit;
  const p = code ? resolvePlayer(s, code) : null;
  // resolved to a real squad player → use their exact, full, accented name; otherwise format the feed name as best
  // we can (title-case + restore accents the feed dropped). resolvePlayer expands surnames ("Havertz" -> Kai Havertz)
  // and initials ("E. Ashour" -> Emam Ashour) but only when it can identify the player with certainty.
  let out;
  if (p) out = p.name;
  else { const dict = code ? _accentDict(code) : null; out = _titleCase(s).replace(/\S+/g, w => (dict && dict[_deburr(w)]) || w); }
  _nameCache.set(key, out);
  return out;
};
// the dense match timeline uses just the surname (football convention) — drop a Jr/Filho-style suffix first.
const tlName = (s, code) => { const t = pName(s, code).trim().split(/\s+/).filter(w => !/^(jr|jnr|junior|filho|neto|ii|iii)\.?$/i.test(_deburr(w))); return t[t.length - 1] || _titleCase(s); };

// real SVG flags (self-hosted) — emoji regional-indicator flags don't render on Windows, where the
// whole flag-heavy UI would degrade to "BR"/"US" letter boxes. alt falls back to the code if a file 404s.
function flag(code) {
  if (!code) return "";
  return `<img class="flagimg" src="assets/flags/${code}.svg" alt="${esc(S.teams?.[code]?.name || "")}" loading="lazy" decoding="async">`;
}
const TBD_FLAG = '<span class="flag-tbd" aria-hidden="true"></span>';   // placeholder flag for a fixture whose team isn't decided yet
// consistent inline-SVG content icons (replacing eclectic emoji in stat/record headings). The thematic
// ⚽ / ${TROPHY} / ★ are kept as-is. Stroke style matches the UI's SVG chrome.
const _ico = p => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  spark: _ico('<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/>'),
  net: _ico('<rect x="3" y="7" width="18" height="11" rx="1"/><path d="M3 11h18M3 14.5h18M8 7v11M13 7v11M18 7v11"/>'),
  bolt: _ico('<path d="M13 2 5 13.5h6l-1 8.5 9-12.5h-6z"/>'),
  clock: _ico('<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/>'),
  glove: _ico('<path d="M8.5 13V8a1.5 1.5 0 0 1 3 0M11.5 12V6a1.5 1.5 0 0 1 3 0v6M14.5 11.5V8a1.5 1.5 0 0 1 3 0v6a6 6 0 0 1-6 6 5 5 0 0 1-5-5l-1-2.6a1.5 1.5 0 0 1 2.6-1.4l.9 1.5"/>'),
  shield: _ico('<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>'),
  ball: _ico('<circle cx="12" cy="12" r="9"/><path d="M12 9l2.85 2.07-1.09 3.36h-3.52L9.15 11.07z"/><path d="M12 9V4.5M14.85 11.07l3.7-1.3M13.76 14.43l1.8 3.1M10.24 14.43l-1.8 3.1M9.15 11.07l-3.7-1.3"/>'),
  trophy: _ico('<path d="M7 4h10v4.5a5 5 0 0 1-10 0z"/><path d="M7 6.3H4.6A2.2 2.2 0 0 0 7 8.6M17 6.3h2.4A2.2 2.2 0 0 1 17 8.6M12 13.5v2.8M9.5 19.5h5M10 16.3h4"/>'),
  people: _ico('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0M16 6a3 3 0 0 1 0 6M17.2 13.6a5.5 5.5 0 0 1 3.3 5.9"/>'),
  link: _ico('<path d="M10.6 13.4a3.4 3.4 0 0 0 4.8 0l2.4-2.4a3.4 3.4 0 0 0-4.8-4.8l-1.2 1.2M13.4 10.6a3.4 3.4 0 0 0-4.8 0L6.2 13a3.4 3.4 0 0 0 4.8 4.8l1.2-1.2"/>'),
  camera: _ico('<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.3"/><path d="M8.5 7l1.2-2.2h4.6L15.5 7"/>'),
  tap: _ico('<path d="M9 11.2V6a1.5 1.5 0 0 1 3 0v4M12 10V8a1.5 1.5 0 0 1 3 0v2.5M15 10.5v-1a1.5 1.5 0 0 1 3 0V15a5 5 0 0 1-5 5h-.7a4 4 0 0 1-2.9-1.2L7 16a1.45 1.45 0 0 1 2.1-2l.9.9"/>'),
  subs: _ico('<path d="M4 9h12M13 6l3 3-3 3M20 15H8M11 12l-3 3 3 3"/>'),       // two opposing arrows — substitution
  compare: _ico('<path d="M4 20h16M7.5 20v-6M12 20V5M16.5 20v-9"/>'),         // bars — compare two players
  calendar: _ico('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>'),   // tournament editions (World Cups played)
  shirt: _ico('<path d="M8 4 4 6.5 6 10.5 8 9.5 8 20 16 20 16 9.5 18 10.5 20 6.5 16 4A6 6 0 0 1 8 4Z"/>'),       // jersey — appearances / caps
};
const TROPHY = `<span class="ico-gold">${ICO.trophy}</span>`;   // gold-tinted trophy (replaces the old emoji)
// Building an Intl.DateTimeFormat is the costly part; reuse one formatter per (locale, zone, options) shape instead of
// constructing a fresh object on every fmt()/timeStr() call in the paint loop. Keyed by tz() so a timezone change is a miss.
const _dtfCache = new Map();
const _dtf = (locale, opts) => {
  const z = tz(), k = locale + "|" + z + "|" + JSON.stringify(opts || {});
  let f = _dtfCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat(locale, { timeZone: z, ...opts }); _dtfCache.set(k, f); }
  return f;
};
const fmt = (iso, opts) => _dtf("en", opts).format(new Date(iso));
const timeStr = iso => fmt(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
// The matches LIST groups by the real, technical calendar date in the visitor's timezone — Sunday's matches under
// "Sunday", a 2am-Monday kickoff under "Monday". Straightforward and correct.
const dayKey = iso => fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
const dayLabel = iso => fmt(iso, { weekday: "long", day: "numeric", month: "long" });
// The "viewing day" is slate-aware — it rolls over at ~10am LOCAL, not midnight — so the TICKER and MATCH OF THE DAY
// treat a night's football as one block even when it runs past midnight (for Dubai the WC slate is 8pm–8am, India
// 9pm–9am, with a long match-free gap through the local daytime where 10am sits). Only those two use it; the list
// above stays on the calendar date.
const DAY_ROLLOVER_H = 10;
// en-CA → "2026-06-14": a SORTABLE practical-day key (used for equality + ordering by the ticker window + match-of-day).
const viewDay = iso => _dtf("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.parse(iso) - DAY_ROLLOVER_H * 36e5));
// uniform offset label everywhere ("GMT+4", "GMT-5", "GMT+5:30") — not the mixed EST/IST/GMT+N that "short" gives
const tzShort = () => {
  try { return new Intl.DateTimeFormat("en", { timeZone: tz(), timeZoneName: "shortOffset" }).formatToParts(new Date()).find(p => p.type === "timeZoneName").value.replace(/^GMT$/, "GMT+0"); }
  catch { return tz(); }
};
const tzOffsetLabel = zone => {
  try {
    const p = new Intl.DateTimeFormat("en", { timeZone: zone === "auto" ? AUTO_TZ : zone, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return p.find(x => x.type === "timeZoneName").value.replace(/^GMT$/, "GMT+0");   // GMT everywhere (matches tzShort), incl. GMT+0 for London
  } catch { return ""; }
};
// numeric GMT offset in minutes (handles DST + half-hour zones) — used to order the picker west→east
const tzMinutes = zone => { try { const v = new Intl.DateTimeFormat("en", { timeZone: zone === "auto" ? AUTO_TZ : zone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find(p => p.type === "timeZoneName").value; const mm = v.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/); return mm ? (mm[1] === "-" ? -1 : 1) * (+mm[2] * 60 + (+mm[3] || 0)) : 0; } catch { return 0; } };
// friendly CITY name for the active zone — from the ZONES list if listed, else the IANA city. Always a city
// (never a country/region) so every place the timezone is shown reads the same way.
const tzCity = () => (ZONES.find(z => z[0] === tz())?.[1]) || tz().split("/").pop().replace(/_/g, " ");

/* ---------------- results / resolution ---------------- */
// scores (results.json, polled) + heavy detail (details.json, fetched on change) are merged into
// S.matchData so every renderer keeps reading one object per match via res().
const res = m => S.matchData[m.id] || null;
function rebuildMatchData() {
  const r = S.results.matches || {}, d = S.details.matches || {}, out = {};
  for (const id in d) out[id] = { ...d[id] };
  for (const id in r) out[id] = { ...(out[id] || {}), ...r[id] };   // fresh scores win over (possibly older) detail
  S.matchData = out;
  applyKickoffs();
}
// openfootball's static kickoff times can drift hours from the real FIFA slate; the scores Action persists the
// feed's true kickoff as `ko` (results.json) when it differs. Overlay it onto each match's `utc` so countdowns,
// day-grouping, sorting and the live hero all agree with reality — every renderer reads `m.utc`, so one overlay
// fixes them all. The original static time is kept in `_utc0` so the overlay is idempotent and reverts if `ko` clears.
function applyKickoffs() {
  if (!S.matches) return;
  const now = Date.now();
  for (const m of S.matches) {
    if (m._utc0 === undefined) m._utc0 = m.utc;
    const md = S.matchData[m.id];
    let ko = md?.ko;
    // Use the feed's corrected kickoff (`ko`) when it drifted from openfootball's static time; otherwise the
    // static time. We deliberately do NOT synthesize a kickoff from `now − feed_minute` for a live match — the
    // free feed's minute is unreliable and that estimate drifted the displayed kickoff (e.g. showing 03:51 for
    // a match that kicked off at 03:00). The authoritative `ko` lands within a poll or two and fixes any wrong
    // static time on its own.
    m.utc = ko || m._utc0;
  }
}
const ST = { SCHED: "SCHED", LIVE: "LIVE", HT: "HT", FT: "FT" };
function status(m) {
  const r = res(m);
  // The FIFA feed is authoritative for status — trust it. (We used to promote a "started by our clock but
  // still SCHED" match to LIVE to mask feed lag, but openfootball's static kickoff times don't always match
  // the real schedule, so that faked a live 0–0 on the wrong match. The feed says which game is actually live.)
  if (r?.st) {
    // A feed stuck on LIVE/HT long past any real match length is stale (the score loop lagged or stopped) — treat it
    // as finished so the hero stops showing it "live" and it drops into Earlier results. Group ≈ 90+HT+stoppage
    // (~125′); knockouts allow extra time + penalties (~160′).
    if ((r.st === ST.LIVE || r.st === ST.HT) && Date.now() - +new Date(m.utc) > (m.stage === "group" ? 125 : 160) * 60000) return ST.FT;
    return r.st;
  }
  // no feed row yet (only before the very first Action run): best-effort from the scheduled time
  return new Date(m.utc) <= new Date() && new Date() - new Date(m.utc) < 3 * 3600e3 ? ST.LIVE : ST.SCHED;
}
// FEED-confirmed final: the feed itself says FT and a real scoreline is present. Distinct from status()===FT, which
// also fires when a LIVE/HT row is stuck past full time (the feed lagged). Standings + qualification math must only
// fold in feed-final results — never a stale-live score the feed hasn't closed — so the table and the Q/out badges
// never disagree. UI ("still live?", "upcoming vs past") keeps using status() so a stuck match still drops out of live.
const isFeedFinal = m => { const r = res(m); return !!r && r.st === ST.FT && r.h != null; };
// live match clock: exact minute from the feed if present, else an estimate from kickoff
// (the free feed often only flags "live" with no minute). Estimate allows for a 15′ half-time.
function clockStr(m, r) {
  if (r && r.min != null) return r.min + "′";
  const real = Math.floor((Date.now() - new Date(m.utc).getTime()) / 60000);
  if (real < 0) return "";
  const est = real <= 45 ? real : Math.max(46, real - 15);
  return (est >= 90 ? "90+" : est) + "′";
}
function slotInfo(m, side) {
  const s = m[side];
  const r = res(m);
  const code = s.team || (r && r[side === "home" ? "ht" : "at"]) || winnerFeed(s);
  if (code && S.teams[code]) return { code, name: S.teams[code].name };
  return { name: s.ph || "TBD", ph: true, short: s.short };
}
function winnerFeed(s) {
  const num = s.feeds || s.feedsL;
  if (!num) return null;
  const fm = S.matches.find(x => x.num === num && x.stage !== "group");
  if (!fm) return null;
  const r = res(fm);
  if (!r || r.st !== ST.FT) return null;
  if (r.h === r.a && r.hp == null && r.ap == null) return null;   // FT level but penalties not in the feed yet — leave unresolved, don't guess (and propagate) a winner
  const hWin = r.h > r.a || (r.h === r.a && (r.hp ?? -1) > (r.ap ?? -1));
  const h = slotInfo(fm, "home").code, a = slotInfo(fm, "away").code;
  if (!h || !a) return null;
  return s.feeds ? (hWin ? h : a) : (hWin ? a : h);
}
const isFavMatch = m => S.fav && (slotInfo(m, "home").code === S.fav || slotInfo(m, "away").code === S.fav);
const matchHasTeam = (m, code) => slotInfo(m, "home").code === code || slotInfo(m, "away").code === code;


/* ---------------- calendar (.ics) export — client-side, kickoffs in UTC ---------------- */
const CAL_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`;
const SHARE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.85 3.99M15.4 6.51l-6.8 3.98"/></svg>`;
const REFRESH_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;
// webcal:// URL to a committed static calendar (data/ics/…) for an auto-updating subscription.
// Derived from the current page so it works wherever the site is hosted.
const webcalURL = file => "webcal://" + location.origin.replace(/^https?:\/\//, "") + location.pathname.replace(/[^/]*$/, "") + "data/ics/" + file;
const icsEsc = s => String(s).replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
const icsStamp = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function icsFold(line) { let o = ""; while (line.length > 73) { o += line.slice(0, 73) + "\r\n "; line = line.slice(73); } return o + line; }
function matchVEVENT(m) {
  const h = slotInfo(m, "home"), a = slotInfo(m, "away");
  const title = `${h.code ? h.name : slotText(m, "home", h)} v ${a.code ? a.name : slotText(m, "away", a)}`;
  const stage = m.group ? `Group ${m.group}` : m.round;
  const start = icsStamp(m.utc), end = icsStamp(new Date(new Date(m.utc).getTime() + 115 * 60000).toISOString());
  return [
    "BEGIN:VEVENT", `UID:wc26-m${m.num}@wc26.site`, `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${start}`, `DTEND:${end}`,
    icsFold(`SUMMARY:${icsEsc(title + " - " + stage)}`),
    icsFold(`LOCATION:${icsEsc(m.stadium + ", " + m.city)}`),
    icsFold(`DESCRIPTION:${icsEsc("FIFA World Cup 2026 · " + stage + " · Match " + m.num)}`),
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT60M", icsFold(`DESCRIPTION:${icsEsc(title + " kicks off in 1 hour")}`), "END:VALARM",
    "END:VEVENT",
  ].join("\r\n");
}
function downloadICS(matches, name) {
  if (!matches.length) return;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WC26//Companion//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    icsFold(`X-WR-CALNAME:${icsEsc(name)}`), ...matches.map(matchVEVENT), "END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name.replace(/[^\w]+/g, "-").toLowerCase().replace(/^-|-$/g, "") + ".ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- standings ---------------- */
// rank a group's rows by FIFA regulations art.13: points → head-to-head (points/GD/goals among the teams level
// on points) → overall GD → overall goals → FIFA World Ranking. (Reg step 2f, conduct/cards, isn't reliably in
// the free feed, so it's omitted — the ranking step decides the rest. Never alphabetical.)
function fifaSort(rows, gm, statuses) {
  const sts = statuses || [ST.FT];
  const gd = r => r.gf - r.ga;
  const byPts = {}; rows.forEach(r => (byPts[r.pts] || (byPts[r.pts] = [])).push(r));
  const out = [];
  for (const pts of Object.keys(byPts).map(Number).sort((a, b) => b - a)) {
    const cohort = byPts[pts];
    if (cohort.length > 1) {
      const set = new Set(cohort.map(r => r.code)), h = {};
      cohort.forEach(r => h[r.code] = { pts: 0, gd: 0, gf: 0 });
      for (const m of gm) {
        const r = res(m); if (!r || r.h == null || !sts.includes(r.st)) continue;
        const H = m.home.team, A = m.away.team; if (!set.has(H) || !set.has(A)) continue;     // matches AMONG the tied cohort only
        h[H].gf += r.h; h[H].gd += r.h - r.a; h[A].gf += r.a; h[A].gd += r.a - r.h;
        if (r.h > r.a) h[H].pts += 3; else if (r.h < r.a) h[A].pts += 3; else { h[H].pts++; h[A].pts++; }
      }
      cohort.sort((x, y) =>
        h[y.code].pts - h[x.code].pts || h[y.code].gd - h[x.code].gd || h[y.code].gf - h[x.code].gf ||   // step 1: head-to-head
        gd(y) - gd(x) || y.gf - x.gf ||                                                                  // step 2: overall GD, goals
        tiebreakRank(x.code) - tiebreakRank(y.code));                                                    // step 3: FIFA World Ranking
    }
    out.push(...cohort);
  }
  return out;
}
function standings(group) {
  const rows = {};
  const gm = S.matches.filter(m => m.group === group);
  gm.forEach(m => [m.home.team, m.away.team].forEach(c => {
    if (c && !rows[c]) rows[c] = { code: c, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
  }));
  gm.forEach(m => {
    const r = res(m);
    if (!isFeedFinal(m)) return;
    const H = rows[m.home.team], A = rows[m.away.team];
    if (!H || !A) return;
    H.p++; A.p++; H.gf += r.h; H.ga += r.a; A.gf += r.a; A.ga += r.h;
    if (r.h > r.a) { H.w++; A.l++; H.pts += 3; }
    else if (r.h < r.a) { A.w++; H.l++; A.pts += 3; }
    else { H.d++; A.d++; H.pts++; A.pts++; }
  });
  return fifaSort(Object.values(rows), gm);
}

// "what each team needs" — enumerate every remaining-result combo in a group.
// Ranks use points only, with ties resolved pessimistically (worst) for guarantees and
// optimistically (best) for elimination, so claims hold regardless of goal difference.
// NOTE: the "What each team needs" outlook is currently not rendered (removed for now);
// groupOutlook/groupOutlookHTML are kept intact — re-add ${groupOutlookHTML(g)} to renderGroups
// (and the team blocks) to bring it back.
function groupOutlook(g) {
  const gm = S.matches.filter(m => m.group === g);
  const codes = [...new Set(gm.flatMap(m => [m.home.team, m.away.team]).filter(Boolean))];
  if (codes.length < 4) return null;
  const done = m => res(m)?.st === ST.FT && res(m)?.h != null;
  const played = gm.filter(done), rem = gm.filter(m => !done(m));
  if (!played.length || !rem.length) return null;          // only meaningful once underway, before it's settled
  const base = {}; codes.forEach(c => base[c] = 0);
  played.forEach(m => { const r = res(m); if (r.h > r.a) base[m.home.team] += 3; else if (r.h < r.a) base[m.away.team] += 3; else { base[m.home.team]++; base[m.away.team]++; } });

  const ranksFor = (fixed, pool) => {                      // worst(pessimistic)+best(optimistic) rank per team
    const range = {}; codes.forEach(c => range[c] = { B: 4, W: 1 });
    const combos = Math.pow(3, pool.length);
    for (let i = 0; i < combos; i++) {
      const pts = { ...base, ...fixed }; let x = i;
      for (const m of pool) { const o = x % 3; x = (x - o) / 3;
        if (o === 0) pts[m.home.team] += 3; else if (o === 1) { pts[m.home.team]++; pts[m.away.team]++; } else pts[m.away.team] += 3; }
      codes.forEach(c => {
        const above = codes.filter(k => k !== c && pts[k] > pts[c]).length;
        const eq = codes.filter(k => k !== c && pts[k] === pts[c]).length;
        range[c].B = Math.min(range[c].B, 1 + above);
        range[c].W = Math.max(range[c].W, 1 + above + eq);
      });
    }
    return range;
  };

  const range = ranksFor({}, rem);
  const nmOf = c => S.teams[c]?.name || c;
  return codes.map(c => {
    const { B, W } = range[c];
    let status, k;
    if (W <= 1) { status = "Group winners, confirmed"; k = "q"; }
    else if (W <= 2) { status = "Through to the last 32"; k = "q"; }
    else if (B <= 2) { status = "Top two still in reach"; k = "live"; }
    else if (B === 3) { status = "Chasing a third-place spot"; k = "third"; }
    else { status = "Eliminated"; k = "out"; }
    // The actionable part: name the exact result a team still needs, for ANY number of games left. winW/drawW =
    // worst finish if they win/draw their last game; winB = best if they win; winOutW = worst if they win them all.
    let need = "";
    const mine = rem.filter(m => m.home.team === c || m.away.team === c);
    if (W > 1 && B <= 3 && mine.length) {
      if (W <= 2) {
        need = B <= 1 ? "can still finish top of the group" : "";   // already through; only the group win is left to settle
      } else if (mine.length === 1) {
        const mc = mine[0], opp = mc.home.team === c ? mc.away.team : mc.home.team, others = rem.filter(m => m !== mc), on = nmOf(opp);
        const winW = ranksFor({ [c]: base[c] + 3, [opp]: base[opp] }, others)[c].W;
        const drawW = ranksFor({ [c]: base[c] + 1, [opp]: base[opp] + 1 }, others)[c].W;
        const winB = ranksFor({ [c]: base[c] + 3, [opp]: base[opp] }, others)[c].B;
        need = drawW <= 2 ? `a draw with ${on} reaches the top two`
          : winW <= 2 ? `must beat ${on} to go through`
          : winB <= 2 ? `must beat ${on}, then hope other results help`
          : `must beat ${on} to keep a best-third place alive`;
      } else {
        const winOutW = ranksFor({ [c]: base[c] + 3 * mine.length }, rem.filter(m => !mine.includes(m)))[c].W;
        need = winOutW <= 2 ? `win their last ${mine.length} and they're through`
          : B <= 2 ? `must win out, and need results to fall their way`
          : `must keep winning to chase a best-third place`;
      }
    }
    return { code: c, status, k, need };
  }).sort((a, b) => standings(g).findIndex(r => r.code === a.code) - standings(g).findIndex(r => r.code === b.code));
}
function groupOutlookHTML(g) {
  const o = groupOutlook(g);
  if (!o) return "";
  const open = S.fav && groupOf(S.fav) === g ? " open" : "";   // auto-expand the favourite's group
  return `<details class="outlook"${open}><summary><span class="ear-tri">▸</span> What each team needs</summary>
    <div class="outlook-body">${o.map(t => `<div class="ol-row ol-${t.k} ${t.code === S.fav ? "is-fav" : ""}">
      <span class="fl">${flag(t.code)}</span><span class="ol-name">${esc(S.teams[t.code]?.name || t.code)}</span>
      <span class="ol-status">${t.status}${t.need ? ` · <b>${t.need}</b>` : ""}</span></div>`).join("")}</div></details>`;
}

/* ---------------- theming ---------------- */
function applyTheme(animateFrom) {
  const root = document.documentElement;
  const t = S.fav && S.teams[S.fav];
  const k1 = t ? t.c1 : "", k2 = t ? t.c2 : "";   // raw kit colours (used as-is for confetti)
  root.style.setProperty("--acc1", t ? readableAccent(k1, k2) : "var(--pitch)");   // contrast-guarded accent for text/buttons
  root.style.setProperty("--acc2", t ? (tooLight(k2) ? "#0D1B2A" : k2) : "#0D1B2A");
  $("#teamChipFlag").innerHTML = t ? flag(S.fav) : "⚽";
  $("#teamChipName").textContent = t ? t.name : "Pick a team";
  if (animateFrom && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const sw = $("#themeSweep"), r = animateFrom.getBoundingClientRect();
    sw.style.left = r.left + r.width / 2 - innerWidth + "px";
    sw.style.top = r.top + r.height / 2 - innerHeight + "px";
    sw.style.width = innerWidth * 2 + "px"; sw.style.height = innerHeight * 2 + "px";
    sw.classList.remove("go"); void sw.offsetWidth; sw.classList.add("go");
    confetti(k1 || "#0BA360", k2 || "#E8B931");
  }
}
const tooLight = hex => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 200;
};
// WCAG relative luminance + contrast ratio, used to keep the team-themed accent readable on paper.
const relLum = hex => { const n = parseInt(hex.slice(1), 16); const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }; return .2126 * f(n >> 16 & 255) + .7152 * f(n >> 8 & 255) + .0722 * f(n & 255); };
const contrastRatio = (a, b) => { const x = relLum(a) + .05, y = relLum(b) + .05; return x > y ? x / y : y / x; };
const scaleRGB = (hex, f) => { const n = parseInt(hex.slice(1), 16); const c = i => Math.max(0, Math.min(255, Math.round(i * f))); return "#" + ((1 << 24) + (c(n >> 16 & 255) << 16) + (c(n >> 8 & 255) << 8) + c(n & 255)).toString(16).slice(1); };
// pick the team kit colour that reads best on the paper background, then darken it until it clears a
// 3.5:1 contrast ratio — so bright mid-tones (orange, sky-blue) stay on-brand but legible, and pale
// kits (yellow/white) fall back to their darker secondary rather than a washed-out accent.
function readableAccent(c1, c2) {
  const PAPER = "#FAFBF9";
  const best = [c1, c2].filter(Boolean).sort((a, b) => contrastRatio(b, PAPER) - contrastRatio(a, PAPER))[0] || "#0BA360";
  let f = 1; while (f > 0.15 && contrastRatio(scaleRGB(best, f), PAPER) < 3.5) f -= 0.05;
  return scaleRGB(best, f);
}

/* ---------------- confetti ---------------- */
function confetti(c1, c2, origin) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("#confetti"), ctx = cv.getContext("2d");
  cv.width = innerWidth; cv.height = innerHeight;
  const ox = origin?.x ?? innerWidth / 2, oy = origin?.y ?? innerHeight * .25;
  const ps = Array.from({ length: 110 }, () => ({
    x: ox + (Math.random() - .5) * 120, y: oy,
    vx: (Math.random() - .5) * 12, vy: -Math.random() * 12 - 3,
    s: Math.random() * 7 + 4, r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3,
    c: [c1, c2, "#FFFFFF", "#E8B931"][Math.random() * 4 | 0],
  }));
  let t = 0;
  (function frame() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ps.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += .32; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.globalAlpha = Math.max(0, 1 - t / 85);
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    });
    if (++t < 90) requestAnimationFrame(frame); else ctx.clearRect(0, 0, cv.width, cv.height);
  })();
}

/* ---------------- football + goal celebration ---------------- */
// Spinning live/goal ball: the classic black-&-white football (Wikimedia Commons "Soccerball.svg", CC0 / public domain).
const BALL = `<img src="assets/football.svg" alt="" decoding="async">`;
const ballSVG = cls => `<span class="ball ${cls || ""}" aria-hidden="true">${BALL}</span>`;

function goalCelebration(code) {
  const t = code && S.teams[code];
  confetti(t ? t.c1 : "#0BA360", t ? t.c2 : "#E8B931");
  goalHorn();
  const toast = document.createElement("div");
  toast.className = "goal-toast";
  toast.innerHTML = `${ballSVG("goal-ball")}<div class="goal-txt"><b>GOAL!</b>${code ? `<span>${flag(code)} ${esc(S.teams[code].name)}</span>` : ""}</div>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2700);
}
// compare previous vs new results; fire a celebration when a LIVE score ticks up
function celebrateGoals(prev, now) {
  let celebrated = false;   // one visual horn/confetti per refresh, but announce every goal + status change for screen readers
  for (const id in now) {
    const a = prev[id], b = now[id]; if (!a || !b) continue;
    const m = S.matches.find(x => x.id === id); if (!m) continue;
    const hs = slotInfo(m, "home"), as = slotInfo(m, "away");
    const score = `${hs.name} ${b.h ?? 0}, ${as.name} ${b.a ?? 0}`;
    // a new goal — counts even when this poll also flipped the match to FT (the late winner), which the old guard missed
    if (((b.h || 0) + (b.a || 0)) > ((a.h || 0) + (a.a || 0)) && [ST.LIVE, ST.HT, ST.FT].includes(b.st)) {
      const scorer = slotInfo(m, (b.h || 0) > (a.h || 0) ? "home" : "away").code;
      if (!celebrated) { goalCelebration(scorer); maybeNotifyGoal(m, b, scorer); celebrated = true; }
      announce(`Goal! ${S.teams[scorer]?.name || ""}. ${score}.`);   // raw text — announce() sets textContent
    } else if (a.st !== b.st && b.st === ST.HT) announce(`Half-time. ${score}.`);
    else if (a.st !== b.st && b.st === ST.FT) announce(`Full time. ${score}.`);
  }
}
// polite screen-reader live region; clear-then-set so an identical message re-announces
function announce(msg) {
  const el = $("#liveAnnounce"); if (!el) return;
  el.textContent = ""; requestAnimationFrame(() => { el.textContent = msg; });
}
/* ---------------- match alerts (opt-in, while the tab is open) ---------------- */
// Goals + kickoff reminders for the favourite team. No push backend — these fire from the same 60s
// poll while the page is open, and only when the tab is in the background (when you're looking at the
// page, the on-screen toast/horn already signal a goal).
function notifyEnabled() { return localStorage.getItem("wc26.notify") === "on" && "Notification" in window && Notification.permission === "granted"; }
function notify(title, body) {
  if (!notifyEnabled() || !document.hidden) return;
  try { new Notification(title, { body, icon: "assets/icon-192.png", tag: "wc26", renotify: true }); } catch { /* blocked mid-session */ }
}
function maybeNotifyGoal(m, r, scorerCode) {
  if (!isFavMatch(m)) return;
  const nm = s => s.code ? (S.teams[s.code]?.name || s.code) : (s.name || "TBD");
  notify(scorerCode === S.fav ? "⚽ GOAL: your team!" : "Goal conceded", `${nm(slotInfo(m, "home"))} ${r.h}–${r.a} ${nm(slotInfo(m, "away"))}`);
}
const _koAlerted = new Set();
function checkKickoffAlert() {
  if (!notifyEnabled() || !S.fav) return;
  const now = Date.now();
  for (const m of S.matches) {
    if (!isFavMatch(m) || status(m) !== ST.SCHED || _koAlerted.has(m.id)) continue;
    const mins = (+new Date(m.utc) - now) / 60000;
    if (mins > 0 && mins <= 6) {
      _koAlerted.add(m.id);
      const opp = slotInfo(m, slotInfo(m, "home").code === S.fav ? "away" : "home");
      notify(`⏰ ${S.teams[S.fav].name} kick off soon`, `vs ${opp.code ? S.teams[opp.code]?.name : (opp.name || "TBD")} · ${timeStr(m.utc)}`);
    }
  }
}

/* ---------------- ticker ---------------- */
let _tickerSig = "";   // last-built marquee string; renderTicker early-returns when unchanged
function renderTicker() {
  // Two practical days at once: the PREVIOUS day's final scores + the CURRENT day's matches (kickoff times →
  // live → finals as they play). At each ~10am boundary the window slides forward one day — today's finals become
  // the "previous", tomorrow's fixtures become the new "current". Always relevant: what just happened + what's next.
  const cur = viewDay(new Date().toISOString());
  const byDay = {};
  for (const m of S.matches) (byDay[viewDay(m.utc)] ??= []).push(m);
  const days = Object.keys(byDay).sort();
  const curDay = byDay[cur] ? cur : days.find(d => d > cur);                                   // today's slate, or the next one with matches
  const prevDay = curDay ? [...days].reverse().find(d => d < curDay) : days[days.length - 1];  // last completed slate
  const todays = [...(byDay[prevDay] || []), ...(byDay[curDay] || [])].sort((a, b) => a.utc.localeCompare(b.utc));
  const wrap = $("#ticker");
  if (!todays.length) { wrap.hidden = true; return; }
  const item = m => {
    const h = slotInfo(m, "home"), a = slotInfo(m, "away"), r = res(m), st = status(m);
    const mid = [ST.LIVE, ST.HT].includes(st)
      ? `<span class="tk-live">● ${r?.h ?? 0}–${r?.a ?? 0}</span>`
      : st === ST.FT ? (r?.h != null ? `<b>${r.h}–${r.a}</b> FT` : `<b>FT</b>`)
      : `<span class="tk-acc">${timeStr(m.utc)}</span>`;
    const nmH = s => s.code ? `${esc(S.teams[s.code]?.name || s.code)} ${flag(s.code)}` : "TBD";
    const nmA = s => s.code ? `${flag(s.code)} ${esc(S.teams[s.code]?.name || s.code)}` : "TBD";
    return `<span class="ticker-item" data-mid="${m.id}">${nmH(h)} ${mid} ${nmA(a)}</span>`;
  };
  const sep = '<span class="tk-sep">／</span>';
  const track = $("#tickerTrack");
  const built = todays.map(item).join(sep);
  if (built === _tickerSig && track.firstChild) { wrap.hidden = false; return; }   // byte-identical since last poll → skip the write-read-write-read reflow (it only changes on a goal)
  _tickerSig = built;
  track.classList.remove("is-static");
  track.innerHTML = built;
  wrap.hidden = false;
  // scroll as a seamless marquee whenever the content is wider than the strip (any number of matches);
  // only centre it static when it genuinely fits — so nothing ever gets clipped. (reading scrollWidth forces layout)
  if (track.scrollWidth > wrap.clientWidth + 4) {
    track.innerHTML = built + sep + built;   // duplicate so the scroll wraps with no gap
    // translate by the EXACT width of one copy (to the 2nd copy's first item) so the loop is seamless. A plain
    // -50% lands half a separator off — the flex gap plus the single middle separator make the two halves
    // unequal — which shows as a flick at every repeat. Measuring the real offset removes it.
    const items = track.querySelectorAll(".ticker-item");
    const dist = Math.round(items[todays.length]?.offsetLeft || track.scrollWidth / 2);
    track.style.setProperty("--tick-x", -dist + "px");
    track.style.animationDuration = Math.max(18, Math.round(dist / 46)) + "s";   // constant pace, any match count
  } else {
    track.classList.add("is-static");
    track.style.removeProperty("--tick-x");
    track.style.removeProperty("animation-duration");
  }
}
const shortName = code => {
  const n = S.teams[code]?.name || code;
  return n.length > 11 ? (code.includes("-") ? code.slice(3) : code) : n;
};

/* ---------------- render: shared match card ---------------- */
function matchCard(m, i, opts = {}) {
  const h = slotInfo(m, "home"), a = slotInfo(m, "away");
  const r = res(m), st = status(m);
  const fav = isFavMatch(m);
  const stageL = m.group ? `Group ${m.group}` : m.stage === "third" ? "3rd place" : m.round;
  const live = st === ST.LIVE || st === ST.HT;
  const score = r && r.h != null;   // a real, feed-reported scoreline
  const sh = r?.h ?? 0, sa = r?.a ?? 0;   // display score — a live match with no goal data shows 0–0
  const winH = score && st === ST.FT && (r.h > r.a || (r.h === r.a && (r.hp ?? -1) > (r.ap ?? -1)));
  const winA = score && st === ST.FT && (r.a > r.h || (r.h === r.a && (r.ap ?? -1) > (r.hp ?? -1)));
  const badge = st === ST.LIVE ? `<span class="badge live">${clockStr(m, r) || "Live"}</span>`
    : st === ST.HT ? `<span class="badge live">HT</span>`
    : st === ST.FT ? `<span class="badge ft">FT</span>`
    : "";   // scheduled: kickoff time already shows on the left — don't repeat it on the right
  const teamRow = (s, key, lost) =>
    `<div class="mcard-team ${s.ph ? "is-ph" : ""} ${lost ? "is-lost" : ""}">` +
    `<span class="fl">${s.code ? flag(s.code) : TBD_FLAG}</span><span>${esc(slotText(m, key, s))}</span></div>`;
  const sv = isSaved(m.id);
  // The card body is the primary button; the save-star is a SIBLING <button>, not nested inside it
  // (nesting two interactive controls is invalid ARIA — screen readers announce it ambiguously). The
  // .mcard-wrap carries the list spacing + entrance animation and is the positioning context for the star.
  return `<div class="mcard-wrap" style="--i:${i}">
    <div class="mcard ${fav ? "is-fav" : ""}" role="button" tabindex="0" data-mid="${m.id}">
    <div class="mcard-row">
      <div class="mcard-time">${timeStr(m.utc)}<small>${fmt(m.utc, { day: "numeric", month: "short" })}</small></div>
      <div class="mcard-teams">${teamRow(h, "home", winA)}${teamRow(a, "away", winH)}</div>
      <div class="mcard-right">${(score || live)
        ? `<div class="mcard-score${live ? " is-live" : ""}"><span class="${winA ? "lo" : ""}">${sh}</span><span class="${winH ? "lo" : ""}">${sa}</span>${r?.hp != null ? `<span class="pens">(${r.hp}–${r.ap} pens)</span>` : ""}</div>${live ? badge : ""}`
        : badge}</div>
    </div>
    ${(() => { const s = matchStakes(m); return s && s.definitive ? `<div class="mcard-stake">${s.lines[0]}</div>` : ""; })()}
    ${opts.sub !== false ? `<div class="mcard-sub"><span class="grp">${esc(stageL)}</span><span>${esc(m.stadium)}</span><span>${esc(m.city)}</span><span class="mcard-go">Details ›</span></div>` : ""}
    ${(() => { if (!document.body.classList.contains("expert") || st === ST.FT) return ""; const wp = winProb(m); if (!wp) return ""; const ph = Math.round(wp.h*100), pd = Math.round(wp.d*100), pa = 100-ph-pd; return `<div class="mcard-wp"><span class="mcard-wp-bar"><span class="mcard-wp-h" style="width:${ph}%"></span><span class="mcard-wp-d" style="width:${pd}%"></span></span><span class="mcard-wp-tx">${ph}% · D ${pd}% · ${pa}%</span></div>`; })()}
    </div>
    <button class="mcard-star ${sv ? "is-on" : ""}" data-save="${m.id}" aria-pressed="${sv}" aria-label="${sv ? "Remove from saved" : "Save match"}" title="${sv ? "Remove from saved" : "Save match"}">${sv ? "★" : "☆"}</button>
  </div>`;
}
// split a starting XI into {gk, bands[]} using its formation string (fallback: coarse positions)
function formationRows(side) {
  const ps = (side.xi || []).slice();
  if (ps.length < 11) return null;
  const gk = ps.find(p => p[2] === 0) || ps[0];
  const out = ps.filter(p => p !== gk);
  let lines = String(side.f || "").split(/[-–]/).map(n => parseInt(n, 10)).filter(n => n > 0);
  if (lines.reduce((s, n) => s + n, 0) !== out.length) lines = null;     // formation doesn't fit → fall back
  let bands;
  if (lines) { bands = []; let i = 0; for (const n of lines) { bands.push(out.slice(i, i + n)); i += n; } }
  else bands = [1, 2, 3].map(pp => out.filter(p => p[2] === pp)).filter(b => b.length);
  return { gk, bands };
}
const lastName = n => {
  const t = String(n || "").trim().split(/\s+/);
  const last = t[t.length - 1];
  // If last token is just an initial like "E." (FIFA's "SURNAME Initial." format), use the first token (the surname)
  if (t.length > 1 && /^[A-Za-zÀ-ÿ]\.$/.test(last)) return t[0];
  return last || String(n || "");
};
function pitchSide(side, s, home) {
  const fr = formationRows(side); if (!fr) return null;
  const c1 = (s.code && S.teams[s.code]?.c1) || "#1f2937", c2 = (s.code && S.teams[s.code]?.c2) || "#ffffff";
  const nb = fr.bands.length;
  const dot = (p, x, depth) => {                                        // depth 0 = own goal, 1 = halfway
    const top = home ? 96 - depth * 44 : 4 + depth * 44;               // home bottom half, away top half
    const left = home ? x : 100 - x;
    const photo = bestPhoto(p[1], s.code, p[0]);   // p[0] = jersey number → exact match
    const num = p[0] ?? "";
    const face = photo
      ? `<span class="pp-face" style="background-image:url('${photo}')"></span>`     // headshot only — no circle, no number on the face
      : `<span class="pp-dot">${num}</span>`;                                        // fallback when no photo exists
    return `<div class="pp pp-clk${photo ? "" : " pp-nf"}" data-player="${esc(p[1])}|${s.code}" role="button" tabindex="0" style="left:${left}%;top:${top}%;--pc:${c1};--pt:${c2}">${face}<span class="pp-name">${num !== "" ? `<b class="pp-no">${num}</b>` : ""}<span class="pp-nm">${esc(lastName(p[1]))}</span></span></div>`;
  };
  let html = dot(fr.gk, 50, 0.06);                                     // keep GK just off the goal line
  fr.bands.forEach((band, bi) => {
    const depth = (bi + 1) / (nb + 0.5);                              // last line stops short of halfway
    band.forEach((p, pi) => html += dot(p, (pi + 1) / (band.length + 1) * 100, depth));
  });
  return html;
}
function xiPanel(xi, h, a) {
  const ph = pitchSide(xi.h, h, true), pa = pitchSide(xi.a, a, false);
  if (ph && pa) {
    const tag = (s, side) => `<span class="pitch-team"><span class="fl">${s.code ? flag(s.code) : ""}</span>${esc(s.name)}${side.f ? ` <b>${esc(side.f)}</b>` : ""}</span>`;
    return `<div class="pitch-head">${tag(h, xi.h)}${tag(a, xi.a)}</div>
      <div class="pitch"><svg class="pitch-lines" viewBox="0 0 100 150" preserveAspectRatio="none" aria-hidden="true">
        <rect x="1" y="1" width="98" height="148"/><line x1="1" y1="75" x2="99" y2="75"/>
        <circle cx="50" cy="75" r="11"/><circle class="pf" cx="50" cy="75" r="0.9"/>
        <rect x="28" y="1" width="44" height="22"/><rect x="40" y="1" width="20" height="8"/>
        <rect x="28" y="127" width="44" height="22"/><rect x="40" y="141" width="20" height="8"/>
      </svg>${ph}${pa}</div>
      ${(xi.h.coach || xi.a.coach) ? `<div class="pitch-coaches"><span>${xi.h.coach ? "Coach · " + esc(xi.h.coach) : ""}</span><span>${xi.a.coach ? "Coach · " + esc(xi.a.coach) : ""}</span></div>` : ""}`;
  }
  const col = (side, s) => `<div class="xi-col">
    <div class="xi-head"><span>${s.code ? flag(s.code) : ""} ${esc(s.name)}</span>${side.f ? `<b>${esc(side.f)}</b>` : ""}</div>
    ${(side.xi || []).map(p => `<div class="xi-p"><span>${p[0] ?? ""}</span>${esc(p[1] || "")}</div>`).join("")}
    ${side.coach ? `<div class="xi-coach">Coach · ${esc(side.coach)}</div>` : ""}
  </div>`;
  return `<div class="mcard-xi">${col(xi.h, h)}${col(xi.a, a)}</div>`;
}
// goals/cards/subs timeline for the match modal (from results `ev`)
const EV_ICON = {
  G: ICO.ball, P: ICO.ball, OG: ICO.ball,
  Y: `<span class="tl-card y" aria-hidden="true"></span>`,
  R: `<span class="tl-card r" aria-hidden="true"></span>`,
  S: `<span class="tl-sub">${ICO.subs}</span>`,
};
function evText(e, code) {
  const P = (n, cls) => `<span class="${cls} tl-clk" data-player="${esc(n)}|${code}" role="button" tabindex="0">${esc(tlName(n, code))}</span>`;
  if (e.k === "S") return `${e.on ? P(e.on, "tl-p tl-in") : ""}${e.off ? P(e.off, "tl-off tl-out") : ""}`;
  const tag = e.k === "P" ? ` <span class="tl-x">pen</span>` : e.k === "OG" ? ` <span class="tl-x">o.g.</span>` : "";
  return `${e.p ? P(e.p, "tl-p") : ""}${tag}${e.a ? P(e.a, "tl-off") : ""}`;
}
function mdTimeline(r, hc, ac) {
  if (!r?.ev?.length) return "";
  const rows = r.ev.map(e => {
    // `tm` is the team the event counts FOR; for an own goal that's the beneficiary, but the scorer belongs to
    // the OTHER team — so link the player to their real side, else the tap opens the wrong team and the photo misses.
    const scorerCode = e.k === "OG" ? (e.tm === "h" ? ac : hc) : (e.tm === "h" ? hc : ac);
    return `<div class="tl ${e.tm === "h" ? "is-h" : "is-a"}${["G", "P", "OG"].includes(e.k) ? " is-goal" : ""}">
    <div class="tl-min">${esc(e.t || "–")}</div>
    <span class="tl-ev"><span class="tl-tx">${evText(e, scorerCode)}</span>${EV_ICON[e.k] ? `<span class="tl-ic">${EV_ICON[e.k]}</span>` : ""}</span>
  </div>`;
  }).join("");
  return `<div class="eyebrow">Match events</div><div class="md-tl">${rows}</div>`;
}
const STAT_ROWS = [
  ["poss", "Possession", "%"],
  ["sh", "Shots"], ["sot", "On target"], ["blk", "Blocked"],
  ["sv", "Saves"], ["cor", "Corners"], ["off", "Offsides"],
  ["pass", "Passes"], ["cross", "Crosses"], ["lball", "Long balls"],
  ["tkl", "Tackles"], ["intc", "Interceptions"], ["clr", "Clearances"],
  ["fls", "Fouls"], ["yc", "Yellow cards"],
];
const statBar = ([hv, av], label, suf = "") => {
  const tot = (hv + av) || 1, hp = Math.round(hv / tot * 100);
  return `<div class="st-row">
    <span class="st-v${hv >= av ? " st-hi" : ""}">${hv}${suf}</span>
    <span class="st-label">${label}</span>
    <span class="st-v st-v-a${av >= hv ? " st-hi" : ""}">${av}${suf}</span>
    <span class="st-bar"><i class="st-h" style="width:${hp}%"></i><i class="st-a" style="width:${100 - hp}%"></i></span>
  </div>`;
};
function mdStats(r, expand = false) {
  if (!r?.stats) return "";
  const s = r.stats, parts = [];
  // possession, shots and on target already sit in Key stats just above — don't repeat them here.
  const inKey = new Set(["poss", "sh", "sot"]);
  for (const [k, label, suf] of STAT_ROWS) {
    if (inKey.has(k) || !Array.isArray(s[k])) continue;
    parts.push(statBar(s[k], label, suf));
    // derive pass accuracy from the accurate/total counts (ESPN's passPct ships as a 0-1 fraction, so we don't store it)
    if (k === "pass" && Array.isArray(s.passT) && s.passT[0] && s.passT[1])
      parts.push(statBar([Math.round(s.pass[0] / s.passT[0] * 100), Math.round(s.pass[1] / s.passT[1] * 100)], "Pass accuracy", "%"));
  }
  if (!parts.length) return "";
  if (expand) {
    return `<div class="eyebrow">All match stats</div><div class="md-stats">${parts.join("")}</div>${mdLeaders(r)}`;
  }
  const head = Array.isArray(s.pass) ? `${s.pass[0]}–${s.pass[1]} passes · ${parts.length} stats` : `${parts.length} stats`;
  return `<details class="md-fold"><summary><span>All match stats</span><small>${head}</small></summary>
    <div class="md-fold-body"><div class="md-stats">${parts.join("")}</div>${mdLeaders(r)}</div></details>`;
}
// the headline stats shown inline above the full fold — possession, xG (post-match), shots, on target — so the
// numbers people came for are visible without a tap, while the full 16-stat table stays one tap deep.
function mdKeyStats(r, m) {
  if (!r?.stats) return "";
  const s = r.stats, bars = [];
  if (Array.isArray(s.poss)) bars.push(statBar([Math.round(s.poss[0]), Math.round(s.poss[1])], "Possession", "%"));
  const e = S.efi?.[m.num];
  if (e?.xg) bars.push(statBar(e.xg, "Expected goals (xG)" + infoBtn("Expected goals — the goals an average team would score from the chances it created, scored by how good each chance was. A better read of performance than the final score.", "What xG means")));
  if (Array.isArray(s.sh)) bars.push(statBar(s.sh, "Shots"));
  if (Array.isArray(s.sot)) bars.push(statBar(s.sot, "On target"));
  return bars.length ? `<div class="eyebrow">Key stats</div><div class="md-stats">${bars.join("")}</div>` : "";
}
// "Deep analysis": FIFA Enhanced Football Intelligence (post-match) — official xG, line breaks, ball progressions,
// pressures, phases of play, and the headline: per-player distance covered. Only shown when data/efi.json has it.
function mdEfi(m, expand = false) {
  const e = S.efi?.[m.num]; if (!e) return "";
  const h = slotInfo(m, "home"), a = slotInfo(m, "away");
  const hc = (h.code && S.teams[h.code]?.c1) || "#0BA360", ac = (a.code && S.teams[a.code]?.c1) || "#5B6B7A";
  const sb = [];
  // When expanded (FT), xG and possession are already visible in Key stats — skip them here to avoid repetition
  if (!expand && e.xg) sb.push(statBar(e.xg, "Expected goals (xG)" + infoBtn("Expected goals — the goals an average team would score from the chances it created, scored by how good each chance was. A better read of performance than the final score.", "What xG means")));
  if (e.shots) sb.push(statBar([e.shots[0], e.shots[2]], "Attempts at goal"));
  if (!expand && e.poss && e.possContest != null) sb.push(statBar(e.poss, "Possession", "%"));
  if (e.lineBreaks) sb.push(statBar(e.lineBreaks, "Completed line breaks"));
  if (e.ballProg) sb.push(statBar(e.ballProg, "Ball progressions"));
  if (e.pressures) sb.push(statBar(e.pressures, "Defensive pressures"));
  const phaseKeys = ["Build Up Unopposed", "Progression", "Final Third", "Attacking Transition"];
  const phaseBars = phaseKeys.filter(k => e.phasesIn?.[k]).map(k => statBar(e.phasesIn[k], k, "%")).join("");
  const homeKm = (e.players?.home || []).filter(p => p.km);
  const awayKm = (e.players?.away || []).filter(p => p.km);
  const players = [...homeKm.map(p => ({ ...p, c: hc, code: h.code })), ...awayKm.map(p => ({ ...p, c: ac, code: a.code }))]
    .sort((x, y) => y.km - x.km);
  const maxKm = players[0]?.km || 12;
  const distLabel = homeKm.length && awayKm.length ? "km, both teams"
    : homeKm.length ? `km, ${esc(h.name)} only`
    : awayKm.length ? `km, ${esc(a.name)} only` : null;
  const dist = players.length && distLabel ? `<div class="efi-sub">Distance covered <small>${distLabel}</small></div>
    <div class="efi-dist">${players.slice(0, 14).map(p => `<div class="efi-prow">
      <span class="efi-pn">${esc(tlName(p.name, p.code))}</span>
      <span class="efi-pbar"><i style="width:${Math.max(5, Math.round(p.km / maxKm * 100))}%;background:${p.c}"></i></span>
      <span class="efi-pv">${p.km.toFixed(1)}</span></div>`).join("")}</div>` : "";
  if (!sb.length && !dist) return "";
  const body = `${sb.length ? `<div class="md-stats">${sb.join("")}</div>` : ""}
      ${phaseBars ? `<div class="efi-sub">Phases of play <small>in possession</small></div><div class="md-stats">${phaseBars}</div>` : ""}
      ${dist}
      <p class="efi-credit">Source: FIFA Enhanced Football Intelligence, published after the match.</p>`;
  const efiInfo = infoBtn("FIFA's official post-match data (Enhanced Football Intelligence). Line breaks = passes played beyond a line of opponents (breaking the press); ball progressions = actions that carry the ball meaningfully towards goal; defensive pressures = times a player closed down the ball-carrier; possession in-contest = the share of the ball while it was genuinely being contested; distance covered = total running per player.", "About FIFA's deep-analysis metrics");
  if (expand) return `<div class="eyebrow">Deep analysis ${efiInfo}</div>${body}`;
  return `<details class="md-fold"><summary><span>Deep analysis</span><small>FIFA EFI · post-match</small></summary>
    <div class="md-fold-body">${body}</div></details>`;
}
// per-team standout performers (top shooter / passer / defender / keeper) — names are display-only
function mdLeaders(r) {
  if (!r?.lead?.length) return "";
  const CAT = [["totalShots", "Shots"], ["accuratePasses", "Passes"], ["defensiveInterventions", "Defensive actions"], ["saves", "Saves"]];
  const byCat = {}; for (const L of r.lead) (byCat[L.k] ||= []).push(L);
  const sects = CAT.filter(([k]) => byCat[k]).map(([k, label]) => {
    const rows = byCat[k].map(L => `<div class="ld-row"><span class="ld-p">${flag(L.c)} <span class="ld-n">${esc(L.n)}</span> <em>${esc(L.v)}</em></span></div>`).join("");
    return `<div class="ld-sect"><span class="ld-cat">${label}</span>${rows}</div>`;
  }).join("");
  return sects ? `<div class="eyebrow">Key performers</div><div class="md-leaders">${sects}</div>` : "";
}
const evMin = s => { const m = String(s || "").match(/(\d+)(?:'?\+(\d+))?/); return m ? +m[1] + (m[2] ? +m[2] / 100 : 0) : 0; };
// "match flow" — the running lead (home − away) over the timeline, as a signed area
// kit colours off the shirt can be near-white or near-black — invisible on the card. Nudge each into a
// readable band for the current theme so the match-flow fill (and its legend swatch) always reads.
function flowColor(hex) {
  let c = String(hex || "").replace("#", "");
  if (c.length === 3) c = c.split("").map(x => x + x).join("");
  if (c.length !== 6) return currentDark() ? "#9FB2C4" : "#5B6B7A";
  let r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (!currentDark() && lum > 0.68) { const f = 0.58 / lum; r *= f; g *= f; b *= f; }            // light kit on paper → darken
  else if (currentDark() && lum < 0.34) { const t = 165; r += (t - r) * 0.55; g += (t - g) * 0.55; b += (t - b) * 0.55; } // dark kit on dark card → lift
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}
const STAGE_NAME = { r32: "Round of 32", r16: "Round of 16", qf: "Quarter-final", sf: "Semi-final", final: "Final", third: "3rd place" };
// narrative breadcrumb of where this match's winner goes, all the way to the final
function koPath(m) {
  if (!m || m.stage === "group") return "";
  const tgt = {}, byNum = {};
  S.matches.forEach(x => { byNum[x.num] = x; if (x.stage !== "group") [x.home, x.away].forEach(s => { if (s.feeds) tgt[s.feeds] = x.num; }); });
  const chain = []; for (let n = m.num; n != null && byNum[n] && !chain.includes(byNum[n]); n = tgt[n]) chain.push(byNum[n]);
  if (chain.length < 2) return "";
  const steps = chain.slice(1).map(x => STAGE_NAME[x.stage] || x.stage);   // rounds ahead, no global match numbers (we don't number matches)
  return `<div class="md-kopath"><span class="kp-label">Winner's road →</span> ${steps.join(`<span class="kp-arr">›</span>`)}</div>`;
}
// win-probability — a bivariate-Poisson goals model. Team strength is each side's World Football Elo rating
// (seeded snapshot in teams.json), nudged by current-tournament form; the Elo gap sets the goal supremacy that
// splits the two scoring rates. Scorelines are summed with a Dixon-Coles low-score correction (independent
// Poisson under-counts draws). In-play, the rates scale to the minutes remaining and the live scoreline is
// carried as a head-start. A clearly-labelled model estimate — not a feed/betting value.
const _FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880];
const _pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / _FACT[k];
const DC_RHO = -0.11;   // Dixon-Coles low-score dependence; NEGATIVE for football — inflates the 0-0 & 1-1 correlation real matches show (their paper lands ~-0.13)
// Dixon-Coles τ: nudges the four low scores independent Poisson gets wrong (mutual caution correlates 0-0/1-1 up).
const _dcTau = (x, y, lh, la) =>
  x === 0 && y === 0 ? 1 - lh * la * DC_RHO :
  x === 0 && y === 1 ? 1 + lh * DC_RHO :
  x === 1 && y === 0 ? 1 + la * DC_RHO :
  x === 1 && y === 1 ? 1 - DC_RHO : 1;
// a host nation gets its home edge ONLY when playing in its own country (city suffix → team code)
const HOST_OF = { USA: "US", Mexico: "MX", Canada: "CA" };
const hostCode = m => HOST_OF[(m.city || "").split(", ").pop()] || null;
// Opponent-adjusted Elo from each completed result AND its official xG (efi); memoised on (#FT, #efi). K is kept cool
// and per-team drift hard-capped so a short group stage — or one blowout — can't swamp a 4-year-seeded prior, and the
// xG blend tames fluky scorelines (xG lives inside the update, so there is NO separate form term to double-count).
// TWO stages: (1) a sequential online walk — the established rating, and the FINAL rating for any one-game team; then
// (2) a strength-of-schedule refinement (a fixed-point iteration) that re-scores every game against opponents' CURRENT
// ratings and re-derives each MULTI-game team from its seed. Stage 2 is what lets a result ripple to a NON-playing team
// through a shared opponent (within a group from matchday 2, across the whole bracket in the knockouts). A one-game team
// has no common-opponent leverage, so it keeps its online value — which also keeps the ratings identical to the pure
// online model until a team's 2nd game. Groups only ever connect a team to its own group, so nothing propagates across
// groups during the group stage by construction (there is no shared-opponent path to carry it).
let _eloCache = null, _eloSig = "";
function eloSeq() {
  const done = S.matches.filter(m => status(m) === ST.FT && res(m)?.h != null).sort((x, y) => x.utc.localeCompare(y.utc));
  const sig = done.length + ":" + Object.keys(S.efi || {}).length;
  if (_eloCache && _eloSig === sig) return _eloCache;
  const seed = c => S.teams[c]?.elo || 1700, K = 22, DRIFT = 70;
  const clamp = (c, v) => seed(c) + Math.max(-DRIFT, Math.min(DRIFT, v - seed(c)));
  const exp = (rH, rA, host, hc, ac) => 1 / (1 + Math.pow(10, -((rH + (host === hc ? 40 : 0)) - (rA + (host === ac ? 40 : 0))) / 400));
  // pre-extract each game's order-independent signal: effective home-score share (xG-blended) + margin-of-victory weight
  const games = [];
  for (const m of done) {
    const hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code, r = res(m);
    if (!hc || !ac) continue;
    let seffH = r.h > r.a ? 1 : r.h < r.a ? 0 : 0.5; const efi = S.efi?.[m.num];
    if (efi?.xg) {   // blend official xG into the result signal (0.7 xG / 0.3 goals); align efi orientation to our home/away
      const xgH = efi.home === hc ? efi.xg[0] : efi.xg[1], xgA = efi.home === hc ? efi.xg[1] : efi.xg[0];
      seffH = 0.7 * Math.max(0, Math.min(1, 0.5 + (xgH - xgA) / 4)) + 0.3 * seffH;
    }
    const mg = Math.abs(r.h - r.a), g = mg <= 1 ? 1 : mg === 2 ? 1.5 : mg === 3 ? 1.75 : 1.75 + (mg - 3) / 8;
    games.push({ hc, ac, host: hostCode(m), seffH, g });
  }
  const ng = {}; for (const x of games) { ng[x.hc] = (ng[x.hc] || 0) + 1; ng[x.ac] = (ng[x.ac] || 0) + 1; }
  // (1) sequential online walk
  const E0 = {}, g0 = c => E0[c] ?? seed(c);
  for (const x of games) {
    const d = K * x.g * (x.seffH - exp(g0(x.hc), g0(x.ac), x.host, x.hc, x.ac));
    E0[x.hc] = clamp(x.hc, g0(x.hc) + d); E0[x.ac] = clamp(x.ac, g0(x.ac) - d);
  }
  // (2) strength-of-schedule refinement — re-derive each multi-game team from its seed against opponents' current
  // ratings; one-game teams keep their online value. Converges in a few passes (the ±DRIFT clamp keeps it bounded).
  let R = {}; for (const c in ng) R[c] = E0[c] ?? seed(c);
  for (let pass = 0; pass < 4; pass++) {
    const acc = {};
    for (const x of games) {
      const d = K * x.g * (x.seffH - exp(R[x.hc], R[x.ac], x.host, x.hc, x.ac));
      acc[x.hc] = (acc[x.hc] || 0) + d; acc[x.ac] = (acc[x.ac] || 0) - d;
    }
    const F = {};
    for (const c in ng) F[c] = ng[c] < 2 ? (E0[c] ?? seed(c)) : clamp(c, seed(c) + (acc[c] || 0));
    R = F;
  }
  return (_eloCache = R, _eloSig = sig, R);
}
function teamRating(code) { return eloSeq()[code] ?? (S.teams[code]?.elo || 1700); }
const liveMinute = (m, r) => r?.st === ST.HT ? 45 : Math.max(1, Math.min(95, Math.round((Date.now() - +new Date(m.utc)) / 60000)));
// effective reds per side in a live match: a straight red, or an accumulated 2nd yellow. Events carry no shirt
// number, so the 2nd-yellow match is on the normalised player name within the same side.
function liveReds(r) {
  const out = { h: 0, a: 0 }, yc = { h: {}, a: {} };
  for (const e of (r?.ev || [])) {
    const s = e.tm === "h" ? "h" : e.tm === "a" ? "a" : null; if (!s) continue;
    if (e.k === "R") out[s]++;
    else if (e.k === "Y" && e.p) { const n = normName(e.p); if ((yc[s][n] = (yc[s][n] || 0) + 1) === 2) out[s]++; }
  }
  return out;
}
// Attack/defence "game-character" estimator (v3). The scalar Elo split provably can't move the TOTAL goals (it pins
// it to 2·mu at every gap), so this overlay reshapes the total (and a small ≤25% slice of the skew) to add the
// orthogonal "good attack / leaky defence" info Elo's single number can't hold — WITHOUT re-counting the xG already
// inside the Elo. Per-team estimates are heavily shrunk toward an Elo-implied prior (every team has barely played),
// and the whole overlay is gated off until a side has ≥2 games, so early-tournament odds are untouched.
let _adCache = null, _adSig = "";
function attackDefence() {
  const done = S.matches.filter(m => status(m) === ST.FT && res(m)?.h != null).sort((x, y) => x.utc.localeCompare(y.utc));
  const sig = done.length + ":" + Object.keys(S.efi || {}).length;
  if (_adCache && _adSig === sig) return _adCache;
  const rec = {};   // code → [{att, def, opp, wt}]: attack = xG/goals FOR, def = conceded; same 0.7xG/0.3goals blend as eloSeq
  for (const m of done) {
    const hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code, r = res(m); if (!hc || !ac) continue;
    const efi = S.efi?.[m.num]; let xgH, xgA, wt = 1;
    if (efi?.xg) { xgH = efi.home === hc ? efi.xg[0] : efi.xg[1]; xgA = efi.home === hc ? efi.xg[1] : efi.xg[0]; }
    else { xgH = r.h; xgA = r.a; wt = 0.6; }   // goals-only fallback, down-weighted (noisier than xG)
    (rec[hc] ??= []).push({ att: 0.7 * xgH + 0.3 * r.h, def: 0.7 * xgA + 0.3 * r.a, opp: ac, wt });
    (rec[ac] ??= []).push({ att: 0.7 * xgA + 0.3 * r.a, def: 0.7 * xgH + 0.3 * r.h, opp: hc, wt });
  }
  let sw = 0, sa = 0; for (const c in rec) for (const g of rec[c]) { sw += g.wt; sa += g.att * g.wt; }
  const L = done.length >= 4 && sw ? sa / sw : 1.25;   // league mean goals/side; fallback until enough data
  const beta = 0.10, zOf = c => ((S.teams[c]?.elo || 1700) - 1786) / 150;   // Elo-implied prior (median seed ≈ 1786)
  const prior = c => ({ A: Math.exp(0.5 * beta * zOf(c)), D: Math.exp(-0.5 * beta * zOf(c) * 0.8) });   // >1 attack = scores more; >1 defence = concedes more
  const p1 = {};   // pass 1: raw league-relative, used only as the opponent adjuster
  for (const c in rec) { let aw = 0, as = 0, ds = 0; for (const g of rec[c]) { aw += g.wt; as += g.att * g.wt; ds += g.def * g.wt; } p1[c] = { A: as / aw / L, D: ds / aw / L }; }
  const out = {};
  for (const c in rec) {
    const n = rec[c].length; let A, D;
    if (n >= 2) {   // ≥2 distinct opponents by now → normalise each game by who you faced (opponent adjustment)
      let aw = 0, as = 0, ds = 0;
      for (const g of rec[c]) { aw += g.wt; as += (g.att / L / (p1[g.opp]?.D || 1)) * g.wt; ds += (g.def / L / (p1[g.opp]?.A || 1)) * g.wt; }
      A = as / aw; D = ds / aw;
    } else { A = p1[c].A; D = p1[c].D; }
    A = Math.max(0.6, Math.min(1.6, A)); D = Math.max(0.6, Math.min(1.6, D));   // clamp raw before shrinkage
    const pr = prior(c), k = n / (n + 4);   // James-Stein shrink toward the Elo prior (n=1 → 20% data, n=3 → 43%)
    out[c] = { A: k * A + (1 - k) * pr.A, D: k * D + (1 - k) * pr.D, n };
  }
  return (_adCache = out, _adSig = sig, out);
}
// Group-stage qualification stakes — only the two scenarios with a real, evidenced behavioural signal, detected
// EXACTLY from the live table via _qualScan (no heuristics). Mutually exclusive; fires only once a final-round
// permutation is decided (so it stays dormant until matchday 3). Returns null when no clear stake applies.
function stakeAdjust(m) {
  if (m.stage !== "group" || !m.group || status(m) === ST.FT) return null;
  const g = m.group, H = m.home.team, A = m.away.team;
  if (!H || !A || !S.matches.some(x => x.group === g && status(x) === ST.FT && res(x)?.h != null)) return null;
  const through = c => _qualScan(g, c).clinched, gone = c => _qualScan(g, c).out;
  // 1) a draw sends BOTH through — neither already safe, yet a draw here guarantees top-two for each (cap the draw, ease the goals)
  if (!through(H) && !through(A) && _qualScan(g, H, m.id, "d").clinched && _qualScan(g, A, m.id, "d").clinched)
    return { lamMult: 0.92, draw: { mode: "boost", w: 0.20 }, reason: { key: "stake", dir: "N", mag: 0.16, text: "A draw sends both through" } };
  // 2) both need the win — for EACH side a win clinches top-two but a draw leaves it uncertain (open, end-to-end game)
  const needWin = (c, win) => !through(c) && !gone(c) && _qualScan(g, c, m.id, win).clinched && !_qualScan(g, c, m.id, "d").clinched;
  if (needWin(H, "h") && needWin(A, "a"))
    return { lamMult: 1.06, draw: { mode: "cut", w: 0.85 }, reason: { key: "stake", dir: "N", mag: 0.14, text: "Both need a win, end to end" } };
  return null;
}
// Dixon-Coles bivariate-Poisson outcome + scoreline. Strength enters via Elo→goal-supremacy; host, live red cards
// and (later) weather enter MULTIPLICATIVELY so they compose without driving a rate negative. The score grid is
// retained to surface the most-likely scoreline, and each factor's signed supremacy shift is logged for the "why".
// pre=true → the frozen PRE-MATCH estimate (ignores the live scoreline/clock/red-cards and works for finished games too),
// for showing "what the model predicted before kickoff" in the match modal regardless of state.
function winProb(m, pre = false) {
  const hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code, st = status(m), r = res(m);
  if (!hc || !ac || (st === ST.FT && !pre)) return null;
  const live = (st === ST.LIVE || st === ST.HT) && !pre, ko = !m.group && m.stage !== "group";
  const nm = c => { const n = S.teams[c]?.name || c; return n.length > 14 ? n.slice(0, 13) + "…" : n; };
  const mu = ko ? 1.25 : 1.35, eloH = teamRating(hc), eloA = teamRating(ac);   // knockouts are played tighter → lower base rate
  const supR = Math.max(-2.5, Math.min(2.5, (eloH - eloA) / 300));
  const lamH0 = mu + supR / 2, lamA0 = mu - supR / 2;
  let lamH = lamH0, lamA = lamA0;
  const reasons = [];
  if (ko) reasons.push({ key: "ko", dir: "N", mag: 0.08, text: "Knockout tie, played tighter" });
  // attack/defence game-character overlay — dormant until BOTH sides have ≥2 games, so today's odds are unchanged
  const ad = attackDefence(), adH = ad[hc], adA = ad[ac];
  const ftN = S.matches.reduce((n, x) => n + (status(x) === ST.FT && res(x)?.h != null ? 1 : 0), 0);
  const adW = 0.6 * Math.min(1, ftN / 24);   // global trust ramp: 0 before any games, ~0.6 by ~24 played
  if (adW > 0 && adH && adA && adH.n >= 2 && adA.n >= 2) {
    const mH = Math.max(0.7, Math.min(1.45, adH.A * adA.D)), mA = Math.max(0.7, Math.min(1.45, adA.A * adH.D));   // my attack × their (leaky=high) defence
    lamH *= Math.pow(mH, adW); lamA *= Math.pow(mA, adW);
    const T = lamH + lamA, lnR = 0.75 * Math.log(lamH0 / lamA0) + 0.25 * Math.log(lamH / lamA);   // skew-lock: Elo keeps ≥75% of who-wins; att/def own the total
    lamH = T / (1 + Math.exp(-lnR)); lamA = T - lamH;
    if (adH.D > 1.08 && adA.D > 1.08) reasons.push({ key: "matchup", dir: "N", mag: 0.06, text: "Two leaky defences, goals likely" });
    else if (adH.D < 0.92 && adA.D < 0.92) reasons.push({ key: "matchup", dir: "N", mag: 0.06, text: "Two tight defences, low and tight" });
  }
  // the bar itself already conveys "who's stronger" — the "why" is reserved for NON-obvious movers. Surface only the
  // in-tournament FORM the sequential-Elo has added on top of the seeded prior (the raw strength gap is intentionally silent).
  const seedGap = ((S.teams[hc]?.elo || 1700) - (S.teams[ac]?.elo || 1700)) / 300;
  const formGap = (eloH - eloA) / 300 - seedGap;
  if (Math.abs(formGap) >= 0.06) reasons.push({ key: "form", dir: formGap >= 0 ? "H" : "A", mag: Math.abs(formGap), text: `${nm(formGap >= 0 ? hc : ac)} in form here` });
  const stk = (ko || live) ? null : stakeAdjust(m);   // pre-match group stakes (qualification scenario)
  if (stk) { lamH *= stk.lamMult; lamA *= stk.lamMult; reasons.push(stk.reason); }
  const host = hostCode(m);   // host home advantage — only a host playing in its own country (else stays neutral)
  if (host === hc || host === ac) {
    const hs = host === hc; lamH *= Math.exp(hs ? 0.13 : -0.06); lamA *= Math.exp(hs ? -0.06 : 0.13);
    reasons.push({ key: "host", dir: hs ? "H" : "A", mag: 0.19, text: `Host edge in ${(m.city || "").split(",")[0]}` });
  }
  const remFrac = live ? Math.max(0.02, 1 - liveMinute(m, r) / 90) : 1;   // live: scale remaining goals by time left
  lamH *= remFrac; lamA *= remFrac;
  if (live) {   // man-advantage from red cards, scaled by remaining time (a 90'+ red barely moves it)
    const reds = liveReds(r), f = remFrac;
    if (reds.h) { lamH *= Math.pow(1 - 0.30 * f, reds.h); lamA *= Math.pow(1 + 0.35 * f, reds.h); }
    if (reds.a) { lamA *= Math.pow(1 - 0.30 * f, reds.a); lamH *= Math.pow(1 + 0.35 * f, reds.a); }
    if (reds.h !== reds.a) { const downH = reds.h > reds.a; reasons.push({ key: "redcard", dir: downH ? "A" : "H", mag: 0.6 * f + 0.2, dot: true, text: `${nm(downH ? hc : ac)} down to 10` }); }
  }
  lamH = Math.max(0.18, lamH); lamA = Math.max(0.18, lamA);
  const lead = live && r && r.h != null ? r.h - r.a : 0, baseH = live ? r.h : 0, baseA = live ? r.a : 0;
  let pH = 0, pD = 0, pA = 0, exH = 0, exA = 0; const cells = [];
  for (let rh = 0; rh < 9; rh++) for (let ra = 0; ra < 9; ra++) {
    const p = _pois(rh, lamH) * _pois(ra, lamA) * (live ? 1 : _dcTau(rh, ra, lamH, lamA)), fin = lead + rh - ra;
    if (fin > 0) pH += p; else if (fin < 0) pA += p; else pD += p;
    cells.push({ h: baseH + rh, a: baseA + ra, p });   // FINAL score (live = current + remaining), for the scoreline
    exH += (baseH + rh) * p; exA += (baseA + ra) * p;   // expected goals = the MEAN of the distribution (higher than its mode, which is the "likely score")
  }
  const tot = pH + pD + pA || 1;
  let probH = pH / tot, probD = pD / tot, probA = pA / tot;
  // early-tournament calibration (pre-match only): while teams have barely shown form, hedge toward a draw-aware
  // base — cagey openers draw far more than a confident Elo split implies. Shrink decays to 0 by the knockouts.
  // A principled uncertainty knob from the research range (15-20%), NOT a fit to results.
  if (!live) {
    const pld = c => S.matches.reduce((n, x) => n + (matchHasTeam(x, c) && status(x) === ST.FT ? 1 : 0), 0);
    const sh = 0.18 * Math.max(0, 1 - (pld(hc) + pld(ac)) / 6);
    if (sh > 0) { probH = (1 - sh) * probH + sh * 0.35; probD = (1 - sh) * probD + sh * 0.30; probA = (1 - sh) * probA + sh * 0.35; }
  }
  if (stk?.draw) {   // reshape the draw to the qualification incentive, then refill home/away proportionally (cap at 0.55)
    const newD = stk.draw.mode === "boost" ? Math.min(0.55, probD + stk.draw.w * (0.50 - probD)) : probD * stk.draw.w;
    const oldRest = probH + probA || 1, rest = 1 - newD;
    probH = probH / oldRest * rest; probA = probA / oldRest * rest; probD = newD;
  }
  const predicted = cells.sort((x, y) => y.p - x.p).slice(0, 3).map(c => ({ h: c.h, a: c.a, p: c.p / tot }));
  return { h: probH, d: probD, a: probA, live, ko,
    adv: ko ? { h: probH + 0.5 * probD, a: probA + 0.5 * probD } : null,   // KO: a 90' draw → ET/pens, split 50/50
    predicted, drawMode: predicted[0] && predicted[0].h === predicted[0].a, xg: { h: exH / tot, a: exA / tot },
    reasons: reasons.sort((x, y) => y.mag - x.mag).slice(0, 3) };
}
function winProbBlock(m, pre = false) {
  const wp = winProb(m, pre); if (!wp) return "";
  const h = slotInfo(m, "home"), a = slotInfo(m, "away");
  const ph = Math.round(wp.h * 100), pd = Math.round(wp.d * 100), pa = 100 - ph - pd;
  const legend = wp.ko && wp.adv
    ? `<div class="wp-legend"><span class="wp-lh"><b>${Math.round(wp.adv.h * 100)}%</b> ${flag(h.code)} <span class="wp-lname">${esc(h.name)}</span></span><span class="wp-ld">advance</span><span class="wp-la"><span class="wp-lname">${esc(a.name)}</span> ${flag(a.code)} <b>${Math.round(wp.adv.a * 100)}%</b></span></div>`
    : `<div class="wp-legend"><span class="wp-lh"><b>${ph}%</b> ${flag(h.code)} <span class="wp-lname">${esc(h.name)}</span></span><span class="wp-ld">Draw <b>${pd}%</b></span><span class="wp-la"><span class="wp-lname">${esc(a.name)}</span> ${flag(a.code)} <b>${pa}%</b></span></div>`;
  // the single "projected score" is dropped — the "Most likely scores" tiles (rendered just below) say it better
  return `<div class="eyebrow">Win probability <span class="wp-est">${wp.live ? "live estimate" : "pre-match estimate"}</span>${infoBtn("A Dixon-Coles goals model. Each side's strength is a World-Football Elo that updates after every result (blending in FIFA's expected goals), nudged by host advantage and, late in the groups, by what each team still needs to qualify. The most-likely scores below are the model's top scorelines. A clearly-labelled estimate, not a betting line.", "How win probability is calculated")}</div>
    <div class="wp">
      <div class="wp-bar" role="img" aria-label="${esc(h.name)} ${ph}%, draw ${pd}%, ${esc(a.name)} ${pa}%">
        <span class="wp-h" style="width:${ph}%"></span><span class="wp-d" style="width:${pd}%"></span><span class="wp-a" style="width:${pa}%"></span></div>
      ${legend}</div>`;
}
/* ---------------- stakes explainer ----------------
   Plain-language "what this result means for qualification" on group matches. Pure points-based reasoning over
   every still-possible W/D/L of the group's unfinished matches, so each claim survives goal-difference tiebreaks;
   where the cut IS GD-dependent we don't fake a call — we fall back to the live standing. No new data. */
function _basePts(g) {                                    // FT-only points — the definite base (feed-final only)
  const pts = {}; groupTeams(g).forEach(c => pts[c] = 0);
  for (const m of S.matches) if (m.group === g && isFeedFinal(m)) {
    const r = res(m);
    if (r.h > r.a) pts[m.home.team] += 3; else if (r.h < r.a) pts[m.away.team] += 3;
    else { pts[m.home.team]++; pts[m.away.team]++; }
  }
  return pts;
}
// For team X: over every W/D/L of the group's unfinished matches (optionally fixing match `fixId` to `fixOut`),
// is X *guaranteed* top-two (≤1 other team can reach its points) and/or *out* of top-two (≥2 teams beat it)?
function _qualScan(g, X, fixId, fixOut) {
  const teams = groupTeams(g), rem = S.matches.filter(m => m.group === g && !isFeedFinal(m));   // a stale-live match is "still to be decided" for guarantees, not folded in as final
  let allTop2 = true, allOut = true;
  const rec = (i, pts) => {
    if (i === rem.length) {
      const px = pts[X]; let ge = 0, gt = 0;
      for (const t of teams) if (t !== X) { if (pts[t] >= px) ge++; if (pts[t] > px) gt++; }
      if (ge > 1) allTop2 = false;     // someone else could match/beat X → not guaranteed top-two here
      if (gt < 2) allOut = false;      // fewer than two strictly above → X could still be top-two here
      return;
    }
    const m = rem[i], h = m.home.team, a = m.away.team;
    for (const o of (fixId && m.id === fixId ? [fixOut] : ["h", "d", "a"])) {
      const np = { ...pts };
      if (o === "h") np[h] += 3; else if (o === "a") np[a] += 3; else { np[h]++; np[a]++; }
      rec(i + 1, np);
    }
  };
  rec(0, _basePts(g));
  return { clinched: allTop2, out: allOut };
}
function _provRows(g) {                                    // FT + in-play points/GD/GF per team in a group
  const rows = {}; groupTeams(g).forEach(c => rows[c] = { code: c, pts: 0, gd: 0, gf: 0 });
  for (const m of S.matches) if (m.group === g) {
    const r = res(m); if (!r || r.h == null || ![ST.FT, ST.LIVE, ST.HT].includes(r.st)) continue;
    const H = rows[m.home.team], A = rows[m.away.team]; if (!H || !A) continue;
    H.gf += r.h; A.gf += r.a; H.gd += r.h - r.a; A.gd += r.a - r.h;
    if (r.h > r.a) H.pts += 3; else if (r.h < r.a) A.pts += 3; else { H.pts++; A.pts++; }
  }
  return rows;
}
// "as it stands" positions. The final tiebreak is the alphabetical code, so a single team's position is only
// meaningful when it isn't dead-level with a neighbour — callers (matchStakes) must guard for that.
function _provPos(g) {                                    // FT + in-play provisional positions ("as it stands")
  const pos = {};
  Object.values(_provRows(g)).sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.code.localeCompare(y.code))
    .forEach((r, i) => pos[r.code] = i + 1);
  return pos;
}
function matchStakes(m) {
  if (m.stage !== "group" || !m.group || status(m) === ST.FT) return null;
  const g = m.group, H = m.home.team, A = m.away.team;
  if (!H || !A || !S.matches.some(x => x.group === g && status(x) === ST.FT && res(x)?.h != null)) return null;
  const nm = c => `<b>${esc(S.teams[c]?.name || c)}</b>`;
  const say = code => {
    if (_qualScan(g, code).clinched) return `${nm(code)} are through to the Round of 32.`;
    if (_qualScan(g, code).out) return `${nm(code)} can no longer finish in the top two.`;
    const win = code === H ? "h" : "a", lose = code === H ? "a" : "h";
    if (_qualScan(g, code, m.id, "d").clinched) return `A draw is enough to send ${nm(code)} through.`;
    if (_qualScan(g, code, m.id, win).clinched) return `Win and ${nm(code)} are through.`;
    if (_qualScan(g, code, m.id, lose).out) return `${nm(code)} drop out of the top two if they lose.`;
    if (_qualScan(g, code, m.id, win).out) return `Even a win can't lift ${nm(code)} into the top two.`;
    return null;
  };
  const lines = [say(H), say(A)].filter(Boolean);
  if (lines.length) return { lines, definitive: true };          // crisp qualification call
  // "As it stands" positions are only meaningful for teams that have actually played — a team on 0
  // games is "Nth" purely by tiebreak among everyone tied on 0 points, which misreads as a real standing.
  const counted = x => { const r = res(x); return r && r.h != null && [ST.FT, ST.LIVE, ST.HT].includes(r.st); };
  const playedIn = code => S.matches.some(x => x.group === g && (x.home.team === code || x.away.team === code) && counted(x));
  const pH = playedIn(H), pA = playedIn(A);
  if (!pH && !pA) return { lines: [`Both sides open their Group ${g} campaign.`], definitive: false };
  // A team's "position" is only real if it isn't dead-level with ANY other group member: when teams tie on
  // points/GD/goals the order is decided purely by the alphabetical code tiebreak, which misreads as a real
  // standing (the "Ecuador 3rd at 0–0" bug — and it also bites when a side is level with a THIRD team, not just
  // its opponent, e.g. a group that opens with four draws). In that case say "level", never an ordinal.
  const R = _provRows(g);
  const levelWithAny = c => Object.values(R).some(o => o.code !== c && o.pts === R[c].pts && o.gd === R[c].gd && o.gf === R[c].gf);
  if (pH && pA && R[H] && R[A] && R[H].pts === R[A].pts && R[H].gd === R[A].gd && R[H].gf === R[A].gf)
    return { lines: [`${nm(H)} and ${nm(A)} are level in Group ${g} so far.`], definitive: false };
  const p = _provPos(g), lvlH = pH && levelWithAny(H), lvlA = pA && levelWithAny(A);
  if (lvlH && lvlA)   // both sit level — say it once, not "X are level on points and Y are level on points"
    return { lines: [`${nm(H)} and ${nm(A)} are level on points in Group ${g} so far.`], definitive: false };
  const parts = [];
  if (pH) parts.push(lvlH ? `${nm(H)} are level on points` : `${nm(H)} are ${ordinal(p[H])}`);
  if (pA) parts.push(lvlA ? `${nm(A)} are level on points` : `${nm(A)} are ${ordinal(p[A])}`);
  return { lines: [`As it stands, ${parts.join(" and ")} in Group ${g}.`], definitive: false };
}
function stakesBlock(m) {
  const s = matchStakes(m); if (!s) return "";
  return `<div class="eyebrow">What's at stake</div><ul class="stakes">${s.lines.map(l => `<li>${l}</li>`).join("")}</ul>`;
}
function openMatch(id, reuse) {   // reuse: re-render the body in place (a live poll) without re-animating the dialog
  const m = S.matches.find(x => x.id === id); if (!m) return;
  const h = slotInfo(m, "home"), a = slotInfo(m, "away"), r = res(m), st = status(m);
  const live = st === ST.LIVE || st === ST.HT;
  const score = r && r.h != null;
  const stageL = m.group ? `Group ${m.group}` : m.stage === "third" ? "3rd place" : m.round;
  const sv = isSaved(id);
  const statusTag = st === ST.LIVE ? `<span class="md-tag live">● Live ${clockStr(m, r)}</span>`
    : st === ST.HT ? `<span class="md-tag live">Half-time</span>`
    : st === ST.FT ? `<span class="md-tag ft">Full time</span>`
    : `<span class="md-tag soon">Upcoming</span>`;   // time/date live in the meta row below — no need to repeat it
  const side = (s, key) => `<div class="md-team ${s.code === S.fav ? "is-fav" : ""}${s.code ? " md-team-clk" : ""}"${s.code ? ` data-squad="${s.code}" role="button" tabindex="0" aria-label="Open ${esc(s.name)} details"` : ""}>
      <span class="md-flag">${s.code ? flag(s.code) : TBD_FLAG}</span>
      <span class="md-name ${s.ph ? "is-ph" : ""}">${esc(slotText(m, key, s))}</span>
      ${s.code ? `<span class="md-teaminfo">${esc(S.teams[s.code].conf || "")}${fifaRankOf(s.code) ? ` · <span class="md-rank" title="FIFA World Ranking">#${fifaRankOf(s.code)}</span>` : ""}${S.teams[s.code].titles ? ` · ${TROPHY} ${S.teams[s.code].titles}` : ""}</span>` : ""}</div>`;
  const mid = (score || live)
    ? `<div class="md-score">${r?.h ?? 0}<span>–</span>${r?.a ?? 0}</div>${r?.hp != null ? `<div class="md-pens">${r.hp}–${r.ap} on penalties</div>` : ""}`
    : `<div class="md-vs">VS</div>`;
  const liveNow = st === ST.LIVE || st === ST.HT;
  $("#matchTitle").innerHTML = `<span class="md-stage">${esc(stageL)}</span>`;
  const isFT = st === ST.FT;
  // every section as its own piece (each returns "" when it doesn't apply), then ordered per match state below
  const pTop = `<div class="md-tagrow">${statusTag}
      <div class="md-actions">
        <button class="md-share" data-share-match="${id}" aria-label="Share this match" title="Share this match">${SHARE_SVG}</button>
        ${isFT ? "" : `<button class="md-cal" data-cal="${id}" aria-label="Add to calendar" title="Add this match to your calendar">${CAL_SVG}</button>`}
        <button class="md-save ${sv ? "is-on" : ""}" data-save="${id}" aria-pressed="${sv}" aria-label="${sv ? "Remove from saved" : "Save match"}" title="${sv ? "Remove from saved" : "Save match"}">${sv ? "★" : "☆"}</button>
      </div>
    </div>
    <div class="md-teams">${side(h, "home")}<div class="md-mid">${mid}</div>${side(a, "away")}</div>
    ${koPath(m)}`;
  const pTimeline = r?.ev?.length ? mdTimeline(r, h.code, a.code) : (r?.gh?.length || r?.ga?.length) ? `<div class="md-goals">
      <div class="md-goals-col">${(r.gh || []).map(g => `<div class="md-goal">${ICO.ball} ${esc(g)}</div>`).join("")}</div>
      <div class="md-goals-col away">${(r.ga || []).map(g => `<div class="md-goal">${esc(g)} ${ICO.ball}</div>`).join("")}</div>
    </div>` : "";
  const pKeyStats = mdKeyStats(r, m), pStats = mdStats(r, isFT), pEfi = mdEfi(m, isFT);
  // win-prob: in-play for a live game (reflects the score), the model's pre-match call otherwise — plus its "why" drivers + top-3 scorelines
  const pre = !live, _wp = winProb(m, pre);
  const pWinProb = _wp ? winProbBlock(m, pre) + liveWhyChips(_wp) + liveScorelines(_wp) : "";
  const pReport = mdReport(m), pComm = mdCommentaryShell(m), pStakes = stakesBlock(m), pCompare = matchCompare(m), pStars = liveStars(m);
  const pXiInline = r?.xi ? `<div class="eyebrow">${liveNow ? "Line-ups" : "Starting XI"}</div>${xiPanel(r.xi, h, a)}` : "";
  const pXiFold = r?.xi ? `<details class="md-fold"><summary><span>Starting XI</span><small>${esc([r.xi.h?.f, r.xi.a?.f].filter(Boolean).join(" v ")) || "line-ups & formations"}</small></summary><div class="md-fold-body">${xiPanel(r.xi, h, a)}</div></details>` : "";
  // "how they compare" rides along as a collapsed fold for live/finished games (it leads expanded in the upcoming branch)
  const pCompareFold = (live || isFT) && pCompare ? `<details class="md-fold"><summary><span>How they compare</span><small>rankings &amp; tournament form</small></summary><div class="md-fold-body">${pCompare}</div></details>` : "";

  const pMeta = `<div class="md-meta">
      <span>${fmt(m.utc, { weekday: "long", day: "numeric", month: "long" })}</span>
      <span>${timeStr(m.utc)}</span>
      <span>${esc(m.stadium)}</span>
      <span>${esc(m.city)}</span>
      ${r?.facts?.att ? `<span>${ICO.people} ${(+r.facts.att).toLocaleString()} in</span>` : ""}
      ${r?.facts?.ref ? `<span>Referee · ${esc(r.facts.ref)}</span>` : ""}
    </div>`;
  // order by state so each opens with what you came for (Live folds in here — no separate tab as of build 329).
  const middle = liveNow
    // live: analytics lead (win-prob), then the live feed, then the numbers, match stars, deep dive, stakes
    ? [pWinProb, pComm, pKeyStats, pStars, pTimeline, pStats, pXiInline, pEfi, pCompareFold, pStakes]
    : isFT
    // finished: the report leads, then key stats, stars, the full timeline & numbers, the model's call, the deep dive
    ? [pReport, pKeyStats, pStars, pTimeline, pStats, pXiInline, pEfi, pWinProb, pCompareFold, pStakes]
    : [pStakes, pCompare, pWinProb, pXiInline];   // upcoming: stakes + head-to-head compare + odds + (announced) line-ups
  const _body = pTop + middle.join("") + pMeta;
  const mb = $("#matchBody");
  if (reuse) paint(mb, _body);                       // live poll: morph the body in place — score/minute/timeline/stats update while expanded folds, scroll & loaded commentary survive
  else { mb.__sig = _body; mb.innerHTML = _body; }   // fresh open: one clean render (seed the signature so the first refresh morphs against it)
  const md = $("#matchDialog"); md.dataset.openMid = id; if (!reuse) showSheet(md);   // openMid (not data-mid) so the global match-open click handler never matches the dialog itself
  // live commentary is per-match; fetch it when the section is open (it opens by default for live games)
  const comm = $("#mdComm", md);
  if (comm && !comm.__wired) {     // __wired is a JS property (survives morph) so a live refresh never stacks a 2nd toggle listener
    comm.__wired = true;
    const loadComm = async () => {
      if (!comm.open || comm.dataset.loaded) return;
      comm.dataset.loaded = "1";
      const body = $("#mdCommBody", md);
      body.innerHTML = `<div class="md-comm-spin">Loading commentary…</div>`;
      body.innerHTML = renderCommentary(await loadCommentary(m.num));
    };
    comm.addEventListener("toggle", loadComm);
    if (comm.open) loadComm();   // <details open> doesn't fire toggle on render — kick it off manually
  }
}

/* ---------------- render: matches (today + full calendar) ---------------- */
let cdTimer = null, prevCd = {};
// The hero area. Stacked (vertical), not a swipe carousel: when two games kick off at once both stay visible
// at a glance with zero gestures — a carousel would hide the second match behind an undiscoverable swipe and
// add interaction cost for no benefit when there are only ever a handful. A header labels the count when >1.
function heroStack(liveMatches, nextM) {
  if (!liveMatches.length) return nextM ? heroBlock(nextM, false) : "";
  const head = liveMatches.length > 1
    ? `<div class="hero-stack-head">${ballSVG("live-ball")} ${liveMatches.length} matches live now</div>` : "";
  return head + `<div class="hero-stack">${liveMatches.map(m => heroBlock(m, true)).join("")}</div>`;
}
// The single hero card, used on BOTH the Matches tab (tappable → opens the Live tab) and the Live tab
// (onLive: same look, but you're already following so no "Follow" CTA / self-navigation). Renders live
// score + ticking-minute chip, a final score for FT, or VS + win-prob + countdown for an upcoming match.
function heroBlock(heroM, isLive, onLive) {
  const h = slotInfo(heroM, "home"), a = slotInfo(heroM, "away"), r = res(heroM), st = status(heroM);
  const live = isLive != null ? isLive : [ST.LIVE, ST.HT].includes(st);   // Matches tab passes it; Live tab derives the state
  const ft = !live && st === ST.FT, clickable = !onLive;
  const tag = live ? `${ballSVG("live-ball")} Live now` : ft ? `● Full time` : `${isFavMatch(heroM) ? "Your team · " : ""}Next kickoff`;
  return `<div class="hero${onLive ? " hero-onlive" : ""}"${clickable ? ` data-hero-live="${heroM.id}" role="button" tabindex="0" aria-label="Follow ${esc(h.name)} v ${esc(a.name)} in the Live tab"` : ""}>
    <div class="hero-tag ${live ? "is-live" : ft ? "is-ft" : ""}">
      ${tag}<span style="color:var(--ink-soft);font-weight:600"> · ${esc(heroM.group ? "Group " + heroM.group : heroM.round)}</span>
      ${clickable ? `<span class="hero-actions"><span class="hero-go">Follow ›</span></span>` : ""}
    </div>
    <div class="hero-teams">
      <div class="hero-side"><span class="hero-flag">${h.code ? flag(h.code) : TBD_FLAG}</span><span class="hero-name">${esc(h.name)}</span></div>
      <div class="hero-mid">${live || ft
        ? `<span class="hero-score">${r?.h ?? 0}–${r?.a ?? 0}</span>${live
            ? `<span class="hero-livechip">${r?.st === ST.HT ? "Half-time" : (clockStr(heroM, r) || "Live")}</span>`
            : (r?.hp != null ? `<span class="hero-pens">${r.hp}–${r.ap} pens</span>` : "")}`
        : `<span class="hero-vs">VS</span>`}</div>
      <div class="hero-side"><span class="hero-flag">${a.code ? flag(a.code) : TBD_FLAG}</span><span class="hero-name">${esc(a.name)}</span></div>
    </div>
    ${!ft ? (() => { const s = matchStakes(heroM); return s ? `<div class="hero-stakes">${s.lines[0]}</div>` : ""; })() : ""}
    ${!live && !ft && !onLive ? (() => { const wp = winProb(heroM); if (!wp) return "";   // pre-match only; on the Live tab the dedicated win-prob section below already covers it
      if (wp.ko && wp.adv) { const ph = Math.round(wp.adv.h * 100), pa = 100 - ph;   // knockout: show advance % (a 90' draw goes to ET/pens), no "draw" segment
        return `<div class="hero-wp" aria-label="${esc(h.name)} ${ph}% to advance, ${esc(a.name)} ${pa}%"><span class="hero-wp-bar"><i class="wp-h" style="width:${ph}%"></i><i class="wp-a" style="width:${pa}%"></i></span><span class="hero-wp-tx"><b>${ph}%</b><span>to advance</span><b>${pa}%</b></span></div>`; }
      const ph = Math.round(wp.h * 100), pd = Math.round(wp.d * 100), pa = 100 - ph - pd;
      return `<div class="hero-wp" aria-label="${esc(h.name)} ${ph}%, draw ${pd}%, ${esc(a.name)} ${pa}%"><span class="hero-wp-bar"><i class="wp-h" style="width:${ph}%"></i><i class="wp-d" style="width:${pd}%"></i><i class="wp-a" style="width:${pa}%"></i></span><span class="hero-wp-tx"><b>${ph}%</b><span>draw ${pd}%</span><b>${pa}%</b></span></div>`; })() : ""}
    ${!live && !ft ? `<div class="countdown" data-utc="${heroM.utc}">
      ${["h", "m"].map((k, i) => `${i ? `<span class="cd-sep" aria-hidden="true">:</span>` : ""}<div class="cd-cell"><span class="cd-num" data-k="${k}">–</span><span class="cd-lab">${{ h: "hrs", m: "min" }[k]}</span></div>`).join("")}
    </div>` : ""}
    <div class="hero-meta">
      <span><b>${timeStr(heroM.utc)}</b></span>
      <span>${esc(heroM.stadium)}</span><span>${esc(heroM.city)}</span>
      <span>${fmt(heroM.utc, { weekday: "short", day: "numeric", month: "short" })}</span>
    </div>
  </div>`;
}
// "Match of the day" — the marquee fixture among the next slate of upcoming/live games, scored by
// stage weight + the two teams' World Cup pedigree + a host bonus. A rolling window over the next few
// fixtures (not a local-day boundary) so a late-night kickoff isn't shoved into "tomorrow" by the tz.
const MOTD_STAGE = { group: 0, r32: 3, r16: 4, qf: 6, sf: 8, third: 5, final: 12 };
const HOSTS = ["CA", "MX", "US"];
// how marquee a fixture is: stage weight + the two teams' current strength (Elo) + historic pedigree (titles) +
// a host bonus. Elo is the main team-quality signal — titles alone can't rank a Netherlands–Croatia tie (both
// 0 titles) above a minnows game; the closeness of the two sides also nudges a balanced heavyweight clash up.
function prestige(m) {
  const h = slotInfo(m, "home"), a = slotInfo(m, "away");
  const eh = S.teams[h.code]?.elo || 1500, ea = S.teams[a.code]?.elo || 1500;
  const strength = (eh + ea - 3000) / 80;          // combined quality, ~0 (minnows) … ~14 (two giants)
  const even = h.code && a.code ? Math.max(0, 3 - Math.abs(eh - ea) / 120) : 0;   // closely-matched = more marquee
  const titles = (S.teams[h.code]?.titles || 0) + (S.teams[a.code]?.titles || 0);
  const host = HOSTS.includes(h.code) || HOSTS.includes(a.code) ? 1 : 0;
  return (MOTD_STAGE[m.stage] || 0) + strength + even + titles + host + (!!h.code + !!a.code);   // prefer known fixtures
}
const marqueeOf = list => list.length ? list.slice().sort((a, b) => prestige(b) - prestige(a) || a.utc.localeCompare(b.utc))[0] : null;
// the marquee of TODAY's remaining fixtures — "today" is the visitor's local day (same one the ticker uses), so
// it's never a tomorrow match mislabelled "of the day", and it re-computes when you change timezone. Null on a
// rest day with nothing left to play (the hero's next-kickoff card carries the gap instead).
function matchOfDay() {
  const todayK = viewDay(new Date().toISOString());
  return marqueeOf(S.matches.filter(m => status(m) !== ST.FT && viewDay(m.utc) === todayK));
}
function motdBanner(m) {
  const h = slotInfo(m, "home"), a = slotInfo(m, "away");
  const nm = (s, side) => s.code ? esc(s.name) : esc(slotText(m, side, s));
  return `<button class="motd" data-mid="${m.id}" aria-label="Match of the day, details">
    <span class="motd-tag">★ Match of the day</span>
    <span class="motd-fix"><span class="fl">${h.code ? flag(h.code) : TBD_FLAG}</span>${nm(h, "home")}<i>v</i>${nm(a, "away")}<span class="fl">${a.code ? flag(a.code) : TBD_FLAG}</span></span>
    <span class="motd-meta"><b>${timeStr(m.utc)}</b> · ${esc(m.group ? "Group " + m.group : m.round)} · ${esc((m.city || "").split(",")[0])}</span>
  </button>`;
}

// the model's discarded "why" drivers, surfaced as chips (host edge, form, down to 10, two leaky defences…)
function liveWhyChips(wp) {
  if (!wp?.reasons?.length) return "";
  const chips = wp.reasons.map(rs => {
    const arrow = rs.dir === "H" ? "◂ " : rs.dir === "A" ? "▸ " : "";
    return `<span class="why-chip${rs.dot ? " why-live" : ""}"><i class="why-dir">${arrow}</i>${esc(rs.text)}</span>`;
  }).join("");
  return `<div class="why-chips">${chips}</div>`;
}
// the model's discarded top-3 most-likely scorelines, as tiles
function liveScorelines(wp) {
  if (!wp?.predicted?.length) return "";
  const tiles = wp.predicted.slice(0, 3).map(s => `<div class="sl-tile"><b>${s.h}–${s.a}</b><i>${Math.round(s.p * 100)}%</i></div>`).join("");
  return `<div class="eyebrow">Most likely scores</div><div class="sl-tiles">${tiles}</div>`;
}
// a team's record + each result so far THIS World Cup (FT matches only)
function teamWcRecord(code) {
  const played = S.matches.filter(x => matchHasTeam(x, code) && status(x) === ST.FT).sort((p, q) => p.utc.localeCompare(q.utc));
  let w = 0, d = 0, l = 0, gf = 0, ga = 0; const results = [];
  for (const x of played) {
    const r = res(x); if (!r || r.h == null) continue;
    const home = slotInfo(x, "home").code === code, my = home ? r.h : r.a, opp = home ? r.a : r.h;
    gf += my; ga += opp; if (my > opp) w++; else if (my < opp) l++; else d++;
    results.push({ opp: home ? slotInfo(x, "away").code : slotInfo(x, "home").code, my, oga: opp, wdl: my > opp ? "w" : my < opp ? "l" : "d", mid: x.id });
  }
  return { w, d, l, gf, ga, n: results.length, results };
}
// pre-match head-to-head: rank + this-tournament record compared, plus each side's results so far (brief score chips)
function matchCompare(m) {
  const h = slotInfo(m, "home"), a = slotInfo(m, "away");
  if (!h.code || !a.code) return "";
  const recA = teamWcRecord(h.code), recB = teamWcRecord(a.code), rkA = fifaRankOf(h.code), rkB = fifaRankOf(a.code);
  const numRow = (label, av, bv, hi, da = av, db = bv) => {
    const aw = av != null && bv != null && av !== bv && (hi ? av > bv : av < bv);
    const bw = av != null && bv != null && av !== bv && (hi ? bv > av : bv < av);
    return `<div class="cmp-row"><span class="cmp-a ${aw ? "win" : ""}">${da ?? "–"}</span><span class="cmp-lbl">${label}</span><span class="cmp-b ${bw ? "win" : ""}">${db ?? "–"}</span></div>`;
  };
  const has = recA.n || recB.n;
  const resChips = rec => rec.n ? rec.results.map(x => `<span class="mc-res mc-res-${x.wdl}" data-mid="${x.mid}" role="button" tabindex="0" title="${esc(S.teams[x.opp]?.name || x.opp)}">${flag(x.opp)} ${x.my}–${x.oga}</span>`).join("") : `<span class="mc-none">No matches yet</span>`;
  return `<div class="eyebrow">How they compare</div>
    <div class="mc-cmp">
      <div class="mc-head"><span class="mc-team"><span class="fl">${flag(h.code)}</span>${esc(h.name)}</span><span class="mc-vs">vs</span><span class="mc-team mc-rt">${esc(a.name)}<span class="fl">${flag(a.code)}</span></span></div>
      <div class="cmp-rows">
        ${numRow("FIFA rank", rkA, rkB, false, rkA ? "#" + rkA : null, rkB ? "#" + rkB : null)}
        ${has ? `<div class="cmp-row"><span class="cmp-a">${recA.w}-${recA.d}-${recA.l}</span><span class="cmp-lbl">W-D-L</span><span class="cmp-b">${recB.w}-${recB.d}-${recB.l}</span></div>` : ""}
        ${has ? numRow("Goals for", recA.gf, recB.gf, true) : ""}
        ${has ? numRow("Goals against", recA.ga, recB.ga, false) : ""}
      </div>
      <div class="mc-reslabel">Results so far</div>
      <div class="mc-reswrap"><div class="mc-resrow">${resChips(recA)}</div><div class="mc-resrow">${resChips(recB)}</div></div>
    </div>`;
}
// "Match stars" — large portrait cards of the goalscorers (live/FT), else each side's leading scorer (upcoming).
// Photo-led: a player with no headshot is skipped, and the whole section drops in data-saver (bestPhoto returns "").
function liveStars(m) {
  const h = slotInfo(m, "home"), a = slotInfo(m, "away"), r = res(m) || {};
  if (!h.code || !a.code) return "";
  let items = [], label = "Match stars";
  const tally = new Map();
  for (const e of (r.ev || [])) {            // goalscorers in THIS match (own goals credit the opponent, so skip)
    if (!["G", "P"].includes(e.k) || !e.p) continue;
    const code = e.tm === "h" ? h.code : a.code, key = e.p + "|" + code;
    const t = tally.get(key) || { name: e.p, code, goals: 0, mins: [] };
    t.goals++; if (e.t) t.mins.push(e.t); tally.set(key, t);
  }
  if (tally.size) {
    items = [...tally.values()].sort((x, y) => y.goals - x.goals).slice(0, 6)
      .map(s => ({ name: s.name, code: s.code, sub: `${s.goals} goal${s.goals > 1 ? "s" : ""}${s.mins.length ? " · " + s.mins.join(", ") : ""}` }));
    // beyond goals: the match's top defender + top keeper from FIFA's key-performer data (lead[])
    const topOf = k => (r.lead || []).filter(L => L.k === k && L.n && +L.v > 0).sort((x, y) => (+y.v) - (+x.v))[0];
    const def = topOf("defensiveInterventions");
    if (def) items.push({ name: def.n, code: def.c, sub: `${def.v} defensive actions`, role: "Top defender" });
    const kp = topOf("saves");
    if (kp) items.push({ name: kp.n, code: kp.c, sub: `${kp.v} save${+kp.v > 1 ? "s" : ""}`, role: "Top keeper" });
  } else {                                   // no goals yet → each side's leading tournament scorer
    const sc = tournamentStats().scorers, pick = c => sc.filter(p => p.code === c && p.goals > 0).sort((x, y) => y.goals - x.goals)[0];
    items = [pick(h.code), pick(a.code)].filter(Boolean).map(s => ({ name: s.name, code: s.code, sub: `${s.goals} goal${s.goals > 1 ? "s" : ""} so far` }));
    label = "Ones to watch";
  }
  const card = s => {
    const photo = bestPhoto(s.name, s.code); if (!photo) return "";
    const big = atWidth(photo, 400) || photo, c1 = S.teams[s.code]?.c1 || "var(--pitch)";
    return `<button class="star-card" data-player="${esc(s.name)}|${s.code}" style="--sc:${c1}" aria-label="${esc(pName(s.name, s.code))}">
      <span class="star-photo" style="background-image:url('${big}')"></span>
      <span class="star-info">${s.role ? `<span class="star-role">${esc(s.role)}</span>` : ""}<span class="star-top"><span class="fl">${flag(s.code)}</span><b>${esc(pName(s.name, s.code))}</b></span><span class="star-sub">${esc(s.sub)}</span></span></button>`;
  };
  const cards = items.map(card).filter(Boolean).join("");
  return cards ? `<div class="eyebrow">${label}${infoBtn("The match's goalscorers (most goals first), plus the top defender (most defensive actions) and top goalkeeper (most saves) from FIFA's key-performer data. Before kickoff it shows each team's leading scorer this tournament.", "How match stars are chosen")}</div><div class="star-row">${cards}</div>` : "";
}
function renderMatches() {
  const el = $("#view-matches");
  const now = new Date();
  const todayK = dayKey(now.toISOString());
  // Simultaneous kickoffs are normal at a World Cup — the final round of every group plays its two games at
  // the same time — so don't pick one "the" live match; surface them all. When nothing's live, a single
  // next-kickoff card carries the countdown.
  const liveMatches = S.matches.filter(m => [ST.LIVE, ST.HT].includes(status(m)))
    .sort((a, b) => a.utc.localeCompare(b.utc));
  const nextM = liveMatches.length ? null
    // include a SCHED match whose kickoff just passed (feed not yet flipped to LIVE) so the hero never goes blank
    // in that gap; the countdown clamps to 0 and re-polls. Bounded to ~2.5h overdue so a stuck fixture isn't pinned.
    : S.matches.filter(m => status(m) === ST.SCHED && new Date(m.utc).getTime() > now.getTime() - 9e6).sort((a, b) => a.utc.localeCompare(b.utc))[0];
  const heroIds = new Set([...liveMatches.map(m => m.id), ...(nextM ? [nextM.id] : [])]);
  const f = S.filters;
  let list = S.matches.slice().sort((a, b) => a.utc.localeCompare(b.utc));
  if (f.stage === "group") list = list.filter(m => m.stage === "group");
  if (f.stage === "ko") list = list.filter(m => m.stage !== "group");
  if (f.team) list = list.filter(m => matchHasTeam(m, f.team));
  if (f.saved) list = list.filter(m => isSaved(m.id));

  // 1A: finished games go into a collapsible "Earlier results"; live + upcoming show below
  const dayGroups = arr => { const d = {}; arr.forEach(m => (d[dayKey(m.utc)] ??= []).push(m)); return Object.entries(d).map(([k, ms]) => `<div class="dayhead ${k === todayK ? "is-today" : ""}">${dayLabel(ms[0].utc)} <small>${ms.length} match${ms.length > 1 ? "es" : ""}</small></div>` + ms.map((m, i) => matchCard(m, Math.min(i, 8))).join("")).join(""); };
  const past = list.filter(m => status(m) === ST.FT);
  const ahead = list.filter(m => status(m) !== ST.FT);

  const motd = matchOfDay();   // skip if it's already a hero card (live/next) — no point showing it twice
  paint(el,
    heroStack(liveMatches, nextM) +
    (motd && !heroIds.has(motd.id) ? motdBanner(motd) : "") +
    `<div class="filters">
      <div class="tsel ${f.stage !== "all" ? "is-on" : ""}" id="stageSelWrap">
        <button type="button" class="fsel tsel-btn" id="stageSelBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Filter by stage">
          <span class="tsel-cur">${({ all: "All 104 matches", group: "Group stage", ko: "Knockouts" })[f.stage] || "All 104 matches"}</span>
        </button>
        <div class="tsel-pop" id="stageSelPop" data-keep hidden>
          <div class="tsel-list" role="listbox" aria-label="Stage">
            ${[["all", "All 104 matches"], ["group", "Group stage"], ["ko", "Knockouts"]].map(([k, l]) =>
              `<button type="button" class="tsel-opt${f.stage === k ? " is-sel" : ""}" role="option" aria-selected="${f.stage === k}" data-stage="${k}"><span class="tsel-opt-name">${l}</span>${f.stage === k ? `<span class="tsel-tick" aria-hidden="true">✓</span>` : ""}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="tsel ${f.team ? "is-on" : ""}" id="teamSelWrap">
        <button type="button" class="fsel tsel-btn" id="teamSelBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Filter by team">
          ${f.team ? `<span class="fl">${flag(f.team)}</span><span class="tsel-cur">${esc(S.teams[f.team].name)}</span>` : `<span class="tsel-cur">All teams</span>`}
        </button>
        <div class="tsel-pop" id="teamSelPop" data-keep hidden>
          <input class="tsel-search" id="teamSelSearch" type="search" placeholder="Search 48 teams…" autocomplete="off">
          <div class="tsel-list" id="teamSelList" role="listbox" aria-label="Teams"></div>
        </div>
      </div>
      <button class="fbtn ${f.saved ? "is-on" : ""}" data-saved>★ Saved${S.saved.size ? ` <b>${S.saved.size}</b>` : ""}</button>
    </div>` +
    (f.saved && S.saved.size ? `<button class="saved-cal" data-cal-saved>${CAL_SVG} Add ${S.saved.size} saved match${S.saved.size > 1 ? "es" : ""} to calendar</button>` : "") +
    (past.length ? `<details class="earlier"><summary><span class="ear-tri">▸</span> Earlier results <b>${past.length}</b><span class="ear-hint">view</span></summary><div class="ear-body">${dayGroups(past)}</div></details>` : "") +
    (ahead.length ? dayGroups(ahead) : (past.length ? "" : `<div class="empty">No matches for this filter.</div>`)));

  startCountdown(el);
  const sbtn = $("#stageSelBtn", el);
  if (sbtn) {
    sbtn.onclick = () => { $("#stageSelPop").hidden ? openStagePop() : closeStagePop(); };
    $$("#stageSelPop .tsel-opt", el).forEach(b => b.onclick = () => { f.stage = b.dataset.stage; renderMatches(); });
  }
  const tb = $("#teamSelBtn", el);
  if (tb) {
    tb.onclick = () => { $("#teamSelPop").hidden ? openTeamSel() : closeTeamSel(); };
    $("#teamSelSearch", el).oninput = e => renderTeamSelList(e.target.value);
    // keyboard: the role="listbox" implies arrow-key traversal — wire it (↓/↑ move, Enter selects, ↑ off the top returns to search)
    $("#teamSelPop", el).onkeydown = e => {
      if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
      const opts = $$("#teamSelList .tsel-opt", el), cur = opts.indexOf(document.activeElement);
      if (!opts.length) return;
      if (e.key === "Enter") { if (cur >= 0) { e.preventDefault(); opts[cur].click(); } return; }
      e.preventDefault();
      if (cur === 0 && e.key === "ArrowUp") return $("#teamSelSearch", el).focus();
      const next = cur < 0 ? (e.key === "ArrowDown" ? 0 : opts.length - 1) : Math.max(0, Math.min(opts.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
      opts[next].focus();
    };
  }
  const sb = $("[data-saved]", el); if (sb) sb.onclick = () => { f.saved = !f.saved; renderMatches(); };
  const scb = $("[data-cal-saved]", el); if (scb) scb.onclick = () => downloadICS(S.matches.filter(m => isSaved(m.id)).sort((a, b) => a.utc.localeCompare(b.utc)), "My World Cup 2026 matches");
  // "Earlier results" lists oldest→newest, so on open jump to the most recent finished match (the last card,
  // just above the upcoming fixtures): the latest result is what you want first, and you scroll up for older.
  const ear = $("details.earlier", el);
  if (ear) ear.ontoggle = () => {
    if (!ear.open) return;
    const cards = $$(".ear-body .mcard-wrap", ear);
    cards[cards.length - 1]?.scrollIntoView({ block: "end", behavior: "smooth" });
  };
  requestAnimationFrame(updateJumpNow);
}
// custom searchable team filter (favourite pinned on top, then alphabetical)
function teamSelOptions(q = "") {
  const f = S.filters, ql = q.trim().toLowerCase();
  const fav = (S.fav && S.teams[S.fav]) ? S.fav : null;
  const opt = (val, name, lead, sel, tag = "") =>
    `<button type="button" class="tsel-opt${sel ? " is-sel" : ""}" role="option" aria-selected="${sel}" data-v="${val}">`
    + `${lead}<span class="tsel-opt-name">${name}${tag}</span>${sel ? `<span class="tsel-tick" aria-hidden="true">✓</span>` : ""}</button>`;
  let html = "";
  if (!ql || "all teams".includes(ql))
    html += opt("", "All teams", `<span class="tsel-globe" aria-hidden="true">🌍</span>`, f.team === "");
  if (fav && S.teams[fav].name.toLowerCase().includes(ql))
    html += opt(fav, esc(S.teams[fav].name), `<span class="fl">${flag(fav)}</span>`, f.team === fav, ` <span class="tsel-favtag" aria-hidden="true">★</span>`);
  const alpha = Object.keys(S.teams).filter(c => c !== fav)
    .sort((a, b) => S.teams[a].name.localeCompare(S.teams[b].name))
    .filter(c => S.teams[c].name.toLowerCase().includes(ql));
  if (alpha.length && html) html += `<div class="tsel-div" role="presentation"></div>`;
  html += alpha.map(c => opt(c, esc(S.teams[c].name), `<span class="fl">${flag(c)}</span>`, f.team === c)).join("");
  return html || `<div class="tsel-empty">No teams found</div>`;
}
function renderTeamSelList(q = "") {
  const l = $("#teamSelList"); if (!l) return;
  l.innerHTML = teamSelOptions(q);
  $$("#teamSelList .tsel-opt").forEach(b => b.onclick = () => { S.filters.team = b.dataset.v; renderMatches(); });
}
function openTeamSel() {
  const pop = $("#teamSelPop"); if (!pop) return;
  pop.hidden = false;
  $("#teamSelBtn")?.setAttribute("aria-expanded", "true");
  $("#teamSelWrap")?.classList.add("open");
  const s = $("#teamSelSearch"); if (s) { s.value = ""; renderTeamSelList(""); s.focus(); }
}
function closeTeamSel() {
  const pop = $("#teamSelPop"); if (!pop || pop.hidden) return;
  pop.hidden = true;
  $("#teamSelBtn")?.setAttribute("aria-expanded", "false");
  $("#teamSelWrap")?.classList.remove("open");
}
// stage filter — a custom dropdown (matches the team one) instead of a native <select>, whose Android
// picker is a jarring edge-to-edge OS sheet that breaks the look of the rest of the page
function openStagePop() {
  const pop = $("#stageSelPop"); if (!pop) return;
  pop.hidden = false;
  $("#stageSelBtn")?.setAttribute("aria-expanded", "true");
  $("#stageSelWrap")?.classList.add("open");
}
function closeStagePop() {
  const pop = $("#stageSelPop"); if (!pop || pop.hidden) return;
  pop.hidden = true;
  $("#stageSelBtn")?.setAttribute("aria-expanded", "false");
  $("#stageSelWrap")?.classList.remove("open");
}
// floating "jump to today/live" control.
// We target the first *match card* of the live/today group, not the day header:
// headers are position:sticky, so their offsetTop / getBoundingClientRect are unreliable.
function jumpTarget() {
  const v = $("#view-matches"); if (!v || S.view !== "matches") return null;
  const liveM = S.matches.find(m => [ST.LIVE, ST.HT].includes(status(m)));
  // a sticky day banner sits above the live card too — pass a visible dayhead (they're all one height) so scrollToNow
  // lands the card *below* the banner instead of behind it. (Was head:null, which let the banner cover the card top.)
  if (liveM) { const c = v.querySelector(`.mcard[data-mid="${liveM.id}"]`); if (c) return { el: c, head: [...v.querySelectorAll(".dayhead")].find(h => h.offsetHeight > 0) || null, live: true }; }
  // there can be two "today" headers — one inside the collapsed "Earlier results" <details> and one in
  // the upcoming list. Target the upcoming (visible) one, never the collapsed one.
  const heads = [...v.querySelectorAll(".dayhead.is-today")];
  const head = heads.find(h => !h.closest("details")) || heads[0];
  if (head) {
    let card = head.nextElementSibling;
    while (card && !card.classList.contains("mcard")) card = card.nextElementSibling;
    return { el: card || head, head, live: false };  // card is non-sticky → accurate geometry
  }
  return null;
}
const STICK = () => ($(".topbar")?.offsetHeight || 56) + ($(".tabs")?.offsetHeight || 48);
// publish the real pinned-chrome heights as CSS vars so the sticky day-headers pin exactly under the
// tabs (the old hardcoded 60px/105px assumed a taller bar) — keeps "jump to today" landing pixel-true.
function setChromeVars() {
  const bar = $(".topbar")?.offsetHeight || 56, tabs = $(".tabs")?.offsetHeight || 46;
  const r = document.documentElement.style;
  r.setProperty("--h-bar", bar + "px");
  r.setProperty("--h-chrome", (bar + tabs) + "px");
}
function updateJumpNow() {
  const btn = $("#jumpNow"); if (!btn) return;
  const t = jumpTarget();
  if (!t) { btn.hidden = true; return; }
  const vp = t.el.getBoundingClientRect().top;               // viewport-relative (target is non-sticky)
  btn.hidden = !(vp < STICK() - 60 || vp > innerHeight - 24); // show only when it's well off-screen
  btn.classList.toggle("is-live", t.live);
  $("#jnLabel").textContent = t.live ? "Live" : "Today";
}
function scrollToNow() {
  const t = jumpTarget(); if (!t) return;
  // land the day header just under the sticky chrome; the card sits right below it
  const headH = t.head ? t.head.offsetHeight : 0;
  const y = t.el.getBoundingClientRect().top + scrollY - STICK() - headH - 8;
  scrollTo({ top: Math.max(0, y), behavior: "smooth" });
}
function startCountdown(root) {
  clearInterval(cdTimer); prevCd = {};
  const cd = (root || document).querySelector(".countdown[data-utc]"); if (!cd) return;   // scoped to the active view (Matches or Live can each carry one)
  const target = new Date(cd.dataset.utc);
  const tickFn = () => {
    let s = Math.max(0, Math.floor((target - new Date()) / 1000));
    const v = { h: s / 3600 | 0, m: s / 60 % 60 | 0, s: s % 60 };   // hours run past 24 (no separate days box)
    $$(".cd-num", cd).forEach(n => {
      const k = n.dataset.k, val = String(v[k]).padStart(2, "0");
      if (prevCd[k] !== val) { n.textContent = val; n.classList.remove("tick"); void n.offsetWidth; n.classList.add("tick"); prevCd[k] = val; }
    });
    if (s === 0) { clearInterval(cdTimer); setTimeout(refreshResults, 4000); }
  };
  tickFn(); cdTimer = setInterval(tickFn, 1000);
}

/* ---------------- render: teams (my team + all 48) ---------------- */
// compact fav-team spotlight (hero + collapsed squad) — sits ABOVE the all-teams landscape; the fixtures/group
// move below the grid (myTeamFixtures) so the landscape isn't buried under your team's full detail.
function myTeamBlock() {
  const t = S.teams[S.fav];
  const mine = S.matches.filter(isFavMatch).sort((a, b) => a.utc.localeCompare(b.utc));
  const group = mine.find(m => m.group)?.group;
  const tbl = group ? standings(group) : [];
  const pos = tbl.findIndex(r => r.code === S.fav) + 1;
  const played = tbl.find(r => r.code === S.fav)?.p || 0;
  return `
    <div class="team-hero">
      <div class="team-hero-tap" data-squad="${S.fav}" role="button" tabindex="0" aria-label="Open ${esc(t.name)} details">
        <span class="fl">${flag(S.fav)}</span>
        <div class="th-text"><h2>${esc(t.name)}</h2>
          <p class="th-sub">${t.conf ? esc(t.conf) + " · " : ""}Group ${group || "–"}${fifaRankOf(S.fav) ? ` · FIFA #${fifaRankOf(S.fav)}` : ""}${t.titles ? ` · <b style="color:var(--gold)">${TROPHY} ${t.titles}</b>` : ""}</p>
          ${played ? `<p class="th-standing">Currently <b>${ordinal(pos)}</b> after ${played} match${played > 1 ? "es" : ""}</p>` : ""}
        </div>
      </div>
      <button class="btn ghost team-change" id="ctaChange">Change</button></div>
    ${mine.length ? `<div class="team-actions"><button class="btn ghost ics-btn" id="icsTeam">${CAL_SVG} Add ${esc(t.name)}'s matches to calendar</button></div>` : ""}
    ${S.squads?.[S.fav]?.players?.length ? `<details class="th-squad"><summary><span>${esc(t.name)}'s squad</span><small>${S.squads[S.fav].players.length} players · tap to view</small></summary>${heroSquad(S.fav)}</details>` : heroSquad(S.fav)}`;
}
function myTeamFixtures() {
  const t = S.teams[S.fav];
  const mine = S.matches.filter(isFavMatch).sort((a, b) => a.utc.localeCompare(b.utc));
  const group = mine.find(m => m.group)?.group;
  const upcoming = mine.filter(m => status(m) === ST.SCHED);
  const done = mine.filter(m => status(m) !== ST.SCHED);
  return `
    ${done.length ? `<div class="eyebrow">${esc(t.name)} · played</div>` + done.map((m, i) => matchCard(m, i)).join("") : ""}
    <div class="eyebrow">${esc(t.name)} · fixtures</div>
    ${upcoming.length ? upcoming.map((m, i) => matchCard(m, i)).join("") : `<div class="empty">No scheduled matches. Check Predict for their knockout path.</div>`}
    ${group ? `<div class="eyebrow">Group ${group}</div><div class="gwrap">${groupTable(group, 0)}</div>
      <div class="legend"><span class="l1"><i></i>Top 2 advance</span><span class="l3"><i></i>3rd: possible best-8 spot</span></div>` : ""}`;
}
// the "what changed since 2022" banner above the all-teams grid
function teamsLandscapeBanner() {
  if (!S.wc22) return "";
  const codes = Object.keys(S.teams), notIn = codes.filter(c => !S.wc22.teams[c]);
  const back = codes.length - notIn.length, debut = notIn.filter(c => S.teams[c]?.best === "First appearance").length;
  return `<div class="wc22-land">
    <div class="wc22-land-hd"><b>Since Qatar 2022</b><span class="wc22-exp">32 → 48 teams</span></div>
    <div class="wc22-land-stats"><span><b>${back}</b> back from 2022</span><span><b>${debut}</b> on debut</span><span><b>${notIn.length - debut}</b> returning</span></div>
    ${S.wc22.matches?.length ? `<button class="wc22-results-btn" data-wc22>Qatar 2022 · full results ›</button>` : ""}
  </div>`;
}
// the last World Cup's matches grouped by stage, with scores + goalscorers — a reference of what happened in 2022
const WC22_STAGES = [["FIN", "Final"], ["3P", "Third place"], ["SF", "Semi-finals"], ["QF", "Quarter-finals"], ["R16", "Round of 16"],
  ["A", "Group A"], ["B", "Group B"], ["C", "Group C"], ["D", "Group D"], ["E", "Group E"], ["F", "Group F"], ["G", "Group G"], ["H", "Group H"]];
function wc2022ResultsHTML() {
  const ms = S.wc22?.matches; if (!ms?.length) return `<div class="empty">2022 results aren't loaded yet.</div>`;
  const scorers = arr => arr.length ? arr.map(x => `${esc(x.n)} ${x.m.map(mm => mm + "'").join(", ")}`).join(" · ") : "—";
  const teamN = c => esc(S.teams[c]?.name || S.wc22?.names?.[c] || c);
  const row = m => `<div class="w22m">
    <div class="w22m-top"><span class="w22m-side"><span class="fl">${flag(m.a)}</span><span class="w22m-nm">${teamN(m.a)}</span></span>
      <span class="w22m-sc">${m.s[0]}–${m.s[1]}${m.pen ? `<small> (${m.pen[0]}–${m.pen[1]}p)</small>` : ""}</span>
      <span class="w22m-side w22m-r"><span class="w22m-nm">${teamN(m.b)}</span><span class="fl">${flag(m.b)}</span></span></div>
    ${(m.ga.length || m.gb.length) ? `<div class="w22m-g"><span>${scorers(m.ga)}</span><span>${scorers(m.gb)}</span></div>` : ""}
  </div>`;
  return `<p class="w22-intro">Every match from <b>${esc(S.wc22.host)} ${S.wc22.year}</b> — champions <b>${teamN("AR")}</b>, runners-up France. Source: Wikipedia.</p>`
    + WC22_STAGES.map(([st, label]) => { const sm = ms.filter(m => m.st === st); return sm.length ? `<div class="eyebrow">${label}</div><div class="w22-list">${sm.map(row).join("")}</div>` : ""; }).join("");
}
function openWc2022() { const b = $("#wc22Body"); if (b) b.innerHTML = wc2022ResultsHTML(); showSheet($("#wc22Dialog")); }
// tap a player portrait → a full-screen lightbox of the same photo at a sharp larger width. The bigger image is
// fetched ONLY here, on demand (one request, browser-cached after) — it never touches initial load or scrolling.
function openLightbox(url) {
  if (!url) return;
  const big = atWidth(url, 1400) || url;   // FIFA resize service: ask for a large width; non-FIFA urls pass through
  // a <dialog> opened with showModal() joins the top layer ABOVE the already-open player dialog (which a plain
  // div would render behind); top-layer dialogs stack in showModal() order, so this lands on top.
  const dlg = document.createElement("dialog");
  dlg.className = "lightbox"; dlg.setAttribute("aria-label", "Full-size photo");
  dlg.innerHTML = `<img class="lightbox-img" src="${esc(big)}" alt="" decoding="async"><button class="lightbox-x" aria-label="Close">✕</button>`;
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("click", close);                       // click anywhere (backdrop or image) closes
  dlg.addEventListener("cancel", e => { e.preventDefault(); close(); });   // Escape
  document.body.appendChild(dlg);
  dlg.showModal();
}
function renderTeams() {
  const el = $("#view-teams");
  const head = S.fav
    ? myTeamBlock()
    : `<div class="pick-cta">
        <span style="font-size:42px;color:var(--pitch);display:inline-flex">${ICO.ball}</span>
        <span class="big">Who are you backing?</span>
        <span style="color:var(--ink-soft);font-size:13.5px;max-width:300px">Pick a team: the site takes their colors, pins their matches and tracks their road to the final.</span>
        <button class="btn" id="ctaPick">Choose your team</button></div>`;
  const grid = Object.keys(S.teams)
    .sort((a, b) => S.teams[a].name.localeCompare(S.teams[b].name))
    .map(c => { const rk = fifaRankOf(c), g = groupOf(c);
      return `<button class="teamcard ${c === S.fav ? "is-fav" : ""}" data-squad="${c}" title="${esc(S.teams[c].name)}${S.teams[c].titles ? `, ${S.teams[c].titles}× World Cup champion` : ""}">
      <span class="fl">${flag(c)}</span><span class="tc-main"><span class="tc-name">${esc(S.teams[c].name)}</span><span class="tc-meta">${rk ? `FIFA #${rk}` : g ? `Group ${g}` : ""}</span></span></button>`; }).join("");
  const isMap = _teamsView === "map";
  const toggle = `<span class="tv-toggle">${[["grid", "Grid"], ["map", "Map"]].map(([k, lbl]) => `<button class="tv-btn ${_teamsView === k ? "is-on" : ""}" data-tview="${k}">${lbl}</button>`).join("")}</span>`;
  const body = isMap ? `<div class="teams-map" id="teamsMap"><div class="wmap-load">Loading the world map…</div></div>` : `<div class="teamsgrid">${grid}</div>`;
  paint(el, head + teamsLandscapeBanner() + `<div class="eyebrow tv-eyebrow">All teams <span style="color:var(--ink-soft);font-weight:600">, ${isMap ? "tap a nation" : "tap for detail"}</span>${toggle}</div>` + body + (S.fav ? myTeamFixtures() : ""));
  $$("[data-tview]", el).forEach(b => b.onclick = () => { _teamsView = b.dataset.tview; renderTeams(); });
  if (isMap) renderTeamsMap();
  const cta = $("#ctaPick", el); if (cta) cta.onclick = () => $("#teamDialog").showModal();
  const chg = $("#ctaChange", el); if (chg) chg.onclick = () => $("#teamDialog").showModal();
  const ics = $("#icsTeam", el);
  if (ics) ics.onclick = () => downloadICS(
    S.matches.filter(isFavMatch).sort((a, b) => a.utc.localeCompare(b.utc)),
    `${S.teams[S.fav].name} · World Cup 2026`);
}
let _teamsView = "grid", _worldMap = null;   // Teams tab: grid vs world-map view; the basemap SVG is fetched once, on first map open
const popStr = n => n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : "" + n;
// spelled-out population for captions, e.g. 48.8 million / 1.4 billion / 150 thousand
const popWords = n => n == null ? "" : n >= 1e9 ? +(n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + " billion" : n >= 1e6 ? +(n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " million" : n >= 1e3 ? Math.round(n / 1e3) + " thousand" : "" + n;
// the all-48-nations world map: a lazy-loaded equirectangular basemap with a kit-coloured dot at each country's
// centroid (same projection as the basemap). Tap a dot to open that team. The 122KB map is fetched only here.
async function renderTeamsMap() {
  if (!$("#teamsMap")) return;
  if (_worldMap == null) { try { _worldMap = await (await fetch("assets/worldmap.svg?v=" + BUILD)).text(); } catch { _worldMap = ""; } }
  const host = $("#teamsMap"); if (!host) return;   // user toggled back to grid while it was loading
  const land = (/<path d="([^"]+)"/.exec(_worldMap) || [, ""])[1];
  if (!land) { host.innerHTML = `<div class="empty">Map couldn't load. Try the grid view.</div>`; return; }
  const px = lon => (((lon + 180) / 360) * 1000).toFixed(1), py = lat => (((90 - lat) / 180) * 500).toFixed(1);
  const dots = Object.keys(S.teams).filter(c => S.teams[c].lat != null).map(c => {
    const t = S.teams[c];
    return `<g class="mdot${c === S.fav ? " is-fav" : ""}" data-squad="${c}" role="button" tabindex="0" aria-label="${esc(t.name)}"><circle cx="${px(t.lon)}" cy="${py(t.lat)}" r="6.5" style="fill:${t.c1 || "var(--acc1)"}"/><title>${esc(t.name)} · pop. ${popStr(t.pop)}</title></g>`;
  }).join("");
  host.innerHTML = `<svg class="wmap" viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" role="img" aria-label="World map of the 48 qualified nations"><path class="wmap-land" d="${land}"/><g class="wmap-dots">${dots}</g></svg>
    <p class="wmap-cap">Each dot is one of the 48 — tap to open. Population: World Bank 2024 (England/Scotland ONS 2023).</p>`;
}
// authoritative head coach: curated teams.json value (web-verified, all 48), API-squad coach as a fallback
const teamCoach = code => S.teams[code]?.coach || S.squads?.[code]?.coach || "";
const initials = n => (n || "").split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase();
function rosterMarkup(sq, code) {
  const groups = { GK: "Goalkeepers", DF: "Defenders", MF: "Midfielders", FW: "Forwards" };
  const byPos = p => sq.players.filter(x => x.pos === p);
  return `<div class="roster">${Object.entries(groups).map(([p, label]) => {
    const ps = byPos(p);
    return ps.length ? `<div class="roster-pos"><h5>${label} <span>${ps.length}</span></h5>
      ${ps.map(x => { const nm = x.name.replace(" (captain)", ""), ph = bestPhoto(nm, code, x.n);
        return `<div class="roster-row" data-player="${esc(nm)}|${code}" role="button" tabindex="0">
        <span class="rnum">${x.n ?? "·"}</span>
        <span class="rface"${ph ? ` style="background-image:url('${ph}')"` : ""}>${ph ? "" : flag(code)}</span>
        <span class="rname"><span class="rname-t">${esc(nm)}${isCaptain(nm, code) ? `<i class="cpt" title="Captain">C</i>` : ""}</span>${x.club ? `<small>${esc(x.club)}</small>` : ""}</span>
        ${x.caps != null ? `<span class="rstat">${x.caps}<i>caps</i>${x.goals ? `<em>${x.goals} g</em>` : ""}</span>` : ""}
      </div>`; }).join("")}</div>` : "";
  }).join("")}</div>`;
}
/* ---------------- render: Players (browse all 1248 with filters) ---------------- */
let _plFilter = { q: "", pos: "all", sort: "caps", dir: "desc", club: "", country: "" };
let _plIdx = null, _plIdxSig = "", _plClubs = null, _plCtries = null, _plPickerClosers = {};
function playersIndex() {
  const sig = Object.keys(S.squads || {}).length + ":" + (tournamentStats().scorers.length);
  if (_plIdx && _plIdxSig === sig) return _plIdx;
  const ts = tournamentStats();
  const wcOf = (name, code) => { const s = ts.scorers.find(p => p.code === code && sameName(p.name, name)); return s ? s.goals : 0; };
  const out = [];
  for (const code in (S.squads || {})) {
    const team = S.squads[code]; if (!team?.players) continue;
    for (const p of team.players) {
      const nm = p.name.replace(" (captain)", ""), bio = playerBio(nm, code);
      out.push({ name: nm, code, n: p.n, pos: p.pos || "", club: p.club || "", caps: p.caps || 0, cg: p.goals || 0,
        wc: wcOf(nm, code), age: bio?.d ? ageFrom(bio.d) : null, cap: isCaptain(nm, code) });
    }
  }
  _plClubs = _plCtries = null;   // invalidate the derived club + country tallies
  return (_plIdx = out, _plIdxSig = sig, out);
}
// clubs that supply players to this World Cup, ranked by how MANY they send (most first), cached with the index
function playerClubs() {
  if (_plClubs) return _plClubs;
  const m = new Map();
  for (const p of playersIndex()) if (p.club) m.set(p.club, (m.get(p.club) || 0) + 1);
  return (_plClubs = [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)));
}
// the 48 nations, each with its squad size — listed alphabetically (counts are ~uniform, so name order is what helps you find one)
function playerCountries() {
  if (_plCtries) return _plCtries;
  const m = new Map();
  for (const p of playersIndex()) m.set(p.code, (m.get(p.code) || 0) + 1);
  return (_plCtries = [...m.entries()].map(([code, count]) => ({ code, name: S.teams[code]?.name || code, count }))
    .sort((a, b) => a.name.localeCompare(b.name)));
}
const PL_POS = [["all", "All"], ["GK", "GK"], ["DF", "DEF"], ["MF", "MID"], ["FW", "FWD"]];
// each sort has a natural default direction; tapping the active one reverses it (cmp is the ASCENDING comparator)
const PL_SORT = [
  { k: "caps", label: "Caps", def: "desc", cmp: (a, b) => a.caps - b.caps },
  { k: "age", label: "Age", def: "asc", cmp: (a, b) => (a.age ?? 0) - (b.age ?? 0), missing: p => p.age == null },
];
const PLG_SEARCH_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const PLG_CLUB_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z"/></svg>';
const PLG_CTRY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.4 3.9 5.6 4 9-.1 3.4-1.5 6.6-4 9-2.5-2.4-3.9-5.6-4-9 .1-3.4 1.5-6.6 4-9z"/></svg>';
function plgCompute() {
  const f = _plFilter, q = f.q.trim().toLowerCase();
  const list = playersIndex().filter(p => (f.pos === "all" || p.pos === f.pos) && (!f.club || p.club === f.club) && (!f.country || p.code === f.country) &&
    (!q || p.name.toLowerCase().includes(q) || p.club.toLowerCase().includes(q) || (S.teams[p.code]?.name || "").toLowerCase().includes(q)));
  const s = PL_SORT.find(x => x.k === f.sort) || PL_SORT[0], sign = f.dir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    if (s.missing) { const am = s.missing(a), bm = s.missing(b); if (am !== bm) return am ? 1 : -1; }   // unknowns always sink, regardless of direction
    return sign * s.cmp(a, b) || a.name.localeCompare(b.name);
  });
  return list;
}
function plgListHTML(list) {
  const f = _plFilter, CAP = 120, shown = list.slice(0, CAP);
  const POSN = { GK: "Goalkeeper", DF: "Defender", MF: "Midfielder", FW: "Forward" };
  const card = p => {
    const ph = bestPhoto(p.name, p.code, p.n);
    // when the Age sort is active, lead the record line with the player's age (the active sort key, made visible)
    const ageBit = (f.sort === "age" && p.age != null) ? `<b>${p.age}</b> yrs · ` : "";
    // second line = the international record (caps + career international goals); third = position · club
    return `<button class="plg-card" data-player="${esc(p.name)}|${p.code}">
      ${ph ? `<span class="plg-face" style="background-image:url('${ph}')"></span>` : `<span class="plg-face plg-flag">${flag(p.code)}</span>`}
      <span class="plg-body"><span class="plg-nm">${esc(pName(p.name, p.code))}${p.cap ? ` <i class="plg-cap">C</i>` : ""}</span>
        <span class="plg-sub"><span class="fl">${flag(p.code)}</span><span class="plg-intl">${ageBit}<b>${p.caps}</b> ${p.caps === 1 ? "cap" : "caps"} · <b>${p.cg}</b> ${p.cg === 1 ? "goal" : "goals"}</span></span>
        <span class="plg-meta">${POSN[p.pos] || p.pos || ""}${p.club ? ` · ${esc(p.club)}` : ""}</span></span>
    </button>`;
  };
  return `<div class="plg-count">${list.length.toLocaleString()} player${list.length === 1 ? "" : "s"}${list.length > CAP ? ` · showing top ${CAP}` : ""}</div>
    ${shown.length ? `<div class="plg-grid">${shown.map(card).join("")}</div>` : `<div class="empty">No players match. Try a different search or filter.</div>`}`;
}
// the club-picker list (sorted by player count), narrowed by its own search box
function plgClubListHTML(q) {
  const clubs = playerClubs(), f = (q || "").trim().toLowerCase();
  const rows = f ? clubs.filter(c => c.name.toLowerCase().includes(f)) : clubs, LIM = 50;
  const all = f ? "" : `<button class="plg-clubrow ${!_plFilter.club ? "is-on" : ""}" data-pick=""><span class="plg-clubnm">All clubs</span><span class="plg-clubn">${playersIndex().length}</span></button>`;
  const body = rows.slice(0, LIM).map(c => `<button class="plg-clubrow ${c.name === _plFilter.club ? "is-on" : ""}" data-pick="${esc(c.name)}"><span class="plg-clubnm">${esc(c.name)}</span><span class="plg-clubn">${c.count}</span></button>`).join("");
  const more = !rows.length ? `<div class="plg-clubmore">No clubs match “${esc(q)}”</div>` : (rows.length > LIM ? `<div class="plg-clubmore">${rows.length - LIM} more — keep typing to narrow</div>` : "");
  return all + body + more;
}
// the country-picker list (all 48, alphabetical, with flag), narrowed by its own search box; value is the team CODE
function plgCountryListHTML(q) {
  const ctries = playerCountries(), f = (q || "").trim().toLowerCase();
  const rows = f ? ctries.filter(c => c.name.toLowerCase().includes(f)) : ctries, LIM = 60;
  const all = f ? "" : `<button class="plg-clubrow ${!_plFilter.country ? "is-on" : ""}" data-pick=""><span class="plg-clubnm">All countries</span><span class="plg-clubn">${playersIndex().length}</span></button>`;
  const body = rows.slice(0, LIM).map(c => `<button class="plg-clubrow ${c.code === _plFilter.country ? "is-on" : ""}" data-pick="${esc(c.code)}"><span class="plg-clubnm"><span class="fl">${flag(c.code)}</span> ${esc(c.name)}</span><span class="plg-clubn">${c.count}</span></button>`).join("");
  const more = rows.length ? "" : `<div class="plg-clubmore">No countries match “${esc(q)}”</div>`;
  return all + body + more;
}
function renderPlayers() {
  for (const k in _plPickerClosers) { const fn = _plPickerClosers[k]; if (fn) fn(); }   // tear down any open picker's doc listeners before rebuild
  _plPickerClosers = {};
  const el = $("#view-players"), f = _plFilter;
  const posSeg = PL_POS.map(([k, label]) => `<button class="plg-segbtn ${k === f.pos ? "is-on" : ""}" data-pos="${k}">${label}</button>`).join("");
  const sortSeg = PL_SORT.map(s => { const on = s.k === f.sort;
    return `<button class="plg-segbtn ${on ? "is-on" : ""}" data-sort="${s.k}" title="${on ? "Tap again to reverse" : `Sort by ${s.label.toLowerCase()}`}">${s.label}${on ? `<i class="plg-dir">${f.dir === "asc" ? "↑" : "↓"}</i>` : ""}</button>`; }).join("");
  // searchable pickers for country (all 48, flagged) and club, mirrored from one template
  const picker = (kind, set, svg, lbl, ph) => `<div class="plg-clubwrap">
        <button class="plg-club ${set ? "is-set" : ""}" id="plg${kind}Btn" aria-haspopup="listbox" aria-expanded="false">${svg}<span class="plg-club-lbl">${lbl}</span>${set ? `<i class="plg-club-x" data-pick-clear role="button" aria-label="Clear">✕</i>` : `<i class="plg-club-cv">▾</i>`}</button>
        <div class="plg-clubpop" id="plg${kind}Pop" hidden>
          <div class="plg-clubsearch">${PLG_SEARCH_SVG}<input id="plg${kind}Q" type="search" placeholder="${ph}" autocomplete="off"></div>
          <div class="plg-clublist" id="plg${kind}List"></div>
        </div>
      </div>`;
  el.innerHTML = viewH2("view-players") + `
    <div class="plg-filters">
      <div class="plg-search">${PLG_SEARCH_SVG}
        <input id="plgQ" type="search" placeholder="Search players or teams…" value="${esc(f.q)}" autocomplete="off"></div>
      ${picker("Ctry", f.country, f.country ? `<span class="fl">${flag(f.country)}</span>` : PLG_CTRY_SVG, f.country ? esc(S.teams[f.country]?.name || f.country) : "All countries", "Search countries…")}
      ${picker("Club", f.club, PLG_CLUB_SVG, f.club ? esc(f.club) : "All clubs", "Search clubs…")}
      <div class="plg-seg">${posSeg}</div>
      <div class="plg-seg plg-sortseg">${sortSeg}</div>
    </div>
    <div id="plgList">${plgListHTML(plgCompute())}</div>`;
  // SEARCH updates ONLY the list node — the input element is never re-created, so fast typing never drops a letter
  const qi = $("#plgQ", el);
  if (qi) qi.oninput = () => { _plFilter.q = qi.value; clearTimeout(qi._t); qi._t = setTimeout(() => { const lc = $("#plgList", el); if (lc) lc.innerHTML = plgListHTML(plgCompute()); }, 110); };
  $$("[data-pos]", el).forEach(b => b.onclick = () => { _plFilter.pos = b.dataset.pos; renderPlayers(); });
  $$("[data-sort]", el).forEach(b => b.onclick = () => {
    const k = b.dataset.sort;
    if (f.sort === k) _plFilter.dir = f.dir === "asc" ? "desc" : "asc";                        // tap active → reverse
    else { _plFilter.sort = k; _plFilter.dir = (PL_SORT.find(s => s.k === k) || {}).def || "desc"; }
    renderPlayers();
  });
  wirePlgPicker(el, "Ctry"); wirePlgPicker(el, "Club");
}
// one searchable picker, parameterised for country or club (popover anchored under its button)
const PLG_PICK = { Ctry: { key: "country", list: plgCountryListHTML }, Club: { key: "club", list: plgClubListHTML } };
function wirePlgPicker(el, kind) {
  const cfg = PLG_PICK[kind];
  const btn = $(`#plg${kind}Btn`, el), pop = $(`#plg${kind}Pop`, el), cq = $(`#plg${kind}Q`, el), list = $(`#plg${kind}List`, el);
  if (!btn) return;
  const draw = () => { list.innerHTML = cfg.list(cq.value); };
  const onEsc = e => { if (e.key === "Escape") { close(); btn.focus(); } };
  let onDoc = null;
  function close() { if (pop.hidden) return; pop.hidden = true; btn.setAttribute("aria-expanded", "false"); if (onDoc) document.removeEventListener("click", onDoc, true); document.removeEventListener("keydown", onEsc); onDoc = null; _plPickerClosers[kind] = null; }
  function open() { if (!pop.hidden) return; pop.hidden = false; btn.setAttribute("aria-expanded", "true"); cq.value = ""; draw();
    // anchor under the button, but flip to right-aligned if left-aligned would spill past the viewport's right edge
    pop.style.left = "0"; pop.style.right = "auto";
    if (pop.getBoundingClientRect().right > innerWidth - 8) { pop.style.left = "auto"; pop.style.right = "0"; }
    setTimeout(() => cq.focus(), 0);
    onDoc = ev => { if (!ev.target.closest(`#plg${kind}Pop`) && !ev.target.closest(`#plg${kind}Btn`)) close(); };
    document.addEventListener("click", onDoc, true); document.addEventListener("keydown", onEsc); _plPickerClosers[kind] = close; }
  btn.onclick = e => { if (e.target.closest("[data-pick-clear]")) { e.stopPropagation(); _plFilter[cfg.key] = ""; renderPlayers(); return; } pop.hidden ? open() : close(); };
  if (cq) cq.oninput = () => { clearTimeout(cq._t); cq._t = setTimeout(draw, 80); };
  if (list) list.onclick = e => { const r = e.target.closest("[data-pick]"); if (!r) return; _plFilter[cfg.key] = r.dataset.pick; close(); renderPlayers(); };
}
function squadSection(code) {
  const sq = S.squads?.[code], coach = teamCoach(code);
  if (!sq) return `<div class="eyebrow">Squad</div><div class="empty">Squad not published yet. Check back closer to kickoff.</div>`;
  return `<div class="eyebrow">Squad: ${sq.players.length} players${coach ? ` · Coach <b style="color:var(--ink)">&nbsp;${esc(coach)}</b>` : ""}</div>
    ${rosterMarkup(sq, code)}`;
}
// the favourite team's squad as a full-photo gallery (position rows of large player cards); the complete detailed
// roster stays one tap away below for anyone whose headshot isn't available.
function heroSquad(code) {
  const sq = S.squads?.[code], coach = teamCoach(code);
  if (!sq) return `<div class="eyebrow">Squad</div><div class="empty">Squad not published yet. Check back closer to kickoff.</div>`;
  const c1 = S.teams[code]?.c1 || "var(--pitch)";
  const card = x => {
    const nm = x.name.replace(" (captain)", ""), photo = bestPhoto(nm, code, x.n);
    if (!photo) return "";
    const big = atWidth(photo, 400) || photo;
    return `<button class="sq-card" data-player="${esc(nm)}|${code}" style="--sc:${c1}" aria-label="${esc(pName(nm, code))}">
      <span class="sq-photo" style="background-image:url('${big}')"></span>
      ${x.n != null ? `<span class="sq-num">${x.n}</span>` : ""}
      <span class="sq-info"><b>${esc(tlName(nm, code))}</b>${isCaptain(nm, code) ? `<span class="sq-cap" title="Captain">C</span>` : ""}</span></button>`;
  };
  const rows = [["GK", "Goalkeepers"], ["DF", "Defenders"], ["MF", "Midfielders"], ["FW", "Forwards"]].map(([p, label]) => {
    const cards = sq.players.filter(x => x.pos === p).map(card).filter(Boolean).join("");
    return cards ? `<div class="sq-poslabel">${label}</div><div class="sq-row">${cards}</div>` : "";
  }).join("");
  return `<div class="eyebrow">Squad <span class="wp-est">${sq.players.length} players${coach ? ` · ${esc(coach)}` : ""}</span></div>
    ${rows || ""}
    <details class="ts-squad sq-fulllist"><summary><span>Full squad list</span><small>numbers, clubs &amp; positions</small></summary>${rosterMarkup(sq, code)}</details>`;
}
// World Cup pedigree (titles · best finish · appearances) + the head coach — the "what this team is about" header
function teamOverview(code) {
  const t = S.teams[code]; if (!t) return "";
  const titles = t.titles || 0, debut = t.best === "First appearance";
  const [finish, yr] = (t.best || "").split(" · ");
  const coach = teamCoach(code);
  const tiles = [
    t.apps != null ? `<div class="tp"><b>${t.apps}</b><span>World Cup${t.apps !== 1 ? "s" : ""}</span></div>` : "",
    titles ? `<div class="tp tp-gold"><b>${titles}×</b><span>Champion${titles !== 1 ? "s" : ""}</span></div>` : "",
    `<div class="tp tp-wide tp-finish"><b>${debut ? "Debut" : "Best finish"}</b><span>${debut ? "First World Cup" : `${esc(finish)}${yr ? ` · ${esc(yr)}` : ""}`}</span></div>`,
  ].filter(Boolean).join("");
  return `<div class="ts-ped">${tiles}</div>
    ${coach ? `<div class="ts-coach"><span class="ts-coach-badge">${esc(initials(coach))}</span><span class="ts-coach-tx"><i>Head coach</i><b>${esc(coach)}</b></span></div>` : ""}`;
}
// Static WC results 2002–2022. Keys: W=winner, F=finalist, 3rd=third, 4th=fourth, QF/R16/GS=round. Missing year = did not qualify.
const WC_HIST = {
  AR:{2002:"GS",2006:"QF",2010:"QF",2014:"F",2018:"R16",2022:"W"},
  AU:{2006:"R16",2010:"GS",2014:"GS",2018:"GS",2022:"R16"},
  BA:{2014:"GS"},
  BE:{2002:"R16",2014:"QF",2018:"3rd",2022:"GS"},
  BR:{2002:"W",2006:"QF",2010:"QF",2014:"4th",2018:"QF",2022:"QF"},
  CA:{2022:"GS"},
  CH:{2006:"R16",2010:"GS",2014:"R16",2018:"R16",2022:"R16"},
  CI:{2006:"GS",2010:"GS",2014:"GS"},
  CO:{2014:"QF",2018:"R16"},
  CZ:{2006:"GS"},
  DE:{2002:"F",2006:"3rd",2010:"3rd",2014:"W",2018:"GS",2022:"GS"},
  DZ:{2010:"GS",2014:"R16"},
  EC:{2002:"GS",2006:"R16",2014:"GS",2022:"GS"},
  EG:{2018:"GS"},
  ES:{2002:"QF",2006:"R16",2010:"W",2014:"GS",2018:"R16",2022:"R16"},
  FR:{2002:"GS",2006:"F",2010:"GS",2014:"QF",2018:"W",2022:"F"},
  "GB-ENG":{2002:"QF",2006:"QF",2010:"R16",2014:"GS",2018:"4th",2022:"QF"},
  GH:{2006:"R16",2010:"QF",2014:"GS",2022:"GS"},
  HR:{2002:"GS",2006:"GS",2014:"GS",2018:"F",2022:"3rd"},
  IR:{2006:"GS",2014:"GS",2018:"GS",2022:"GS"},
  JP:{2002:"R16",2006:"GS",2010:"R16",2014:"GS",2018:"R16",2022:"R16"},
  KR:{2002:"4th",2006:"GS",2010:"R16",2014:"GS",2018:"GS",2022:"R16"},
  MA:{2018:"GS",2022:"4th"},
  MX:{2002:"R16",2006:"R16",2010:"R16",2014:"R16",2018:"R16",2022:"GS"},
  NL:{2006:"R16",2010:"F",2014:"3rd",2022:"QF"},
  NZ:{2010:"GS"},
  PA:{2018:"GS"},
  PT:{2002:"GS",2006:"4th",2010:"R16",2014:"GS",2018:"R16",2022:"QF"},
  PY:{2002:"R16",2006:"GS",2010:"QF"},
  QA:{2022:"GS"},
  SA:{2002:"GS",2006:"GS",2018:"GS",2022:"GS"},
  SE:{2002:"R16",2006:"R16",2018:"QF"},
  SN:{2002:"QF",2018:"GS",2022:"R16"},
  TN:{2002:"GS",2006:"GS",2018:"GS",2022:"GS"},
  TR:{2002:"3rd"},
  US:{2002:"QF",2006:"GS",2010:"R16",2014:"R16",2022:"R16"},
  UY:{2002:"GS",2010:"4th",2014:"R16",2018:"QF",2022:"GS"},
  ZA:{2002:"GS",2010:"GS"},
};
function wcHistory(code) {
  const YEARS = [2002, 2006, 2010, 2014, 2018, 2022];
  const hist = WC_HIST[code] || {};
  if (!YEARS.some(y => hist[y])) return "";
  const chips = YEARS.map(y => {
    const r = hist[y] || null;
    return `<div class="wch-chip" data-r="${r || '-'}"><span class="wch-yr">’${String(y).slice(2)}</span><span class="wch-res">${r || "–"}</span></div>`;
  }).join("");
  return `<div class="eyebrow">World Cup since 2002</div><div class="wch-grid">${chips}</div>`;
}
// a player's record at THIS World Cup — counted from the team's played matches (tolerant name match vs feed names)
function playerWC(name, code) {
  let g = 0, a = 0, y = 0, rc = 0, apps = 0, starts = 0, cs = 0, ga = 0;
  for (const m of S.matches) {
    if (!matchHasTeam(m, code) || status(m) === ST.SCHED) continue;
    const r = res(m); if (!r) continue;
    const side = slotInfo(m, "home").code === code ? "h" : slotInfo(m, "away").code === code ? "a" : null;
    if (!side) continue;
    const xi = r.xi?.[side]?.xi || [];
    const inXI = xi.some(p => sameName(p[1], name));
    const onBench = (r.ev || []).some(e => e.tm === side && e.k === "S" && e.on && sameName(e.on, name));
    if (inXI || onBench) apps++;
    // clean sheets / goals conceded while the player STARTED — shared by the keeper and the back line,
    // approximated to the match's final score (the same simplification the keeper leaderboard uses)
    if (inXI && r.h != null) {
      starts++; const conceded = side === "h" ? r.a : r.h; ga += conceded; if (conceded === 0) cs++;
    }
    for (const e of (r.ev || [])) {
      if (e.tm !== side) continue;
      if (["G", "P"].includes(e.k) && e.p && sameName(e.p, name)) g++;
      if (e.a && sameName(e.a, name)) a++;
      if (e.k === "Y" && e.p && sameName(e.p, name)) y++;
      if (e.k === "R" && e.p && sameName(e.p, name)) rc++;
    }
  }
  return { g, a, y, rc, apps, starts, cs, ga };
}
// a player's tournament match-by-match: opponent, result and what they did — tappable through to the match
function playerMatchLog(name, code) {
  const rows = [];
  for (const m of S.matches) {
    if (!matchHasTeam(m, code) || status(m) === ST.SCHED) continue;
    const r = res(m); if (!r || r.h == null) continue;
    const side = slotInfo(m, "home").code === code ? "h" : slotInfo(m, "away").code === code ? "a" : null;
    if (!side) continue;
    const inXI = (r.xi?.[side]?.xi || []).some(p => sameName(p[1], name));
    const subOn = (r.ev || []).some(e => e.tm === side && e.k === "S" && e.on && sameName(e.on, name));
    if (!inXI && !subOn) continue;
    const gf = side === "h" ? r.h : r.a, ga = side === "h" ? r.a : r.h;
    let g = 0, a = 0, yc = 0, rc = 0;
    for (const e of (r.ev || [])) {
      if (e.tm !== side) continue;
      if (["G", "P"].includes(e.k) && e.p && sameName(e.p, name)) g++;
      if (e.a && sameName(e.a, name)) a++;
      if (e.k === "Y" && e.p && sameName(e.p, name)) yc++;
      if (e.k === "R" && e.p && sameName(e.p, name)) rc++;
    }
    rows.push({ mid: m.id, utc: m.utc, opp: side === "h" ? slotInfo(m, "away").code : slotInfo(m, "home").code,
      wdl: gf > ga ? "W" : gf < ga ? "L" : "D", gf, ga, started: inXI, g, a, yc, rc });
  }
  return rows.sort((x, y) => x.utc.localeCompare(y.utc));
}
// a team's match-by-match key stats (possession, shots, on target) — tappable through to the match
function teamMatchStats(code) {
  const rows = [];
  for (const m of S.matches) {
    if (!matchHasTeam(m, code) || status(m) === ST.SCHED) continue;
    const r = res(m); if (!r || r.h == null) continue;
    const i = slotInfo(m, "home").code === code ? 0 : slotInfo(m, "away").code === code ? 1 : null;
    if (i == null) continue;
    const s = r.stats || {}, gf = i === 0 ? r.h : r.a, ga = i === 0 ? r.a : r.h;
    rows.push({ mid: m.id, utc: m.utc, opp: i === 0 ? slotInfo(m, "away").code : slotInfo(m, "home").code,
      wdl: gf > ga ? "W" : gf < ga ? "L" : "D", gf, ga,
      poss: Array.isArray(s.poss) ? Math.round(s.poss[i]) : null,
      sh: Array.isArray(s.sh) ? s.sh[i] : null, sot: Array.isArray(s.sot) ? s.sot[i] : null });
  }
  return rows.sort((x, y) => x.utc.localeCompare(y.utc));
}
// Team detail sheet — overview, recent form, every fixture (results + upcoming), the group
// standing + qualification outlook, and the full squad (collapsible). Tapping a team anywhere
// (grid, group table, leaderboards, match modal) opens this; match cards inside drill deeper.
// minutes & rotation, built from each match's starting XI (xi) + substitutions (ev). Approximate
// minutes (nominal 90' full-time): a starter not subbed = 90, subbed off at t = t, a sub on at t = 90−t.
function teamRotation(code) {
  const ms = S.matches.filter(m => matchHasTeam(m, code) && status(m) === ST.FT && res(m)?.xi).sort((a, b) => a.utc.localeCompare(b.utc));
  if (!ms.length) return null;
  const grid = ms.map(m => {
    const r = res(m), side = slotInfo(m, "home").code === code ? "h" : "a";
    const xi = new Set((r.xi[side]?.xi || []).map(p => p[1]));
    const off = {}, on = {};
    for (const e of (r.ev || [])) if (e.tm === side && e.k === "S") { if (e.off) off[e.off] = evMin(e.t); if (e.on) on[e.on] = evMin(e.t); }
    return { xi, off, on, opp: slotInfo(m, side === "h" ? "away" : "home"), num: m.num };
  });
  const featured = new Set(); grid.forEach(g => { g.xi.forEach(n => featured.add(n)); Object.keys(g.on).forEach(n => featured.add(n)); });
  const players = [...featured].map(name => {
    let mins = 0, starts = 0, subs = 0;
    const cells = grid.map(g => {
      if (g.xi.has(name)) { starts++; const o = g.off[name]; if (o != null) { mins += Math.round(o); return { k: "P", t: `M${g.num}: started, off ${Math.round(o)}'` }; } mins += 90; return { k: "S", t: `M${g.num}: started (90')` }; }
      if (g.on[name] != null) { subs++; mins += Math.max(0, 90 - Math.round(g.on[name])); return { k: "U", t: `M${g.num}: on ${Math.round(g.on[name])}'` }; }
      return { k: "-", t: `M${g.num}: unused` };
    });
    return { name, code, mins, starts, subs, cells };
  }).sort((a, b) => b.mins - a.mins || b.starts - a.starts || a.name.localeCompare(b.name));
  return { matches: ms.length, players };
}
function rotationSection(code) {
  const R = teamRotation(code);
  if (!R) return "";
  const row = p => { const ph = bestPhoto(p.name, p.code, p.n);
    return `<div class="rt-row" data-player="${esc(p.name)}|${p.code}" role="button" tabindex="0">
      ${ph ? `<span class="lead-face" style="background-image:url('${ph}')"></span>` : `<span class="fl">${flag(p.code)}</span>`}
      <span class="rt-name">${esc(pName(p.name, p.code))}<small>${p.starts} start${p.starts !== 1 ? "s" : ""}${p.subs ? ` · ${p.subs} sub` : ""}</small></span>
      <span class="rt-cells">${p.cells.map(c => `<span class="rt-cell s-${c.k}" title="${esc(c.t)}"></span>`).join("")}</span>
      <span class="rt-min">${p.mins}<small>min</small></span></div>`; };
  return `<details class="ts-squad rt-block"><summary><span>Minutes &amp; rotation</span><small>${R.matches} match${R.matches !== 1 ? "es" : ""}</small></summary>
    <div class="rt-list">${R.players.map(row).join("")}</div>
    <div class="rt-legend"><span><i class="rt-cell s-S"></i>Started</span><span><i class="rt-cell s-P"></i>Subbed off</span><span><i class="rt-cell s-U"></i>Off the bench</span><span><i class="rt-cell s--"></i>Unused</span></div></details>`;
}
// a team's "playing style" fingerprint — five identity axes, each a bar showing where the team sits among
// the field (min-max percentile over teams that have a match-stats line). It's a shape, not a ranking.
function styleSection(code) {
  const me = tournamentStats().style, mine = me.find(x => x.code === code);
  if (!mine || me.length < 4) return "";
  const AXES = [
    ["poss", "Possession", v => v.toFixed(0) + "%", "Average share of the ball. Formula: possession % across their matches."],
    ["passAcc", "Passing", v => v.toFixed(0) + "%", "Pass accuracy. Formula: completed passes ÷ passes attempted."],
    ["directness", "Direct play", v => v.toFixed(0) + "%", "How much they go long vs build patiently. Formula: long balls ÷ (passes + long balls)."],
    ["pressPg", "Pressing", v => v.toFixed(0) + "/g", "Defensive activity. Formula: (tackles + interceptions) per match."],
    ["shotsPg", "Attacking", v => v.toFixed(1) + "/g", "Shot volume. Formula: shots taken per match."],
  ];
  const pct = key => { const vs = me.map(x => x[key]), lo = Math.min(...vs), hi = Math.max(...vs); return hi > lo ? Math.round((mine[key] - lo) / (hi - lo) * 100) : 50; };
  const rows = AXES.map(([key, label, fmt, help]) => `<div class="sty-item">
    <div class="sty-row"><span class="sty-lbl">${label}${infoBtn(help + " The bar shows where they rank among all teams (full = highest), not how good it is.", label + " explained")}</span><span class="sty-bar"><i style="width:${pct(key)}%"></i></span><span class="sty-v">${fmt(mine[key])}</span></div></div>`).join("");
  return `<div class="eyebrow">Playing style</div><div class="sty-card">${rows}<p class="sty-hint">Where ${esc(S.teams[code].name)} ranks among teams with match stats. A fuller bar means more than its rivals, not "better".</p></div>`;
}
// "Then & Now": this team at the last World Cup (2022) — their finish + who carried over vs who's new this time.
function since2022Section(code) {
  if (!S.wc22) return "";   // dataset not loaded yet (re-renders when it lands)
  const c = wc22Continuity(code);
  if (!c) { const debut = S.teams[code]?.best === "First appearance";
    return `<div class="eyebrow">Since 2022</div><div class="s22-card s22-absent"><b>${debut ? "World Cup debut" : "Did not play at Qatar 2022"}</b><span>${debut ? "Their first-ever World Cup." : "Back at the World Cup this year."}</span></div>`; }
  const cont = c.continuing.length, fresh = c.fresh.length, tot = cont + fresh, pct = tot ? Math.round(cont / tot * 100) : 0;
  const names = arr => arr.map(p => esc(pName(p.name, code))).join(", ") || "None";
  return `<div class="eyebrow">Since 2022</div>
    <div class="s22-card">
      <div class="s22-top"><span class="s22-finish s22-t${c.tier}">Qatar 2022: ${esc(c.finish)}</span><span class="s22-split"><b>${cont}</b> returning · <b>${fresh}</b> new</span></div>
      <div class="s22-bar" role="img" aria-label="${cont} of ${tot} played in 2022"><i style="width:${pct}%"></i></div>
      <details class="s22-det"><summary>${cont} carried over from the 2022 squad</summary><p>${names(c.continuing)}</p></details>
      <details class="s22-det"><summary>${fresh} new since 2022</summary><p>${names(c.fresh)}</p></details>
    </div>`;
}
function openTeam(code) {
  const t = S.teams[code]; if (!t) return;
  const all = S.matches.filter(m => matchHasTeam(m, code)).sort((a, b) => a.utc.localeCompare(b.utc));
  const group = groupOf(code), tbl = group ? standings(group) : [];
  const pos = tbl.findIndex(r => r.code === code) + 1, played = tbl.find(r => r.code === code)?.p || 0;
  const done = all.filter(m => status(m) !== ST.SCHED), upcoming = all.filter(m => status(m) === ST.SCHED);
  const sq = S.squads?.[code], isFav = code === S.fav;
  const tms = teamMatchStats(code);
  const tmsHtml = tms.length ? `<div class="eyebrow">Match stats</div><div class="tms"><div class="tms-head"><span class="tms-opp">Opponent</span><span>Result</span><span>Poss</span><span>Shots</span><span>SoT</span></div>${tms.map(row => `<div class="tms-row" data-mid="${row.mid}" role="button" tabindex="0"><span class="tms-opp"><span class="fl">${flag(row.opp)}</span> ${esc(S.teams[row.opp]?.name || "TBD")}</span><span class="rchip rchip-${row.wdl}">${row.wdl} ${row.gf}–${row.ga}</span><span class="tms-v">${row.poss != null ? row.poss + "%" : "–"}</span><span class="tms-v">${row.sh ?? "–"}</span><span class="tms-v">${row.sot ?? "–"}</span></div>`).join("")}</div>` : "";
  $("#teamSheetTitle").innerHTML = `<span class="fl">${flag(code)}</span> ${esc(t.name)}`;
  $("#teamSheetBody").innerHTML = `
    <div class="ts-meta">${t.conf ? esc(t.conf) : ""}${group ? ` · Group ${group}` : ""}${played ? ` · <b>${ordinal(pos)}</b> after ${played} match${played > 1 ? "es" : ""}` : ""}</div>
    ${teamOverview(code)}
    ${countryMiniMap(code)}
    ${wcHistory(code)}
    ${since2022Section(code)}
    <div class="ts-actrow">
      ${isFav
        ? `<div class="ts-fav-tag">★ Your team</div>`
        : `<button class="ts-setfav" data-follow="${code}">★ Make ${esc(t.name)} my team</button>`}
      <button class="ts-compare" data-compare-team="${code}">${ICO.compare} Compare</button>
    </div>
    ${styleSection(code)}
    ${tmsHtml}
    ${sq ? `<details class="ts-squad" open><summary><span>Squad</span><small>${sq.players.length} players${teamCoach(code) ? ` · ${esc(teamCoach(code))}` : ""}</small></summary>${rosterMarkup(sq, code)}</details>`
        : `<div class="eyebrow">Squad</div><div class="empty">${esc(t.name)}'s squad isn't published yet. Check back closer to kickoff.</div>`}
    ${done.length ? `<div class="eyebrow">Results</div>${done.map((m, i) => matchCard(m, i)).join("")}` : ""}
    ${upcoming.length ? `<div class="eyebrow">Fixtures</div>${upcoming.map((m, i) => matchCard(m, i)).join("")}` : (done.length ? "" : `<div class="empty">Fixtures to be confirmed.</div>`)}
    ${group ? `<div class="eyebrow">Group ${group}</div><div class="gwrap">${groupTable(group, 0)}</div>
      <div class="legend"><span class="l1"><i></i>Top 2 advance</span><span class="l3"><i></i>3rd: possible best-8 spot</span></div>` : ""}
    ${roadSection(code)}
    ${rotationSection(code)}`;
  $("#teamSheet").dataset.code = code;   // so loadWC2022() can re-render this sheet once the dataset lands
  showSheet($("#teamSheet"));
  fillCountryMap(code);   // lazy: drop in the country silhouette once the shapes file loads
}
// a small "country shape" map at the top of the team sheet — the nation's silhouette filled in its kit colours.
// The 46KB shapes file is fetched once, on first team-sheet open; the two micro-states without a 110m shape just
// get no map (the section removes itself). Same equirectangular space as the world map.
function countryMiniMap(code) {
  return _countryShapes && !_countryShapes[code] ? "" : `<div class="ctry-map" id="ctryMap" data-mapcode="${code}"><span class="ctry-map-ph"></span></div>`;
}
let _countryShapes = null;
async function fillCountryMap(code) {
  if (!$("#ctryMap")) return;
  if (_countryShapes == null) { try { _countryShapes = await (await fetch("assets/country-shapes.json?v=" + BUILD)).json(); } catch { _countryShapes = {}; } }
  if (_worldMap == null) { try { _worldMap = await (await fetch("assets/worldmap.svg?v=" + BUILD)).text(); } catch { _worldMap = ""; } }
  const host = $("#ctryMap"); if (!host || host.dataset.mapcode !== code) return;   // the sheet changed while loading
  const t = S.teams[code];
  const cap = `<span class="ctry-map-name"><span class="fl">${flag(code)}</span> ${esc(t.name)}</span>${t.pop ? `<span class="ctry-map-pop">Population · <b>${popWords(t.pop)}</b></span>` : ""}`;
  const s = _countryShapes[code];
  if (!s) { host.classList.add("ctry-map-solo"); host.innerHTML = `<span class="ctry-map-cap">${cap}</span>`; return; }   // micro-states absent from the 110m set
  // widen the country's bounding box so the surrounding land shows around it, for a sense of where it sits
  const [x, y, w, h] = s.vb.split(" ").map(Number), pad = Math.max(w, h) * 0.42;
  const vb = `${(x - pad).toFixed(1)} ${(y - pad).toFixed(1)} ${(w + 2 * pad).toFixed(1)} ${(h + 2 * pad).toFixed(1)}`;
  const land = (/<path d="([^"]+)"/.exec(_worldMap || "") || [, ""])[1];
  const c1 = t.c1 || "var(--acc1)", c2 = t.c2 || c1, gid = "cg-" + code.replace(/[^A-Za-z]/g, "");
  host.innerHTML = `<svg class="ctry-svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map showing the location of ${esc(t.name)}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    ${land ? `<path class="ctry-context" d="${land}"/>` : ""}
    <path d="${s.d}" fill="url(#${gid})" stroke="#fff" stroke-width="1.1" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg><span class="ctry-map-cap">${cap}</span>`;
}
// best-effort match of a feed name (e.g. "Julian QUINONES") to a squad entry (names come from a different feed)
// the squad player behind a feed reference (caps, club, position, jersey) — same robust resolver as the name & photo,
// so the bio can never describe a different person than the one named.
function squadBio(name, code) { return resolvePlayer(name, code); }
// tap a player name anywhere (timeline, lineup, Golden Boot, squad) → a compact profile.
// Uses live-match context (XI position + what they did) only when a match modal is actually open.
// join a player to their ESPN per-match box score (pstats keys are raw ESPN names) — exact, then unique surname
function matchPstat(name, ps) {
  if (!ps) return null;
  const nn = normName(name);
  for (const k in ps) if (normName(k) === nn) return ps[k];
  const sur = surnameOf(name), bySur = Object.keys(ps).filter(k => surnameOf(k) === sur);
  return bySur.length === 1 ? ps[bySur[0]] : null;   // don't guess when a surname is shared
}
const PL_BOX = [["sh", "Shots"], ["sot", "On target"], ["g", "Goals"], ["a", "Assists"], ["sv", "Saves"], ["ga", "Conceded"], ["fa", "Fouls won"], ["fc", "Fouls"], ["of", "Offside"]];
function openPlayer(name, code) {
  const team = S.teams[code];
  const md = $("#matchDialog");
  const m = (md?.open && md.dataset.openMid) ? S.matches.find(x => x.id === md.dataset.openMid) : null;
  const r = m && res(m);
  const bio = squadBio(name, code);
  const photo = atWidth(bestPhoto(name, code, bio?.n) || bio?.photo || "", 640);   // sharp on retina for the big 78px popup avatar
  let num = null, pos = "";
  if (r?.xi && m) {
    const side = slotInfo(m, "home").code === code ? "h" : "a";
    const row = (r.xi[side]?.xi || []).find(p => p[1] === name);
    if (row) { num = row[0]; pos = ["Goalkeeper", "Defender", "Midfielder", "Forward"][row[2]] || ""; }
  }
  if (bio) { if (num == null && bio.n != null) num = bio.n; if (!pos && bio.pos) pos = { GK: "Goalkeeper", DF: "Defender", MF: "Midfielder", FW: "Forward" }[bio.pos] || ""; }
  const vitals = playerBio(name, code, num, pos), age = vitals?.d ? ageFrom(vitals.d) : null;   // FIFA DOB/height/weight
  const wc = playerWC(name, code);   // this-tournament record, counted from the team's played matches
  const isGK = pos === "Goalkeeper" || bio?.pos === "GK";   // keepers: clean sheets / conceded, not goals / assists
  const isDF = pos === "Defender" || bio?.pos === "DF";     // defenders: clean sheets + goals (assists are rarely their story)
  const acts = (r?.ev || []).filter(e => [e.p, e.a, e.on, e.off].includes(name)).map(e => {
    const mn = esc(e.t || "");
    if (["G", "P", "OG"].includes(e.k)) return `<span class="pl-act">${ICO.ball} ${mn}${e.k === "P" ? " pen" : e.k === "OG" ? " o.g." : ""}${e.a === name && e.p !== name ? " · assist" : ""}</span>`;
    if (e.k === "Y") return `<span class="pl-act"><i class="tl-card y"></i> ${mn}</span>`;
    if (e.k === "R") return `<span class="pl-act"><i class="tl-card r"></i> ${mn}</span>`;
    if (e.k === "S") return `<span class="pl-act">${e.on === name ? "▲ on" : "▼ off"} ${mn}</span>`;
    return "";
  }).join("");
  const log = playerMatchLog(name, code);    // every match they featured in, this tournament
  const logHtml = log.length ? `<div class="eyebrow">Match log</div><div class="plog">${log.map(row => {
    const tags = [];
    if (row.g) tags.push(`<span class="plog-tag">${ICO.ball}${row.g > 1 ? " " + row.g : ""}</span>`);
    if (row.a) tags.push(`<span class="plog-tag">${row.a}<i>A</i></span>`);
    if (row.yc) tags.push(`<i class="tl-card y"></i>`);
    if (row.rc) tags.push(`<i class="tl-card r"></i>`);
    const did = tags.length ? `<span class="plog-did">${tags.join("")}</span>` : `<span class="plog-app">${row.started ? "Started" : "Sub"}</span>`;
    return `<div class="plog-row" data-mid="${row.mid}" role="button" tabindex="0"><span class="plog-opp"><span class="fl">${flag(row.opp)}</span> ${esc(S.teams[row.opp]?.name || "TBD")}</span><span class="rchip rchip-${row.wdl}">${row.wdl} ${row.gf}–${row.ga}</span>${did}</div>`;
  }).join("")}</div>` : "";
  const box = matchPstat(name, r?.pstats);   // ESPN per-match box score for this player, if a match is open
  const boxHtml = box ? PL_BOX.filter(([k]) => box[k]).map(([k, label]) => `<span class="pl-stat"><b>${box[k]}</b>${label}</span>`).join("") : "";
  $("#playerTitle").textContent = pName(name, code);   // real dialog name for screen readers (was a generic "Player")
  $("#playerBody").innerHTML = `
    <div class="pl">
      ${photo ? `<span class="pl-portrait pl-zoomable" style="background-image:url('${photo}')" data-zoom="${esc(photo)}" role="button" tabindex="0" aria-label="View full-size photo" title="Tap to enlarge"></span>` : `<span class="pl-portrait pl-flag">${code ? flag(code) : "·"}</span>`}
      <div class="pl-meta">
        <b class="pl-name">${esc(pName(name, code))}</b>
        ${code ? `<button type="button" class="pl-team pl-team-link" data-squad="${code}" title="View ${esc(team?.name || code)}">${flag(code)} ${esc(team?.name || code)}</button>` : `<span class="pl-team">${esc(team?.name || "")}</span>`}
        ${(num != null || pos) ? `<span class="pl-pos">${num != null ? "#" + num : ""}${num != null && pos ? " · " : ""}${pos}${isCaptain(name, code) ? ` · <b class="pl-capt">Captain</b>` : ""}</span>` : ""}
      </div>
    </div>
    ${(age != null || vitals?.h || vitals?.w) ? `<div class="pl-bio">
      ${age != null ? `<span><i>Age</i>${age}</span>` : ""}
      ${vitals?.h ? `<span><i>Height</i>${vitals.h} cm</span>` : ""}
      ${vitals?.w ? `<span><i>Weight</i>${vitals.w} kg</span>` : ""}
    </div>` : ""}
    ${(bio?.caps != null || bio?.goals) ? `<div class="pl-bio pl-bio-intl">
      ${bio?.caps != null ? `<span><i>Int'l caps</i>${bio.caps}</span>` : ""}
      ${bio?.goals ? `<span><i>Int'l goals</i>${bio.goals}</span>` : ""}
    </div>` : ""}
    ${bio?.club ? `<div class="pl-club"><i>Club</i><b>${esc(bio.club)}</b></div>` : ""}
    ${wc.apps ? `<div class="eyebrow">This World Cup</div><div class="pl-wc">
      <div class="pw"><b>${wc.apps}</b><span>Played</span></div>
      ${isGK
        ? `<div class="pw"><b>${wc.cs}</b><span>Clean sheet${wc.cs !== 1 ? "s" : ""}</span></div>
      <div class="pw"><b>${wc.ga}</b><span>Conceded</span></div>`
        : isDF
        ? `<div class="pw"><b>${wc.cs}</b><span>Clean sheet${wc.cs !== 1 ? "s" : ""}</span></div>
      <div class="pw"><b>${wc.g}</b><span>Goal${wc.g !== 1 ? "s" : ""}</span></div>`
        : `<div class="pw"><b>${wc.g}</b><span>Goal${wc.g !== 1 ? "s" : ""}</span></div>
      <div class="pw"><b>${wc.a}</b><span>Assist${wc.a !== 1 ? "s" : ""}</span></div>`}
      <div class="pw"><b class="pw-cards">${wc.y || wc.rc ? `${wc.y ? `<span class="cc cc-y">${wc.y}</span>` : ""}${wc.rc ? `<span class="cc cc-r">${wc.rc}</span>` : ""}` : "0"}</b><span>Cards</span></div>
    </div>` : ""}
    ${logHtml}
    ${(boxHtml || acts) ? `<div class="eyebrow">In this match</div>${boxHtml ? `<div class="pl-box">${boxHtml}</div>` : ""}${acts ? `<div class="pl-acts">${acts}</div>` : ""}` : ""}
    <button class="pl-compare" data-compare-seed="${esc(name)}|${code}">${ICO.compare} Compare with another player</button>`;
  const cmpBtn = $("#playerBody [data-compare-seed]");
  if (cmpBtn) cmpBtn.onclick = () => { const [n, c] = cmpBtn.dataset.compareSeed.split("|"); $("#playerDialog").close(); openCompareSearch({ name: n, code: c }); };
  showSheet($("#playerDialog"));
}
const ordinal = n => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

/* ---------------- global search (teams · players · matches) ---------------- */
// Result rows reuse the existing data-squad / data-player / data-mid delegation, so a tap
// opens the right sheet; #searchResults' own listener just closes the overlay first.
let SIDX = null, _sidxSig = "";
// Memoised wrapper: rebuilding the whole index (every team, ~700 players, every match's slot resolution) on each
// search-open was wasted work when nothing changed. Rebuild only when the data that feeds it moves — team count,
// total squad size, match count, or the results stamp (which is what flips knockout slot names + scores).
function searchIndex() {
  const sig = S.matches.length + "|" + Object.keys(S.teams).length + "|" +
    Object.values(S.squads || {}).reduce((n, s) => n + (s.players ? s.players.length : 0), 0) + "|" + (S.results.updated || "");
  if (SIDX && sig === _sidxSig) return SIDX;
  _sidxSig = sig;
  return (SIDX = buildSearchIndex());
}
function buildSearchIndex() {
  const teams = Object.keys(S.teams).map(c => ({ code: c, name: S.teams[c].name, conf: S.teams[c].conf || "" }));
  const players = [];
  for (const [code, sq] of Object.entries(S.squads || {}))
    for (const p of (sq.players || [])) players.push({ name: (p.name || "").replace(" (captain)", ""), code, club: p.club || "" });
  const matches = S.matches.map(m => {
    const h = slotInfo(m, "home"), a = slotInfo(m, "away");
    return { id: m.id, hc: h.code, ac: a.code,
      hn: h.code ? S.teams[h.code].name : slotText(m, "home", h),
      an: a.code ? S.teams[a.code].name : slotText(m, "away", a),
      stage: m.group ? "Group " + m.group : (m.round || ""), city: (m.city || "").split(",")[0] };
  });
  return { teams, players, matches };
}
let compareSeed = null;   // when set, the search overlay is in "pick a player to compare" mode
let compareTeamSeed = null;   // when set (a team code), the search overlay is in "pick a team to compare" mode
function openSearch() { compareSeed = null; compareTeamSeed = null; openSearchOverlay(); }
function openCompareSearch(seed) { compareSeed = seed; compareTeamSeed = null; openSearchOverlay(); }
function openTeamCompareSearch(code) { compareTeamSeed = code; compareSeed = null; openSearchOverlay(); }
// a gentle roll of example queries that stands in for a static placeholder on the main search
const SEARCH_ROLL = ["Brazil", "Mbappé", "Miami", "Argentina", "Mexico", "Spain", "Senegal", "Boston"];
let _rollTimer = null, _rollIdx = 0;
function stopSearchRoll() { if (_rollTimer) { clearInterval(_rollTimer); _rollTimer = null; } }
function startSearchRoll() {
  const el = $("#searchRoll"); if (!el) return;
  stopSearchRoll(); _rollIdx = 0;
  const b = el.querySelector("b"); if (b) b.textContent = SEARCH_ROLL[0];
  el.classList.remove("is-hidden", "swap");
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;   // one static suggestion, no cycling
  _rollTimer = setInterval(() => {
    if ($("#searchInput")?.value) return;          // hold while there's a query in the box
    el.classList.add("swap");                       // current term slides up + fades out the TOP…
    setTimeout(() => {
      _rollIdx = (_rollIdx + 1) % SEARCH_ROLL.length;
      const t = el.querySelector("b"); if (t) t.textContent = SEARCH_ROLL[_rollIdx];
      el.classList.add("enter"); el.classList.remove("swap");   // …drop the next term in below the line (no transition)…
      void el.offsetWidth;                                       // commit that jump
      el.classList.remove("enter");                              // …then let it rise UP into place from the bottom (one direction)
    }, 280);
  }, 2600);
}
function openSearchOverlay() {
  searchIndex();   // (re)builds SIDX only when the underlying data changed
  const inp = $("#searchInput"), roll = $("#searchRoll");
  inp.value = "";
  if (compareSeed) { inp.placeholder = `Compare ${pName(compareSeed.name, compareSeed.code)} with…`; stopSearchRoll(); if (roll) roll.classList.add("is-hidden"); }
  else if (compareTeamSeed) { inp.placeholder = `Compare ${esc(S.teams[compareTeamSeed]?.name || compareTeamSeed)} with…`; stopSearchRoll(); if (roll) roll.classList.add("is-hidden"); }
  else { inp.placeholder = ""; startSearchRoll(); }
  renderSearch("");
  showSheet($("#searchDialog"));
  $("#searchResults").onclick = e => {
    const cmp = e.target.closest("[data-compare]");  // compare mode: a player was picked
    if (cmp) { const [n, c] = cmp.dataset.compare.split("|"); const seed = compareSeed; compareSeed = null; $("#searchDialog").close(); openCompare(seed, { name: n, code: c }); return; }
    const cmpT = e.target.closest("[data-compare-pick]");   // team-compare mode: a second team was picked
    if (cmpT) { const seed = compareTeamSeed; compareTeamSeed = null; $("#searchDialog").close(); openTeamCompare(seed, cmpT.dataset.comparePick); return; }
    // Open the picked result HERE — in the same handler as the close — not via the document delegation. The modal
    // history-back runs at the microtask checkpoint BETWEEN event listeners, so if we only closed and let the doc
    // handler open the target on the next listener, that back() fires in the gap (no dialog open yet) and a popstate
    // immediately tears down the dialog we just opened. stopPropagation keeps the doc handler from double-firing.
    const pl = e.target.closest("[data-player]"), sq = e.target.closest("[data-squad]"), md = e.target.closest("[data-mid]");
    e.stopPropagation();
    $("#searchDialog").close();
    if (pl) { const [n, c] = pl.dataset.player.split("|"); openPlayer(n, c); }
    else if (sq && sq.dataset.squad) openTeam(sq.dataset.squad);
    else if (md) openMatch(md.dataset.mid);
  };
  setTimeout(() => inp.focus(), 60);
}
function renderSearch(raw) {
  const q = raw.trim().toLowerCase(), res = $("#searchResults"), cmp = !!compareSeed;
  const tname = c => esc(S.teams[c]?.name || c);
  if (compareTeamSeed) {   // team-compare mode: teams only, tapping picks the second team
    if (!q) { res.innerHTML = ""; return; }
    const ts = SIDX.teams.filter(t => ((t.name || "").toLowerCase().includes(q) || t.code.toLowerCase() === q || (t.conf || "").toLowerCase().includes(q)) && t.code !== compareTeamSeed)
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 10);
    res.innerHTML = ts.length ? `<div class="sr-label">Compare with…</div>` + ts.map(t =>
      `<button class="sr-row" data-compare-pick="${t.code}"><span class="fl">${flag(t.code)}</span><span class="sr-name">${esc(t.name)}<small>${esc(t.conf)}</small></span></button>`).join("")
      : `<div class="sr-hint">No teams match “${esc(raw.trim())}”.</div>`;
    return;
  }
  if (!q) { res.innerHTML = ""; return; }   // empty state: the placeholder (rolling suggestions, or "Compare X with…") says it all
  const has = s => (s || "").toLowerCase().includes(q);
  // relevance: a word that *starts* with the query beats a mid-word hit (so "mess" → Messi, not a club coincidence)
  const rank = s => { const n = (s || "").toLowerCase(); return n.startsWith(q) ? 0 : n.split(/\s+/).some(w => w.startsWith(q)) ? 1 : 2; };
  const byRank = key => (a, b) => rank(key(a)) - rank(key(b)) || key(a).localeCompare(key(b));
  const players = SIDX.players.filter(p => (has(p.name) || has(p.club)) && !(cmp && p.name === compareSeed.name && p.code === compareSeed.code)).sort(byRank(p => p.name)).slice(0, cmp ? 12 : 8);
  const playerRowHtml = (p, attr) => { const ph = bestPhoto(p.name, p.code, p.n);
    return `<button class="sr-row" ${attr}>${ph ? `<span class="lead-face" style="background-image:url('${ph}')"></span>` : `<span class="fl">${flag(p.code)}</span>`}<span class="sr-name">${esc(pName(p.name, p.code))}<small>${flag(p.code)} ${tname(p.code)}${p.club ? ` · ${esc(p.club)}` : ""}</small></span></button>`; };
  if (cmp) {   // compare mode: players only, tapping picks the second player
    res.innerHTML = players.length ? `<div class="sr-label">Compare with…</div>` + players.map(p => playerRowHtml(p, `data-compare="${esc(p.name)}|${p.code}"`)).join("") : `<div class="sr-hint">No players match “${esc(raw.trim())}”.</div>`;
    return;
  }
  const teams = SIDX.teams.filter(t => has(t.name) || t.code.toLowerCase() === q || has(t.conf)).sort(byRank(t => t.name)).slice(0, 6);
  const matches = SIDX.matches.filter(m => has(m.hn) || has(m.an) || has(m.city) || has(m.stage)).slice(0, 6);
  const teamHtml = teams.length ? `<div class="sr-label">Teams</div>` + teams.map(t =>
    `<button class="sr-row" data-squad="${t.code}"><span class="fl">${flag(t.code)}</span><span class="sr-name">${esc(t.name)}<small>${esc(t.conf)}</small></span></button>`).join("") : "";
  const playerHtml = players.length ? `<div class="sr-label">Players</div>` + players.map(p => playerRowHtml(p, `data-player="${esc(p.name)}|${p.code}"`)).join("") : "";
  const matchHtml = matches.length ? `<div class="sr-label">Matches</div>` + matches.map(m =>
    `<button class="sr-row" data-mid="${m.id}"><span class="sr-vs">${m.hc ? flag(m.hc) : TBD_FLAG}${m.ac ? flag(m.ac) : TBD_FLAG}</span><span class="sr-name"><span class="sr-mt">${esc(m.hn)} <i>v</i> ${esc(m.an)}</span><small>${esc(m.stage)}${m.city ? ` · ${esc(m.city)}` : ""}</small></span></button>`).join("") : "";
  res.innerHTML = (teamHtml + playerHtml + matchHtml) || `<div class="sr-hint">No teams, players or matches match “${esc(raw.trim())}”.</div>`;
}
// feed scorer names (e.g. "Cyle LARIN") and squad names (e.g. "Cyle Larin") differ in case and
// sometimes fullness — match tolerantly so a player picked from search still finds their feed stats.
function sameName(a, b) {
  if (a === b) return true;
  const x = normName(a), y = normName(b);
  return x === y || (x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x)));
}
// a player's tournament + career line, for the comparison view
function playerStats(name, code, ts) {
  const hit = list => list.find(p => p.code === code && sameName(p.name, name));
  const sc = hit(ts.scorers), as = hit(ts.assisters), bk = hit(ts.booked), ke = hit(ts.keepers);
  const bio = squadBio(name, code) || {};
  return { goals: sc?.goals || 0, assists: sc?.assists ?? as?.assists ?? 0, y: bk?.y || 0, r: bk?.r || 0, cs: ke?.cs || 0,
    caps: bio.caps, careerGoals: bio.goals, club: bio.club, pos: bio.pos, photo: atWidth(bestPhoto(name, code, bio.n) || bio.photo || "", 640) };
}
// head-to-head comparison of two players (reuses the player dialog)
function openCompare(a, b) {
  if (!a || !b) return;
  const ts = tournamentStats();
  const A = playerStats(a.name, a.code, ts), B = playerStats(b.name, b.code, ts);
  const va = playerBio(a.name, a.code), vb = playerBio(b.name, b.code);   // FIFA vitals (age/height/weight)
  const ageA = va?.d ? ageFrom(va.d) : null, ageB = vb?.d ? ageFrom(vb.d) : null;
  const POS = { GK: "Goalkeeper", DF: "Defender", MF: "Midfielder", FW: "Forward" };
  const head = (p, side) => `<div class="cmp-p">
    ${p.photo ? `<span class="pl-face" style="background-image:url('${p.photo}')"></span>` : `<span class="pl-face pl-flag">${flag(side.code)}</span>`}
    <b>${esc(pName(side.name, side.code))}</b><span>${flag(side.code)} ${esc(S.teams[side.code]?.name || side.code)}</span>${p.pos ? `<span class="cmp-pos">${POS[p.pos] || p.pos}</span>` : ""}</div>`;
  const row = (label, av, bv, hi = true) => {
    const an = +av || 0, bn = +bv || 0;
    return `<div class="cmp-row"><span class="cmp-a ${hi && an > bn ? "win" : ""}">${av ?? "–"}</span><span class="cmp-lbl">${label}</span><span class="cmp-b ${hi && bn > an ? "win" : ""}">${bv ?? "–"}</span></div>`;
  };
  $("#playerTitle").textContent = "Compare";
  $("#playerBody").innerHTML = `<div class="cmp">
    <div class="cmp-head">${head(A, a)}<span class="cmp-vs">vs</span>${head(B, b)}</div>
    <div class="eyebrow">This tournament</div>
    <div class="cmp-rows">
      ${row("Goals", A.goals, B.goals)}
      ${row("Assists", A.assists, B.assists)}
      ${row("Clean sheets", A.cs, B.cs)}
      ${row("Yellow cards", A.y, B.y, false)}
      ${row("Red cards", A.r, B.r, false)}
    </div>
    ${(A.caps != null || B.caps != null || A.club || B.club) ? `<div class="eyebrow">Career</div><div class="cmp-rows">
      ${row("Caps", A.caps, B.caps)}
      ${row("Career goals", A.careerGoals, B.careerGoals)}
      <div class="cmp-row"><span class="cmp-a cmp-txt">${A.club ? esc(A.club) : "–"}</span><span class="cmp-lbl">Club</span><span class="cmp-b cmp-txt">${B.club ? esc(B.club) : "–"}</span></div>
    </div>` : ""}
    ${(va || vb) ? `<div class="eyebrow">Profile</div><div class="cmp-rows">
      ${row("Age", ageA, ageB, false)}
      ${row("Height", va?.h ? va.h + " cm" : null, vb?.h ? vb.h + " cm" : null, false)}
      ${row("Weight", va?.w ? va.w + " kg" : null, vb?.w ? vb.w + " kg" : null, false)}
    </div>` : ""}
    <button class="pl-compare" data-recompare="${esc(a.name)}|${a.code}">${ICO.compare} Compare ${esc(a.name)} with someone else</button></div>`;
  const re = $("#playerBody [data-recompare]");
  if (re) re.onclick = () => { const [n, c] = re.dataset.recompare.split("|"); $("#playerDialog").close(); openCompareSearch({ name: n, code: c }); };
  showSheet($("#playerDialog"));
}
// neutral-venue model win-probability + expected score between any two teams (same bivariate-Poisson core as winProb,
// minus match context — no host edge, group base rate). Powers the "if they met now" line in team comparison.
function h2hProb(aCode, bCode) {
  const ea = teamRating(aCode), eb = teamRating(bCode);
  const mu = 1.35, sup = Math.max(-2.5, Math.min(2.5, (ea - eb) / 300));
  const la = Math.max(0.18, mu + sup / 2), lb = Math.max(0.18, mu - sup / 2);
  let pa = 0, pd = 0, pb = 0, xa = 0, xb = 0;
  for (let x = 0; x < 9; x++) for (let y = 0; y < 9; y++) {
    const p = _pois(x, la) * _pois(y, lb) * _dcTau(x, y, la, lb);
    if (x > y) pa += p; else if (x < y) pb += p; else pd += p;
    xa += x * p; xb += y * p;
  }
  const tot = pa + pd + pb || 1;
  return { a: pa / tot, d: pd / tot, b: pb / tot, xa: xa / tot, xb: xb / tot };
}
// every comparable datum for one team, gathered from the live tables, the strength model and the static meta
function teamCompareData(code) {
  const t = S.teams[code] || {};
  const g = groupOf(code), tbl = g ? standings(g) : [];
  const r = tbl.find(x => x.code === code) || {};
  const tms = teamMatchStats(code);
  const avg = key => { const vs = tms.map(x => x[key]).filter(v => v != null); return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null; };
  const style = (tournamentStats().style || []).find(x => x.code === code) || null;
  return {
    code, name: t.name || code, conf: t.conf || "", c1: t.c1 || "var(--ink-soft)",
    rank: fifaRankOf(code), elo: Math.round(teamRating(code)), titles: t.titles || 0, apps: t.apps,
    best: t.best || "",
    played: r.p || 0, w: r.w || 0, d: r.d || 0, l: r.l || 0, gf: r.gf || 0, ga: r.ga || 0,
    gd: (r.gf || 0) - (r.ga || 0), pts: r.pts || 0, style,
  };
}
// head-to-head comparison of two TEAMS (reuses the player dialog shell). Mirrors the player-compare layout but
// richer: a model win-probability centrepiece, tournament vs-bars, strength rows, mirrored style bars, pedigree.
function openTeamCompare(aCode, bCode) {
  if (!aCode || !bCode || !S.teams[aCode] || !S.teams[bCode]) return;
  const A = teamCompareData(aCode), B = teamCompareData(bCode);
  const wp = h2hProb(aCode, bCode);
  const pa = Math.round(wp.a * 100), pd = Math.round(wp.d * 100), pb = 100 - pa - pd;
  const styleList = tournamentStats().style || [];
  const pctOf = (key, val) => { const vs = styleList.map(x => x[key]); const lo = Math.min(...vs), hi = Math.max(...vs); return hi > lo ? Math.round((val - lo) / (hi - lo) * 100) : 50; };
  const head = T => `<div class="cmp-p cmp-team">
    <span class="cmp-crest">${flag(T.code)}</span>
    <b>${esc(T.name)}</b><span>${esc(T.conf)}${T.rank ? ` · #${T.rank}` : ""}</span></div>`;
  const numOf = v => v == null ? null : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));   // tolerate "#3", "+2", "1986" etc.
  const row = (label, av, bv, higherWins = true) => {
    const an = numOf(av), bn = numOf(bv);
    const aWin = an != null && bn != null && an !== bn && (higherWins ? an > bn : an < bn);
    const bWin = an != null && bn != null && an !== bn && (higherWins ? bn > an : bn < an);
    return `<div class="cmp-row"><span class="cmp-a ${aWin ? "win" : ""}">${av ?? "–"}</span><span class="cmp-lbl">${label}</span><span class="cmp-b ${bWin ? "win" : ""}">${bv ?? "–"}</span></div>`;
  };
  const axis = (label, aPct, bPct, aVal, bVal) => `<div class="cmpx">
    <span class="cmpx-v cmpx-va">${aVal}</span>
    <span class="cmpx-tk cmpx-l"><i style="width:${aPct}%;background:${A.c1}"></i></span>
    <span class="cmpx-lbl">${label}</span>
    <span class="cmpx-tk cmpx-r"><i style="width:${bPct}%;background:${B.c1}"></i></span>
    <span class="cmpx-v cmpx-vb">${bVal}</span></div>`;
  const hasPlayed = A.played || B.played;
  const styleRows = (A.style && B.style) ? [
    ["poss", "Possession", v => v.toFixed(0) + "%"],
    ["passAcc", "Passing", v => v.toFixed(0) + "%"],
    ["directness", "Direct play", v => v.toFixed(0) + "%"],
    ["pressPg", "Pressing", v => v.toFixed(0)],
    ["shotsPg", "Attacking", v => v.toFixed(1)],
  ].map(([k, lbl, f]) => axis(lbl, pctOf(k, A.style[k]), pctOf(k, B.style[k]), f(A.style[k]), f(B.style[k]))).join("") : "";
  const histStrip = T => { const h = WC_HIST[T.code]; if (!h) return ""; return [2002, 2006, 2010, 2014, 2018, 2022].map(y =>
    `<div class="wch-chip" data-r="${h[y] || '-'}"><span class="wch-yr">’${String(y).slice(2)}</span><span class="wch-res">${h[y] || "–"}</span></div>`).join(""); };
  const hA = histStrip(A), hB = histStrip(B);
  const sign = n => (n > 0 ? "+" : "") + n;
  $("#playerTitle").textContent = "Compare teams";
  $("#playerBody").innerHTML = `<div class="cmp cmp-teams">
    <div class="cmp-head">${head(A)}<span class="cmp-vs">vs</span>${head(B)}</div>
    <div class="eyebrow">If they met now <span class="wp-est">model estimate</span></div>
    <div class="wp">
      <div class="wp-bar" role="img" aria-label="${esc(A.name)} ${pa}%, draw ${pd}%, ${esc(B.name)} ${pb}%"><span class="wp-h" style="width:${pa}%"></span><span class="wp-d" style="width:${pd}%"></span><span class="wp-a" style="width:${pb}%"></span></div>
      <div class="wp-legend"><span class="wp-lh"><b>${pa}%</b> ${flag(A.code)} <span class="wp-lname">${esc(A.name)}</span></span><span class="wp-ld">Draw <b>${pd}%</b></span><span class="wp-la"><span class="wp-lname">${esc(B.name)}</span> ${flag(B.code)} <b>${pb}%</b></span></div>
      <div class="wp-score"><span class="wp-score-lab">Projected score</span> <b>${Math.round(wp.xa)}–${Math.round(wp.xb)}</b> <span class="wp-score-p">(${wp.xa.toFixed(1)}–${wp.xb.toFixed(1)})</span></div>
    </div>
    ${hasPlayed ? `<div class="eyebrow">This tournament</div><div class="cmp-rows">
      ${row("Points", A.pts, B.pts)}
      <div class="cmp-row"><span class="cmp-a">${A.w}-${A.d}-${A.l}</span><span class="cmp-lbl">W-D-L</span><span class="cmp-b">${B.w}-${B.d}-${B.l}</span></div>
      ${row("Goals for", A.gf, B.gf)}
      ${row("Goals against", A.ga, B.ga, false)}
      ${row("Goal difference", sign(A.gd), sign(B.gd))}
    </div>` : ""}
    <div class="eyebrow">Strength &amp; ranking${infoBtn("Elo is a continuously-updated strength rating: a team gains or loses points after each match by how much it beats (or loses to) the opponent, weighted by the goal margin and blended with expected goals. Higher = stronger. It differs from the FIFA World Ranking, which uses FIFA's own points formula — so the two can order teams differently.", "Elo vs FIFA rank")}</div><div class="cmp-rows">
      ${row("Elo rating", A.elo, B.elo)}
      ${row("FIFA world rank", A.rank ? "#" + A.rank : null, B.rank ? "#" + B.rank : null, false)}
    </div>
    ${styleRows ? `<div class="eyebrow">Playing style <span class="wp-est">vs the field</span></div><div class="cmpx-card">${styleRows}</div>` : ""}
    <div class="eyebrow">Pedigree</div><div class="cmp-rows">
      ${row("World Cup titles", A.titles, B.titles)}
      ${row("World Cups played", A.apps, B.apps)}
      <div class="cmp-row"><span class="cmp-a cmp-txt">${A.best ? esc(A.best.split(" · ")[0]) : "–"}</span><span class="cmp-lbl">Best finish</span><span class="cmp-b cmp-txt">${B.best ? esc(B.best.split(" · ")[0]) : "–"}</span></div>
    </div>
    ${(hA || hB) ? `<div class="eyebrow">World Cup since 2002</div>
      <div class="cmp-hist"><span class="cmp-hist-fl">${flag(A.code)}</span><div class="wch-grid">${hA || `<span class="cmp-hist-none">No appearances</span>`}</div></div>
      <div class="cmp-hist"><span class="cmp-hist-fl">${flag(B.code)}</span><div class="wch-grid">${hB || `<span class="cmp-hist-none">No appearances</span>`}</div></div>` : ""}
    <button class="pl-compare" data-recompare-team="${A.code}">${ICO.compare} Compare ${esc(A.name)} with another team</button>
  </div>`;
  const re = $("#playerBody [data-recompare-team]");
  if (re) re.onclick = () => { $("#playerDialog").close(); openTeamCompareSearch(re.dataset.recompareTeam); };
  showSheet($("#playerDialog"));
}

/* ---------------- render: groups ---------------- */
const TABLE_COLS = `<colgroup><col class="c-name"><col class="c-n"><col class="c-n"><col class="c-n"><col class="c-n"><col class="c-gd"><col class="c-pts"></colgroup>`;
function groupTable(g, i) {
  const rows = standings(g);
  const started = S.matches.some(x => x.group === g && status(x) === ST.FT && res(x)?.h != null);
  const qtag = code => {                                  // through / out-of-top-two markers (same engine as the stakes line)
    if (!started) return "";
    const q = _qualScan(g, code);
    return q.clinched ? `<span class="qx qx-in" title="Through to the Round of 32">Q</span>`
      : q.out ? `<span class="qx qx-out" title="Can no longer finish in the top two">out</span>` : "";
  };
  return `<div class="gtable" style="--i:${i}"><h4>Group <span>${g}</span></h4>
    <table>${TABLE_COLS}<thead><tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead><tbody>
    ${rows.map((r, idx) => `<tr class="${idx < 2 ? "q1" : idx === 2 ? "q3" : ""} ${r.code === S.fav ? "is-fav" : ""}" data-g="${g}" data-code="${r.code}">
      <td class="tname"><span class="tname-tap" title="View ${esc(S.teams[r.code].name)}" data-squad="${r.code}" role="button" tabindex="0"><span class="fl">${flag(r.code)}</span>${esc(S.teams[r.code].name)}</span>${qtag(r.code)}</td>
      <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.gf - r.ga > 0 ? "+" : ""}${r.gf - r.ga}</td><td><b>${r.pts}</b></td></tr>`).join("")}
    </tbody></table></div>`;
}
// the 48-team format sends 8 of the 12 third-placed teams through — a ranking that's impossible to
// eyeball across 12 separate tables. Rank them by FIFA's third-place criteria (pts → GD → GF) and
// draw the cut line after the 8th. Pure client math, no extra data.
function thirdPlaceRace() {
  const rows = [];
  for (const g of GROUPS) { const t = standings(g)[2]; if (t) rows.push({ group: g, code: t.code, pts: t.pts, gd: t.gf - t.ga, gf: t.gf }); }
  return rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || tiebreakRank(a.code) - tiebreakRank(b.code));
}
function thirdRaceHTML() {
  const anyPlayed = S.matches.some(m => m.group && status(m) === ST.FT && res(m)?.h != null);
  const rows = thirdPlaceRace();
  if (!anyPlayed || rows.length < 3) return "";
  const sign = n => (n > 0 ? "+" : "") + n;
  const ranks = compRanks(rows, r => r.pts + "|" + r.gd + "|" + r.gf);   // genuine 3rd-place criteria; teams level on all three share a rank
  const cut = i => {                                                      // honest cut — a tie group straddling the 8th spot is undecided, not arbitrarily split
    const first = ranks.indexOf(ranks[i]), last = ranks.lastIndexOf(ranks[i]);
    return last < 8 ? "tr-in" : first >= 8 ? "tr-out" : "tr-bubble";
  };
  return `<div class="eyebrow">Race for the best third places</div>
    <div class="third-race">${rows.map((r, i) => `<div class="tr-row ${cut(i)} ${r.code === S.fav ? "is-fav" : ""}" data-squad="${r.code}" role="button" tabindex="0">
      <span class="tr-rank">${ranks[i]}</span><span class="fl">${flag(r.code)}</span>
      <span class="tr-name">${esc(S.teams[r.code]?.name || r.code)}<small>Group ${r.group}</small></span>
      <span class="tr-gd">${sign(r.gd)}</span><span class="tr-pts">${r.pts}<small>pts</small></span></div>${i === 7 && rows.length > 8 && ranks[7] !== ranks[8] ? `<div class="tr-cut"><span>Top 8 advance</span></div>` : ""}`).join("")}</div>
    <p class="sim-ko-hint">Ranked by points, then goal difference, then goals scored: the eight best of twelve reach the Round of 32. Teams level on all three share a rank; FIFA then separates them on fair play, and finally a drawing of lots.</p>`;
}
// read-only "if the groups ended today" Round-of-32 — resolved purely from live standings (group
// winners/runners-up + the best-8 thirds routed through FIFA's slot constraints). Never touches the
// user's saved prediction; that interactive bracket lives in Predict.
function projectedR32() {
  const order = {}; GROUPS.forEach(g => order[g] = standings(g).map(r => r.code));
  const thirds = thirdPlaceRace().slice(0, 8).map(r => r.code);
  const alloc = allocateThirdsPure(r32ThirdSlots(), thirds.map(code => ({ code, g: groupOf(code) })));
  const side = (m, s) => {
    if (s.team) return s.team;
    const sh = s.short || "";
    if (/^[12][A-L]$/.test(sh)) { const o = order[sh[1]] || []; return sh[0] === "1" ? o[0] : o[1]; }
    if (sh.startsWith("3rd")) return alloc ? alloc[m.id + ":" + (s === m.home ? "home" : "away")] : null;
    return null;
  };
  return S.matches.filter(m => m.stage === "r32").sort((a, b) => a.num - b.num)
    .map(m => ({ m, h: side(m, m.home), a: side(m, m.away) }));
}
function projR32HTML() {
  const allDone = GROUPS.every(g => S.matches.filter(x => x.group === g).every(x => status(x) === ST.FT));
  const anyPlayed = S.matches.some(m => m.group && status(m) === ST.FT && res(m)?.h != null);
  if (!anyPlayed) return "";
  const ties = projectedR32();
  const cell = (code, sh) => code && S.teams[code]
    ? `<span class="fl">${flag(code)}</span><span class="pj-nm">${esc(S.teams[code].name)}</span>`
    : `<span class="fl">·</span><span class="pj-nm pj-tbd">${esc(sh || "TBD")}</span>`;
  const rows = ties.map(({ m, h, a }) => `<button class="pj-row" data-mid="${m.id}">
    <span class="pj-side">${cell(h, m.home.short)}</span><span class="pj-v">v</span><span class="pj-side pj-r">${cell(a, m.away.short)}</span></button>`).join("");
  return `<details class="proj"${allDone ? " open" : ""}><summary><span>Projected Round of 32</span><small>if the groups ended today</small></summary>
    <div class="proj-body">${rows}</div>
    <p class="sim-ko-hint">Live group winners &amp; runners-up plus the best-8 third places, routed through FIFA's slot rules. Make your own calls in <b>Predict</b>.</p></details>`;
}
// big-flag "Round of 32 — as it stands" board: the same projectedR32() allocation as the buried Tables list, but as
// tappable tie cards with an honest per-tie certainty chip. Mounted atop Predict so the live bracket greets a visitor
// before the build-your-own editor. Third-place slots stay TBD until mathematically settled — a board this prominent
// must never commit to a nation that can still change (the site's zero-error bar).
function r32SeedInfo(sh) {
  return /^1[A-L]$/.test(sh) ? { lbl: "Winners · Group " + sh[1], g: sh[1] }
    : /^2[A-L]$/.test(sh) ? { lbl: "Runners-up · Group " + sh[1], g: sh[1] }
    : sh.startsWith("3rd") ? { lbl: "Best third place", g: null, third: true }
    : { lbl: sh || "To be decided", g: null };
}
function r32BoardHTML() {
  const anyPlayed = S.matches.some(m => m.group && status(m) === ST.FT && res(m)?.h != null);
  if (!anyPlayed) return "";
  const remOf = g => S.matches.filter(x => x.group === g && status(x) !== ST.FT).length;
  const allGroupsDone = GROUPS.every(g => remOf(g) === 0);
  const ties = projectedR32();
  const CIC = {
    ok: _ico('<path d="M20 6 9 17l-5-5"/>'),
    games: _ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    bubble: _ico('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  };
  const verdict = (sH, sA, h, a) => {                       // honest per-tie certainty
    const thirdPending = (sH.third || sA.third) && !allGroupsDone;
    const rem = (sH.g ? remOf(sH.g) : 0) + (sA.g ? remOf(sA.g) : 0);
    if (thirdPending) return { k: "bubble", t: "On the bubble" };
    if (rem === 0 && h && a) return { k: "ok", t: "Confirmed" };
    return { k: "games", t: rem + " game" + (rem === 1 ? "" : "s") + " left" };
  };
  const side = (code, s) => {
    const locked = s.third ? allGroupsDone : (s.g ? remOf(s.g) === 0 : !!code);
    const tbd = s.third && !locked;                         // never commit a nation to an unsettled third-place slot
    const known = code && !tbd && S.teams[code];
    return `<span class="r32-side">
      <span class="r32-flag">${known ? flag(code) : `<span class="r32-tbdf">?</span>`}</span>
      <span class="r32-id"><span class="r32-nm${known ? "" : " r32-tbd"}">${known ? esc(S.teams[code].name) : "Best 3rd"}</span><span class="r32-seed">${tbd ? "Best 3rd — undecided" : s.lbl}</span></span>
    </span>`;
  };
  let confirmed = 0;
  const cards = ties.map(({ m, h, a }) => {
    const sH = r32SeedInfo(m.home.short), sA = r32SeedInfo(m.away.short);
    const v = verdict(sH, sA, h, a); if (v.k === "ok") confirmed++;
    return `<button class="r32-card" data-mid="${m.id}">
      <span class="r32-top"><span class="r32-no">Match ${m.num}</span><span class="r32-chip r32-chip-${v.k}">${CIC[v.k]}${v.t}</span></span>
      <span class="r32-tie">${side(h, sH)}<span class="r32-mid">v</span>${side(a, sA)}</span>
    </button>`;
  }).join("");
  return `<section class="r32board">
    <div class="r32board-head"><span class="r32board-eyebrow"><span class="r32board-dot"></span>Round of 32 — as it stands</span>
      <p class="r32board-sub">If the groups ended today · <b>${confirmed}</b> of 16 ties confirmed</p></div>
    <div class="r32board-grid">${cards}</div>
    <div class="r32board-foot"><span>Group winners &amp; runners-up plus the best-eight third places, routed through FIFA's slot rules.</span>
      <button class="r32board-cta" data-sim-edit>Make your own picks ${ICO.tap}</button></div>
  </section>`;
}
// a team's current-standings strength (for projecting knockout winners)
function teamStrength(code) {
  const g = groupOf(code); if (!g) return -1;
  const r = standings(g).find(x => x.code === code);
  return r ? r.pts * 1000 + (r.gf - r.ga) * 10 + r.gf : -1;
}
// project the whole knockout bracket from live standings: winner of every match = the stronger team
// (ties → the "home"/upper slot). Returns { W: matchNum→winnerCode }.
function projectBracket() {
  const W = {};
  const str = c => (c ? (S.teams[c]?.elo || 0) : -1);   // project knockout winners by Elo (matches-played-agnostic), not the partial group table
  const pick = (h, a) => (h && a) ? (str(h) >= str(a) ? h : a) : (h || a || null);
  for (const { m, h, a } of projectedR32()) W[m.num] = pick(h, a);
  S.matches.filter(m => ["r16", "qf", "sf", "final"].includes(m.stage)).sort((x, y) => x.num - y.num)
    .forEach(m => { const side = s => s.team || (s.feeds ? W[s.feeds] : null); W[m.num] = pick(side(m.home), side(m.away)); });
  return W;
}
// a team's projected route to the final from where they currently sit: their R32 tie, then each
// onward round assuming they keep winning, with the opponent = the projected winner of the other side.
function roadToFinal(code) {
  const r32 = projectedR32().find(t => t.h === code || t.a === code);
  if (!r32) return null;                                    // not projected into the Round of 32
  const W = projectBracket();
  const feedsTo = {}; S.matches.forEach(m => ["home", "away"].forEach(s => { if (m[s]?.feeds) feedsTo[m[s].feeds] = m.num; }));
  const byNum = n => S.matches.find(m => m.num === n);
  const path = [{ m: r32.m, opp: r32.h === code ? r32.a : r32.h }];
  let cur = r32.m, guard = 0;
  while (guard++ < 6) {
    const nextNum = feedsTo[cur.num]; if (!nextNum) break;  // the final feeds nowhere
    const nm = byNum(nextNum); if (!nm || nm.stage === "third") break;
    const sib = [nm.home, nm.away].find(s => s.feeds && s.feeds !== cur.num);
    path.push({ m: nm, opp: sib ? W[sib.feeds] : null });
    cur = nm;
  }
  return { code, path, reachesFinal: cur.stage === "final" };
}
function roadSection(code) {
  // only project a team's route once they've actually played — before that, standings are all level
  // and any "road" would be arbitrary tiebreak noise.
  const teamPlayed = S.matches.some(m => matchHasTeam(m, code) && status(m) === ST.FT && res(m)?.h != null);
  if (!teamPlayed) {
    const next = S.matches.filter(m => matchHasTeam(m, code) && status(m) === ST.SCHED).sort((a, b) => a.utc.localeCompare(b.utc))[0];
    return `<div class="eyebrow">Road to the final</div><div class="empty">${esc(S.teams[code]?.name || code)}'s projected route opens once they kick off${next ? `, first up ${fmt(next.utc, { weekday: "short", day: "numeric", month: "short" })}` : ""}.</div>`;
  }
  const road = roadToFinal(code);
  if (!road) return `<div class="eyebrow">Road to the final</div><div class="empty">As it stands, ${esc(S.teams[code]?.name || code)} are projected to miss the Round of 32. A couple of group wins flips that.</div>`;
  const t = S.teams[code], reaches = road.reachesFinal;
  const steps = road.path.map(({ m, opp }) => {
    const oc = opp && S.teams[opp];
    return `<div class="rdp-step" data-mid="${m.id}" role="button" tabindex="0" title="${esc(fmt(m.utc, { day: "numeric", month: "short" }))} · ${esc((m.city || "").split(",")[0])}">
      <span class="rdp-rd">${esc(STAGE_SHORT[m.stage] || m.round)}</span>
      <span class="rdp-opp">${oc ? `<span class="fl">${flag(opp)}</span><small>${esc(shortName(opp) || S.teams[opp].name)}</small>` : `<span class="fl">·</span><small>TBD</small>`}</span>
    </div>`;
  }).join(`<span class="rdp-arr">›</span>`);
  return `<div class="eyebrow">Road to the final${reaches ? ` ${TROPHY}` : ""}</div>
    <div class="rdp${reaches ? " rdp-final" : ""}">${steps}${reaches ? `<span class="rdp-arr">›</span><div class="rdp-step rdp-cup"><span class="rdp-rd">Lift it</span><span class="rdp-opp">${TROPHY}</span></div>` : ""}</div>
    <p class="sim-ko-hint">Projected from live standings: assumes ${esc(t.name)} keep winning, with the stronger projected team waiting in each tie. Tap a step to open that match.</p>`;
}
function renderGroups() {
  const el = $("#view-groups");
  const html =
    `<div class="gwrap">${GROUPS.map((g, i) => `<div class="gcol">${groupTable(g, i)}</div>`).join("")}</div>
     <div class="legend"><span class="l1"><i></i>Top 2 advance to the Round of 32</span><span class="l3"><i></i>3rd place: eight best advance</span><button class="legend-about" data-about>ⓘ How the format works</button></div>
     ${thirdRaceHTML()}
     ${projR32HTML()}`;
  if (el.__sig === html) return;                           // groups unchanged (e.g. a minute tick elsewhere) — no flicker
  el.__sig = html;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const prev = {};                                          // capture row positions for a FLIP when standings reorder
  if (!reduce) el.querySelectorAll("tr[data-code]").forEach(tr => prev[tr.dataset.g + tr.dataset.code] = tr.getBoundingClientRect().top);
  el.innerHTML = viewH2("view-groups") + html;
  if (!reduce && Object.keys(prev).length) el.querySelectorAll("tr[data-code]").forEach(tr => {
    const old = prev[tr.dataset.g + tr.dataset.code]; if (old == null) return;
    const dy = old - tr.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    tr.style.transition = "none"; tr.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => { tr.style.transition = "transform .55s cubic-bezier(.2,.8,.2,1)"; tr.style.transform = ""; });
  });
}

// human label for an unresolved knockout slot fed by another match's winner/loser
const STAGE_SHORT = { r32: "R32", r16: "R16", qf: "QF", sf: "SF", final: "Final" };
function feedLabel(num, loser) {
  const m = S.matches.find(x => x.num === num && x.stage !== "group");
  if (!m) return (loser ? "Loser " : "Winner ") + "M" + num;
  const peers = S.matches.filter(x => x.stage === m.stage).sort((a, b) => a.num - b.num);
  const idx = peers.indexOf(m) + 1;
  const sh = STAGE_SHORT[m.stage] || m.stage.toUpperCase();
  return (loser ? "Loser " : "Winner ") + sh + "-" + idx;
}
// human label for a knockout match — users never see global match numbers, so "M104" becomes "Final", "SF 1"…
function matchTag(m) {
  if (m.stage === "final") return "Final";
  if (m.stage === "third") return "3rd place";
  const peers = S.matches.filter(x => x.stage === m.stage).sort((a, b) => a.num - b.num);
  return (STAGE_SHORT[m.stage] || (m.round || m.stage)) + " " + (peers.indexOf(m) + 1);
}
function slotText(m, side, si) {
  if (!si.ph) return si.name;                         // a real team is known
  const slot = m[side];
  if (slot.feeds) return feedLabel(slot.feeds, false); // "Winner QF1"
  if (slot.feedsL) return feedLabel(slot.feedsL, true);// "Loser SF1" (third-place)
  return si.name;                                      // group placeholder — the friendly "Runner-up Group A" (not the terse "2A")
}
// position every bracket card at the vertical midpoint of its feeder matches (a true bracket tree)
function layoutBracket(scope) {
  const bracket = scope.querySelector(".bracket");
  if (!bracket) return;
  const els = {};
  bracket.querySelectorAll(".bm[data-num]").forEach(el => els[el.dataset.num] = el);
  const nums = Object.keys(els);
  if (!nums.length) return;
  const cardH = els[nums[0]].offsetHeight || 70, step = cardH + 18;
  const byNum = {};
  S.matches.forEach(m => { if (m.stage !== "group") byNum[m.num] = m; });
  const y = {};
  let leaf = 0;
  (function place(num) {
    if (y[num] != null) return y[num];
    const m = byNum[num]; if (!m) return 0;
    const kids = [m.home.feeds, m.away.feeds].filter(Boolean);
    if (!kids.length) { return y[num] = (leaf++) * step; }      // R32 leaf
    const cy = kids.map(place);
    return y[num] = cy.reduce((s, v) => s + v, 0) / cy.length;  // midpoint of feeders
  })((S.matches.find(m => m.stage === "final") || {}).num);
  const third = S.matches.find(m => m.stage === "third");
  if (third) y[third.num] = leaf * step;                        // consolation match sits at the bottom
  let H = 0;
  Object.entries(y).forEach(([num, val]) => {
    const el = els[num]; if (!el) return;
    el.style.position = "absolute"; el.style.top = val + "px";
    H = Math.max(H, val + el.offsetHeight); // use each card's real height (3rd-place card is taller)
  });
  bracket.querySelectorAll(".bcol-matches").forEach(c => {
    c.style.position = "relative"; c.style.height = H + "px";
    const w = c.querySelector(".bm")?.offsetWidth; if (w) c.style.width = w + "px";
  });
  drawBracketLines(scope);
}
// draw orthogonal connector lines between feeder matches and their target (winner advances)
function drawBracketLines(scope) {
  const bracket = scope.querySelector(".bracket");
  const svg = scope.querySelector(".bracket-lines");
  if (!bracket || !svg) return;
  const W = bracket.scrollWidth, H = bracket.scrollHeight;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  const br = bracket.getBoundingClientRect(), pos = {};
  bracket.querySelectorAll(".bm[data-num]").forEach(el => {
    const r = el.getBoundingClientRect();
    pos[el.dataset.num] = { left: r.left - br.left, right: r.right - br.left, cy: r.top - br.top + r.height / 2 };
  });
  let d = "";
  S.matches.filter(m => m.stage !== "group" && m.stage !== "third").forEach(m => {
    const tgt = pos[m.num]; if (!tgt) return;
    [m.home, m.away].forEach(s => {
      const src = s.feeds && pos[s.feeds]; if (!src) return; // winner-advance links only
      const midX = src.right + (tgt.left - src.right) / 2;
      d += `M${src.right} ${src.cy} H${midX} V${tgt.cy} H${tgt.left} `;
    });
  });
  svg.innerHTML = d ? `<path d="${d}"/>` : "";
}
/* ============================================================
   SIMULATOR — order groups, pick thirds, tap winners
   ============================================================ */
const saveSim = () => localStorage.setItem("wc26.predict", JSON.stringify(S.simBox));
// fill a slot's group order + thirds from the live standings (the bracket's natural starting point). Operates on the
// given slot by briefly making it active, since seedSimThirds() works on S.sim; restores the prior active slot after.
function fillSlotFromStandings(i) {
  const prev = S.simBox.active;
  S.simBox.active = i; S.sim = S.simBox.slots[i];
  S.sim.order = {}; S.sim.thirds = []; seedSimThirds(); pruneSim();
  S.simBox.active = prev; S.sim = S.simBox.slots[prev]; saveSim();
}
// encode the whole prediction into a short URL-safe string (and back)
function encodeSim() {
  const json = JSON.stringify({ o: S.sim.order, t: S.sim.thirds, k: S.sim.ko });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeSim(str) {
  try {
    const json = decodeURIComponent(escape(atob(str.replace(/-/g, "+").replace(/_/g, "/"))));
    const c = JSON.parse(json);
    if (!c || typeof c !== "object") return null;
    return { order: c.o && typeof c.o === "object" ? c.o : {}, thirds: Array.isArray(c.t) ? c.t : [], ko: c.k && typeof c.k === "object" ? c.k : {} };
  } catch { return null; }
}
function flashToast(msg) {
  let t = $("#flashToast");
  if (!t) { t = document.createElement("div"); t.id = "flashToast"; t.className = "flash-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2400);
}
// in-app text prompt (replaces the native prompt(), which falls back to the OS dialog). Resolves the entered
// string on Save/Enter, or null on Cancel/Escape/backdrop. Built once, reused.
function textPrompt(label, value = "", { ok = "Save", max = 24 } = {}) {
  return new Promise(resolve => {
    let d = $("#promptDialog");
    if (!d) {
      d = document.createElement("dialog");
      d.id = "promptDialog"; d.className = "sheet prompt-sheet";
      d.innerHTML = `<div class="sheet-body prompt-body"><h3 id="promptLabel"></h3>
        <input id="promptInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="prompt-actions"><button class="btn ghost" id="promptCancel" type="button">Cancel</button><button class="btn" id="promptOk" type="button"></button></div></div>`;
      document.body.appendChild(d);
    }
    const lab = $("#promptLabel", d), inp = $("#promptInput", d), okb = $("#promptOk", d), cab = $("#promptCancel", d);
    lab.textContent = label; inp.value = value; inp.maxLength = max; okb.textContent = ok;
    let done = false;
    const finish = v => { if (done) return; done = true; d.removeEventListener("close", onClose); d.close(); resolve(v); };
    const onClose = () => finish(null);   // Escape / backdrop
    okb.onclick = () => finish(inp.value.trim());
    cab.onclick = () => finish(null);
    d.addEventListener("close", onClose);
    inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); finish(inp.value.trim()); } };
    showSheet(d);
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}
// ---- reusable "i" explainer: any [data-info] button reveals its text in one shared popover (touch-safe, unlike title=) ----
function infoBtn(text, label) { return `<button class="info-i" type="button" data-info="${esc(text)}" aria-label="${esc(label || "What this means")}">i</button>`; }
// native Popover API renders in the browser's top layer — ABOVE an open <dialog>. Without it a body-level
// popover is painted behind any showModal()'d match/team sheet (the bug: tap an "i" in a modal, see nothing).
const _POPOVER_OK = typeof HTMLElement !== "undefined" && HTMLElement.prototype.hasOwnProperty("showPopover");
function closeInfoPop() {
  const p = $("#infoPop"); if (!p) return;
  p.classList.remove("show"); p._anchor = null;
  if (_POPOVER_OK) { try { p.hidePopover(); } catch {} }
}
function showInfoPop(anchor, text) {
  let pop = $("#infoPop");
  if (!pop) {
    pop = document.createElement("div"); pop.id = "infoPop"; pop.className = "info-pop"; pop.setAttribute("role", "tooltip");
    if (_POPOVER_OK) pop.setAttribute("popover", "manual");   // top layer so it floats over open modals
    document.body.appendChild(pop);
  }
  if (pop._anchor === anchor && pop.classList.contains("show")) return closeInfoPop();   // tap again to dismiss
  pop.textContent = text; pop._anchor = anchor;
  if (_POPOVER_OK) { try { pop.hidePopover(); } catch {} try { pop.showPopover(); } catch {} }
  pop.classList.add("show");
  // fixed/viewport coords (the popover's containing block is the viewport, not the transformed dialog);
  // we dismiss on scroll, so not tracking scroll is fine.
  const r = anchor.getBoundingClientRect(), w = Math.min(280, innerWidth - 24);
  pop.style.width = w + "px";
  pop.style.left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 12)) + "px";
  pop.style.top = (r.bottom + 7) + "px";
}
/* compact prediction codec (~23 bytes → ~31-char link); decode falls back to the old JSON format */
const FACT = [1, 1, 2, 6, 24];
const groupTeams = g => [...new Set(S.matches.filter(m => m.group === g).flatMap(m => [m.home.team, m.away.team]).filter(Boolean))].sort();
function permToIndex(order, canon) {
  const pool = canon.slice(); let idx = 0;
  for (let i = 0; i < canon.length; i++) { const p = pool.indexOf(order[i]); if (p < 0) return 0; idx += p * FACT[canon.length - 1 - i]; pool.splice(p, 1); }
  return idx;
}
function indexToPerm(idx, canon) {
  const pool = canon.slice(), out = [];
  for (let i = 0; i < canon.length; i++) { const f = FACT[canon.length - 1 - i], p = Math.min(Math.floor(idx / f), pool.length - 1); idx %= f; out.push(pool[p]); pool.splice(p, 1); }
  return out;
}
const bytesToB64url = arr => btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = str => Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const koOrder = () => S.matches.filter(m => m.stage !== "group").sort((a, b) => a.num - b.num);
function packSim() {
  const bytes = [1];                                                  // version 1
  for (const g of GROUPS) bytes.push(permToIndex(simOrder(g), groupTeams(g)) & 0xff);
  let mask = 0; GROUPS.forEach((g, i) => { if (S.sim.thirds.includes(simOrder(g)[2])) mask |= 1 << i; });
  bytes.push(mask & 0xff, (mask >> 8) & 0xff);
  const alloc = allocateThirds(); let acc = 0, bits = 0;
  for (const m of koOrder()) {
    const { h, a } = simSlots(m, alloc), w = S.sim.ko[m.num];
    acc |= (w === h ? 1 : w === a ? 2 : 0) << bits; bits += 2;
    while (bits >= 8) { bytes.push(acc & 0xff); acc >>= 8; bits -= 8; }
  }
  if (bits > 0) bytes.push(acc & 0xff);
  return bytesToB64url(bytes);
}
function applyPacked(bytes) {
  if (bytes[0] !== 1) return false;
  const order = {}; GROUPS.forEach((g, i) => { order[g] = indexToPerm(bytes[1 + i], groupTeams(g)); });
  S.sim.order = order;
  const mask = bytes[13] | (bytes[14] << 8), thirds = [];
  GROUPS.forEach((g, i) => { if (mask & (1 << i)) thirds.push(order[g][2]); });
  S.sim.thirds = thirds; S.sim.ko = {};
  const alloc = allocateThirds(); let acc = 0, bits = 0, idx = 15;
  for (const m of koOrder()) {                                        // num order → feeders resolved before they're needed
    while (bits < 2) { acc |= (bytes[idx++] || 0) << bits; bits += 8; }
    const v = acc & 3; acc >>= 2; bits -= 2;
    if (!v) continue;
    const { h, a } = simSlots(m, alloc), code = v === 1 ? h : a;
    if (code) S.sim.ko[m.num] = code;
  }
  return true;
}
// scrub a decoded (legacy-JSON) prediction so a hand-crafted #p= link can't inject fake team codes that would
// crash renderSim at S.teams[c].name — keep only real codes / valid group permutations.
function sanitizeSim(d) {
  const out = { order: {}, thirds: [], ko: {} };
  for (const g of GROUPS) {
    const canon = groupTeams(g), o = d.order?.[g];
    if (Array.isArray(o) && o.length === canon.length && new Set(o).size === o.length && o.every(c => canon.includes(c))) out.order[g] = o;
  }
  out.thirds = (Array.isArray(d.thirds) ? d.thirds : []).filter(c => typeof c === "string" && S.teams[c]);
  for (const [k, v] of Object.entries(d.ko || {})) if (/^\d+$/.test(k) && typeof v === "string" && S.teams[v]) out.ko[k] = v;
  return out;
}
function loadSharedSim(enc) {
  try { const b = b64urlToBytes(enc); if (b[0] === 1 && applyPacked(b)) return true; } catch { /* not compact → try JSON */ }
  const d = decodeSim(enc); if (d) { const s = sanitizeSim(d); S.sim.order = s.order; S.sim.thirds = s.thirds; S.sim.ko = s.ko; return true; }
  return false;
}

function simOrder(g) {
  if (!S.sim.order[g] || S.sim.order[g].length !== 4) S.sim.order[g] = standings(g).map(r => r.code);
  return S.sim.order[g];
}
// parse allowed groups from a third-place slot short label "3rd A/B/C/D/F"
const thirdAllowed = s => (s.short || "").replace("3rd ", "").split("/");

// the 8 constrained "3rd …" R32 slots, each with its allowed groups
function r32ThirdSlots() {
  const slots = [];
  S.matches.filter(m => m.stage === "r32").forEach(m => ["home", "away"].forEach(side => {
    if ((m[side].short || "").startsWith("3rd")) slots.push({ key: m.id + ":" + side, allowed: thirdAllowed(m[side]) });
  }));
  return slots;
}
// assign chosen third-place teams to the constrained slots (backtracking); pure — no shared state.
// Returns {slotKey: code} or null if no valid assignment exists.
function allocateThirdsPure(slots, picks) {
  if (picks.length !== slots.length) return null;
  const used = new Array(picks.length).fill(false), assign = {};
  const order = slots.map((s, i) => i).sort((a, b) =>        // most-constrained slot first
    picks.filter(p => slots[a].allowed.includes(p.g)).length - picks.filter(p => slots[b].allowed.includes(p.g)).length);
  function bt(k) {
    if (k === order.length) return true;
    const s = slots[order[k]];
    for (let i = 0; i < picks.length; i++) {
      if (used[i] || !s.allowed.includes(picks[i].g)) continue;
      used[i] = true; assign[s.key] = picks[i].code;
      if (bt(k + 1)) return true;
      used[i] = false; delete assign[s.key];
    }
    return false;
  }
  return bt(0) ? assign : null;
}
// predictor's allocator — over the user's chosen thirds. Keeps the "impossible" sentinel its callers expect.
function allocateThirds() {
  const slots = r32ThirdSlots();
  const picks = S.sim.thirds.map(code => ({ code, g: groupOf(code) }));
  if (picks.length !== slots.length) return null;
  return allocateThirdsPure(slots, picks) || "impossible";
}
const groupOf = code => { const m = S.matches.find(m => m.group && (m.home.team === code || m.away.team === code)); return m?.group; };

// resolve both sides of a knockout match inside the simulation
function simSlots(m, alloc) {
  const side = s => {
    if (s.team) return s.team;
    const sh = s.short || "";
    if (/^[12][A-L]$/.test(sh)) { const o = simOrder(sh[1]); return sh[0] === "1" ? o[0] : o[1]; }
    if (sh.startsWith("3rd")) return alloc && alloc !== "impossible" ? alloc[m.id + ":" + (s === m.home ? "home" : "away")] : null;
    const num = s.feeds || s.feedsL;
    if (num) {
      const fm = S.matches.find(x => x.num === num && x.stage !== "group");
      const winner = S.sim.ko[num];
      if (!fm || !winner) return null;
      const fs = simSlots(fm, alloc);
      if (!fs.h || !fs.a) return null;
      return s.feeds ? winner : (winner === fs.h ? fs.a : fs.h);
    }
    return null;
  };
  return { h: side(m.home), a: side(m.away) };
}
// drop picks that are no longer reachable after upstream edits
function pruneSim() {
  const alloc = allocateThirds();
  S.matches.filter(m => m.stage !== "group").sort((a, b) => a.num - b.num).forEach(m => {
    const pick = S.sim.ko[m.num];
    if (pick == null) return;
    const { h, a } = simSlots(m, alloc);
    if (pick !== h && pick !== a) delete S.sim.ko[m.num];
  });
}
// pick a valid default set of 8 third-place teams so the knockout bracket is visible (and tappable) by default
function seedSimThirds() {
  GROUPS.forEach(g => { S.sim.order[g] = standings(g).map(r => r.code); });   // sync group order to live standings
  const all = GROUPS.map(g => S.sim.order[g][2]);
  const rank = c => { const r = standings(groupOf(c)).find(x => x.code === c) || {}; return (r.pts || 0) * 1000 + (r.gd || 0) * 10 + (r.gf || 0); };
  const ranked = all.slice().sort((a, b) => rank(b) - rank(a));
  S.sim.thirds = ranked.slice(0, 8);
  let guard = 0;
  while (allocateThirds() === "impossible" && guard++ < 200)
    S.sim.thirds = ranked.slice().sort(() => Math.random() - 0.5).slice(0, 8);
}

// score the saved prediction against reality: predicted group top-2 vs live standings, and KO winners vs results
function simScore() {
  const fts = S.matches.filter(m => status(m) === ST.FT && res(m)?.h != null);
  if (!fts.length) return null;
  let gSpots = 0, gTotal = 0;
  GROUPS.forEach(g => {
    if (!fts.some(m => m.group === g)) return;            // only score groups that have kicked off
    const pred = simOrder(g).slice(0, 2);
    const actual = standings(g).slice(0, 2).map(r => r.code);
    gTotal += 2; pred.forEach(c => { if (actual.includes(c)) gSpots++; });
  });
  let koHit = 0, koDecided = 0;
  S.matches.filter(m => m.stage !== "group").forEach(m => {
    const r = res(m); if (!(r && r.st === ST.FT && r.h != null)) return;
    const hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code; if (!hc || !ac) return;
    const homeWon = r.h > r.a || (r.h === r.a && (r.hp ?? -1) > (r.ap ?? -1));
    const pick = S.sim.ko[m.num];
    if (pick) { koDecided++; if (pick === (homeWon ? hc : ac)) koHit++; }
  });
  return gTotal || koDecided ? { gSpots, gTotal, koHit, koDecided } : null;
}
// a shareable champion card — drawn on a canvas (same-origin flag SVG → not tainted), then offered via
// the Web Share API (files) where supported, falling back to a download. Turns the prediction into reach.
function rrect(x, X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }
async function shareChampionImage(code) {
  const t = code && S.teams[code]; if (!t) { flashToast("Crown a champion first"); return; }
  try { await document.fonts.ready; } catch { /* fall back to system fonts */ }
  const W = 1080, H = 1080, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#0c1a28"); g.addColorStop(1, "#08231b");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const glow = (cx, cy, r, col) => { const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r); rg.addColorStop(0, col); rg.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = rg; x.fillRect(0, 0, W, H); };
  glow(170, 150, 460, "rgba(11,163,96,.34)"); glow(930, 940, 480, "rgba(232,185,49,.24)");
  x.textAlign = "center";
  x.fillStyle = "#E8B931"; x.font = "700 36px Archivo, sans-serif"; x.fillText("FIFA WORLD CUP 2026", W / 2, 132);
  x.fillStyle = "#9fb0bd"; x.font = "600 30px 'Instrument Sans', sans-serif"; x.fillText("MY PREDICTED CHAMPION", W / 2, 198);
  const img = new Image(); img.src = "assets/flags/" + code + ".svg";
  try { await img.decode(); } catch { /* draw without the flag */ }
  const fw = 420, fh = Math.round(fw * ((img.naturalHeight / img.naturalWidth) || 0.66)), fx = W / 2 - fw / 2, fy = 300;
  x.save(); rrect(x, fx, fy, fw, fh, 16); x.clip(); x.fillStyle = "#fff"; x.fillRect(fx, fy, fw, fh);
  if (img.complete && img.naturalWidth) x.drawImage(img, fx, fy, fw, fh); x.restore();
  x.lineWidth = 2; x.strokeStyle = "rgba(255,255,255,.22)"; rrect(x, fx, fy, fw, fh, 16); x.stroke();
  x.fillStyle = "#fff"; x.font = "900 96px Archivo, sans-serif"; x.fillText(t.name.toUpperCase(), W / 2, fy + fh + 152);
  x.fillStyle = "#1FD673"; x.font = "800 52px Archivo, sans-serif"; x.fillText("CHAMPIONS", W / 2, fy + fh + 226);
  x.fillStyle = "#7b8894"; x.font = "500 28px 'Spline Sans Mono', monospace"; x.fillText("July 19 · MetLife Stadium", W / 2, H - 112);
  x.fillStyle = "#5b6b7a"; x.font = "500 25px 'Spline Sans Mono', monospace"; x.fillText((location.host + location.pathname).replace(/\/$/, ""), W / 2, H - 62);
  c.toBlob(async blob => {
    if (!blob) { flashToast("Couldn't make the image"); return; }
    const file = new File([blob], "my-wc26-champion.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `My World Cup 2026 champion: ${t.name}` }); return; } catch { /* cancelled → fall through to download */ }
    }
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "my-wc26-champion.png"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000); flashToast("Champion card saved");
  }, "image/png");
}
// the canonical share URL for a match: a finished game points at the Action-rendered result-card stub (it unfurls on
// social); anything else deep-links into the live match view.
function matchShareLink(m) {
  const base = (location.origin + location.pathname).replace(/\/(index\.html)?$/, "");
  return status(m) === ST.FT ? `${base}/share/${m.num}.html` : `${base}/?match=${m.id}`;
}
// Share a single match. Finished → hand over the link to the already-rendered result card. Upcoming/live → generate a
// 1080² PREDICTION card (odds bar + projected score) and share the image with a tap-through link. Web Share files where
// supported, else copy the link, else download the image.
async function shareMatchCard(m) {
  const h = slotInfo(m, "home"), a = slotInfo(m, "away"), r = res(m), st = status(m);
  const link = matchShareLink(m), hn = h.code ? h.name : slotText(m, "home", h), an = a.code ? a.name : slotText(m, "away", a);
  const copyLink = async () => { try { await navigator.clipboard.writeText(link); flashToast("Match link copied. Share it!"); } catch { flashToast("Couldn't copy the link"); } };
  if (st === ST.FT) {   // result card already exists; share its link
    const title = r && r.h != null ? `${hn} ${r.h}–${r.a} ${an} · WC 2026` : `${hn} vs ${an} · WC 2026`;   // guard a FT row that briefly lacks a scoreline
    if (navigator.share) { try { await navigator.share({ title, url: link }); return; } catch (err) { if (err?.name === "AbortError") return; } }
    return copyLink();
  }
  try { await document.fonts.ready; } catch { /* fall back to system fonts */ }
  const W = 1080, H = 1080, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#0c1a28"); g.addColorStop(1, "#08231b"); x.fillStyle = g; x.fillRect(0, 0, W, H);
  const glow = (cx, cy, rd, col) => { const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rd); rg.addColorStop(0, col); rg.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = rg; x.fillRect(0, 0, W, H); };
  glow(150, 140, 460, "rgba(11,163,96,.30)"); glow(940, 950, 480, "rgba(232,185,49,.22)");
  x.textAlign = "center";
  x.fillStyle = "#E8B931"; x.font = "700 34px Archivo, sans-serif"; x.fillText("FIFA WORLD CUP 2026", W / 2, 108);
  x.fillStyle = "#9fb0bd"; x.font = "600 27px 'Instrument Sans', sans-serif";
  x.fillText(((m.group ? "Group " + m.group : (m.round || "")) + "  ·  " + fmt(m.utc, { weekday: "short", day: "numeric", month: "short" })).toUpperCase(), W / 2, 160);
  const fw = 250, fyTop = 235;
  const team = async (code, name, cx) => {
    let fh = Math.round(fw * 0.66), im = null;
    if (code) { im = new Image(); im.src = "assets/flags/" + code + ".svg"; try { await im.decode(); } catch { /* draw blank */ } if (im.naturalWidth) fh = Math.round(fw * im.naturalHeight / im.naturalWidth); }
    const fx = cx - fw / 2, fy = fyTop;
    x.save(); rrect(x, fx, fy, fw, fh, 14); x.clip(); x.fillStyle = "#fff"; x.fillRect(fx, fy, fw, fh); if (im && im.naturalWidth) x.drawImage(im, fx, fy, fw, fh); x.restore();
    x.lineWidth = 2; x.strokeStyle = "rgba(255,255,255,.22)"; rrect(x, fx, fy, fw, fh, 14); x.stroke();
    const up = name.toUpperCase(); let fs = 40; x.fillStyle = "#fff"; x.font = `800 ${fs}px Archivo, sans-serif`;
    while (x.measureText(up).width > 400 && fs > 22) { fs -= 2; x.font = `800 ${fs}px Archivo, sans-serif`; }
    x.fillText(up, cx, fy + fh + 56);
  };
  await team(h.code, hn, 300); await team(a.code, an, 780);
  const scored = r && r.h != null, midY = fyTop + 128;
  if (scored) { x.fillStyle = "#fff"; x.font = "800 92px Archivo, sans-serif"; x.fillText(`${r.h}–${r.a}`, W / 2, midY); }
  else { x.fillStyle = "#E8B931"; x.font = "800 56px Archivo, sans-serif"; x.fillText("VS", W / 2, midY - 16); }
  const wp = winProb(m);
  if (wp) {
    const ph = Math.round(wp.h * 100), pd = Math.round(wp.d * 100), pa = 100 - ph - pd;
    const bx = 130, bw = W - 260, by = 592, bh = 26;
    x.font = "700 26px 'Instrument Sans', sans-serif";
    x.textAlign = "left"; x.fillStyle = "#1FD673"; x.fillText(`${ph}%`, bx, by - 16);
    x.textAlign = "center"; x.fillStyle = "#9fb0bd"; x.fillText(`Draw ${pd}%`, W / 2, by - 16);
    x.textAlign = "right"; x.fillStyle = "#dbe3ea"; x.fillText(`${pa}%`, bx + bw, by - 16);
    let sx = bx; x.save(); rrect(x, bx, by, bw, bh, 13); x.clip();
    for (const [p, col] of [[ph, "#1FD673"], [pd, "#64748b"], [pa, "#dbe3ea"]]) { const sw = bw * p / 100; x.fillStyle = col; x.fillRect(sx, by, sw, bh); sx += sw; }
    x.restore(); x.textAlign = "center";
    if (wp.xg) {
      x.fillStyle = "#7b8894"; x.font = "600 25px 'Instrument Sans', sans-serif"; x.fillText(scored ? "PROJECTED FINAL" : "PROJECTED SCORE", W / 2, by + 96);
      x.fillStyle = "#fff"; x.font = "800 72px Archivo, sans-serif"; x.fillText(`${Math.round(wp.xg.h)}–${Math.round(wp.xg.a)}`, W / 2, by + 168);
    }
  }
  x.fillStyle = "#7b8894"; x.font = "500 25px 'Spline Sans Mono', monospace"; x.fillText("WC·26 · your World Cup, in one page", W / 2, H - 100);
  x.fillStyle = "#5b6b7a"; x.font = "500 23px 'Spline Sans Mono', monospace"; x.fillText((location.host + location.pathname).replace(/\/$/, ""), W / 2, H - 54);
  c.toBlob(async blob => {
    if (!blob) { flashToast("Couldn't make the image"); return; }
    const file = new File([blob], `wc26-${h.code || "home"}-${a.code || "away"}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: `${hn} v ${an} · WC 2026 prediction`, url: link }); return; } catch (err) { if (err?.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(link); flashToast("Match link copied. Share it!"); }
    catch { const u = URL.createObjectURL(blob); const el = document.createElement("a"); el.href = u; el.download = file.name; document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(u), 3000); flashToast("Prediction card saved"); }
  }, "image/png");
}
function renderSim() {
  return S.simView === "edit" ? renderSimEditor() : renderSimDash();
}
// the landing: three saved brackets as cards (champion + progress), each opening into the editor. The 3-slot model
// lets a user keep a gut pick, the chalk and a wildcard side by side.
function renderSimDash() {
  const el = $("#view-sim");
  const koMatches = S.matches.filter(m => m.stage !== "group");
  const koTotal = koMatches.length || 1;
  const card = (slot, i) => {
    const champ = slot.ko[104], valid = champ && S.teams[champ];
    const picked = koMatches.filter(m => slot.ko[m.num] != null).length;
    const pct = Math.round(picked / koTotal * 100);
    return `<div class="pslot${i === S.simBox.active ? " is-active" : ""}">
      <button class="pslot-open" data-slot-open="${i}" aria-label="Open ${esc(slot.name)}">
        <span class="pslot-top"><span class="pslot-name">${esc(slot.name)}</span>${i === S.simBox.active ? `<span class="pslot-badge">Last opened</span>` : ""}</span>
        <span class="pslot-champ">${valid
          ? `<span class="pslot-cup">${TROPHY}</span><span class="fl">${flag(champ)}</span><b>${esc(S.teams[champ].name)}</b>`
          : `<span class="pslot-nochamp">No champion picked yet</span>`}</span>
        <span class="pslot-bar"><i style="width:${pct}%"></i></span>
        <span class="pslot-meta">${picked}/${koTotal} ties picked</span>
      </button>
      <div class="pslot-tools">
        <button class="pslot-tool" data-slot-rename="${i}">Rename</button>
        <button class="pslot-tool" data-slot-fill="${i}">Fill from standings</button>
        <button class="pslot-tool" data-slot-clear="${i}">Clear picks</button>
      </div>
    </div>`;
  };
  el.innerHTML = viewH2("view-sim") + r32BoardHTML() + `
    <div class="pdash-sep"><span>Build your own</span></div>
    <p class="pdash-intro">${ICO.spark} Keep up to three scenarios — a gut pick, the chalk, a wildcard. Tap one to build it, all the way to a champion. Saved on this device.</p>
    <div class="pdash">${S.simBox.slots.map(card).join("")}</div>`;
  const editCta = el.querySelector("[data-sim-edit]"); if (editCta) editCta.onclick = () => { S.simView = "edit"; renderSim(); };
  $$("[data-slot-open]", el).forEach(b => b.onclick = () => { setActiveSlot(+b.dataset.slotOpen); S.simView = "edit"; renderSim(); });
  $$("[data-slot-rename]", el).forEach(b => b.onclick = async () => {
    const i = +b.dataset.slotRename, cur = S.simBox.slots[i];
    const name = await textPrompt("Name this scenario", cur.name);
    if (name) { cur.name = name.slice(0, 24); saveSim(); renderSim(); }
  });
  $$("[data-slot-fill]", el).forEach(b => b.onclick = () => { fillSlotFromStandings(+b.dataset.slotFill); renderSim(); flashToast("Filled from current standings"); });
  $$("[data-slot-clear]", el).forEach(b => b.onclick = () => { S.simBox.slots[+b.dataset.slotClear].ko = {}; saveSim(); renderSim(); });
}
function renderSimEditor() {
  const el = $("#view-sim");
  // preserve scroll + which step sections are expanded so a re-render (a pick, photos loading, a poll) never
  // bounces the user back to the top or collapses what they were working on
  const openSteps = new Set([...el.querySelectorAll(".sim-step[open]")].map(d => d.id));
  const firstRender = !el.querySelector(".sim-step");   // first paint → open step 3 (the bracket) so it's seen, not buried
  const keepY = window.scrollY, keepBX = el.querySelector(".bracket-scroll")?.scrollLeft || 0;
  // seed a valid default set of thirds so the knockout bracket is visible & tappable from the first visit
  // (done here, not at boot, so live standings are already loaded — order reflects real results)
  if (S.sim.thirds.length === 0) { seedSimThirds(); saveSim(); }
  const alloc = allocateThirds();
  const thirdsDone = S.sim.thirds.length === 8;
  const champ = S.sim.ko[104];

  const groupCard = (g, i) => {
    const order = simOrder(g);
    return `<div class="sgroup" style="--i:${i}"><h4>Group <span>${g}</span></h4>
      ${order.map((c, idx) => `<div class="srow ${idx < 2 ? "is-q" : idx === 2 ? "is-t" : ""}">
        <span class="pos">${idx + 1}</span>
        <button class="srow-team" data-squad="${c}" aria-label="View ${esc(S.teams[c].name)}"><span class="fl">${flag(c)}</span><span class="nm">${esc(S.teams[c].name)}</span></button>
        <span class="srow-arr">
          <button class="up" data-g="${g}" data-i="${idx}" data-dir="-1" ${idx === 0 ? "disabled" : ""} aria-label="Move ${esc(S.teams[c].name)} up">▲</button>
          <button class="up" data-g="${g}" data-i="${idx}" data-dir="1" ${idx === order.length - 1 ? "disabled" : ""} aria-label="Move ${esc(S.teams[c].name)} down">▼</button>
        </span>
      </div>`).join("")}</div>`;
  };

  const thirdChips = GROUPS.map(g => {
    const c = simOrder(g)[2];
    const on = S.sim.thirds.includes(c);
    const off = !on && thirdsDone;
    return `<button class="tchip ${on ? "is-on" : ""} ${off ? "is-off" : ""}" data-third="${c}">
      <span class="fl">${flag(c)}</span>${esc(shortName(c))}<span class="gl">${g}</span></button>`;
  }).join("");

  const cols = [["r32", "Round of 32"], ["r16", "Round of 16"], ["qf", "Quarter-finals"], ["sf", "Semi-finals"], ["final", "Final"]];
  const third = S.matches.find(m => m.stage === "third");
  const need = 8 - S.sim.thirds.length;
  const simBracket = !thirdsDone ? `<div class="empty">Pick ${need} more third-placed team${need === 1 ? "" : "s"} above and your knockout path appears here, then tap your way to a champion.</div>`
    : alloc === "impossible" ? `<div class="empty">That combination of thirds can't fill the slots. Swap one and try again.</div>`
    : `<div class="bracket-scroll"><div class="bracket"><svg class="bracket-lines" aria-hidden="true"></svg>
        ${cols.map(([st, title]) => {
          const inner = S.matches.filter(m => m.stage === st).sort((a, b) => a.num - b.num).map((m, i) => simMatch(m, i, alloc)).join("")
            + (st === "final" && third ? simMatch(third, 1, alloc) : "");
          return `<div class="bcol bcol-${st}"><div class="bcol-title">${title}</div><div class="bcol-matches">${inner}</div></div>`;
        }).join("")}
      </div></div>`;

  // prominent "north star": the champion you're building toward — tap to jump to the knockout bracket
  const koMatches = S.matches.filter(m => m.stage !== "group");
  const koPicked = koMatches.filter(m => S.sim.ko[m.num] != null).length;
  const champTeaser = `<button class="sim-goal ${champ ? "is-set" : ""}" id="simGoal" type="button">
    <span class="sg-cup">${TROPHY}</span>
    ${champ
      ? `<span class="sg-fl">${flag(champ)}</span><span class="sg-tx"><b>${esc(S.teams[champ].name)}</b><small>Your predicted world champions · tap to edit your scenario</small></span>`
      : `<span class="sg-tx"><b>Crown your champion</b><small>Tap a winner in each knockout tie, all the way to the final →</small></span>`}
    <span class="sg-prog" aria-label="${koPicked} of ${koMatches.length} ties picked">${koPicked}<i>/${koMatches.length}</i></span>
  </button>`;

  // how the prediction is tracking against real results (only once something has been played)
  // "Your call vs reality" scorecard removed from the UI for now (unclear to users); simScore() kept.
  // each step is a collapsible section. On first paint step 3 (the bracket — the fun part) is open so it's seen
  // straight away; steps 1 & 2 stay collapsed. After that the user's own open/closed state is preserved across
  // re-renders. The intro + actions sit at the BOTTOM so the steps and bracket get the top of the page.
  const stepOpen = id => firstRender ? id === "simStep3" : openSteps.has(id);
  const step = (id, head, body) => `<details class="sim-step" id="${id}"${stepOpen(id) ? " open" : ""}><summary class="eyebrow">${head}<span class="sim-chev" aria-hidden="true">▾</span></summary><div class="sim-step-body">${body}</div></details>`;
  el.innerHTML = viewH2("view-sim") + `
    <div class="sim-edhead">
      <button class="sim-back" id="simBack" aria-label="Back to your scenarios">‹ Scenarios</button>
      <span class="sim-edname">${esc(S.simBox.slots[S.simBox.active].name)}</span>
    </div>
    ${champTeaser}
    ${firstRender && Object.keys(S.sim.ko).length === 0 ? `<p class="sim-firsthint">${ICO.spark} <b>New here?</b> The three steps below build your scenario: <b>order each group</b>, <b>pick the best thirds</b>, then <b>tap winners</b> to a champion. It's pre-filled from the live tables, so you can dive straight into the knockouts too. Saved on this device.</p>` : ""}
    ${step("simStep1", `<span class="step-n">1</span> Order the groups: top two go through`, `<div class="gwrap">${GROUPS.map(groupCard).join("")}</div>`)}
    ${step("simStep2", `<span class="step-n">2</span> Best third-placed teams <span class="tcount">${S.sim.thirds.length}/8</span>`, `<div class="thirds">${thirdChips}</div>`)}
    ${step("simStep3", `<span class="step-n">3</span> Tap winners to crown your champion ${TROPHY}`, `${thirdsDone && alloc !== "impossible" ? `<p class="sim-ko-hint">${ICO.tap} Tap a team in any tie to send them through. Winners flow left → right to the final.</p>` : ""}${simBracket}`)}
    ${champ ? championBanner(champ, true) : ""}
    ${champ ? `<div class="sim-share-row">
      <button class="btn" id="simShare">${ICO.link} Share prediction</button>
      <button class="btn" id="simShareImg">${ICO.camera} Champion card</button>
    </div>` : ""}
    <div class="sim-actions sim-actions-foot">
      <button class="btn ghost" id="simFill"><span class="b-lg">Use live standings</span><span class="b-sm">Standings</span></button>
      <button class="btn ghost" id="simShuffle"><span class="b-lg">Shuffle it all</span><span class="b-sm">Shuffle</span></button>
      <button class="btn ghost" id="simReset"><span class="b-lg">Start over</span><span class="b-sm">Reset</span></button>
      ${champ ? "" : `<button class="btn" id="simShare">${ICO.link} Share prediction</button>`}
    </div>`;

  $("#simBack").onclick = () => { S.simView = "dash"; renderSim(); };
  $("#simFill").onclick = () => { S.sim.order = {}; S.sim.thirds = []; seedSimThirds(); pruneSim(); saveSim(); renderSim(); flashToast("Filled from current standings"); };

  const goal = $("#simGoal", el);
  if (goal) goal.onclick = () => { const s3 = $("#simStep3", el); if (s3) { s3.open = true; s3.scrollIntoView({ behavior: "smooth", block: "start" }); } };

  // wire: reorder (▲ up / ▼ down via data-dir)
  $$(".up", el).forEach(b => b.onclick = () => {
    const g = b.dataset.g, i = +b.dataset.i, dir = +b.dataset.dir, j = i + dir;
    const o = simOrder(g);
    if (j < 0 || j >= o.length) return;
    [o[j], o[i]] = [o[i], o[j]];
    // moved team may no longer be the group's third → drop stale third picks
    S.sim.thirds = S.sim.thirds.filter(c => simOrder(groupOf(c))[2] === c);
    pruneSim(); saveSim(); renderSim();
    const row = $$(`.sgroup [data-g="${g}"] .up`, el).find(x => +x.dataset.i === j)?.closest(".srow");
    row?.classList.add("just-moved");
  });
  // wire: thirds
  $$("[data-third]", el).forEach(b => b.onclick = () => {
    const c = b.dataset.third;
    const i = S.sim.thirds.indexOf(c);
    if (i >= 0) S.sim.thirds.splice(i, 1);
    else if (S.sim.thirds.length < 8) S.sim.thirds.push(c);
    pruneSim(); saveSim(); renderSim();
  });
  // wire: bracket picks
  $$("[data-pick]", el).forEach(r => r.onclick = e => {
    const [num, code] = r.dataset.pick.split("|");
    S.sim.ko[+num] = code;
    pruneSim(); saveSim(); renderSim();   // renderSim restores scroll + the bracket's horizontal position centrally
    if (+num === 104) {
      const t = S.teams[code];
      confetti(t.c1, t.c2, { x: e.clientX || innerWidth / 2, y: e.clientY || innerHeight / 2 });
    }
  });
  // wire: actions
  $("#simShuffle").onclick = () => {
    GROUPS.forEach(g => S.sim.order[g] = simOrder(g).slice().sort(() => Math.random() - .5));
    const thirds = GROUPS.map(g => simOrder(g)[2]).sort(() => Math.random() - .5);
    S.sim.thirds = thirds.slice(0, 8); S.sim.ko = {};
    let alloc2 = allocateThirds(), guard = 0;
    while (alloc2 === "impossible" && guard++ < 60) { // reshuffle until allocatable
      S.sim.thirds = thirds.slice().sort(() => Math.random() - .5).slice(0, 8);
      alloc2 = allocateThirds();
    }
    // auto-pick random winners through the bracket
    S.matches.filter(m => m.stage !== "group").sort((a, b) => a.num - b.num).forEach(m => {
      const { h, a } = simSlots(m, allocateThirds());
      if (h && a) S.sim.ko[m.num] = Math.random() < .5 ? h : a;
    });
    saveSim(); renderSim();
    const c = S.teams[S.sim.ko[104]];
    if (c) confetti(c.c1, c.c2);
  };
  $("#simReset").onclick = () => { S.sim.order = {}; S.sim.thirds = []; S.sim.ko = {}; seedSimThirds(); saveSim(); renderSim(); };
  $("#simShare").onclick = async () => {
    const url = location.origin + location.pathname + "#p=" + packSim();
    try { await navigator.clipboard.writeText(url); flashToast("Prediction link copied. Share it!"); }
    catch { prompt("Copy your prediction link:", url); }
  };
  $("#simShareImg")?.addEventListener("click", () => shareChampionImage(S.sim.ko[104]));
  // the bracket needs measurable dimensions to lay out its tree, so only when step 3 is expanded — and re-lay it
  // out whenever that section is opened
  const s3 = $("#simStep3", el);
  if (s3) { if (s3.open) layoutBracket(el); s3.ontoggle = () => { if (s3.open) layoutBracket(el); }; }
  // restore scroll + bracket position captured at the top (the innerHTML rebuild reset them)
  window.scrollTo(0, keepY);
  const nb = el.querySelector(".bracket-scroll"); if (nb) nb.scrollLeft = keepBX;
}
function simMatch(m, i, alloc) {
  const { h, a } = simSlots(m, alloc);
  const pick = S.sim.ko[m.num];
  const row = (code, other) => {
    if (!code) return `<div class="bm-row"><span class="fl">·</span><span class="nm ph">awaiting pick</span></div>`;
    const isPick = pick === code, isOut = pick && pick !== code;
    return `<div class="bm-row pickable ${isPick ? "is-pick" : ""} ${isOut ? "is-out" : ""}" data-pick="${m.num}|${code}" role="button" tabindex="0">
      <span class="fl">${flag(code)}</span><span class="nm">${esc(S.teams[code].name)}${isPick && m.stage === "final" ? ` ${TROPHY}` : ""}</span></div>`;
  };
  return `<div class="bm ${m.stage === "final" ? "is-final" : ""} ${m.stage === "third" ? "is-third" : ""}" style="--i:${i}" data-num="${m.num}">
    ${m.stage === "third" ? `<div class="bm-tag">3rd place</div>` : ""}
    ${row(h, a)}${row(a, h)}
    <div class="bm-label">${matchTag(m)} · ${fmt(m.utc, { day: "numeric", month: "short" })} · ${esc(m.city.split(",")[0])}</div></div>`;
}
// the champion's route through the user's own picks: one match per knockout round, with who they beat.
function champPath(code) {
  const alloc = allocateThirds(); if (alloc === "impossible") return [];
  const STAGES = [["r32", "R32"], ["r16", "R16"], ["qf", "QF"], ["sf", "SF"], ["final", "Final"]];
  const path = [];
  for (const [stage, label] of STAGES) {
    for (const m of S.matches.filter(x => x.stage === stage).sort((x, y) => x.num - y.num)) {
      const { h, a } = simSlots(m, alloc);
      if ((h === code || a === code) && S.sim.ko[m.num] === code) { path.push({ label, opp: h === code ? a : h, mid: m.id }); break; }
    }
  }
  return path;
}
function championBanner(code, predicted) {
  const t = S.teams[code];
  const path = predicted ? champPath(code) : [];
  const steps = path.map(s => `<div class="cpath-step"${s.opp ? ` data-mid="${s.mid}" role="button" tabindex="0"` : ""}>
    <span class="cpath-rd">${s.label}</span>
    <span class="cpath-opp">${s.opp ? `<span class="fl">${flag(s.opp)}</span><small>${esc(shortName(s.opp) || S.teams[s.opp]?.name || "")}</small>` : `<span class="fl">·</span><small>TBD</small>`}</span>
  </div>`).join(`<span class="cpath-arr">›</span>`);
  return `<div class="champ">
    <span class="cup">${TROPHY}</span><span class="cfl">${flag(code)}</span>
    <h3>${esc(t.name)}</h3><p>${predicted ? "Your predicted champions" : "Champions of the world"} · July 19 · MetLife</p>
    ${steps ? `<div class="cpath-lbl">Path to glory</div><div class="cpath">${steps}<span class="cpath-arr">›</span><div class="cpath-step cpath-cup"><span class="cpath-rd">Champions</span><span class="cpath-opp">${TROPHY}</span></div></div>` : ""}</div>`;
}

/* ---------------- tournament stats (team + player) ---------------- */
let _tsCache = null, _tsSig = "";
function tournamentStats() {
  // memoise: the ~15 leaderboards depend only on FT scores/events/stats, never the live minute that ticks every poll.
  // Without this, an open Stats tab rebuilds and re-sorts everything every 30s on a busy matchday for zero visible change.
  const sig = S.matches.reduce((s, m) => { const r = res(m); return status(m) === ST.FT && r?.h != null ? s + `${m.num}:${r.h}-${r.a}:${(r.ev || []).length}:${r.stats ? 1 : 0};` : s; }, "");
  if (_tsCache && _tsSig === sig) return _tsCache;
  const fts = S.matches.filter(m => status(m) === ST.FT && res(m)?.h != null);
  const gf = {}, ga = {}, poss = {}, possN = {}, sot = {}, sotN = {}, yel = {}, red = {}, played = {}, scorers = {}, assists = {}, pyel = {}, pred = {}, cs = {}, conf = {}, keepers = {}, tstat = {}, statN = {};
  const TSTAT_KEYS = ["sh", "pass", "passT", "cross", "lball", "tkl", "intc", "clr", "blk", "sv", "off", "fls"];   // richer ESPN team stats → leaderboards + style
  let goals = 0, totYellow = 0, totRed = 0, totPen = 0, totOg = 0, totSot = 0;
  const rec = { bigWin: null, hiScore: null, fastG: null, lateG: null, hiDraw: null, topMatch: null, mostCards: null, mostTackles: null, bestDef: null };
  const add = (o, k, n = 1) => { if (k) o[k] = (o[k] || 0) + n; };
  const addConf = (code, gfv, gav, diff) => {   // a team's match folded into its confederation's collective record
    const k = S.teams[code]?.conf; if (!k) return;
    const o = conf[k] || (conf[k] = { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
    o.p++; o.gf += gfv; o.ga += gav;
    if (diff > 0) { o.w++; o.pts += 3; } else if (diff < 0) o.l++; else { o.d++; o.pts++; }
  };
  for (const m of fts) {
    const r = res(m), hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code;
    add(played, hc); add(played, ac);
    add(gf, hc, r.h); add(ga, hc, r.a); add(gf, ac, r.a); add(ga, ac, r.h);
    if (r.a === 0) add(cs, hc); if (r.h === 0) add(cs, ac);   // clean sheets (shutouts)
    // per-keeper: credit the starting GK (pos 0 in the lineup) with the shutout / goals conceded
    const gkOf = side => (r.xi?.[side]?.xi || []).find(p => p[2] === 0) || null;   // the lineup row [num, name, pos]
    [["h", hc, r.a], ["a", ac, r.h]].forEach(([side, code, conceded]) => {
      const row = gkOf(side); if (!row || !code) return;
      const gk = resolvePlayer(row[1], code, row[0])?.name || row[1];   // resolve by jersey → the exact keeper (distinguishes same-surname GKs)
      const k = gk + "\t" + code, o = keepers[k] || (keepers[k] = { app: 0, ga: 0, cs: 0 });
      o.app++; o.ga += conceded; if (conceded === 0) o.cs++;
    });
    addConf(hc, r.h, r.a, r.h - r.a); addConf(ac, r.a, r.h, r.a - r.h);
    goals += r.h + r.a;
    // records: biggest winning margin (tiebreak by total goals) + highest-scoring match
    const margin = Math.abs(r.h - r.a), total = r.h + r.a;
    const win = r.h >= r.a ? { w: hc, l: ac, ws: r.h, ls: r.a } : { w: ac, l: hc, ws: r.a, ls: r.h };
    if (margin > 0 && (!rec.bigWin || margin > rec.bigWin.margin || (margin === rec.bigWin.margin && total > rec.bigWin.total)))
      rec.bigWin = { mid: m.id, num: m.num, total, margin, ...win };
    if (total > 0 && (!rec.hiScore || total > rec.hiScore.total))
      rec.hiScore = { mid: m.id, num: m.num, total, hc, ac, h: r.h, a: r.a };
    const matchGoals = {};
    let mYellow = 0, mRed = 0;
    for (const e of (r.ev || [])) {
      const tc = e.tm === "h" ? hc : ac;
      if (e.k === "P") totPen++; else if (e.k === "OG") totOg++;   // penalties converted in play + own goals (tournament totals)
      if ((e.k === "G" || e.k === "P") && e.p) {
        // resolve to the full squad name using the API jersey (e.n) when present, else "out" = an outfielder (never the same-surname keeper)
        const sc = resolvePlayer(e.p, tc, e.n, "out")?.name || e.p;
        add(scorers, sc + "\t" + tc); if (e.a) add(assists, (resolvePlayer(e.a, tc, e.an, "out")?.name || e.a) + "\t" + tc);   // own goals excluded from the Boot
        const mk = sc + "\t" + tc; matchGoals[mk] = (matchGoals[mk] || 0) + 1;
        const mn = evMin(e.t);   // fastest / latest goal of the tournament (by the player who scored it)
        if (mn >= 1) {
          if (!rec.fastG || mn < rec.fastG.mn) rec.fastG = { name: sc, code: tc, t: e.t, mn, mid: m.id };
          if (!rec.lateG || mn > rec.lateG.mn) rec.lateG = { name: sc, code: tc, t: e.t, mn, mid: m.id };
        }
      }
      if (e.k === "Y") { add(yel, tc); totYellow++; mYellow++; if (e.p) add(pyel, (resolvePlayer(e.p, tc, e.n)?.name || e.p) + "\t" + tc); }
      else if (e.k === "R") { add(red, tc); totRed++; mRed++; if (e.p) add(pred, (resolvePlayer(e.p, tc, e.n)?.name || e.p) + "\t" + tc); }
    }
    // per-match superlatives
    if (r.h === r.a && (r.h + r.a) > 0 && (!rec.hiDraw || (r.h + r.a) > rec.hiDraw.total))
      rec.hiDraw = { mid: m.id, hc, ac, h: r.h, a: r.a, total: r.h + r.a };
    for (const [mk, cnt] of Object.entries(matchGoals)) {
      if (cnt >= 2 && (!rec.topMatch || cnt > rec.topMatch.v)) {
        const ti = mk.indexOf("\t"); const tc2 = mk.slice(ti + 1);
        rec.topMatch = { name: mk.slice(0, ti), code: tc2, opp: tc2 === hc ? ac : hc, v: cnt, mid: m.id };
      }
    }
    const mCards = mYellow + mRed;
    if (mCards > 0 && (!rec.mostCards || mCards > rec.mostCards.total))
      rec.mostCards = { mid: m.id, hc, ac, y: mYellow, r: mRed, total: mCards };
    // most tackles by a team in a match (team stat), + best individual defensive display (key-performer data)
    if (Array.isArray(r.stats?.tkl)) {
      const [ht, at] = r.stats.tkl, top = ht >= at ? { code: hc, v: ht, opp: ac } : { code: ac, v: at, opp: hc };
      if (top.v > 0 && (!rec.mostTackles || top.v > rec.mostTackles.v)) rec.mostTackles = { ...top, mid: m.id };
    }
    for (const L of (r.lead || [])) {
      if (L.k !== "defensiveInterventions" || !L.n || !(+L.v > 0)) continue;
      if (!rec.bestDef || +L.v > rec.bestDef.v) rec.bestDef = { name: resolvePlayer(L.n, L.c)?.name || L.n, code: L.c, v: +L.v, opp: L.c === hc ? ac : hc, mid: m.id };
    }
    if (r.stats?.poss) { add(poss, hc, r.stats.poss[0]); add(possN, hc); add(poss, ac, r.stats.poss[1]); add(possN, ac); }
    if (r.stats?.sot) { add(sot, hc, r.stats.sot[0]); add(sotN, hc); add(sot, ac, r.stats.sot[1]); add(sotN, ac); totSot += (r.stats.sot[0] || 0) + (r.stats.sot[1] || 0); }
    if (r.stats) {   // accumulate the richer team stats (per-match averaged later, like FotMob)
      add(statN, hc); add(statN, ac);
      for (const k of TSTAT_KEYS) if (Array.isArray(r.stats[k])) { (tstat[k] ||= {}); add(tstat[k], hc, r.stats[k][0]); add(tstat[k], ac, r.stats[k][1]); }
    }
  }
  const split = k => { const i = k.indexOf("\t"); return [k.slice(0, i), k.slice(i + 1)]; };
  const scorerList = Object.entries(scorers).map(([k, g]) => { const [name, code] = split(k); return { name, code, goals: g, assists: assists[name + "\t" + code] || 0 }; })
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name));
  const assistList = Object.entries(assists).map(([k, a]) => { const [name, code] = split(k); return { name, code, assists: a }; })
    .sort((a, b) => b.assists - a.assists || a.name.localeCompare(b.name));
  const bookedList = [...new Set([...Object.keys(pyel), ...Object.keys(pred)])].map(k => { const [name, code] = split(k); return { name, code, y: pyel[k] || 0, r: pred[k] || 0 }; })
    .sort((a, b) => b.r - a.r || b.y - a.y || a.name.localeCompare(b.name));
  const cardList = [...new Set([...Object.keys(yel), ...Object.keys(red)])]
    .map(c => ({ code: c, y: yel[c] || 0, r: red[c] || 0, v: (yel[c] || 0) + (red[c] || 0) }))
    .sort((a, b) => b.v - a.v || b.r - a.r);
  // team metrics are per-match (like FotMob) so a team that's played fewer games isn't ranked unfairly
  const perMatch = (tot, n) => Object.keys(tot).map(c => ({ code: c, v: tot[c] / (n[c] || 1) }));
  const pmT = fn => Object.keys(statN).map(c => ({ code: c, v: fn(c) / statN[c] })).sort((a, b) => b.v - a.v);   // per-game over teams with team-stats
  const g = (k, c) => tstat[k]?.[c] || 0;
  const _out = {
    pulse: { goals, matches: fts.length, perMatch: fts.length ? goals / fts.length : 0, yellows: totYellow, reds: totRed, pens: totPen, og: totOg, sot: totSot },
    records: rec,
    scorers: scorerList, assisters: assistList, booked: bookedList,
    teamCards: cardList,
    // FIFA fair-play points (a real group tiebreaker): −1 per yellow, −3 per red (we can't tell a
    // second-yellow from a straight red, so reds are flat −3). Ranked cleanest-first across played teams.
    fairPlay: Object.keys(played).map(c => ({ code: c, y: yel[c] || 0, r: red[c] || 0, pts: (yel[c] || 0) + (red[c] || 0) * 3 }))
      .sort((a, b) => a.pts - b.pts || a.y - b.y || a.code.localeCompare(b.code)),
    teamScored: perMatch(gf, played).sort((a, b) => b.v - a.v),
    teamConceded: perMatch(ga, played).sort((a, b) => a.v - b.v),
    cleanSheets: Object.entries(cs).map(([code, v]) => ({ code, v })).sort((a, b) => b.v - a.v),
    keepers: Object.entries(keepers).map(([k, o]) => { const [name, code] = split(k); return { name, code, ...o }; })
      .filter(x => x.cs > 0).sort((a, b) => b.cs - a.cs || a.ga - b.ga || b.app - a.app || a.name.localeCompare(b.name)),
    teamSot: perMatch(sot, sotN).sort((a, b) => b.v - a.v),
    possession: Object.keys(poss).map(c => ({ code: c, v: poss[c] / possN[c] })).filter(x => isFinite(x.v)).sort((a, b) => b.v - a.v),
    teamPassAcc: Object.keys(tstat.passT || {}).filter(c => tstat.passT[c]).map(c => ({ code: c, v: g("pass", c) / tstat.passT[c] * 100 })).sort((a, b) => b.v - a.v),
    teamDef: pmT(c => g("tkl", c) + g("intc", c)),     // tackles + interceptions per game
    teamSaves: pmT(c => g("sv", c)),
    teamCrosses: pmT(c => g("cross", c)),
    // a team's playing identity, for the style fingerprint (only teams that have a stats line)
    style: Object.keys(statN).filter(c => tstat.passT?.[c]).map(c => ({
      code: c, poss: poss[c] / (possN[c] || 1), passAcc: g("pass", c) / tstat.passT[c] * 100,
      directness: g("lball", c) / ((g("pass", c) + g("lball", c)) || 1) * 100,
      pressPg: (g("tkl", c) + g("intc", c)) / statN[c], shotsPg: g("sh", c) / statN[c],
    })),
    confeds: (() => {
      const teamCount = {}; Object.values(S.teams).forEach(t => { if (t.conf) teamCount[t.conf] = (teamCount[t.conf] || 0) + 1; });
      return Object.entries(conf).map(([k, o]) => ({ conf: k, teams: teamCount[k] || 0, ...o, ppg: o.p ? o.pts / o.p : 0, gpg: o.p ? o.gf / o.p : 0 }))
        .sort((a, b) => b.ppg - a.ppg || b.gpg - a.gpg || a.conf.localeCompare(b.conf));
    })(),
  };
  return (_tsCache = _out, _tsSig = sig, _out);
}
let statsTab = "overview";   // active Stats sub-section (persists across re-renders)
let _statsHTML = "";        // last rendered Stats markup — re-rendered only when it actually changes (see renderStats)
// FIFA World Ranking — 18 Sep 2025 snapshot (top 50), the latest FIFA published pre-tournament. A bare string = a
// qualified WC26 team (name/flag from teams.json); a [code,name] pair = a top-50 nation that did NOT make the field.
// Rank is the array index + 1. The 11 finalists ranked outside the top 50 are derived (teams.json minus this list).
const FIFA_RANK = [
  "AR", "ES", "FR", "GB-ENG", "PT", "BR", "MA", "NL", "BE", "DE", "HR", ["IT", "Italy"],
  "CO", "MX", "SN", "UY", "US", "JP", "CH", "IR", ["DK", "Denmark"], "TR", "EC", "AT", "KR",
  ["NG", "Nigeria"], "AU", "DZ", "EG", "CA", "NO", ["UA", "Ukraine"], "CI", "PA",
  ["RU", "Russia"], ["PL", "Poland"], ["GB-WLS", "Wales"], "SE", ["HU", "Hungary"], "CZ", "PY", "GB-SCT",
  ["RS", "Serbia"], ["CM", "Cameroon"], "TN", "CD", ["SK", "Slovakia"], ["GR", "Greece"], ["VE", "Venezuela"], "UZ",
];
const FIFA_POS = {}; FIFA_RANK.forEach((e, i) => { FIFA_POS[typeof e === "string" ? e : e[0]] = i; });
// final group-stage tiebreak per FIFA regulations art.13 step 3 (FIFA World Ranking). Teams outside the top-50
// snapshot fall back to their Elo so it's still skill-based — never the alphabetical code.
const tiebreakRank = code => FIFA_POS[code] != null ? FIFA_POS[code] : 100 - (S.teams[code]?.elo || 0) / 100;
const CONF_FULL = { UEFA: "Europe", CONMEBOL: "South America", CONCACAF: "N. & C. America", AFC: "Asia", CAF: "Africa", OFC: "Oceania" };
// a team's FIFA world-ranking position from the frozen 211-team snapshot, by code. Built once (the snapshot
// doesn't change during the tournament); returns null until the ranking file has loaded.
let _rankByCode = null;
function fifaRankOf(code) {
  if (!_rankByCode && S.fifaRanking?.length) { _rankByCode = {}; for (const t of S.fifaRanking) if (t.q) _rankByCode[t.q] = t.r; }
  return _rankByCode?.[code] || null;
}
function fifaRankingPanel() {
  const rk = S.fifaRanking;
  if (!rk?.length) {   // ranking file not loaded (stale cache / offline) — minimal fallback from teams.json
    const quals = Object.keys(S.teams).sort((a, b) => (S.teams[b].elo || 0) - (S.teams[a].elo || 0));
    return `<div class="eyebrow">World Cup field</div><div class="lead-card rk-list">${quals.map((c, n) => `<div class="rk-row" data-squad="${c}" role="button" tabindex="0"><span class="rk-num">${n + 1}</span><span class="fl">${flag(c)}</span><span class="rk-name">${esc(S.teams[c].name)}</span></div>`).join("")}</div>`;
  }
  const qCount = rk.filter(t => t.q).length;
  const row = t => `<div class="rk-row${t.q ? "" : " rk-nq"}" data-conf="${esc(t.conf || "")}" data-q="${t.q ? 1 : 0}"${t.q ? ` data-squad="${t.q}" role="button" tabindex="0"` : ""}>
    <span class="rk-num">${t.r ?? "–"}</span>
    <img class="rk-flag" loading="lazy" src="${esc(t.flag || "")}" alt="" width="26" height="17">
    <span class="rk-name">${esc(t.name)}</span>
    <span class="rk-conf" title="${CONF_FULL[t.conf] || ""}">${esc(t.conf || "")}</span>
    ${t.q ? `<span class="rk-q" title="Qualified for the 2026 World Cup">WC</span>` : ""}</div>`;
  // two combining dropdown pills: the team set (all / WC qualifiers) and the confederation (with an All option).
  const opt = (a, v, label, sel) => `<button type="button" class="tsel-opt${sel ? " is-sel" : ""}" role="option" aria-selected="${sel}" data-${a}="${v}"><span class="tsel-opt-name">${label}</span>${sel ? `<span class="tsel-tick" aria-hidden="true">✓</span>` : ""}</button>`;
  const setOpts = opt("set", "all", `All teams · ${rk.length}`, true) + opt("set", "q", `WC qualifiers · ${qCount}`, false);
  const confOpts = opt("conf", "all", "All confederations", true)
    + ["UEFA", "CONMEBOL", "CONCACAF", "CAF", "AFC", "OFC"].filter(c => rk.some(t => t.conf === c))
        .map(c => opt("conf", c, `${c} · ${esc(CONF_FULL[c] || "")}`, false)).join("");
  const asOf = (() => { const d = S.fifaRankDate; if (!d) return ""; const dt = new Date(d + "T00:00:00Z"); return isNaN(+dt) ? "" : dt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); })();
  return `<div class="eyebrow">FIFA World Ranking · all ${rk.length} teams</div>
    ${asOf ? `<p class="rk-asof">As of <b>${asOf}</b>, the latest FIFA / Coca-Cola Men's World Ranking published before the tournament.</p>` : ""}
    <div class="rk-filter">
      <div class="tsel" id="rkSetWrap">
        <button type="button" class="fsel tsel-btn" id="rkSetBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Filter by team set"><span class="tsel-cur">All teams</span></button>
        <div class="tsel-pop" id="rkSetPop" data-keep hidden><div class="tsel-list" role="listbox" aria-label="Team set">${setOpts}</div></div>
      </div>
      <div class="tsel" id="rkConfWrap">
        <button type="button" class="fsel tsel-btn" id="rkConfBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Filter by confederation"><span class="tsel-cur">Confederation</span></button>
        <div class="tsel-pop" id="rkConfPop" data-keep hidden><div class="tsel-list" role="listbox" aria-label="Confederation">${confOpts}</div></div>
      </div>
    </div>
    <input class="team-search rk-search" id="rkSearch" type="search" placeholder="Search teams…" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="lead-card rk-list" id="rkList">${rk.map(row).join("")}</div>
    <p class="sim-ko-hint">Source: FIFA / Coca-Cola Men's World Ranking · the <b>WC</b> badge marks the 48 finalists · tap one for its page.</p>`;
}
// wire the ranking panel's filter pills + search — called both on render AND after the lazy first-click build,
// so the World-Cup pill and the search work whichever way the panel came into the DOM
function wireRankings(scope) {
  const list = $("#rkList", scope), search = $("#rkSearch", scope);
  if (!list) return;
  let setMode = "all", confMode = "all";   // two independent filters that AND together
  const apply = () => {
    const q = (search?.value || "").trim().toLowerCase();
    $$(".rk-row", list).forEach(r => {
      const okSet = setMode === "all" || r.dataset.q === "1";
      const okConf = confMode === "all" || r.dataset.conf === confMode;
      const okSearch = !q || (r.querySelector(".rk-name")?.textContent || "").toLowerCase().includes(q);
      r.classList.toggle("rk-hide", !(okSet && okConf && okSearch));
    });
  };
  const closeAll = () => $$(".rk-filter .tsel-pop", scope).forEach(p => { p.hidden = true; p.parentElement.querySelector(".tsel-btn")?.setAttribute("aria-expanded", "false"); });
  // one dropdown pill: toggle its popup (closing any other), pick an option → set the label/state + filter
  const wireSel = (wrapId, defaultLabel, attr, onPick) => {
    const wrap = $("#" + wrapId, scope); if (!wrap) return;
    const btn = wrap.querySelector(".tsel-btn"), pop = wrap.querySelector(".tsel-pop"), cur = wrap.querySelector(".tsel-cur");
    btn.onclick = e => { e.stopPropagation(); const wasHidden = pop.hidden; closeAll(); if (wasHidden) { pop.hidden = false; btn.setAttribute("aria-expanded", "true"); } };
    $$(".tsel-opt", pop).forEach(o => o.onclick = () => {
      const val = o.dataset[attr], isDefault = val === "all";
      $$(".tsel-opt", pop).forEach(x => { const on = x === o; x.classList.toggle("is-sel", on); x.setAttribute("aria-selected", String(on)); x.querySelector(".tsel-tick")?.remove(); if (on) x.insertAdjacentHTML("beforeend", `<span class="tsel-tick" aria-hidden="true">✓</span>`); });
      if (cur) cur.textContent = isDefault ? defaultLabel : (o.querySelector(".tsel-opt-name")?.textContent || defaultLabel).replace(/ · .*/, "");
      wrap.classList.toggle("is-on", !isDefault);
      closeAll(); onPick(val); apply();
    });
  };
  wireSel("rkSetWrap", "All teams", "set", v => { setMode = v; });
  wireSel("rkConfWrap", "Confederation", "conf", v => { confMode = v; });
  if (search) search.oninput = apply;
}
function closeRkPops() {   // both ranking dropdowns — used by the global outside-tap + Escape handlers
  for (const id of ["rkSetPop", "rkConfPop"]) { const p = $("#" + id); if (p && !p.hidden) { p.hidden = true; $("#" + id.replace("Pop", "Btn"))?.setAttribute("aria-expanded", "false"); } }
}

// Curated all-time World Cup records (verified historical facts) tracked LIVE against this tournament. Career records
// carry each active 2026 player's PRE-2026 tally; we add their goals from the feed to get the running all-time total,
// so a mark being approached, tied or broken right now is flagged. Static curated data, not Action-owned.
function recordsPanel(s) {
  const goalsOf = (code, re) => { const p = s.scorers.find(x => x.code === code && re.test(x.name)); return p ? p.goals : 0; };
  const inSquad = (code, re) => (S.squads?.[code]?.players || []).some(p => re.test(p.name || ""));
  const apps2026 = (code, re) => { let n = 0; for (const m of S.matches) { if (![ST.FT, ST.LIVE, ST.HT].includes(status(m))) continue; const hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code; if (hc !== code && ac !== code) continue; const r = res(m); if (!r) continue; const side = hc === code ? "h" : "a"; if ((r.xi?.[side]?.xi || []).some(p => re.test(p[1] || "")) || (r.ev || []).some(e => e.k === "S" && e.tm === side && re.test(e.on || ""))) n++; } return n; };
  const e = (name, code, v, yr) => ({ name, code, v, sub: yr });   // a static, all-time entry
  // build a record card from its all-time top list. `recVal` = the #1 mark to beat (Infinity = a standing record that
  // can't move yet). Entries flagged `live` are 2026 players/teams: highlighted, sorted to the top of any tie, and
  // their value is computed live by the caller. Shows the real leaderboard, not just the chasers.
  const card = (ic, title, recVal, entries, opt = {}) => {
    entries = entries.filter(Boolean).sort((a, b) => b.v - a.v || (b.live ? 1 : 0) - (a.live ? 1 : 0)).slice(0, 8);
    const ranks = compRanks(entries, x => x.v);
    const rows = entries.map((x, i) => {
      const attr = x.live ? `${opt.team ? `data-squad="${x.code}"` : `data-player="${esc(x.tap || x.name)}|${x.code}"`} role="button" tabindex="0"` : "";   // only 2026 entries tap through; legends aren't in our data
      const tag = "";
      return `<div class="atr-row${x.live ? " is-live" : ""}" ${attr}>
        <span class="atr-rank">${ranks[i]}</span><span class="fl">${flag(x.code)}</span>
        <span class="atr-nm">${esc(x.name)}${x.sub ? ` <small>${esc(x.sub)}</small>` : ""}</span>
        ${tag}<span class="atr-num">${x.v}</span></div>`;
    }).join("");
    return `<div class="atr"><div class="atr-head"><span class="atr-ic">${ic}</span><span class="atr-title">${title}</span></div>${rows}</div>`;
  };
  // live entries: career goals (pre-2026 + this WC), appearances, World Cups played, the live single-WC leader, a title-holding team
  const lg = (name, code, pre, re, yr) => ({ name, code, v: pre + goalsOf(code, re), live: true, tap: name, sub: `${yr}–` });
  const la = (name, code, pre, re, yr) => ({ name, code, v: pre + apps2026(code, re), live: true, tap: name, sub: `${yr}–` });
  const lt = (name, code, base, re, yr) => ({ name, code, v: base + (inSquad(code, re) ? 1 : 0), live: inSquad(code, re), tap: name, sub: `${yr}–` });
  const teamGoals2026 = () => { const g = {}; for (const m of S.matches) { const r = res(m); if (!r || r.h == null) continue; const hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code; if (hc) g[hc] = (g[hc] || 0) + r.h; if (ac) g[ac] = (g[ac] || 0) + r.a; } let b = null; for (const c in g) if (!b || g[c] > b.v) b = { code: c, v: g[c] }; return b; };
  const matchHaul2026 = () => { let b = null; for (const m of S.matches) { const r = res(m); if (!r) continue; const hc = slotInfo(m, "home").code, ac = slotInfo(m, "away").code, cnt = {}; for (const ev of (r.ev || [])) if ((ev.k === "G" || ev.k === "P") && ev.p) { const tc = ev.tm === "h" ? hc : ac, k = (resolvePlayer(ev.p, tc, ev.n, "out")?.name || ev.p) + "\t" + tc; cnt[k] = (cnt[k] || 0) + 1; } for (const k in cnt) if (!b || cnt[k] > b.v) { const [nm, tc] = k.split("\t"); b = { name: nm, code: tc, v: cnt[k] }; } } return b; };
  const boot = s.scorers[0], tg = teamGoals2026(), mh = matchHaul2026();
  const cards = [
    card(ICO.ball, "Most career World Cup goals", 16, [
      e("Miroslav Klose", "DE", 16, "2002–14"), e("Ronaldo", "BR", 15, "1998–2006"), e("Gerd Müller", "DE", 14, "1970–74"),
      e("Just Fontaine", "FR", 13, "1958"), e("Pelé", "BR", 12, "1958–70"), e("Sándor Kocsis", "HU", 11, "1954"),
      lg("Lionel Messi", "AR", 13, /messi/i, "2006"), lg("Kylian Mbappé", "FR", 12, /mbapp/i, "2018"),
    ]),
    card(ICO.shirt, "Most World Cup appearances", 26, [
      e("Lothar Matthäus", "DE", 25, "1982–98"), e("Miroslav Klose", "DE", 24, "2002–14"), e("Paolo Maldini", "IT", 23, "1990–2002"),
      e("Diego Maradona", "AR", 21, "1982–94"), la("Lionel Messi", "AR", 26, /messi/i, "2006"), la("Cristiano Ronaldo", "PT", 22, /ronaldo/i, "2006"),
    ]),
    card(ICO.calendar, "Most World Cups played", 5, [
      e("Antonio Carbajal", "MX", 5, "1950–66"), e("Lothar Matthäus", "DE", 5, "1982–98"), e("Rafael Márquez", "MX", 5, "2002–18"),
      e("Gianluigi Buffon", "IT", 5, "1998–2014"), lt("Lionel Messi", "AR", 5, /messi/i, "2006"), lt("Cristiano Ronaldo", "PT", 5, /ronaldo/i, "2006"),
    ]),
    card(ICO.net, "Most goals in a single World Cup", 13, [
      e("Just Fontaine", "FR", 13, "1958"), e("Sándor Kocsis", "HU", 11, "1954"), e("Gerd Müller", "DE", 10, "1970"),
      e("Ademir", "BR", 9, "1950"), e("Eusébio", "PT", 9, "1966"),
      e("Ronaldo", "BR", 8, "2002"), e("Kylian Mbappé", "FR", 8, "2022"), e("Guillermo Stábile", "AR", 8, "1930"),
      boot ? { name: pName(boot.name, boot.code), code: boot.code, v: boot.goals, live: true, tap: boot.name, sub: "2026" } : null,
    ]),
    card(ICO.people, "Most goals by a team in one World Cup", 27, [
      e("Hungary", "HU", 27, "1954"), e("West Germany", "DE", 25, "1954"), e("France", "FR", 23, "1958"),
      e("Brazil", "BR", 22, "1950"), e("Brazil", "BR", 19, "1970"),
      e("Germany", "DE", 18, "2014"), e("Brazil", "BR", 18, "2002"), e("Argentina", "AR", 18, "1930"),
      tg ? { name: S.teams[tg.code]?.name || tg.code, code: tg.code, v: tg.v, live: true, sub: "2026" } : null,
    ], { team: true }),
    card(ICO.spark, "Most goals in a match by a player", 5, [
      e("Oleg Salenko", "RU", 5, "1994"), e("Emilio Butragueño", "ES", 4, "1986"), e("Eusébio", "PT", 4, "1966"),
      mh ? { name: pName(mh.name, mh.code), code: mh.code, v: mh.v, live: true, tap: mh.name, sub: "2026" } : null,
    ]),
    card(ICO.trophy, "Most World Cup titles", Infinity, [
      { name: "Brazil", code: "BR", v: 5, sub: "1958–2002" }, { name: "Italy", code: "IT", v: 4, sub: "1934–2006" }, { name: "Germany", code: "DE", v: 4, sub: "1954–2014" },
      { name: "Argentina", code: "AR", v: 3, sub: "1978–2022" }, { name: "Uruguay", code: "UY", v: 2, sub: "1930–50" }, { name: "France", code: "FR", v: 2, sub: "1998–2018" },
    ].map(t => ({ ...t, live: !!S.teams[t.code] })), { team: true }),
  ];
  return `<div class="eyebrow">All-time records</div>
    ${cards.map((h, i) => h.replace('<div class="atr"', `<div class="atr" style="--i:${i}"`)).join("")}
    <p class="sim-ko-hint">All-time figures from official records. Tap a row to open the player or team.</p>`;
}
function renderStats() {
  const el = $("#view-stats"), s = tournamentStats();
  if (!s.pulse.matches) { paint(el, `<div class="rk-pre">Tournament stats (scorers, records, team form) fill in as matches kick off. Until then, here's the field by world ranking.</div>${fifaRankingPanel()}`); return; }
  const tile = (label, val) => `<div class="stat-tile"><span class="stat-val">${val}</span><span class="stat-lbl">${label}</span></div>`;
  const tname = c => esc(S.teams[c]?.name || c);
  // a player leaderboard row (photo + name + value). 2nd arg is the competition rank (tied rows share it), not the index.
  const playerRow = (p, rank, val) => { const ph = bestPhoto(p.name, p.code); return `<div class="lead-row lead-player${rank === 1 ? " lead-top" : ""}" data-player="${esc(p.name)}|${p.code}" role="button" tabindex="0">
    <span class="lead-rank">${rank}</span>${ph ? `<span class="lead-face" style="background-image:url('${ph}')"></span>` : `<span class="fl">${flag(p.code)}</span>`}
    <span class="lead-name">${esc(pName(p.name, p.code))}<small>${flag(p.code)} ${tname(p.code)}</small></span>
    <span class="lead-v">${val}</span></div>`; };
  const scorerRow = (p, rank) => playerRow(p, rank, `${p.goals}<small>${p.assists ? `${p.assists} ast` : "&nbsp;"}</small>`);
  const assistRow = (p, rank) => playerRow(p, rank, `${p.assists}<small>assist${p.assists > 1 ? "s" : ""}</small>`);
  const keeperRow = (p, rank) => playerRow(p, rank, `${p.cs}<small>clean sheet${p.cs !== 1 ? "s" : ""}</small>`);
  const bookedRow = (p, rank) => playerRow(p, rank, `<span class="card-tally">${p.y ? `<span class="ct ct-y">${p.y}</span>` : ""}${p.r ? `<span class="ct ct-r">${p.r}</span>` : ""}</span>`);
  // map a leaderboard to HTML with competition ranks. rowFn(item, rank, index); rows with an equal keyOf share a rank.
  const ranked = (rows, rowFn, keyOf) => { const rk = compRanks(rows, keyOf); return rows.map((x, i) => rowFn(x, rk[i], i)).join(""); };
  // suspension watch: a red card or an accumulated 2nd yellow = a one-match ban. We list only players who will
  // actually miss their next game — a lone yellow is far too common to flag (and the count is arbitrary).
  const suspRow = p => { const ph = bestPhoto(p.name, p.code); return `<div class="lead-row lead-player" data-player="${esc(p.name)}|${p.code}" role="button" tabindex="0">
    ${ph ? `<span class="lead-face" style="background-image:url('${ph}')"></span>` : `<span class="fl">${flag(p.code)}</span>`}
    <span class="lead-name">${esc(pName(p.name, p.code))}<small>${flag(p.code)} ${tname(p.code)}</small></span>
    <span class="susp-tag is-ban">${p.r > 0 ? "Sent off: banned" : "2 yellows: banned"}</span></div>`; };
  const suspended = s.booked.filter(p => p.r > 0 || p.y >= 2);
  const suspHtml = suspended.length
    ? `<div class="lead-card"><h4>Suspension watch <small>out of their next match</small></h4>${suspended.map(suspRow).join("")}</div>` : "";
  const teamLead = (title, rows, fmt) => rows.length ? `<div class="lead-card"><h4>${title}</h4>${ranked(rows.slice(0, 5), (x, rank) => `<div class="lead-row" data-squad="${x.code}" role="button" tabindex="0">
    <span class="lead-rank">${rank}</span><span class="fl">${flag(x.code)}</span><span class="lead-name">${tname(x.code)}</span>
    <span class="lead-v">${fmt(x)}</span></div>`, fmt)}</div>` : "";
  const perGame = x => `${x.v.toFixed(1)}<small>/ match</small>`;
  const fairLead = s.fairPlay.length ? `<div class="lead-card"><h4>Fair play <small>−1 per yellow, −3 per red · fewer is cleaner</small></h4>${ranked(s.fairPlay.slice(0, 5), (x, rank, i) => `<div class="lead-row ${rank === 1 ? "lead-fair-top" : ""}" data-squad="${x.code}" role="button" tabindex="0">
    <span class="lead-rank">${rank}</span><span class="fl">${flag(x.code)}</span><span class="lead-name">${tname(x.code)}</span>
    <span class="lead-v">${x.pts}<small>pts</small></span></div>`, x => x.pts)}</div>` : "";
  const cardLead = s.teamCards.length ? `<div class="lead-card"><h4>Team cards</h4>${ranked(s.teamCards.slice(0, 5), (x, rank) => `<div class="lead-row" data-squad="${x.code}" role="button" tabindex="0">
    <span class="lead-rank">${rank}</span><span class="fl">${flag(x.code)}</span><span class="lead-name">${tname(x.code)}</span>
    <span class="lead-v card-tally"><span class="ct ct-y" title="${x.y} yellow">${x.y}</span><span class="ct ct-r" title="${x.r} red">${x.r}</span></span></div>`, x => x.v)}</div>` : "";

  // records / superlatives — each row taps through to its match or the player who scored
  const rc = s.records;
  const recRow = (ic, label, sub, val, attr) => `<div class="rec-row" ${attr} role="button" tabindex="0">
    <span class="rec-ic">${ic}</span><span class="rec-tx"><b>${label}</b><small>${sub}</small></span><span class="rec-v">${val}</span></div>`;
  const recItems = [];
  if (rc.bigWin) { const r = rc.bigWin; recItems.push(recRow(ICO.spark, "Biggest win", `${flag(r.w)} ${tname(r.w)} beat ${flag(r.l)} ${tname(r.l)}`, `${r.ws}–${r.ls}`, `data-mid="${r.mid}"`)); }
  if (rc.hiScore) { const r = rc.hiScore; recItems.push(recRow(ICO.net, "Highest-scoring match", `${flag(r.hc)} ${tname(r.hc)} v ${flag(r.ac)} ${tname(r.ac)}`, `${r.h}–${r.a}<small>${r.total} goals</small>`, `data-mid="${r.mid}"`)); }
  if (rc.hiDraw) { const r = rc.hiDraw; recItems.push(recRow(ICO.net, "Highest-scoring draw", `${flag(r.hc)} ${tname(r.hc)} v ${flag(r.ac)} ${tname(r.ac)}`, `${r.h}–${r.a}`, `data-mid="${r.mid}"`)); }
  if (rc.topMatch) { const r = rc.topMatch; recItems.push(recRow(ICO.ball, "Best individual haul", `${flag(r.code)} ${esc(r.name)}${r.opp ? ` vs ${flag(r.opp)} ${tname(r.opp)}` : ""}`, `${r.v} goals`, `data-player="${esc(r.name)}|${r.code}"`)); }
  if (rc.fastG) { const r = rc.fastG; recItems.push(recRow(ICO.bolt, "Fastest goal", `${flag(r.code)} ${esc(r.name)}`, esc(r.t), `data-player="${esc(r.name)}|${r.code}"`)); }
  if (rc.lateG) { const r = rc.lateG; recItems.push(recRow(ICO.clock, "Latest goal", `${flag(r.code)} ${esc(r.name)}`, esc(r.t), `data-player="${esc(r.name)}|${r.code}"`)); }
  if (rc.mostCards) { const r = rc.mostCards; recItems.push(recRow(ICO.spark, "Most cards in a match", `${flag(r.hc)} ${tname(r.hc)} v ${flag(r.ac)} ${tname(r.ac)}`, `<span class="card-tally"><span class="ct ct-y">${r.y}</span>${r.r ? `<span class="ct ct-r">${r.r}</span>` : ""}</span>`, `data-mid="${r.mid}"`)); }
  if (rc.mostTackles) { const r = rc.mostTackles; recItems.push(recRow(ICO.shield, "Most tackles by a team", `${flag(r.code)} ${tname(r.code)}${r.opp ? ` vs ${flag(r.opp)} ${tname(r.opp)}` : ""}`, `${r.v}`, `data-mid="${r.mid}"`)); }
  if (rc.bestDef) { const r = rc.bestDef; recItems.push(recRow(ICO.shield, "Best defensive display", `${flag(r.code)} ${esc(pName(r.name, r.code))}${r.opp ? ` vs ${flag(r.opp)} ${tname(r.opp)}` : ""}`, `${r.v}<small>actions</small>`, `data-player="${esc(r.name)}|${r.code}"`)); }
  const recordsHtml = recItems.length
    ? `<div class="lead-card rec-card">${recItems.join("")}</div><p class="sim-ko-hint">Tap a record to open the match or player.</p>`
    : `<div class="empty">Records fill in as matches are played.</div>`;

  // confederation breakdown — each confederation's collective record, ranked by points per game
  // A proper standings table (same chrome + column rhythm as the group tables): one header row of stat names,
  // numbers aligned in fixed columns beneath. Names abbreviated so every column lines up on a phone.
  const CONF_LABEL = { UEFA: "Europe", CONMEBOL: "S. America", CONCACAF: "N/C America", AFC: "Asia", CAF: "Africa", OFC: "Oceania" };
  const confHtml = s.confeds.length ? `<div class="eyebrow">By confederation</div>
    <div class="gtable conf-table">
      <table><colgroup><col class="c-name"><col class="c-n"><col class="c-n"><col class="c-n"><col class="c-n"><col class="c-gf"><col class="c-gf"></colgroup>
      <thead><tr><th>Confederation</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th></tr></thead>
      <tbody>${s.confeds.map(c => `<tr>
        <td class="conf-tname">${CONF_LABEL[c.conf] || c.conf}<small>${c.conf} · ${c.teams}</small></td>
        <td>${c.p}</td><td>${c.w}</td><td>${c.d}</td><td>${c.l}</td><td>${c.gf}</td><td>${c.ga}</td>
      </tr>`).join("")}</tbody></table>
    </div>
    <p class="sim-ko-hint">Combined record of every team in each confederation (P played, GF/GA goals for and against), ordered by points per game.</p>` : "";

  // sections behind a segmented sub-nav so the tab grows down (not into one endless scroll)
  // discipline is split by subject: player bookings/suspensions go under Players, team cards/fair-play under Teams
  const bookedCard = s.booked.length ? `<div class="lead-card"><h4>Booked players</h4>${ranked(s.booked.slice(0, 8), bookedRow, p => p.r + "," + p.y)}</div>` : "";
  const playerDisc = (suspHtml || bookedCard) ? `<div class="eyebrow">Discipline</div><div class="lead-grid">${suspHtml}${bookedCard}</div>` : "";
  const teamDisc = (cardLead || fairLead) ? `<div class="eyebrow">Discipline</div><div class="lead-grid">${cardLead}${fairLead}</div>${s.fairPlay.length ? `<p class="sim-ko-hint">Fair play points (−1 a yellow, −3 a red) are a real group tiebreaker; fewer is cleaner. A red or second yellow also means a one-match ban (single yellows clear after the quarter-finals).</p>` : ""}` : "";
  const sections = [
    ["overview", "Overview", `<div class="eyebrow">Tournament so far</div><div class="stat-tiles">
      ${tile("Goals", s.pulse.goals)}${tile("Matches", s.pulse.matches)}
      ${tile("Goals / match", s.pulse.perMatch.toFixed(2))}
      ${tile("Shots on target", s.pulse.sot)}${tile("Penalties scored", s.pulse.pens)}${tile("Own goals", s.pulse.og)}
      <div class="stat-tile"><span class="stat-val card-val"><span class="cv cv-y">${s.pulse.yellows}</span><span class="cv cv-r">${s.pulse.reds}</span></span><span class="stat-lbl">Cards</span></div>
    </div>
      <div class="eyebrow">Records so far</div>${recordsHtml}
      ${confHtml}`],
    ["players", "Players", `
      ${s.scorers.length ? `<div class="eyebrow">${ICO.ball} Golden Boot</div><div class="lead-card lead-scorers">${ranked(s.scorers.slice(0, 12), scorerRow, p => p.goals)}</div>` : ""}
      ${s.assisters.length ? `<div class="eyebrow">Playmakers · assists</div><div class="lead-card lead-scorers">${ranked(s.assisters.slice(0, 8), assistRow, p => p.assists)}</div>` : ""}
      ${s.keepers.length ? `<div class="eyebrow">${ICO.glove} Goalkeepers · clean sheets</div><div class="lead-card lead-scorers">${ranked(s.keepers.slice(0, 8), keeperRow, p => p.cs)}</div>` : ""}
      ${playerDisc}
      ${!s.scorers.length && !s.assisters.length ? `<div class="empty">No goals yet. The Golden Boot race starts with the first goal.</div>` : ""}`],
    ["teams", "Teams", `<div class="eyebrow">Team leaderboards</div><div class="lead-grid">
      ${teamLead("Possession", s.possession, x => x.v.toFixed(1) + "%")}
      ${teamLead("Pass accuracy", s.teamPassAcc, x => x.v.toFixed(0) + "%")}
      ${teamLead("Saves", s.teamSaves, perGame)}
      ${teamLead("Defensive actions", s.teamDef, perGame)}
      ${teamLead("Shots on target", s.teamSot, perGame)}
      ${teamLead("Crosses", s.teamCrosses, perGame)}
    </div>${teamDisc}`],
    ["records", "All-time", recordsPanel(s)],
    ["rankings", "Ranking", statsTab === "rankings" ? fifaRankingPanel() : ""],   // lazy: the 211-row panel is built only when its tab is shown (or on first click, below)
  ];
  if (!sections.some(([k]) => k === statsTab)) statsTab = "overview";
  const out = `<div class="substat-nav" role="tablist" aria-label="Statistics sections">${sections.map(([k, label]) => `<button class="substat ${k === statsTab ? "is-on" : ""}" id="substab-${k}" role="tab" aria-selected="${k === statsTab}" aria-controls="substat-${k}" data-stat="${k}">${label}</button>`).join("")}</div>`
    + sections.map(([k, , html]) => `<div class="substat-panel" id="substat-${k}" role="tabpanel" aria-labelledby="substab-${k}" data-panel="${k}"${k === statsTab ? "" : " hidden"}>${html}</div>`).join("");
  // a live match rewrites results.json every poll (the minute ticks), which re-renders the active view. If the
  // Stats markup is byte-identical, keep the existing DOM — otherwise a tap mid-poll lands on a freshly-swapped row.
  if (out === _statsHTML && el.firstChild) return;
  _statsHTML = out;
  paint(el, out);
  $$(".substat", el).forEach(b => b.onclick = () => {
    const k = statsTab = b.dataset.stat;
    $$(".substat", el).forEach(x => { const on = x.dataset.stat === k; x.classList.toggle("is-on", on); x.setAttribute("aria-selected", on); });
    const panel = $(`.substat-panel[data-panel="${k}"]`, el);
    if (k === "rankings" && panel && !panel.firstChild) { panel.innerHTML = fifaRankingPanel(); wireRankings(panel); }   // built lazily on first view → wire its pills + search now
    $$(".substat-panel", el).forEach(p => p.hidden = p.dataset.panel !== k);
  });
  wireRankings(el);   // also wire it when Rankings is the active tab on (re-)render
}

/* ---------------- match report + live commentary (rendered inside the match popup) ---------------- */
// full credited write-up for a finished match (reports.json arrives a little after full time)
function mdReport(m) {
  if ([ST.LIVE, ST.HT].includes(status(m))) return "";   // a live game shows commentary instead, never the report
  const rp = report(m); if (!rp || !(rp.rep?.length || rp.hl)) return "";
  const paras = (rp.rep || []).map(p => `<p>${esc(p)}</p>`).join("");
  const credit = (rp.src || rp.by) ? `<div class="md-credit">Report: ${rp.by ? esc(rp.by) + " · " : ""}${rp.url ? `<a href="${esc(rp.url)}" target="_blank" rel="noopener noreferrer">${esc(rp.src || "source")} ↗</a>` : esc(rp.src || "")}</div>` : "";
  return `<div class="eyebrow">Match report</div><div class="md-report">${rp.hl ? `<h4>${esc(rp.hl)}</h4>` : ""}${paras}${credit}</div>`;
}
// live commentary — only while a match is in play; finished matches get the report above instead
function mdCommentaryShell(m) {
  if (![ST.LIVE, ST.HT].includes(status(m))) return "";
  return `<details class="md-comm" id="mdComm" data-keep open><summary><span>Live commentary</span><small class="md-comm-hint">● updating</small></summary><div class="md-comm-body" id="mdCommBody"></div></details>`;
}
function renderCommentary(c) {
  if (!c || !c.items?.length) return `<div class="empty">No commentary published for this match.</div>`;
  // ESPN ships terse VAR strings (e.g. "VAR Decision: Other Decision Cancelled.") — badge them and say it plainly
  const clarify = t => {
    const m = /^VAR Decision:\s*(.+?)\.?\s*$/i.exec(t || "");
    if (!m) return esc(t || "");
    let d = m[1].trim();
    if (/^other decision cancelled$/i.test(d)) d = "an on-field decision was overturned after review";
    return `<b class="cm-var">VAR</b> ${esc(d)}`;
  };
  const row = it => {
    const isVar = /^VAR Decision:/i.test(it.x || "");
    return `<div class="cm-row${it.k ? ` cm-${esc(it.k)}` : ""}${isVar ? " cm-var-row" : ""}">${it.t ? `<span class="cm-t">${esc(it.t)}</span>` : `<span class="cm-t cm-t-x"></span>`}<span class="cm-x">${isVar ? clarify(it.x) : esc(it.x || "")}</span></div>`;
  };
  // a raw play-by-play is mostly throw-ins and blocked shots — lead with the moments that matter; full feed one tap away
  const KEY = it => it.k || /\bpenalt|\bVAR\b|own goal|sent off|red card|hits the (bar|post|crossbar)|Match ends|First Half ends|Second Half ends|Half begins|^Goal|kick-off/i.test(it.x || "");
  const key = c.items.filter(KEY);
  const lead = key.length >= 3 ? key : c.items.slice(0, 10);   // enough highlights? lead with them, else the latest 10
  const credit = c.src ? `<div class="md-credit">Commentary: ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.src)} ↗</a>` : esc(c.src)}</div>` : "";
  const full = lead.length < c.items.length
    ? `<details class="cm-full"><summary>Full play-by-play · ${c.items.length} entries</summary>${c.items.map(row).join("")}</details>` : "";
  return lead.map(row).join("") + full + credit;
}

/* ---------------- the Pulse: fan reactions + press headlines, baked into data/buzz.json by the Action ---------------- */
// Shape: { updated, matches: { "<matchId>": { heat:0-100, reactions:[{text,score,src,url}] } }, headlines:[{title,src,url,team?}] }
// short relative age for the chronological News feed: "12m ago" / "3h ago" / "2d ago"
const relTime = iso => {
  const s = (Date.now() - +new Date(iso)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};
// News: a chronological feed of World Cup headlines (newest first) with a live filter box. The fan-reaction
// pipeline is parked (see fetch-buzz.mjs SOCIAL flag); this reads only b.headlines.
// Some desks leak NON-football stories that merely mention a country whose name is also a team's ("Iran", "US",
// "Korea"…) — even the World-Cup feeds occasionally tag host-country politics/travel as WC. Keep an item only if it's
// clearly football: a World-Cup mention, a football keyword/scoreline, or a marquee player. (Legit WC headlines almost
// always carry "World Cup" or a football term, so this is safe; a bare country name is never enough.)
const NEWS_FOOTBALL_RE = /\b(footbal|soccer|fifa|world ?cup|wc[\s-]?2026|match(es)?|goals?|scored?|coach|managers?|squads?|line-?ups?|qualif|group ?[a-l]\b|group ?stage|strikers?|midfield|defenders?|goalkeep|keeper|friendl(y|ies)|fixtures?|kick-?off|penalt|knockout|tournament|equali[sz]|hat-?trick|substitut|stadium|referee|red card|yellow card|caps?|capped|national team|trophy|champions?|finals?|semi-?finals?|quarter-?finals?|round of (16|32)|injur|transfer|forwards?|wingers?|dribbl|free.?kick|golden boot|own goal)\b|\b\d{1,2}\s?[-–]\s?\d{1,2}\b/i;
const NEWS_STAR_RE = /\b(mbappe|messi|ronaldo|haaland|neymar|bellingham|vinicius|lewandowski|modric|griezmann|musiala|wirtz|kimmich|tchouameni|saliba|rodrygo|endrick|raphinha|osimhen|kvaratskhelia|gakpo|pulisic|havertz|dembele|vlahovic|yamal|salah|kane)\b/i;
const newsIsFootball = h => NEWS_FOOTBALL_RE.test(h.title) || NEWS_STAR_RE.test(h.title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase());
function renderPulse() {
  const el = $("#view-pulse"), b = S.buzz;
  const intro = `<div class="pulse-intro"><h2>News</h2><p>The latest World Cup headlines from football desks worldwide, newest first. Each links out to its source.</p></div>`;
  // show whole headlines only: some desks (ESPN live blogs) ship a title the source itself truncated with "…" and an
  // editorial "Copy of " prefix. Strip the prefix and drop anything still cut off, so every card reads in full.
  const cleanHl = t => String(t || "").replace(/^\s*copy of\s+/i, "").trim();
  const heads = ((b && b.headlines) || [])
    .map(h => ({ ...h, title: cleanHl(h.title) }))
    .filter(h => h.title && !/(?:…|\.\.\.)\s*$/.test(h.title))
    .filter(newsIsFootball)   // drop non-football items that only matched on a country name (e.g. Iran/US politics)
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  if (!heads.length) {
    paint(el, intro + `<div class="pulse-empty">${ICO.spark}<p>The day's headlines gather here as the tournament plays. Check back soon.</p></div>`);
    return;
  }
  const list = heads.map(hd => `<a class="pl-head" data-news="${esc((hd.title + " " + (hd.src || "")).toLowerCase())}" href="${esc(hd.url || "#")}" target="_blank" rel="noopener noreferrer">
    <span class="pl-head-t">${esc(hd.title)}</span>
    <span class="pl-head-s">${esc(hd.src || "")}${hd.date ? ` · ${relTime(hd.date)}` : ""} ↗</span></a>`).join("");
  paint(el, intro +
    `<input class="team-search news-search" id="newsSearch" type="search" placeholder="Search headlines…" autocomplete="off" autocapitalize="off" spellcheck="false">` +
    `<div class="pl-heads" id="newsList">${list}</div>` +
    `<p class="news-empty" id="newsEmpty" hidden>No headlines match that search.</p>` +
    `<p class="pulse-foot">Gathered automatically from public news feeds, newest first. Each links out to its source.</p>`);
  const s = $("#newsSearch", el);
  const applyNewsFilter = () => {
    const q = (s?.value || "").trim().toLowerCase();
    let shown = 0;
    $$("#newsList .pl-head", el).forEach(a => { const hide = !!q && !a.dataset.news.includes(q); a.classList.toggle("news-hide", hide); if (!hide) shown++; });
    const empty = $("#newsEmpty", el); if (empty) empty.hidden = !q || shown > 0;
  };
  if (s) { s.oninput = applyNewsFilter; if (s.value) applyNewsFilter(); }   // re-apply after a 60s poll re-render (the input value survives the morph, the .news-hide classes don't)
}
async function loadBuzz() {
  try { S.buzz = await (await fetch("data/buzz.json?t=" + Date.now(), { cache: "no-store" })).json(); } catch { /* not published yet — keep what we have */ }
  if (S.view === "pulse") renderPulse();
}
// FIFA EFI deep-analysis data (post-match). If the currently-open match popup just gained EFI, re-render it.
async function loadEfi() {
  try { S.efi = (await (await fetch("data/efi.json?t=" + Date.now(), { cache: "no-store" })).json()).matches || {}; } catch { /* not published yet */ }
  const md = $("#matchDialog"); if (md?.open && md.dataset.openMid) openMatch(md.dataset.openMid, true);
}
// last World Cup (Qatar 2022): finishes + squads, for the "Then & Now" team views. Static — fetched once.
async function loadWC2022() {
  try { S.wc22 = await (await fetch("data/wc2022.json")).json(); } catch { /* not published yet */ }
  if ($("#teamSheet")?.open && $("#teamSheet").dataset.code) openTeam($("#teamSheet").dataset.code);   // refresh an open sheet
}
// of a 2026 team, who CONTINUES from its 2022 squad vs who's NEW. 2022 names resolve to 2026 players by full
// (order/accent-insensitive) name match — strict, so we never count a same-surname different player as "continuing".
const _wc22KeyCache = new Map();
function wc22Continuity(code) {
  const w = S.wc22?.teams?.[code], sq = S.squads?.[code]?.players;
  if (!w || !sq) return null;
  const key = n => { const k = _deburr(n).replace(/\(.*?\)/g, "").split(/\s+/).map(t => t.replace(/[^a-z]/g, "")).filter(Boolean).sort().join(" "); return k; };
  const had = new Set((w.squad || []).map(key));
  const continuing = sq.filter(p => had.has(key(p.name)));
  const fresh = sq.filter(p => !had.has(key(p.name)));
  return { finish: w.finish, tier: w.tier, in2022: (w.squad || []).length, continuing, fresh };
}

/* ---------------- navigation ---------------- */
const RENDER = { matches: renderMatches, teams: renderTeams, players: renderPlayers, groups: renderGroups, stats: renderStats, sim: renderSim, pulse: renderPulse };
// shareable per-tab URL hash (Matches is the default → no hash; Predict's internal view name is "sim")
const VIEW_HASH = { teams: "teams", players: "players", groups: "tables", sim: "predict", stats: "stats", pulse: "pulse" };
// "live" survives only as a redirect: Live folded into the match modal (build 329), but old #live links still land on Matches
const HASH_VIEW = { live: "matches", matches: "matches", teams: "teams", players: "players", tables: "groups", groups: "groups", predict: "sim", stats: "stats", pulse: "pulse" };
function nav(v) {
  if (typeof closeInfoPop === "function") closeInfoPop();   // an open explainer is anchored to the old view
  S.view = v;
  const _want = VIEW_HASH[v] ? "#" + VIEW_HASH[v] : "";       // reflect the tab in the URL so it's shareable / bookmarkable
  if (location.hash !== _want && !location.hash.startsWith("#p=")) history.replaceState(null, "", location.pathname + location.search + _want);
  $$(".view").forEach(el => el.hidden = el.id !== "view-" + v);
  $$(".tab").forEach(t => { const on = t.dataset.nav === v; t.classList.toggle("is-active", on); on ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current"); });
  moveInk();
  const at = $(".tab.is-active"), tabs = $(".tabs");          // keep the active tab in view on the scrollable bar
  if (at && tabs) tabs.scrollTo({ left: at.offsetLeft - tabs.clientWidth / 2 + at.offsetWidth / 2, behavior: "smooth" });
  RENDER[v]();
  scrollTo({ top: 0, behavior: "instant" });
  if (v !== "matches") $("#jumpNow").hidden = true;
  try { window.goatcounter?.count?.({ path: location.pathname + "#" + v, title: "WC26 · " + v, event: false }); } catch { /* analytics off or not loaded */ }
}
function moveInk() {
  const t = $(".tab.is-active"), ink = $("#tabInk");
  if (!t) return;
  ink.style.left = t.offsetLeft + 8 + "px";
  ink.style.width = t.offsetWidth - 16 + "px";
}

/* ---------------- pickers ---------------- */
function buildPickers() {
  $("#tzList").innerHTML = ZONES.slice().sort((a, b) => a[0] === "auto" ? -1 : b[0] === "auto" ? 1 : tzMinutes(a[0]) - tzMinutes(b[0])).map(([z, l]) =>
    `<button class="tz-opt ${S.tz === z ? "is-on" : ""}" data-z="${z}"><span>${l}</span><span class="off">${tzOffsetLabel(z)}</span></button>`).join("");
  $$("#tzList .tz-opt").forEach(b => b.onclick = () => {
    S.tz = b.dataset.z; localStorage.setItem("wc26.tz", S.tz);
    $("#tzDialog").close(); syncTzLabels(); buildPickers(); renderTicker(); RENDER[S.view]();
  });
  const list = (q = "") => Object.entries(S.teams)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .filter(([, t]) => t.name.toLowerCase().includes(q.toLowerCase()))
    .map(([c, t]) => `<button class="team-opt ${S.fav === c ? "is-on" : ""}" data-c="${c}"><span class="fl">${flag(c)}</span>${esc(t.name)}</button>`).join("");
  const wire = () => $$("#teamList .team-opt").forEach(b => b.onclick = () => {
    S.fav = b.dataset.c; localStorage.setItem("wc26.fav", S.fav);
    $("#teamDialog").close(); applyTheme($("#teamChip")); buildPickers(); RENDER[S.view]();
  });
  $("#teamList").innerHTML = list(); wire();
  $("#teamSearch").oninput = e => { $("#teamList").innerHTML = list(e.target.value); wire(); };
  $("#teamClear").onclick = () => {
    S.fav = null; localStorage.removeItem("wc26.fav");
    $("#teamDialog").close(); applyTheme(); buildPickers(); RENDER[S.view]();
  };
}
function syncTzLabels() {
  const tzl = $("#tzState"); if (tzl) tzl.textContent = `${tzCity().split(",")[0].trim()} · ${tzShort()}`;  // compact: City · GMT±N (no country / "auto" clutter)
  $("#footTz").textContent = `${tzCity()} · ${tzShort()}`;
  const bt = $("#buildTag");
  if (bt) {
    bt.textContent = "build " + BUILD;
    if (!bt._egg) {
      bt._egg = true;
      let taps = 0, tapTimer;
      bt.addEventListener("click", () => {
        clearTimeout(tapTimer);
        taps++;
        bt.classList.remove("egg-tap");
        void bt.offsetWidth;
        bt.classList.add("egg-tap");
        setTimeout(() => bt.classList.remove("egg-tap"), 500);
        const left = 7 - taps;
        if (taps >= 3 && taps < 7) eggToast(left + " more tap" + (left === 1 ? "" : "s") + "...");
        if (taps >= 7) { taps = 0; eggUnlock(); }
        else tapTimer = setTimeout(() => { taps = 0; }, 2200);
      });
    }
  }
  setFreshness();   // re-render the "scores from / checked" times in the new timezone
}
function eggToast(msg) {
  let t = document.getElementById("eggToast");
  if (!t) { t = document.createElement("div"); t.id = "eggToast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("egg-show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("egg-show"), 1500);
}
function eggUnlock() {
  localStorage.setItem("wc26.egg", "1");
  openChampOverlay();
}

/* ---------------- expert view ---------------- */
function currentTheme() { return document.documentElement.dataset.theme || "light"; }

/* ---------------- championship odds overlay ---------------- */
function isStillIn(code) {
  // A team is still competing if they have at least one confirmed non-FT appearance remaining
  return S.matches.some(m => {
    if (status(m) === ST.FT) return false;
    const h = slotInfo(m, "home"), a = slotInfo(m, "away");
    return h.code === code || a.code === code;
  });
}
function champProbs() {
  const R = eloSeq();
  const alive = Object.keys(S.teams).filter(c => S.teams[c] && isStillIn(c));
  // Fall back to all teams if no live/upcoming matches found (e.g. pre-tournament)
  const pool = alive.length ? alive : Object.keys(S.teams).filter(c => S.teams[c]);
  return pool
    .map(c => ({ code: c, p: Math.exp(((R[c] ?? S.teams[c]?.elo ?? 1700) - 1700) / 600) }))
    .sort((a, b) => b.p - a.p)
    .map((item, _, arr) => ({ ...item, p: item.p / arr.reduce((s, x) => s + x.p, 0) }));
}
function openChampOverlay() {
  let ov = document.getElementById("champOv");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "champOv";
    ov.className = "champ-ov";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "Championship odds");
    ov.innerHTML = `<div class="champ-panel">
      <div class="champ-ph">
        <div class="champ-titles">
          <p class="champ-eye">Model estimate</p>
          <h2 class="champ-head">Championship odds</h2>
        </div>
        <button class="champ-x" aria-label="Close">&#x2715;</button>
      </div>
      <ol class="champ-list" id="champList"></ol>
      <p class="champ-note">Relative strength from current ratings · tap build number 7x to reopen</p>
    </div>`;
    document.body.appendChild(ov);
    ov.querySelector(".champ-x").onclick = () => {
      ov.classList.remove("is-open");
      setTimeout(() => { ov.hidden = true; }, 380);
    };
    ov.addEventListener("click", e => { if (e.target === ov) ov.querySelector(".champ-x").click(); });
  }
  // populate list fresh each open (ratings may have updated)
  const probs = champProbs();
  const top = probs[0].p;
  document.getElementById("champList").innerHTML = probs.map((item, i) => {
    const t = S.teams[item.code];
    const pct = (item.p * 100).toFixed(1);
    const barW = Math.round(item.p / top * 100);
    return `<li class="champ-row" style="--d:${Math.min(i * 18, 500)}ms">
      <span class="champ-rank">${i + 1}</span>
      <span class="champ-fl">${flag(item.code)}</span>
      <span class="champ-name">${esc(t.name)}</span>
      <span class="champ-bar"><span class="champ-bar-fill" style="--d:${Math.min(i * 18, 500)}ms;width:${barW}%"></span></span>
      <span class="champ-pct">${pct}%</span>
    </li>`;
  }).join("");
  ov.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add("is-open")));
}

/* ---------------- background music (off by default) ---------------- */
// Royalty-free "stadium mix" — 14 match-day tracks sourced by the user (Pixabay/Uppbeat artists:
// hitslab, ikoliks, mfcc, nastelbom, positive_sound, prettyjohn1, soundsurfer, starostin, the_mountain,
// tunetank, yevhenastafiev). Curated from 15 by dropping a 0.95-similar duplicate (prettyjohn twin);
// the rest were ordered/kept by a timbre-similarity pass so near-alike tracks don't cluster.
const MUSIC = ["hitslab-334834", "ikoliks-381489", "mfcc-414731", "nastelbom-412586", "positivesound-487188",
  "prettyjohn1-499975", "soundsurfer-516385", "soundsurfer-edit-276736", "starostin-samba-260573",
  "starostin-541750", "themountain-485564", "themountain-496555", "tunetank-349258", "yevhenastafiev-526075"]
  .map(n => `assets/music/${n}.mp3`);
// The button reflects the audio's REAL paused state (not just a saved flag), so it
// can never get out of sync with what you actually hear.
function initMusic() {
  const a = $("#bgm"), btn = $("#musicToggle"); if (!btn || !a) return;
  a.volume = 0.32;
  const HEARD_KEY = "wc26.music.heard", POS_KEY = "wc26.music.pos";
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  // "heard" persists ACROSS sessions: a shuffle-bag that never replays a track until the whole catalogue
  // has been heard, so returning visitors keep getting NEW songs rather than re-rolling the same favourites.
  let heard = new Set((load(HEARD_KEY, []) || []).filter(s => MUSIC.includes(s)));
  let current = null, pendingSeek = 0, lastSave = -99;
  const saveHeard = () => localStorage.setItem(HEARD_KEY, JSON.stringify([...heard]));
  const savePos = () => { if (current) localStorage.setItem(POS_KEY, JSON.stringify({ src: current, t: a.currentTime || 0 })); };
  const pick = () => {                                 // a fresh, not-yet-heard track (avoid an immediate repeat)
    let pool = MUSIC.filter(s => !heard.has(s));
    if (!pool.length) { heard = current ? new Set([current]) : new Set(); pool = MUSIC.filter(s => !heard.has(s)); }  // catalogue done → new cycle
    if (pool.length > 1 && current) pool = pool.filter(s => s !== current);
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const cue = src => { current = src || pick(); heard.add(current); saveHeard(); a.src = current; lastSave = -99; savePos(); };
  const play = () => {
    if (!a.src) {
      const saved = load(POS_KEY, null);               // resume the SAME track + position from last time, not the first song
      if (saved && MUSIC.includes(saved.src)) { current = saved.src; pendingSeek = saved.t || 0; heard.add(current); saveHeard(); a.src = current; }
      else cue();
    }
    return a.play();
  };
  const trySeek = () => {                             // resume the saved position once that byte offset is actually seekable
    if (pendingSeek <= 1) return;                     // (with HTTP range support it's instant; without, it lands after buffering)
    if (a.duration && pendingSeek >= a.duration - 2) { pendingSeek = 0; return; }   // saved point past this track's end → start fresh
    if (a.seekable.length && a.seekable.end(a.seekable.length - 1) >= pendingSeek) { try { a.currentTime = pendingSeek; } catch {} pendingSeek = 0; }
  };
  ["loadedmetadata", "canplay", "progress"].forEach(ev => a.addEventListener(ev, trySeek));
  a.addEventListener("ended", () => { cue(); a.play().catch(() => {}); });   // rolling playlist, never stops on its own
  a.addEventListener("timeupdate", () => { const t = a.currentTime; if (t - lastSave > 5 || t < lastSave) { lastSave = t; savePos(); } });
  const sync = () => {
    const playing = !a.paused;
    btn.setAttribute("aria-pressed", String(playing));
    const st = $("#musicState"); if (st) st.textContent = playing ? "On" : "Off";
    const mc = $("#musicChip"); if (mc) { mc.setAttribute("aria-pressed", String(playing)); mc.classList.toggle("is-on", playing); }
  };
  const mc = $("#musicChip"); if (mc) mc.onclick = () => btn.click();   // header chip mirrors the settings toggle
  a.addEventListener("play", sync);
  a.addEventListener("pause", sync);
  btn.onclick = () => {
    if (a.paused) { play().then(() => localStorage.setItem("wc26.music", "on")).catch(() => {}); }
    else { a.pause(); savePos(); localStorage.setItem("wc26.music", "off"); }
  };
  // resume a previously-on preference on the first interaction (autoplay is blocked on load) —
  // but ignore a tap on the toggle itself, so toggling can never fight the resume
  if (localStorage.getItem("wc26.music") === "on") {
    const resume = e => { if (!e.target.closest("#musicToggle")) play().catch(() => {}); };
    addEventListener("pointerdown", resume, { once: true });
  }
  sync();
}
/* ---------------- theme (dark mode) + goal horn ---------------- */
const currentDark = () => document.documentElement.dataset.theme === "dark";
function setDark(on) {
  document.documentElement.dataset.theme = on ? "dark" : "light";
  localStorage.setItem("wc26.theme", on ? "dark" : "light");
  $('meta[name="theme-color"]')?.setAttribute("content", on ? "#0E1822" : "#0BA360");
  const st = $("#themeState"); if (st) st.textContent = on ? "On" : "Off";
  $("#themeToggle")?.setAttribute("aria-pressed", String(on));
  const dc = $("#darkChip"); if (dc) { dc.setAttribute("aria-pressed", String(on)); dc.classList.toggle("is-on", on); }
}
// a short synthesized stadium air-horn (no audio file needed); opt-in, fires on goals
let _ac = null;
function goalHorn() {
  if (localStorage.getItem("wc26.horn") !== "on") return;
  try {
    _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _ac; if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime, out = ctx.createGain(); out.connect(ctx.destination);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.22, t + 0.04);
    out.gain.setValueAtTime(0.22, t + 0.55);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2200; lp.connect(out);
    [233, 311, 392].forEach((f, i) => {                  // stacked, slightly-detuned horn chord
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f * (1 + (i - 1) * 0.004);
      const g = ctx.createGain(); g.gain.value = [0.5, 0.4, 0.3][i];
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + 0.82);
    });
  } catch { /* audio unavailable */ }
}

/* ---------------- data ---------------- */
async function loadStatic() {
  const [m, t, fr] = await Promise.all([
    fetch("data/matches.json?v=" + BUILD).then(r => r.json()),
    fetch("data/teams.json?v=" + BUILD).then(r => r.json()),   // ?v=BUILD so the browser refetches when team data (pedigree/coach) changes per deploy
    fetch("data/fifa-ranking.json?v=" + BUILD).then(r => r.json()).catch(() => null),   // full 211-team FIFA ranking (static snapshot, frozen during the WC)
  ]);
  S.matches = m.matches; S.teams = t; S.fifaRanking = fr?.teams || null; S.fifaRankDate = fr?.rankingDate || null;
  // squads.json is committed data that changes (squad updates) — bypass cache so it's always current
  try { S.squads = (await (await fetch("data/squads.json?t=" + Date.now(), { cache: "no-store" })).json()).squads || {}; }
  catch { S.squads = {}; }
  // official player photos + bios (DOB/height/weight) harvested from FIFA, keyed "name|CODE"; optional, skipped in data-saver
  if (!LITE()) {
    try { S.photos = await (await fetch("data/photos.json?t=" + Date.now(), { cache: "no-store" })).json() || {}; } catch { S.photos = {}; }
    try { S.bio = await (await fetch("data/playerbio.json?t=" + Date.now(), { cache: "no-store" })).json() || {}; } catch { S.bio = {}; }
  }
  _resolveCache.clear(); _teamPhotoCache.clear(); _teamBioCache.clear(); _nameCache.clear(); _accentCache.clear();   // squads/photos/bios just loaded → drop anything resolved before the data was ready
}
const LITE = () => localStorage.getItem("wc26.lite") === "on";   // data-saver: suppress hot-linked photos, fall back to flags
// Only ever surface an https image URL with no CSS/HTML-breaking characters: these are inserted into
// `url('…')` background-images, where esc() wouldn't even cover the quote/paren — so sanitise at the source.
// FIFA's portrait PNGs are ~900KB each, so a squad list or pitch pulled 10-20MB and stalled. Their image service
// resizes via ?io=transform: request a small width and let the existing CSS (background cover, top-anchored) crop to
// the face. ~900KB -> ~14KB per avatar, no visual change. Only FIFA URLs support it; everything else passes through.
const safePhoto = u => !/^https:\/\/[^\s'"()<>]+$/.test(u || "") ? "" : (/\/\/digitalhub\.fifa\.com\//.test(u) && !u.includes("?") ? u + "?io=transform:fit,width:256" : u);
// list avatars take the tiny 256px default; the big player-popup / compare photo asks for a sharper width (one image, retina-ready).
const atWidth = (u, w) => (u || "").includes("io=transform:fit,width:") ? u.replace(/width:\d+/, "width:" + w) : (u || "");
const normName = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/gi, "").toLowerCase();
const PH_SUFFIX = new Set(["jr", "junior", "jnr", "filho", "neto", "segundo", "ii", "iii"]);
const nameToks = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
const sigToks = s => { const t = nameToks(s).filter(w => !PH_SUFFIX.has(w)); return t.length ? t : nameToks(s); };
const surnameOf = s => { const t = sigToks(s); return t[t.length - 1] || ""; };   // matchPstat joins ESPN box-score keys by surname
// ---------- one source of truth for "who is this feed reference?" ----------
// resolvePlayer maps a feed name (+team, with optional jersey number / position hints) to the actual squad player,
// so the displayed name, the headshot and the bio always describe the SAME person. Signals strongest-first: jersey
// number → exact full name → surname (anchored; also tries the last two tokens so "Alamri" finds "Al Amri")
// narrowed by the given name/initial, then position → a unique first-name match (for players the feed lists by
// first name, e.g. Vinicius). Returns null when it genuinely can't separate two same-surname team-mates, so callers
// fall back to the plain feed name (and no photo) rather than risk showing the wrong person.
const _resolveCache = new Map();
function resolvePlayer(name, code, num, pos) {
  const sq = S.squads?.[code]?.players; if (!sq || (!name && num == null)) return null;
  const ck = (name || "") + "|" + (code || "") + "|" + (num ?? "") + "|" + (pos || "");
  if (_resolveCache.has(ck)) return _resolveCache.get(ck);
  const nrm = w => _deburr(w).replace(/[^a-z]/g, "");
  let hit = null;
  if (num != null) hit = sq.find(p => p.n === num) || null;                       // jersey: exact + strongest
  if (!hit && name) {
    const toks = _splitInitials(name).split(/\s+/).filter(Boolean), L = toks.length, full = toks.map(nrm).join("");   // "E.ASHOUR" -> "E. ASHOUR"
    hit = sq.find(p => p.name.split(/\s+/).map(nrm).join("") === full);           // whole-name match (also fixes accents)
    if (!hit && L) {
      // a name suffix (Jr / Júnior / Filho…) is NOT a surname, and the feed may abbreviate it differently from the
      // squad ("Vinicius Jr" vs "Vinicius Júnior"). Drop suffixes on BOTH sides so a player is keyed by their real
      // distinguishing name — otherwise "Vinicius Jr" keys on "jr" and wrongly resolves to a "Neymar Jr" team-mate.
      const sigA = a => { const f = a.filter(w => !PH_SUFFIX.has(nrm(w))); return f.length ? f : a; };
      const fT = sigA(toks), sur = nrm(fT[fT.length - 1]);
      let cand = sq.filter(p => { const t = sigA(p.name.split(/\s+/)), n = t.length; return nrm(t[n - 1]) === sur || (n > 1 && nrm(t[n - 2] + t[n - 1]) === sur); });
      if (cand.length > 1 && fT.length > 1) { const g = nrm(fT.slice(0, -1).join("")); const byG = cand.filter(p => { const f = nrm(p.name.split(/\s+/)[0]); return f === g || f[0] === g[0]; }); if (byG.length) cand = byG; }
      if (cand.length > 1 && pos) { const byPos = pos === "out" ? cand.filter(p => p.pos !== "GK") : cand.filter(p => p.pos === pos); if (byPos.length) cand = byPos; }   // "out" = outfielder (a scorer is never the same-surname keeper)
      if (cand.length === 1) hit = cand[0];
      else if (!cand.length && L === 1) { const bf = sq.filter(p => nrm(p.name.split(/\s+/)[0]) === nrm(toks[0])); if (bf.length === 1) hit = bf[0]; }
      if (!hit && L > 1) {   // same set of name tokens, any order — handles reversed "SURNAME-First" photo filenames
        const set = toks.map(nrm).filter(Boolean), ts = sq.filter(p => { const pt = p.name.split(/\s+/).map(nrm).filter(Boolean); return pt.length === set.length && set.every(w => pt.includes(w)); });
        if (ts.length === 1) hit = ts[0];
      }
    }
  }
  _resolveCache.set(ck, hit);
  return hit;
}
// Team captains. The FIFA squad source carries NO captain field, so this is a hand-curated, high-confidence set
// (only well-established, stable national-team captains) and each is VERIFIED to exist in that squad before it ships
// — a name that doesn't resolve is simply not flagged. Snapshot, not a live feed; teams not listed show no captain.
const CAPTAINS = {
  AR: "Lionel Messi", PT: "Cristiano Ronaldo", FR: "Kylian Mbappe", "GB-ENG": "Harry Kane", HR: "Luka Modric",
  NL: "Virgil van Dijk", KR: "Heungmin Son", EG: "Mohamed Salah", CH: "Granit Xhaka", NO: "Martin Odegaard",
  BE: "Youri Tielemans", JP: "Kou Itakura", SN: "Kalidou Koulibaly", DE: "Joshua Kimmich", CO: "James Rodriguez",
  EC: "Enner Valencia", AU: "Mathew Ryan", CA: "Alphonso Davies", DZ: "Riyad Mahrez", US: "Tim Ream",
};
function isCaptain(name, code) {
  const c = CAPTAINS[code]; if (!c) return false;
  const cap = resolvePlayer(c, code), p = resolvePlayer(name, code);
  return !!(cap && p && cap.name === p.name);
}
// FIFA photo filenames carry the player's name even when the key is only a surname (".../FOFANA-Yahia_405873"),
// which disambiguates two same-surname team-mates the key alone can't.
const urlName = u => ((u || "").split("?")[0].split("/").pop() || "").replace(/\.\w+$/, "").replace(/_\d+$/, "").replace(/[-_]+/g, " ").trim();
// Match each headshot to a squad player, once per team, so everyone carries the RIGHT face. A surname-only key is
// resolved via its filename; if it still can't be pinned to one player it's assigned to nobody (no photo > wrong photo).
const _teamPhotoCache = new Map();
function teamPhotos(code) {
  if (_teamPhotoCache.has(code)) return _teamPhotoCache.get(code);
  const tmp = new Map(), suf = "|" + code;
  if (S.photos) for (const k in S.photos) {
    if (!k.endsWith(suf)) continue;
    const feed = k.slice(0, -suf.length), url = S.photos[k];
    const p = resolvePlayer(feed, code) || resolvePlayer(urlName(url), code); if (!p) continue;
    const t = Math.max(feed.split(/\s+/).length, urlName(url).split(/\s+/).length), prev = tmp.get(p.name);   // keep the fullest-named key
    if (!prev || t > prev.t) tmp.set(p.name, { u: safePhoto(url), t });
  }
  const m = new Map([...tmp].map(([n, v]) => [n, v.u]));
  _teamPhotoCache.set(code, m); return m;
}
// the headshot for a feed reference: resolve the player, return THEIR photo. Optional jersey/pos sharpen the match.
// If the player can't be pinned down (ambiguous surname) we show no photo rather than risk a team-mate's face.
function bestPhoto(name, code, num, pos) {
  if (LITE() || !S.photos) return "";
  const p = resolvePlayer(name, code, num, pos);
  return p ? (teamPhotos(code).get(p.name) || "") : "";
}
// player vitals (DOB → age, height, weight) from data/playerbio.json, resolved the same way as the headshot
const _teamBioCache = new Map();
function teamBio(code) {
  if (_teamBioCache.has(code)) return _teamBioCache.get(code);
  const m = new Map(), suf = "|" + code;
  if (S.bio) for (const k in S.bio) {
    if (!k.endsWith(suf)) continue;
    const p = resolvePlayer(k.slice(0, -suf.length), code); if (!p || m.has(p.name)) continue;
    m.set(p.name, S.bio[k]);
  }
  _teamBioCache.set(code, m); return m;
}
function playerBio(name, code, num, pos) {
  const p = resolvePlayer(name, code, num, pos);
  if (!p) return null;
  const feed = (S.bio && teamBio(code).get(p.name)) || null;       // FIFA bio feed: DOB + height + weight
  // the official squad list (squads.json, PDF import) carries DOB + height for EVERY player — use it to fill any
  // gap the feed leaves (weight is feed-only). Feed wins where both exist; the squad backfills the rest → 100% age/height.
  const sq = (p.d || p.h) ? { ...(p.d ? { d: p.d } : {}), ...(p.h ? { h: p.h } : {}) } : null;
  if (!feed) return sq;
  if (!sq) return feed;
  return { ...sq, ...feed };
}
const ageFrom = dob => { const t = Date.parse(dob); if (!t) return null; const a = (Date.now() - t) / 31557600000; return a > 13 && a < 60 ? Math.floor(a) : null; };
// manual "refresh scores" controls (footer + hero) — re-fetch the published results.json now
async function manualRefresh(origin) {
  const btns = origin ? [origin] : $$("[data-refresh]");   // a tapped per-card/footer button spins only itself, not every refresh icon
  if (btns.some(b => b.classList.contains("spinning"))) return;
  btns.forEach(b => { b.classList.add("spinning"); b.setAttribute("aria-busy", "true"); b.disabled = true; });
  const t0 = Date.now();
  try { await refreshResults(); }
  finally { setTimeout(() => btns.forEach(b => { b.classList.remove("spinning"); b.removeAttribute("aria-busy"); b.disabled = false; }), Math.max(0, 650 - (Date.now() - t0))); }
}
// heavy per-match detail (timeline/lineups/stats) lives in its own file so it isn't re-downloaded
// every 60s — fetched only when scores change (see refreshResults). Tolerates a missing file.
async function loadDetails() {   // returns true when details.json actually changed (so the caller can re-render)
  try {
    const txt = await (await fetch("data/details.json?t=" + Date.now(), { cache: "no-store" })).text();
    if (txt === S._lastDetails) return false;
    S._lastDetails = txt;
    const d = JSON.parse(txt); S.details = d && d.matches ? d : { matches: {} };
    return true;
  } catch { return false; }   // keep whatever we have on a blip
}
// credited match reports (headline + prose) — small file, refreshed on score change like details.json. Tolerates absence.
async function loadReports() {
  try { const d = await (await fetch("data/reports.json?t=" + Date.now(), { cache: "no-store" })).json(); S.reports = d && d.matches ? d : { matches: {} }; }
  catch { /* keep whatever we have — reports are optional */ }
}
// heavy live commentary lives in one file per match so we only download it when a popup actually wants it
async function loadCommentary(num) {
  if (S.commentary[num] !== undefined) return S.commentary[num];   // cached (incl. null for "none")
  try { S.commentary[num] = await (await fetch(`data/commentary/${num}.json?t=` + Date.now(), { cache: "no-store" })).json(); }
  catch { S.commentary[num] = null; }
  return S.commentary[num];
}
// footer line: separate "when we last checked" (every poll) from "when the scores last changed"
// (results.json's `updated`), so a quiet hour never reads as a stale/broken site.
function setFreshness() {
  const el = $("#updatedLabel"); if (!el) return;
  if (!S.lastChecked) { el.textContent = S.results.updated ? "Up to date" : "Schedule loaded"; return; }
  const fmtT = ms => _dtf("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));   // 24h, matching every kickoff time on screen
  if (S.offline) { el.textContent = `Offline · last update ${fmtT(S.lastChecked)}`; return; }   // say so, rather than show a frozen "just now"
  // lead with how recently we checked, not the data's age — a quiet stretch with no matches isn't staleness
  if (Date.now() - S.lastChecked > 5 * 60000) { el.textContent = `Last checked ${fmtT(S.lastChecked)}`; return; }
  const live = S.matches.some(m => [ST.LIVE, ST.HT].includes(status(m)));
  el.textContent = `${live ? "Live" : "Up to date"} · checked just now`;
}
let _pollFails = 0;
async function refreshResults() {
  try {
    const r = await fetch("data/results.json?t=" + Date.now(), { cache: "no-store" });
    _pollFails = 0;                                       // the fetch resolved → the network is reachable
    if (S.offline) { S.offline = false; setFreshness(); }
    if (!r.ok) return;
    const txt = await r.text();
    S.lastChecked = Date.now();
    const scoresChanged = txt !== S._lastResults;
    const live = S.matches.some(m => [ST.LIVE, ST.HT].includes(status(m)));
    if (!scoresChanged && !live) { setFreshness(); return; }   // quiet and nothing in play → just update the "checked" time
    const firstLoad = S._lastResults == null;
    const prev = S.results.matches || {};
    if (scoresChanged) { S._lastResults = txt; S.results = JSON.parse(txt); }
    // Refresh detail whenever scores changed OR a match is live: the free feed can omit the ticking minute, so
    // results.json may be byte-identical while events/stats advanced. details.json is small + no-store.
    const detailChanged = await loadDetails();
    if (scoresChanged) await loadReports();
    if (scoresChanged || detailChanged) {
      for (const m of S.matches) if ([ST.LIVE, ST.HT].includes(status(m))) delete S.commentary[m.num];   // only live commentary advances — keep finished matches cached
      rebuildMatchData();
      renderTicker();
      // Predict is driven by the user's saved picks, not live results — re-rendering it on a poll would reset their
      // bracket scroll for no benefit. Refresh every other view. (S.view is null pre-first-paint — boot's nav renders.)
      if (S.view && S.view !== "sim") RENDER[S.view]();
      refreshOpenMatch();           // keep an open match popup live — score/minute/timeline/stats, not just commentary
      if (scoresChanged && !firstLoad) celebrateGoals(prev, S.results.matches);
    }
    setFreshness();
  } catch {
    // network unreachable (offline / DNS / CORS-less failure). One blip is normal; flag offline only once it's
    // clearly not transient so the footer can say so instead of silently showing a stale time. self-heals on reconnect.
    if (!navigator.onLine || ++_pollFails >= 2) { S.offline = true; setFreshness(); }
  }
}
// On a poll, re-render an open match popup in place so its score/minute/timeline/stats/win-prob stay current (it was
// written once on open and otherwise freezes). Preserve what the user is doing: expanded sections, scroll, and the
// already-loaded commentary (so it doesn't flash empty before refreshOpenCommentary refills it).
function refreshOpenMatch() {
  const md = $("#matchDialog");
  if (!(md?.open && md.dataset.openMid)) return;
  const y = md.scrollTop;
  openMatch(md.dataset.openMid, true);        // paint() morphs the body: expanded folds (open is never synced) & loaded commentary ([data-keep]) survive on their own
  if (md.scrollTop !== y) md.scrollTop = y;    // belt-and-braces — a morph shouldn't move the scroll, but pin it if a node above changed height
}
// keep an open live-match popup's commentary current — re-fetch its feed each poll (commentary advances on
// fouls/cards too, not just goals, so this runs every tick, independent of whether the score changed)
async function refreshOpenCommentary() {
  const md = document.getElementById("matchDialog");
  if (!md?.open || !md.dataset.openMid) return;
  const om = S.matches.find(x => x.id === md.dataset.openMid);
  const comm = md.querySelector("#mdComm");
  if (!om || !comm?.open || !comm.dataset.loaded || ![ST.LIVE, ST.HT].includes(status(om))) return;
  delete S.commentary[om.num];                      // force a fresh fetch
  const c = await loadCommentary(om.num);
  const body = md.querySelector("#mdCommBody");
  if (body) body.innerHTML = renderCommentary(c);
}
// Scores update live via the poll, but the *app itself* (HTML/CSS/JS) can't be force-reloaded on a static
// site — a page left open keeps running its old build. So detect a new deploy (the live index.html bumps
// app.js?v=<BUILD> each release) and offer a one-tap refresh instead of leaving people on a stale UI.
async function checkVersion() {
  try {
    const html = await (await fetch("index.html?t=" + Date.now(), { cache: "no-store" })).text();
    const m = html.match(/app\.js\?v=([\w.]+)/);
    if (m && m[1] !== BUILD) { const p = $("#updatePill"); if (p) p.hidden = false; }
  } catch { /* offline — try again next tick */ }
}
// Thorough refresh for the update pill: wipe every cache + unregister the worker so the reload is guaranteed to
// come from the network (the latest build) — even on a device stuck behind an old worker. The page re-registers
// a fresh worker on next load, so offline support is restored immediately after.
async function hardRefresh() {
  const p = $("#updatePill"); if (p) p.disabled = true;
  try {
    if (window.caches) await Promise.all((await caches.keys()).map(k => caches.delete(k)));
    if ("serviceWorker" in navigator) await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
  } catch { /* best effort — reload regardless */ }
  location.reload();
}

/* ---------------- boot ---------------- */
async function boot() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // always open at the top
  try {
    await loadStatic();
  } catch (e) {
    $("#main").innerHTML = `<div class="empty" style="margin:32px 16px">Couldn't load the schedule data. If you opened this file directly, run it through a static server (see README): <code>file://</code> can't fetch <code>data/*.json</code>. Otherwise check your connection and reload.</div>`;
    return;
  }
  if (!S.matches.length) {
    $("#main").innerHTML = `<div class="empty" style="margin:32px 16px">No fixtures found in <code>data/matches.json</code>.</div>`;
    return;
  }
  S.filters.team = "";            // default filter shows all teams (favourite is still pinned in the dropdown)
  applyTheme(); syncTzLabels(); buildPickers(); renderTicker();
  $$("[data-nav]").forEach(b => b.onclick = e => { e.preventDefault(); if (b.dataset.nav === "sim") S.simView = "dash"; nav(b.dataset.nav); });
  $("#settingsChip").onclick = () => $("#settingsDialog").showModal();
  $("#tzRow").onclick = () => { $("#settingsDialog").close(); $("#tzDialog").showModal(); };
  // Subscribe to the auto-updating feed. iOS/macOS hand webcal:// straight to Calendar; Android/desktop usually
  // have no webcal handler (it silently does nothing), so there we copy the URL and open Google Calendar's add-by-URL.
  $("#calSubscribe").onclick = () => {
    const webcal = webcalURL("all.ics"), https = webcal.replace(/^webcal:\/\//, "https://");
    if (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)) { location.href = webcal; return; }
    try { navigator.clipboard?.writeText(https); } catch { /* clipboard blocked — the Google tab still opens */ }
    window.open("https://calendar.google.com/calendar/u/0/r?cid=" + encodeURIComponent(https), "_blank", "noopener");
    flashToast("Calendar URL copied. Paste it into your calendar app if it doesn't open");
  };
  $("#calDownload").onclick = () => downloadICS(S.matches.slice().sort((a, b) => a.utc.localeCompare(b.utc)), "FIFA World Cup 2026");
  const _fillBuild = () => { const b = $("#devStoryBuild"); if (b) b.textContent = "build " + BUILD; };
  $("#aboutSiteBtn").onclick = () => { _fillBuild(); showSheet($("#aboutSiteDialog")); };   // single About sheet; tournament format lives in the Tables legend's "How the format works"
  $("#devStoryBtn")?.addEventListener("click", () => { _fillBuild(); const t = $("#aboutTech"); if (t) t.open = true; showSheet($("#aboutSiteDialog")); setTimeout(() => $("#aboutTech")?.scrollIntoView({ block: "start" }), 90); });   // "i" by the build → About, with the technical story expanded (the number itself keeps its egg)
  const _footTz = $("#footTz"); if (_footTz) _footTz.onclick = () => $("#tzDialog").showModal();   // the "in your timezone" promise is now one tap from the footer
  $("#teamChip").onclick = () => $("#teamDialog").showModal();
  // first-launch onboarding — a short, skippable welcome shown once (any dismissal marks it seen)
  if (!localStorage.getItem("wc26.seen")) {
    const w = $("#welcomeDialog");
    if (w) {
      const tzl = $("#welcomeTz"); if (tzl) tzl.textContent = `${tzCity()} · ${tzShort()}`;
      const seen = () => localStorage.setItem("wc26.seen", "1");
      w.addEventListener("close", seen);   // also covers Escape / backdrop dismissal
      $("#welcomePick").onclick = () => { seen(); w.close(); $("#teamDialog").showModal(); };
      $("#welcomeGo").onclick = () => { seen(); w.close(); };
      setTimeout(() => { if (w.isConnected && !w.open) w.showModal(); }, 700);
    }
  }
  $("#searchChip").onclick = openSearch;
  $("#searchInput").oninput = e => { renderSearch(e.target.value); const r = $("#searchRoll"); if (r && !compareSeed && !compareTeamSeed) r.classList.toggle("is-hidden", !!e.target.value); };
  addEventListener("keydown", e => {   // ⌘K / Ctrl-K anywhere, or "/" when not already typing
    if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openSearch(); }
    else if (e.key === "/" && !$("#searchDialog").open && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) { e.preventDefault(); openSearch(); }
  });
  // dark mode + goal horn (live in the Settings sheet; dark mode also has a header chip)
  const _isDark = currentTheme() === "dark";
  $("#themeState").textContent = _isDark ? "On" : "Off";
  $("#themeToggle").setAttribute("aria-pressed", String(_isDark));
  $("#themeToggle").onclick = () => setDark(currentTheme() !== "dark");
  const _dc = $("#darkChip");
  if (_dc) { _dc.setAttribute("aria-pressed", String(_isDark)); _dc.classList.toggle("is-on", _isDark); _dc.onclick = () => setDark(currentTheme() !== "dark"); }
  const hornOn = localStorage.getItem("wc26.horn") === "on";
  $("#hornState").textContent = hornOn ? "On" : "Off";
  $("#hornToggle").setAttribute("aria-pressed", String(hornOn));
  $("#hornToggle").onclick = () => {
    const on = localStorage.getItem("wc26.horn") !== "on";
    localStorage.setItem("wc26.horn", on ? "on" : "off");
    $("#hornToggle").setAttribute("aria-pressed", String(on));
    $("#hornState").textContent = on ? "On" : "Off";
    if (on) goalHorn();   // preview + unlock the audio context (this tap is the user gesture)
  };
  const supported = "Notification" in window;
  const notifyUI = () => {
    const state = !supported ? "N/A" : Notification.permission === "denied" ? "Blocked" : (notifyEnabled() ? "On" : "Off");
    $("#notifyState").textContent = state;
    $("#notifyToggle").setAttribute("aria-pressed", String(state === "On"));
  };
  notifyUI();
  $("#notifyToggle").onclick = async () => {
    if (!supported) { flashToast("Notifications aren't supported on this device"); return; }
    if (localStorage.getItem("wc26.notify") === "on") { localStorage.setItem("wc26.notify", "off"); notifyUI(); return; }
    let perm = Notification.permission;
    if (perm === "default") { try { perm = await Notification.requestPermission(); } catch { /* dismissed */ } }
    if (perm !== "granted") { flashToast(perm === "denied" ? "Notifications are blocked in your browser" : "Allow notifications to enable alerts"); notifyUI(); return; }
    localStorage.setItem("wc26.notify", "on"); notifyUI();
    try { new Notification("World Cup 26", { body: "Match alerts on: goals & kickoffs for your team.", icon: "assets/icon-192.png", tag: "wc26" }); } catch { /* */ }
  };
  const liteUI = () => { const on = LITE(); $("#liteState").textContent = on ? "On" : "Off"; $("#liteToggle").setAttribute("aria-pressed", String(on)); };
  liteUI();
  $("#liteToggle").onclick = async () => {
    const on = !LITE();
    localStorage.setItem("wc26.lite", on ? "on" : "off"); liteUI();
    if (!on && (!S.photos || !Object.keys(S.photos).length)) {   // turning off → fetch the photos + bios we skipped
      try { S.photos = await (await fetch("data/photos.json?t=" + Date.now(), { cache: "no-store" })).json() || {}; } catch { /* keep flags */ }
      try { S.bio = await (await fetch("data/playerbio.json?t=" + Date.now(), { cache: "no-store" })).json() || {}; } catch { /* keep flags */ }
      _teamPhotoCache.clear(); _teamBioCache.clear();   // photos/bios now available → rebuild the maps
    }
    flashToast(on ? "Data saver on: photos hidden" : "Data saver off");
    RENDER[S.view]();   // re-render so photos↔flags swap immediately
  };
  $("#jumpNow").onclick = scrollToNow;
  addEventListener("scroll", () => { if (S.view === "matches") requestAnimationFrame(updateJumpNow); }, { passive: true });
  addEventListener("click", e => { if (!e.target.closest("#teamSelWrap")) closeTeamSel(); });   // close team dropdown on outside click
  addEventListener("click", e => { if (!e.target.closest("#stageSelWrap")) closeStagePop(); });  // …and the stage dropdown
  addEventListener("click", e => { if (!e.target.closest(".rk-filter .tsel")) closeRkPops(); });   // …and both rankings dropdowns
  addEventListener("keydown", e => { if (e.key === "Escape") { closeTeamSel(); closeRkPops(); closeInfoPop(); } });
  addEventListener("scroll", () => closeInfoPop(), { passive: true, capture: true });   // an explainer popover dismisses on scroll
  // Keep an open sheet (search, compare, team picker…) above the on-screen keyboard. The visual viewport shrinks when
  // the keyboard is up, so cap the dialog to that height and top-anchor it; reset to the centered CSS default when it's
  // down. Fixes the keyboard covering the player-search results on phones (works on iOS + Android via visualViewport).
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fitSheet = () => {
      const kbUp = innerHeight - vv.height > 120;
      document.querySelectorAll("dialog.sheet").forEach(d => {
        if (kbUp && d.open) { d.style.maxHeight = (vv.height - 12) + "px"; d.style.marginTop = (vv.offsetTop + 8) + "px"; d.style.marginBottom = "auto"; }
        else { d.style.maxHeight = ""; d.style.marginTop = ""; d.style.marginBottom = ""; }
      });
    };
    vv.addEventListener("resize", fitSheet);
    vv.addEventListener("scroll", fitSheet);
  }
  initMusic();
  $$("[data-close]").forEach(b => b.onclick = () => b.closest("dialog").close());
  $$("dialog").forEach(d => d.onclick = e => { if (e.target === d) { if (d.classList.contains("sheet")) _closeAll(); else d.close(); } });
  $("#searchDialog").addEventListener("close", () => { compareSeed = null; stopSearchRoll(); });   // never leave compare mode armed (or a timer running) after the overlay closes
  // Closing a modal restores focus to whatever opened it (e.g. the tapped match card). On a pointer close the
  // browser paints a :focus-visible ring on that card, which reads as a flicker. Track input modality and drop
  // the ring on pointer closes only — keyboard closes keep focus so keyboard users don't lose their place.
  let _kbdNav = false;
  addEventListener("keydown", () => { _kbdNav = true; }, true);
  addEventListener("pointerdown", () => { _kbdNav = false; }, true);
  ["#matchDialog", "#playerDialog", "#teamSheet"].forEach(sel => $(sel)?.addEventListener("close", () => {
    if (!_kbdNav && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }));
  addEventListener("resize", () => {
    moveInk(); setChromeVars();
    if (S.view === "sim") layoutBracket($("#view-sim"));
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
    setChromeVars();   // fonts can change the bar height → re-measure so sticky offsets stay exact
    if (S.view === "sim") layoutBracket($("#view-sim"));
  });
  document.addEventListener("click", e => {
    // a close button or a backdrop (click landing on the <dialog> itself) is handled by the dialog's own
    // close wiring — never let it fall through to an open-handler, or closing would immediately re-open.
    if (e.target.closest("[data-close]") || e.target.tagName === "DIALOG") return;
    const ii = e.target.closest("[data-info]");   // reusable "i" explainer → shared popover (touch-safe)
    if (ii) { e.stopPropagation(); showInfoPop(ii, ii.dataset.info); return; }
    if (!e.target.closest("#infoPop")) closeInfoPop();   // any other click dismisses an open explainer
    const rf = e.target.closest("[data-refresh]");
    if (rf) { e.stopPropagation(); manualRefresh(rf); return; }
    const star = e.target.closest("[data-save]");
    if (star) { e.stopPropagation(); toggleSave(star.dataset.save); return; }
    const zoom = e.target.closest("[data-zoom]");   // tap a player portrait → full-size lightbox
    if (zoom) { e.stopPropagation(); openLightbox(zoom.dataset.zoom); return; }
    const pl = e.target.closest("[data-player]");
    if (pl) { e.stopPropagation(); const [pn, pc] = pl.dataset.player.split("|"); openPlayer(pn, pc); return; }
    const fol = e.target.closest("[data-follow]");
    if (fol) {   // "Follow this team" from inside the team sheet
      e.stopPropagation(); S.fav = fol.dataset.follow; localStorage.setItem("wc26.fav", S.fav);
      $("#teamSheet").close(); applyTheme($("#teamChip")); buildPickers(); RENDER[S.view](); return;
    }
    const ic = e.target.closest("[data-ics]");
    if (ic) { e.stopPropagation(); const c = ic.dataset.ics; downloadICS(S.matches.filter(m => matchHasTeam(m, c)).sort((a, b) => a.utc.localeCompare(b.utc)), `${S.teams[c].name} · World Cup 2026`); return; }
    const cal = e.target.closest("[data-cal]");   // add a single match to the calendar (.ics download)
    if (cal) { e.stopPropagation(); const m = S.matches.find(x => x.id === cal.dataset.cal); if (m) { const h = slotInfo(m, "home"), a = slotInfo(m, "away"); downloadICS([m], `${h.code ? h.name : slotText(m, "home", h)} v ${a.code ? a.name : slotText(m, "away", a)}`); } return; }
    const shm = e.target.closest("[data-share-match]");   // share a match: prediction card (upcoming/live) or result-card link (finished)
    if (shm) { e.stopPropagation(); const m = S.matches.find(x => x.id === shm.dataset.shareMatch); if (m) shareMatchCard(m); return; }
    const cmt = e.target.closest("[data-compare-team]");   // "Compare" from inside the team sheet → pick a second team
    if (cmt) { e.stopPropagation(); $("#teamSheet").close(); openTeamCompareSearch(cmt.dataset.compareTeam); return; }
    const sq = e.target.closest("[data-squad]");
    if (sq && sq.dataset.squad) { openTeam(sq.dataset.squad); return; }
    const ab = e.target.closest("[data-about]");   // "how the format works" → tournament info sheet
    if (ab) { showSheet($("#aboutDialog")); return; }
    const w22 = e.target.closest("[data-wc22]");   // "Qatar 2022 · full results" → last-World-Cup reference
    if (w22) { openWc2022(); return; }
    const hl = e.target.closest("[data-hero-live]");   // the Matches hero → open the match modal (Live folded into it, build 329)
    if (hl) { openMatch(hl.dataset.heroLive); return; }
    const mid = e.target.closest("[data-mid]");   // hero, match card, or a record row (never a dialog)
    if (mid && mid.tagName !== "DIALOG") { openMatch(mid.dataset.mid); }
  });
  // keyboard: activate focusable custom controls (save stars, squad cells, sim picks, hero) with Enter/Space
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target.closest('[data-save],[data-squad],[data-player],[data-pick],.up,[data-mid],[role="button"]');
    if (t) { e.preventDefault(); t.click(); }
  });
  // a shared prediction link (#p=…) loads that bracket and opens the Predict tab
  let initView = "matches";
  if (location.hash.startsWith("#p=")) {
    if (loadSharedSim(location.hash.slice(3))) { pruneSim(); saveSim(); initView = "sim"; S.simView = "edit"; setTimeout(() => flashToast("Loaded a shared prediction"), 400); }
    history.replaceState(null, "", location.pathname + location.search);
  } else if (HASH_VIEW[location.hash.slice(1)]) {
    initView = HASH_VIEW[location.hash.slice(1)];             // deep-link straight to a tab (#teams, #groups, #predict, #stats)
  }
  setChromeVars();
  // Load live scores + detail BEFORE the first paint, so a refresh never flickers from a no-scores render to the
  // live one — the visitor always opens straight onto current data. Raced with a timeout so a slow/hung network
  // can't block the page; if the data is late it simply re-renders when it lands.
  await Promise.race([refreshResults(), new Promise(r => setTimeout(r, 3500))]);
  nav(initView);
  loadBuzz();   // fan reactions + headlines (data/buzz.json); refreshed on the poll below
  loadWC2022();   // last World Cup (static) — for the team "Since 2022" view
  loadEfi();    // FIFA EFI deep-analysis (data/efi.json), post-match
  addEventListener("hashchange", () => { const v = HASH_VIEW[location.hash.slice(1)]; if (v && v !== S.view) nav(v); });  // a shared #tab link opened in-session / back-forward
  const bl = $("#bootLoading"); if (bl) { bl.classList.add("gone"); setTimeout(() => bl.remove(), 320); }   // first view rendered → reveal
  // a shared match link (?match=<id>, e.g. from a share-card stub) opens that match
  const mq = new URLSearchParams(location.search).get("match");
  if (mq && S.matches.some(m => m.id === mq)) {
    history.replaceState(null, "", location.pathname);
    setTimeout(() => openMatch(mq), 350);
  }
  setInterval(refreshResults, 30 * 1000);   // scores: poll every 30s so the page catches each new commit sooner
  setInterval(() => { refreshOpenCommentary(); loadBuzz(); }, 60 * 1000);   // commentary + buzz change slower — 60s is plenty
  // returning to a backgrounded tab is the classic "stale score" moment (the goal happened while you were away):
  // pull the latest immediately instead of waiting for the next poll. Throttled so quick tab-flicks don't spam.
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("bg-paused", document.hidden);   // park the ambient blobs (animation + GPU promotion) while backgrounded
    if (!document.hidden && Date.now() - (S.lastChecked || 0) > 8000) refreshResults();
  });
  addEventListener("online", () => refreshResults());                // reconnected → pull immediately and clear the offline label
  addEventListener("offline", () => { S.offline = true; setFreshness(); });
  setInterval(loadEfi, 5 * 60 * 1000);   // EFI is post-match — refresh every 5 min is plenty
  checkKickoffAlert();
  setInterval(checkKickoffAlert, 60 * 1000); // fire a kickoff reminder for the favourite team (opt-in)
  $("#updatePill").onclick = hardRefresh;
  setInterval(checkVersion, 120 * 1000);  // nudge open pages to refresh when a new build ships
  // offline support — network-first SW (registered after first render so it never blocks paint).
  // The shell stays network-first so an online visitor always gets the latest build; the version
  // nudge still handles prompting a reload when a new app.js ships.
  // background-scroll lock behind modals — primary is the CSS `:has()` rule; this is a fallback for older webviews
  const _lockObs = new MutationObserver(() => document.documentElement.classList.toggle("modal-open", !!document.querySelector("dialog[open]")));
  $$("dialog").forEach(d => _lockObs.observe(d, { attributes: true, attributeFilter: ["open"] }));
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(reg => {
      const poke = () => reg.update().catch(() => {});           // re-check for a new worker promptly (don't wait on the browser's lazy ~24h schedule)
      addEventListener("focus", poke); setInterval(poke, 120 * 1000);
    }).catch(() => {});
    // a freshly-activated worker (a new deploy just took over) pings open pages → surface the one-tap refresh immediately
    navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "wc26-updated") { const p = $("#updatePill"); if (p) p.hidden = false; } });
  }
}
boot();
})();
