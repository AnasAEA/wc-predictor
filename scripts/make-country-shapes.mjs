/* Generate assets/country-shapes.json — per-nation silhouette paths for the team-sheet "country shape" mini-map.
 * Source: Natural Earth 1:110m admin-0 countries (public domain). Each country's polygons are projected with the
 * SAME equirectangular math the world map uses, and a padded per-country viewBox is stored so the app can draw
 * just that country, filling its bounding box. England + Scotland both map to the UK shape (110m doesn't split
 * the UK); Cabo Verde + Curaçao are too small for the 110m set, so they're pulled from the finer 50m set.
 *   { "<code>": { d: "<path in 1000x500 space>", vb: "minx miny w h" } }.  Re-run: node scripts/make-country-shapes.mjs
 */
import { writeFileSync } from "fs";

const W = 1000, H = 500;
const px = lon => +(((lon + 180) / 360) * W).toFixed(1);
const py = lat => +(((90 - lat) / 180) * H).toFixed(1);
const ISO3 = {
  MX: "MEX", AR: "ARG", AT: "AUT", AU: "AUS", BA: "BIH", BE: "BEL", BR: "BRA", CA: "CAN", CD: "COD", CH: "CHE",
  CI: "CIV", CO: "COL", CV: "CPV", CW: "CUW", CZ: "CZE", DE: "DEU", DZ: "DZA", EC: "ECU", EG: "EGY", ES: "ESP",
  FR: "FRA", GH: "GHA", HR: "HRV", HT: "HTI", IQ: "IRQ", IR: "IRN", JO: "JOR", JP: "JPN", KR: "KOR", MA: "MAR",
  NL: "NLD", NO: "NOR", NZ: "NZL", PA: "PAN", PT: "PRT", PY: "PRY", QA: "QAT", SA: "SAU", SE: "SWE", SN: "SEN",
  TN: "TUN", TR: "TUR", US: "USA", UY: "URY", UZ: "UZB", ZA: "ZAF", "GB-ENG": "GBR", "GB-SCT": "GBR",
};
const rev = {}; for (const [code, i3] of Object.entries(ISO3)) (rev[i3] ||= []).push(code);

// Build one country's { d, vb } entry. mainlandOnly drops far-flung overseas territories so the homeland fills
// the frame; for tiny archipelago nations (Cabo Verde) we keep every island so the whole country is shown.
function buildEntry(geometry, mainlandOnly) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  const rings = [];
  for (const poly of polys) for (const ring of poly) {
    if (ring.length < 4) continue;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    const pts = ring.map(([lon, lat]) => {
      const x = px(lon), y = py(lat);
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      return x + " " + y;
    });
    rings.push({ seg: "M" + pts.join("L") + "Z", area: (maxx - minx) * (maxy - miny), minx, maxx, miny, maxy });
  }
  if (!rings.length) return null;
  let kept = rings;
  if (mainlandOnly) {
    // keep the largest ring plus anything adjacent to it, and drop far overseas territories
    // (French Guiana, the Canaries, Réunion, Hawaii/Alaska, Svalbard…).
    const main = rings.slice().sort((a, b) => b.area - a.area)[0];
    const mdim = Math.max(main.maxx - main.minx, main.maxy - main.miny);
    const gap = r => Math.hypot(Math.max(0, r.minx - main.maxx, main.minx - r.maxx), Math.max(0, r.miny - main.maxy, main.miny - r.maxy));
    kept = rings.filter(r => gap(r) < 0.2 * mdim);
  }
  const d = kept.map(r => r.seg).join("");
  const minx = Math.min(...kept.map(r => r.minx)), maxx = Math.max(...kept.map(r => r.maxx));
  const miny = Math.min(...kept.map(r => r.miny)), maxy = Math.max(...kept.map(r => r.maxy));
  const pad = Math.max(maxx - minx, maxy - miny) * 0.12 + 0.5;
  const vb = `${+(minx - pad).toFixed(1)} ${+(miny - pad).toFixed(1)} ${+(maxx - minx + 2 * pad).toFixed(1)} ${+(maxy - miny + 2 * pad).toFixed(1)}`;
  return { d, vb };
}

const out = {};
const i3of = p => (p.ISO_A3_EH && p.ISO_A3_EH !== "-99") ? p.ISO_A3_EH : (p.ADM0_A3 && p.ADM0_A3 !== "-99" ? p.ADM0_A3 : p.ISO_A3);
const URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const gj = await (await fetch(URL)).json();
for (const f of gj.features) {
  const codes = rev[i3of(f.properties || {})]; if (!codes) continue;
  const e = buildEntry(f.geometry, true); if (!e) continue;
  for (const code of codes) out[code] = e;
}
// Fallback: the 110m set omits micro-island nations (Cabo Verde, Curaçao). Pull just the stragglers from the
// finer 50m set, keeping the whole archipelago so the country actually shows on its team sheet.
let still = Object.keys(ISO3).filter(c => !out[c]);
if (still.length) {
  const URL50 = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";
  const gj50 = await (await fetch(URL50)).json();
  const want = new Set(still.map(c => ISO3[c]));
  for (const f of gj50.features) {
    const i3 = i3of(f.properties || {}); if (!want.has(i3)) continue;
    const e = buildEntry(f.geometry, false); if (!e) continue;
    for (const code of rev[i3]) if (!out[code]) out[code] = e;
  }
}
const miss = Object.keys(ISO3).filter(c => !out[c]);
writeFileSync("assets/country-shapes.json", JSON.stringify(out));
console.log(`wrote assets/country-shapes.json — ${Object.keys(out).length}/48 shapes, ${JSON.stringify(out).length} bytes; missing: ${miss.join(", ") || "none"}`);
