/**
 * Generates a 1200×630 share-card PNG per finished match → assets/og/<num>.png,
 * plus a tiny share/<num>.html stub (OG meta + redirect) so links unfurl with the card.
 * Build-time only (satori + resvg); the site itself stays dependency-free.
 *
 * Run:  npm run share-cards     (or: node scripts/make-share-cards.mjs)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const SITE = "https://lavyagarg240294.github.io/wc26";
const fixtures = JSON.parse(readFileSync("data/matches.json", "utf8")).matches;
const teams = JSON.parse(readFileSync("data/teams.json", "utf8"));
const results = (() => { try { return JSON.parse(readFileSync("data/results.json", "utf8")).matches || {}; } catch { return {}; } })();
const details = (() => { try { return JSON.parse(readFileSync("data/details.json", "utf8")).matches || {}; } catch { return {}; } })();   // ev/xi/stats split out of results.json
const mergedRes = id => ({ ...(details[id] || {}), ...(results[id] || {}) });   // card needs scores (slim) + scorers (detail)
const byId = Object.fromEntries(fixtures.map(f => [f.id, f]));
const font400 = readFileSync("assets/fonts/archivo-400.woff");
const font700 = readFileSync("assets/fonts/archivo-700.woff");
mkdirSync("assets/og", { recursive: true });
mkdirSync("share", { recursive: true });

// tiny hyperscript for satori (no JSX in plain .mjs)
const h = (type, props = {}, ...children) => ({ type, props: { ...props, children: children.flat().filter(c => c !== null && c !== false) } });
const tname = code => teams[code]?.name || code;
const kit = code => teams[code]?.c1 || "#0D1B2A";
const esc = s => String(s ?? "");

function teamBlock(code, align) {
  return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", width: "420px" } },
    h("div", { style: { display: "flex", width: "90px", height: "12px", borderRadius: "6px", background: kit(code), marginBottom: "26px" } }),
    h("div", { style: { display: "flex", fontSize: tname(code).length > 14 ? "44px" : "56px", fontWeight: 800, color: "#0D1B2A", textAlign: "center", lineHeight: 1.05 } }, tname(code)));
}

function card(f, r) {
  const hc = f.home.team || r.ht, ac = f.away.team || r.at;   // knockouts: fixture slots are placeholders → use the resolved teams from the result
  const stage = f.group ? `Group ${f.group}` : (f.round || "Knockout");
  const score = (r.h != null) ? `${r.h} – ${r.a}` : "vs";
  const pens = r.hp != null ? `${r.hp}–${r.ap} pens` : "";
  const scorers = (r.ev || []).filter(e => ["G", "P", "OG"].includes(e.k)).map(e => `${esc(e.p)} ${esc(e.t)}`).slice(0, 6).join("   ·   ");
  return h("div", { style: { display: "flex", flexDirection: "column", width: "1200px", height: "630px", background: "#FAFBF9", padding: "64px 72px", fontFamily: "Archivo" } },
    // top bar
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      h("div", { style: { display: "flex", fontSize: "26px", fontWeight: 800, letterSpacing: "2px", color: "#0BA360" } }, "FIFA WORLD CUP 2026"),
      h("div", { style: { display: "flex", fontSize: "24px", fontWeight: 700, color: "#5B6B7A" } }, stage)),
    // teams + score
    h("div", { style: { display: "flex", flex: 1, alignItems: "center", justifyContent: "space-between" } },
      teamBlock(hc, "left"),
      h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center" } },
        h("div", { style: { display: "flex", fontSize: "104px", fontWeight: 800, color: "#0D1B2A" } }, score),
        h("div", { style: { display: "flex", fontSize: "22px", fontWeight: 700, letterSpacing: "2px", color: r.st === "FT" ? "#5B6B7A" : "#FF3B30", marginTop: "10px" } }, r.st === "FT" ? (pens || "FULL TIME") : "LIVE")),
      teamBlock(ac, "right")),
    // bottom
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "2px solid #E4E9E3", paddingTop: "26px" } },
      h("div", { style: { display: "flex", fontSize: "22px", color: "#5B6B7A", maxWidth: "820px", overflow: "hidden" } }, scorers || " "),
      h("div", { style: { display: "flex", fontSize: "22px", fontWeight: 800, color: "#0D1B2A" } }, "WC·26")));
}

function stub(f, r, num) {
  const hc = f.home.team || r.ht, ac = f.away.team || r.at, title = `${tname(hc)} v ${tname(ac)} — WC 2026`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="FIFA World Cup 2026 · ${f.group ? "Group " + f.group : esc(f.round || "")} — live scores, lineups & stats on WC·26.">
<meta property="og:image" content="${SITE}/assets/og/${num}.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta property="og:url" content="${SITE}/share/${num}.html">
<meta http-equiv="refresh" content="0; url=${SITE}/?match=${f.id}">
<link rel="canonical" href="${SITE}/?match=${f.id}">
</head><body><script>location.replace(${JSON.stringify(SITE + "/?match=" + f.id)})</script>
<a href="${SITE}/?match=${f.id}">${esc(title)}</a></body></html>`;
}

const finished = fixtures.filter(f => { const r = results[f.id]; return r && r.st === "FT" && r.h != null; });
const force = process.argv.includes("--force");
let made = 0;
for (const f of finished) {
  const r = mergedRes(f.id);   // scores from results.json + scorers (ev) from details.json
  if (!force && existsSync(`assets/og/${f.num}.png`)) continue;   // card already rendered (delete + --force to redo)
  try {
    const svg = await satori(card(f, r), { width: 1200, height: 630, fonts: [
      { name: "Archivo", data: font400, weight: 400, style: "normal" },
      { name: "Archivo", data: font700, weight: 700, style: "normal" },
      { name: "Archivo", data: font700, weight: 800, style: "normal" },
    ] });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
    writeFileSync(`assets/og/${f.num}.png`, png);
    writeFileSync(`share/${f.num}.html`, stub(f, r, f.num));
    made++;
  } catch (e) { console.warn(`card ${f.num} failed:`, e.message); }
}
console.log(`share cards: ${made}/${finished.length} finished matches rendered`);
