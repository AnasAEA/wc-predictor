#!/usr/bin/env python3
"""Parse FIFA's Enhanced Football Intelligence "Post-Match Summary Report" PDFs into data/efi.json.

FIFA publishes a public (no-login) PDF per match on the FIFA Training Centre Match Report Hub. It carries
advanced data we can't get anywhere else for free: official xG, in-contest possession, phases of play, line
breaks, ball progressions, defensive pressures, and per-player physical/distance. This is POST-MATCH only.

Runs in GitHub Actions (Python 3, pdfplumber — already a dep via the squads importer). The browser only ever
reads the baked data/efi.json, so nothing here touches a visitor's page. Distance numbers on the physical pages
use a custom private-use font (U+E071..E07A = 0..9, U+E094 = '.') which we decode and sanity-check (per-player
total must sum to the published team total, else we drop the distances rather than show garbage).

  python3 scripts/fetch-efi.py            # scrape the hub, parse every played match, write data/efi.json
  python3 scripts/fetch-efi.py --file X   # parse one local PDF and print the result (no write) — for testing
"""
import re, json, sys, os, unicodedata, urllib.request, subprocess, warnings, logging
warnings.filterwarnings("ignore"); logging.getLogger("pdfminer").setLevel(logging.ERROR)
import pdfplumber

HUB = "https://www.fifatrainingcentre.com/en/fifa-world-cup-2026/match-report-hub.php"
BASE = "https://www.fifatrainingcentre.com"
UA = "Mozilla/5.0 (compatible; wc26-bot/1.0; +https://github.com/lavyagarg240294/wc26)"

teams = json.load(open("data/teams.json"))
fixtures = json.load(open("data/matches.json"))["matches"]

def deb(s):
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower().strip()
# team display name -> our code (e.g. "Brazil" -> "BR"), with the aliases FIFA's reports use
ALIAS = {"korea republic": "KR", "south korea": "KR", "ir iran": "IR", "iran": "IR", "usa": "US",
         "united states": "US", "england": "GB-ENG", "scotland": "GB-SCT", "turkiye": "TR", "türkiye": "TR",
         "czechia": "CZ", "cote d'ivoire": "CI", "ivory coast": "CI", "cabo verde": "CV", "cape verde": "CV",
         "bosnia and herzegovina": "BA", "curacao": "CW", "dr congo": "CD"}
NAME2CODE = {deb(t["name"]): c for c, t in teams.items()}
NAME2CODE.update(ALIAS)
def code_of(name):
    d = deb(name)
    return NAME2CODE.get(d) or next((c for n, c in NAME2CODE.items() if n and (n in d or d in n)), None)

def match_num(hc, ac):
    for f in fixtures:
        h, a = (f.get("home") or {}).get("team"), (f.get("away") or {}).get("team")
        if {h, a} == {hc, ac} and h and a:
            return f["num"]
    return None

# decode the custom private-use digit font used on the physical/distance pages
def dec(s):
    return "".join(str(ord(c) - 0xE071) if 0xE071 <= ord(c) <= 0xE07A else ("." if ord(c) == 0xE094 else c) for c in s)

def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=40).read()

# scrape the hub for the per-match PDF links, keyed by the report's match number (M01..M104)
def hub_links():
    html = fetch(HUB).decode("utf-8", "ignore")
    out = {}
    for href in re.findall(r'href="([^"]*PMSR[^"]*\.pdf)"', html, re.I):
        m = re.search(r'PMSR[ -]M0*(\d+)', href, re.I)
        if m:
            url = href if href.startswith("http") else BASE + href
            out[int(m.group(1))] = url.replace(" ", "%20")
    return out

