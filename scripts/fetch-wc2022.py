#!/usr/bin/env python3
"""Build data/wc2022.json — the LAST World Cup (Qatar 2022) as a reference for the "Then & Now" views:
each team's finish + full squad (player names), so the app can show, per 2026 team, who is CONTINUING from
2022 and who is NEW. Matches + goalscorers are layered on by a later pass.

Source: Wikipedia (authoritative, static — 2022 won't change). Squads come from the "2022 FIFA World Cup squads"
article wikitext (the {{nat fs g player|name=[[…]]}} templates); finishes are the well-known final classification.
One-off / re-runnable:  python3 scripts/fetch-wc2022.py
"""
import re, json, urllib.request

UA = "Mozilla/5.0 (compatible; wc26-bot/1.0; +https://github.com/lavyagarg240294/wc26)"
WIKI = "https://en.wikipedia.org/w/api.php?action=parse&page=%s&prop=wikitext&format=json&formatversion=2"

# 2022 team (Wikipedia section name) -> our team code (data/teams.json keys). 6 of these (WLS/PL/DK/RS/CM/CR) did
# not qualify for 2026; they're still recorded so the landscape can show "didn't return".
NAME2CODE = {
    "Ecuador": "EC", "Netherlands": "NL", "Qatar": "QA", "Senegal": "SN", "England": "GB-ENG", "Iran": "IR",
    "United States": "US", "Wales": "GB-WLS", "Argentina": "AR", "Mexico": "MX", "Poland": "PL", "Saudi Arabia": "SA",
    "Australia": "AU", "Denmark": "DK", "France": "FR", "Tunisia": "TN", "Costa Rica": "CR", "Germany": "DE",
    "Japan": "JP", "Spain": "ES", "Belgium": "BE", "Canada": "CA", "Croatia": "HR", "Morocco": "MA", "Brazil": "BR",
    "Cameroon": "CM", "Serbia": "RS", "Switzerland": "CH", "Ghana": "GH", "Portugal": "PT", "South Korea": "KR",
    "Uruguay": "UY",
}
# final classification at Qatar 2022 (tier: 1 champions … 7 group stage) — for the per-team "2022 finish" chip
FINISH = {
    "AR": ("Champions", 1), "FR": ("Runners-up", 2), "HR": ("Third place", 3), "MA": ("Fourth place", 4),
    "NL": ("Quarter-finals", 5), "GB-ENG": ("Quarter-finals", 5), "BR": ("Quarter-finals", 5), "PT": ("Quarter-finals", 5),
    "US": ("Round of 16", 6), "AU": ("Round of 16", 6), "JP": ("Round of 16", 6), "KR": ("Round of 16", 6),
    "CH": ("Round of 16", 6), "SN": ("Round of 16", 6), "PL": ("Round of 16", 6), "ES": ("Round of 16", 6),
    "QA": ("Group stage", 7), "EC": ("Group stage", 7), "GB-WLS": ("Group stage", 7), "IR": ("Group stage", 7),
    "SA": ("Group stage", 7), "MX": ("Group stage", 7), "DK": ("Group stage", 7), "TN": ("Group stage", 7),
    "CR": ("Group stage", 7), "DE": ("Group stage", 7), "BE": ("Group stage", 7), "CA": ("Group stage", 7),
    "CM": ("Group stage", 7), "RS": ("Group stage", 7), "GH": ("Group stage", 7), "UY": ("Group stage", 7),
}

def fetch_wikitext(page):
    req = urllib.request.Request(WIKI % page, headers={"User-Agent": UA})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=40).read()).get("parse", {}).get("wikitext", "") or ""
    except Exception as e:
        print(f"  !! fetch failed for {page}: {e}")
        return ""

def parse_squads():
    wt = fetch_wikitext("2022_FIFA_World_Cup_squads").split("==Statistics==")[0]
    parts = re.split(r"^===\s*(.+?)\s*===\s*$", wt, flags=re.M)
    namerx = re.compile(r"name=\[\[(?:[^|\]]*\|)?([^\]]+)\]\]")
    out = {}
    for i in range(1, len(parts), 2):
        code = NAME2CODE.get(parts[i].strip())
        if not code:
            continue
        names = [m.group(1).strip() for m in namerx.finditer(parts[i + 1])]
        if names:
            out[code] = names
    return out

# 2022 footballbox 3-letter codes -> our team codes
FIFA3 = {
    "NED": "NL", "USA": "US", "ARG": "AR", "KSA": "SA", "MEX": "MX", "POL": "PL", "FRA": "FR", "AUS": "AU",
    "DEN": "DK", "TUN": "TN", "ESP": "ES", "CRC": "CR", "GER": "DE", "JPN": "JP", "BEL": "BE", "CAN": "CA",
    "MAR": "MA", "CRO": "HR", "BRA": "BR", "SRB": "RS", "SUI": "CH", "CMR": "CM", "GHA": "GH", "POR": "PT",
    "KOR": "KR", "URU": "UY", "ECU": "EC", "QAT": "QA", "SEN": "SN", "ENG": "GB-ENG", "IRN": "IR", "WAL": "GB-WLS",
    "SPA": "ES",   # Wikipedia uses both ESP and SPA for Spain across the group pages
}
def _field(ch, name):
    m = re.search(r"\|" + name + r"=(.*?)(?=\n\|\w+=|\n\}\})", ch, re.S)
    return m.group(1) if m else ""
