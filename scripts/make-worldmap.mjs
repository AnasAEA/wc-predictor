/* Generate assets/worldmap.svg — a compact equirectangular world basemap for the Teams-tab map view.
 * Source: Natural Earth 1:110m admin-0 countries (public domain) via the natural-earth-vector mirror.
 * Every land ring is projected with the SAME equirectangular math the app uses to place the 48 dots
 * (x = (lon+180)/360 * 1000, y = (90-lat)/180 * 500), so dots land exactly on the right country.
 * Tiny islands are dropped and coords rounded to 0.1 to keep the file lean (~120KB). Re-run:
 *   node scripts/make-worldmap.mjs
 */
import { writeFileSync } from "fs";

const W = 1000, H = 500;
const px = lon => +(((lon + 180) / 360) * W).toFixed(1);
const py = lat => +(((90 - lat) / 180) * H).toFixed(1);
const URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";

const gj = await (await fetch(URL)).json();
const paths = [];
for (const f of gj.features) {
  const g = f.geometry; if (!g) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polys) for (const ring of poly) {
    if (ring.length < 4) continue;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    const pts = ring.map(([lon, lat]) => {
      const x = px(lon), y = py(lat);
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      return x + " " + y;
    });
    if ((maxx - minx) < 1.2 && (maxy - miny) < 1.2) continue;   // drop sub-pixel islands
    paths.push("M" + pts.join("L") + "Z");
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><path d="${paths.join("")}" fill="currentColor"/></svg>`;
writeFileSync("assets/worldmap.svg", svg);
console.log(`wrote assets/worldmap.svg — ${paths.length} rings, ${svg.length} bytes`);