def parse_pdf(path):
    pdf = pdfplumber.open(path)
    pg = lambda i: (pdf.pages[i].extract_text() or "") if i < len(pdf.pages) else ""
    p1, p3, p4 = pg(0), pg(2), pg(3)
    hdr = re.search(r"^(.+?)\s+\d+\s*-\s*\d+\s+(.+?)\s*$", re.sub(r"\s+", " ", p1.split("|")[0] if "|" in p1 else p1.split("\n")[0]))
    if not hdr:
        return None
    home, away = hdr.group(1).strip(), hdr.group(2).strip()
    hc, ac = code_of(home), code_of(away)
    num = match_num(hc, ac) if hc and ac else None
    def pair(rx, t=p3, f=float):
        m = re.search(rx, t); return [f(m.group(1)), f(m.group(2))] if m else None
    poss = re.search(r"Total\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s+Total", p3)
    d = {
        "home": hc, "away": ac, "homeName": home, "awayName": away,
        "xg": pair(r"([\d.]+)\s+xG \(Expected Goals\)\s+([\d.]+)"),
        "poss": [float(poss.group(1)), float(poss.group(3))] if poss else None,
        "possContest": float(poss.group(2)) if poss else None,
        "shots": (lambda m: [int(m.group(i)) for i in (1, 2, 3, 4)] if m else None)(re.search(r"(\d+) \((\d+)\) Attempts at Goal \(On Target\) (\d+) \((\d+)\)", p3)),
        "lineBreaks": pair(r"(\d+)\s+Completed Line Breaks\s+(\d+)", f=int),
        "ballProg": pair(r"(\d+)\s+Ball Progressions\s+(\d+)", f=int),
        "pressures": pair(r"(\d+) \(\d+\) Defensive Pressures Applied \(Direct Pressures\) (\d+)", f=int),
        "distance": pair(r"([\d.]+) km Total Distance Covered\s+([\d.]+) km"),
    }
    # phases of play (page 4): "<home>% <label> <away>%"
    pin, pout = {}, {}
    section = pin
    for line in p4.split("\n"):
        if re.search(r"OUT OF POSSESSION", line, re.I): section = pout
        m = re.match(r"\s*(\d+)% ([A-Za-z][A-Za-z /-]+?) (\d+)%\s*$", line)
        if m: section[m.group(2).strip()] = [int(m.group(1)), int(m.group(3))]
    d["phasesIn"], d["phasesOut"] = pin, pout
    # per-player distance (custom-font decoded, in metres). FIFA's PMSR page count VARIES per match, so rather
    # than hardcoding page indices we SCAN every page for the per-player table and assign, to each side, the page
    # whose decoded rows sum to that team's published Total Distance Covered (within 1 km). This both locates the
    # right pages and sanity-checks the font decode in one step — a page summing to garbage is never accepted.
    row_rx = re.compile(r"\s*(\d+)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.\- ]+?)\s+(\d{4,5}\.\d)\b")
    def rows_on(i):
        out = []
        for line in dec(pg(i)).split("\n"):
            m = row_rx.match(line)
            if m:
                out.append({"n": int(m.group(1)), "name": m.group(2).strip().title(), "km": round(float(m.group(3)) / 1000, 2)})
        return out
    players = {"home": [], "away": []}
    if d["distance"]:
        cands = []                                    # (page_index, rows, sum_km) for any page that looks like a distance table
        for i in range(len(pdf.pages)):
            r = rows_on(i)
            if len(r) >= 7:                           # a real per-player table has ~11-18 outfield+sub rows
                cands.append((i, r, sum(x["km"] for x in r)))
        used = set()
        for i, side in ((0, "home"), (1, "away")):
            target = d["distance"][i]
            best, best_diff = None, 1.0               # accept only a page summing within 1 km of the team total
            for (pi, r, tot) in cands:
                if pi in used:
                    continue
                if abs(tot - target) < best_diff:
                    best_diff, best = abs(tot - target), (pi, r)
            if best:
                players[side] = best[1]
                used.add(best[0])
    d["players"] = players
    return num, d

def main():
    if "--file" in sys.argv:
        r = parse_pdf(sys.argv[sys.argv.index("--file") + 1])
        print(json.dumps({"num": r[0], **r[1]} if r else None, indent=2, ensure_ascii=False)[:2400]); return
    out = json.load(open("data/efi.json"))["matches"] if os.path.exists("data/efi.json") else {}
    links = hub_links()
    print(f"hub: {len(links)} report links")
    for n, url in sorted(links.items()):
        try:
            open("/tmp/_efi.pdf", "wb").write(fetch(url))
            r = parse_pdf("/tmp/_efi.pdf")
            if r and r[0]:
                out[str(r[0])] = r[1]
                print(f"  M{n:03} -> match {r[0]}: {r[1]['homeName']} v {r[1]['awayName']} (xg={r[1]['xg']}, players={len(r[1]['players']['home'])+len(r[1]['players']['away'])})")
        except Exception as e:
            print(f"  M{n:03} skipped: {e}")
    json.dump({"updated": None, "matches": out}, open("data/efi.json", "w"), ensure_ascii=False)
    print(f"wrote data/efi.json ({len(out)} matches)")

main()