def _scorers(field):   # "*[[Player|Name]] {{goal|10|45+1}}" -> [{n, m:[mins]}]
    out = []
    for line in field.split("\n"):
        nm = re.search(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", line)
        if not nm:
            continue
        mins = [x.strip().replace("'", "") for mg in re.findall(r"\{\{goal\|([^}]+)\}\}", line, re.I)
                for x in mg.split("|") if re.match(r"\d", x.strip())]
        out.append({"n": nm.group(1).strip(), "m": mins})
    return out
def _boxes_from_text(text, stage):
    out = []
    for ch in text.split("{{Football box")[1:]:
        t1 = re.search(r"team1=\{\{[^}]*\|([A-Z]{3})\}\}", ch)
        t2 = re.search(r"team2=\{\{[^}]*\|([A-Z]{3})\}\}", ch)
        sc = re.search(r"score=(?:\{\{[Ss]core ?link\|[^|]*\|)?\s*'?'?(\d+)\s*[–-]\s*(\d+)", ch)
        if not (t1 and t2 and sc):
            continue
        c1, c2 = FIFA3.get(t1.group(1)), FIFA3.get(t2.group(1))
        if not c1 or not c2:
            continue
        mt = {"a": c1, "b": c2, "s": [int(sc.group(1)), int(sc.group(2))],
              "ga": _scorers(_field(ch, "goals1")), "gb": _scorers(_field(ch, "goals2")), "st": stage}
        pen = re.search(r"penaltyscore=\s*(\d+)\s*[–-]\s*(\d+)", ch)
        if pen:
            mt["pen"] = [int(pen.group(1)), int(pen.group(2))]
        out.append(mt)
    return out
def parse_match_page(page, stage):
    return _boxes_from_text(fetch_wikitext(page), stage)

# Knockout boxes are stage-tagged by the level-2 section they sit under (NOT by position): Wikipedia's
# knockout article is occasionally missing a box, and positional indexing then silently mislabels every
# match after the gap. "Match for third place" -> 3P; the Final has no box here (it's a {{main}} link).
KO_SECTION_STAGE = {"Round of 16": "R16", "Quarter-finals": "QF", "Semi-finals": "SF", "Match for third place": "3P"}
def parse_knockout():
    parts = re.split(r"^==(?!=)\s*(.+?)\s*==\s*$", fetch_wikitext("2022_FIFA_World_Cup_knockout_stage"), flags=re.M)
    out = []
    for i in range(1, len(parts), 2):
        stage = KO_SECTION_STAGE.get(parts[i].strip())
        if stage:
            out += _boxes_from_text(parts[i + 1], stage)
    return out
def parse_matches():
    ms = []
    for g in "ABCDEFGH":
        ms += parse_match_page(f"2022_FIFA_World_Cup_Group_{g}", g)   # stage = group letter
    ko = parse_knockout()
    # The knockout article omits the Netherlands-Argentina QF box (the "Battle of Lusail"); it has its own
    # article, so pull it from there to keep the quarter-finals complete (4 of 4).
    if not any({m["a"], m["b"]} == {"NL", "AR"} and m["st"] == "QF" for m in ko):
        na = next((m for m in parse_match_page("Battle_of_Lusail", "QF") if {m["a"], m["b"]} == {"NL", "AR"}), None)
        if na:
            ko.append(na)
    ms += ko
    # the final has its own article (no box in the knockout page); filter to the actual finalists.
    fin = next((m for m in parse_match_page("2022_FIFA_World_Cup_final", "FIN") if {m["a"], m["b"]} == {"AR", "FR"}), None)
    if fin:
        ms.append(fin)
    return ms

def main():
    squads = parse_squads()
    matches = parse_matches()
    teams = {}
    for code, (finish, tier) in FINISH.items():
        teams[code] = {"finish": finish, "tier": tier, "squad": squads.get(code, [])}
    bad = [c for c, t in teams.items() if not (23 <= len(t["squad"]) <= 26)]
    out = {
        "source": "Wikipedia: 2022 FIFA World Cup squads + final classification",
        "host": "Qatar", "year": 2022, "teamCount": 32,
        # code -> 2022 name, so the app can label the 6 teams that didn't return in 2026 (and so aren't in teams.json)
        "names": {code: name for name, code in NAME2CODE.items()},
        "teams": teams, "matches": matches,
    }
    json.dump(out, open("data/wc2022.json", "w"), ensure_ascii=False)
    goals = sum(len(m["ga"]) + len(m["gb"]) for m in matches)
    print(f"wrote data/wc2022.json — {len(teams)} teams ({sum(1 for t in teams.values() if t['squad'])} w/ squads), "
          f"{len(matches)} matches, {goals} scorer entries")
    print("squad-count outliers:", bad or "none (all 23-26)")

main()
