#!/usr/bin/env python3
"""Add lat / lon / pop / popYr to each of the 48 teams in data/teams.json — for the Teams-tab world map and the
"population" line in the team sheet.

- Coordinates: a vetted static table of country centroids (a dot inside the country is all the map needs).
- Population:  World Bank indicator SP.POP.TOTL, most-recent value (authoritative, keyless). England and Scotland
  aren't ISO countries (World Bank only has the UK), so they use the ONS mid-2023 estimates.

teams.json is rewritten in its existing compact format (json.dumps indent=0). Re-run:  python3 scripts/make-teams-geopop.py
"""
import json, urllib.request

CEN = {  # country centroid (lat, lon)
    "MX": (23.6, -102.5), "AR": (-38.4, -63.6), "AT": (47.5, 14.6), "AU": (-25.3, 133.8), "BA": (43.9, 17.7),
    "BE": (50.5, 4.5), "BR": (-14.2, -51.9), "CA": (56.1, -106.3), "CD": (-4.0, 21.8), "CH": (46.8, 8.2),
    "CI": (7.5, -5.5), "CO": (4.6, -74.3), "CV": (16.0, -24.0), "CW": (12.2, -69.0), "CZ": (49.8, 15.5),
    "DE": (51.2, 10.4), "DZ": (28.0, 1.7), "EC": (-1.8, -78.2), "EG": (26.8, 30.8), "ES": (40.5, -3.7),
    "FR": (46.6, 2.2), "GB-ENG": (52.5, -1.5), "GB-SCT": (56.8, -4.2), "GH": (7.9, -1.0), "HR": (45.1, 15.2),
    "HT": (19.0, -72.3), "IQ": (33.2, 43.7), "IR": (32.4, 53.7), "JO": (31.0, 36.2), "JP": (36.2, 138.3),
    "KR": (36.5, 127.8), "MA": (31.8, -7.1), "NL": (52.1, 5.3), "NO": (60.5, 8.5), "NZ": (-41.5, 172.8),
    "PA": (8.5, -80.8), "PT": (39.4, -8.2), "PY": (-23.4, -58.4), "QA": (25.3, 51.2), "SA": (23.9, 45.1),
    "SE": (62.0, 16.5), "SN": (14.5, -14.5), "TN": (33.9, 9.6), "TR": (39.0, 35.2), "US": (39.8, -98.6),
    "UY": (-32.5, -55.8), "UZ": (41.4, 64.6), "ZA": (-30.6, 22.9),
}
ISO3 = {
    "MX": "MEX", "AR": "ARG", "AT": "AUT", "AU": "AUS", "BA": "BIH", "BE": "BEL", "BR": "BRA", "CA": "CAN",
    "CD": "COD", "CH": "CHE", "CI": "CIV", "CO": "COL", "CV": "CPV", "CW": "CUW", "CZ": "CZE", "DE": "DEU",
    "DZ": "DZA", "EC": "ECU", "EG": "EGY", "ES": "ESP", "FR": "FRA", "GH": "GHA", "HR": "HRV", "HT": "HTI",
    "IQ": "IRQ", "IR": "IRN", "JO": "JOR", "JP": "JPN", "KR": "KOR", "MA": "MAR", "NL": "NLD", "NO": "NOR",
    "NZ": "NZL", "PA": "PAN", "PT": "PRT", "PY": "PRY", "QA": "QAT", "SA": "SAU", "SE": "SWE", "SN": "SEN",
    "TN": "TUN", "TR": "TUR", "US": "USA", "UY": "URY", "UZ": "UZB", "ZA": "ZAF",
}
MANUAL_POP = {"GB-ENG": (57106398, 2023), "GB-SCT": (5490100, 2023)}   # ONS mid-2023 (no ISO country code)

teams = json.loads(open("data/teams.json").read())
codes = ";".join(ISO3.values())
url = f"https://api.worldbank.org/v2/country/{codes}/indicator/SP.POP.TOTL?format=json&mrv=1&per_page=300"
wb = json.loads(urllib.request.urlopen(url, timeout=40).read())
pop = {r["countryiso3code"]: r["value"] for r in (wb[1] or []) if r["value"] is not None}
yr = {r["countryiso3code"]: int(r["date"]) for r in (wb[1] or []) if r["value"] is not None}

missing = []
for code, t in teams.items():
    cen = CEN.get(code)
    p, y = MANUAL_POP.get(code, (pop.get(ISO3.get(code)), yr.get(ISO3.get(code))))
    if not cen or p is None:
        missing.append(code); continue
    t["lat"], t["lon"], t["pop"], t["popYr"] = cen[0], cen[1], p, y
if missing:
    raise SystemExit(f"MISSING geo/pop for: {missing}")

open("data/teams.json", "w").write(json.dumps(teams, ensure_ascii=False, indent=0, separators=(",", ":")) + "\n")
print(f"updated data/teams.json — geo+pop for {len(teams)} teams (pop years: {sorted(set(t['popYr'] for t in teams.values()))})")
