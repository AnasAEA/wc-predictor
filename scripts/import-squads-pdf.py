#!/usr/bin/env python3
"""One-off importer: FIFA official 'SquadLists-English.pdf' -> data/squads.json.

Pulls jersey number, position, name, caps, goals, club for all 48 teams.
Preserves existing coach names; the PDF carries no coach. Run from repo root:
    python3 scripts/import-squads-pdf.py /path/to/SquadLists-English.pdf

Name handling (the whole point): the PDF's "PLAYER NAME" column is the COMMON name but ASCII
("BELAID Zineddine", "GOUIRI Amine"); the accents live in the "FIRST NAME(S)" / "LAST NAME(S)"
columns ("Zineddine", "BELAÏD", "GHOUIRI"). We take the common name and restore accents word by
word from those columns — but only when it's demonstrably the SAME word (deburr match). So
"BELAID" gains its accent -> "Belaïd", while a genuine spelling variant like the formal "GHOUIRI"
does NOT overwrite the common "Gouiri". Best of both: the name people know, correctly accented.
"""
import sys, re, json, warnings, logging, unicodedata
warnings.filterwarnings("ignore"); logging.getLogger("pdfminer").setLevel(logging.ERROR)
import pdfplumber

PDF = sys.argv[1] if len(sys.argv) > 1 else "/Users/lgarg/Downloads/SquadLists-English.pdf"

# FIFA 3-letter -> our ISO2-ish code (matches data/teams.json keys)
FIFA = {
 "ALG":"DZ","ARG":"AR","AUS":"AU","AUT":"AT","BEL":"BE","BIH":"BA","BRA":"BR","CPV":"CV",
 "CAN":"CA","COL":"CO","COD":"CD","CIV":"CI","CRO":"HR","CUW":"CW","CZE":"CZ","ECU":"EC",
 "EGY":"EG","ENG":"GB-ENG","FRA":"FR","GER":"DE","GHA":"GH","HAI":"HT","IRN":"IR","IRQ":"IQ",
 "JPN":"JP","JOR":"JO","KOR":"KR","MEX":"MX","MAR":"MA","NED":"NL","NZL":"NZ","NOR":"NO",
 "PAN":"PA","PAR":"PY","POR":"PT","QAT":"QA","KSA":"SA","SCO":"GB-SCT","SEN":"SN","RSA":"ZA",
 "ESP":"ES","SWE":"SE","SUI":"CH","TUN":"TN","TUR":"TR","URU":"UY","USA":"US","UZB":"UZ",
}
POS_OK = {"GK","DF","MF","FW"}

def deb(s):
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode("ascii").lower()

def title_word(w):
    # Title-case a token, keeping hyphens/apostrophes + accents: AÏT-NOURI -> Aït-Nouri, O'NEIL -> O'Neil.
    # [^\W\d_] = any Unicode letter (not just Latin-1), so Latin-Extended names case correctly too: MODRIĆ -> Modrić.
    return re.sub(r"[^\W\d_]+", lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(), w, flags=re.UNICODE)

def title_str(s):
    return " ".join(title_word(w) for w in (s or "").split())

def accentize(common, accented_source):
    """Restore accents on `common`, word by word, from the accented column — only when it's the same word."""
    amap = {}
    for w in (accented_source or "").split():
        k = deb(w)
        if k and k != w.lower():               # this source word carries an accent worth remembering
            amap.setdefault(k, w)
    return " ".join(amap.get(deb(t), t) for t in (common or "").split())

def build_name(player_name, first_names, last_names):
    """PLAYER NAME is 'SURNAME Given' (surname = leading ALL-CAPS tokens). Accent-restore each half."""
    toks = (player_name or "").split()
    i = 0
    while i < len(toks) and toks[i] == toks[i].upper() and any(c.isalpha() for c in toks[i]):
        i += 1
    sur_common = " ".join(toks[:i]) if i else (toks[0] if toks else "")
    giv_common = " ".join(toks[i:]) if 0 < i < len(toks) else ""
    sur = title_str(accentize(sur_common, last_names))
    giv = title_str(accentize(giv_common, first_names))
    return (giv + " " + sur).strip() if giv else sur

# A few club glyphs drop to a NUL byte in this PDF font (the fi/ffi ligature), exactly as player names do.
# Reconstruct the known cases; for any other stray NUL fall back to the far-most-common "fi" so a control
# byte never reaches the JSON (which otherwise renders as a missing letter / box in club names).
CLUB_FIX = {
    "SL Ben\x00ca": "SL Benfica", "She\x00eld United FC": "Sheffield United FC",
    "AE Ki\x00sia FC": "AE Kifisia FC", "CA Vélez Sars\x00eld": "CA Vélez Sarsfield",
    "FC Cincinnatti": "FC Cincinnati",
}
def clean_club(c):
    c = re.sub(r"\s*\([A-Z]{3}\)\s*$", "", c or "").strip()
    c = CLUB_FIX.get(c, c)
    if "\x00" in c:
        c = c.replace("\x00", "fi")
    return c or None

def to_int(x):
    m = re.search(r"-?\d+", x or "")
    return int(m.group(0)) if m else None

_MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
def parse_dob(s):
    """The PDF's DOB column -> ISO 'YYYY-MM-DD' (same shape as data/playerbio.json's `d`)."""
    s = (s or "").strip()
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)                       # already ISO-ish
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.match(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", s)           # DD.MM.YYYY / DD/MM/YYYY
        if m:
            d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        else:
            m = re.match(r"(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})", s)  # 25 Feb 2000
            if not m:
                return None
            d, mo, y = int(m.group(1)), _MONTHS.get(m.group(2).lower(), 0), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= d <= 31 and 1960 <= y <= 2012):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"

def parse_height(x):
    h = to_int(x)
    return h if h and 140 <= h <= 220 else None                          # plausible cm; ignore stray numbers

try:
    prev = json.load(open("data/squads.json"))["squads"]
except Exception:
    prev = {}
# prior clean ASCII names, keyed by code+jersey — authoritative spelling baseline. Some glyphs (the "fi"
# ligature) drop to a null byte in this PDF's font; when a rebuilt name deburrs differently from the prior
# one, the drop corrupted it, so we re-accent the prior clean spelling instead.
prev_name = {(c, p.get("n")): p.get("name") for c, s in prev.items() for p in s.get("players", [])}

pdf = pdfplumber.open(PDF)
out_squads = {}
suspicious = []
team_names = {}

for pi, page in enumerate(pdf.pages):
    txt = page.extract_text() or ""
    fifa = None; tname = None
    for line in txt.split("\n"):
        mm = re.match(r"^(.+?)\s+\(([A-Z]{3})\)\s*$", line.strip())
        if mm:
            tname, fifa = mm.group(1), mm.group(2); break
    code = FIFA.get(fifa)
    if not code:
        print(f"  !! page {pi+1}: unmapped FIFA code {fifa} ({tname})"); continue
    team_names[code] = tname
    table = page.extract_table()
    players = []
    for row in (table or [])[1:]:
        cells = [c for c in row if c is not None]
        if len(cells) < 11:
            continue
        # layout: 0:#  1:POS  2:PLAYER NAME  3:FIRST  4:LAST  5:SHIRT  6:DOB  7:CLUB  8:HEIGHT  9:CAPS  10:GOALS
        num, pos, pname, first, last = cells[0], cells[1], cells[2], cells[3], cells[4]
        if pos not in POS_OK:
            continue
        name = build_name(pname, first, last)
        n = to_int(num)
        o = prev_name.get((code, n))
        if "\x00" in name or (o and deb(name) != deb(o)):   # glyph drop corrupted it → re-accent the prior clean spelling
            name = title_str(accentize(accentize(o or name.replace("\x00", ""), first), last))
        p = {"pos": pos, "name": name}
        if n is not None: p = {"n": n, **p}
        caps = to_int(cells[9]); goals = to_int(cells[10])
        if caps is not None: p["caps"] = caps
        if goals is not None: p["goals"] = goals
        club = clean_club(cells[7])
        if club: p["club"] = club
        dob = parse_dob(cells[6]); height = parse_height(cells[8])   # official DOB + height (every player) → app bio fallback
        if dob: p["d"] = dob
        if height: p["h"] = height
        players.append(p)
        if "  " in pname or re.search(r"\b[b-df-hj-np-tv-z]\b", deb(name), re.I):
            suspicious.append(f"{code} #{num}: '{pname}' / '{first}' / '{last}' -> '{name}'")
    out_squads[code] = {"players": players}

for code, sq in out_squads.items():
    sq["coach"] = (prev.get(code) or {}).get("coach")

print(f"teams parsed: {len(out_squads)} / 48")
counts = {c: len(s["players"]) for c, s in out_squads.items()}
bad = {c: n for c, n in counts.items() if n < 20 or n > 30}
print("player counts out of [20,30]:", bad or "none")
acc = sum(len(re.findall(r"[À-ÿ]", p["name"])) for s in out_squads.values() for p in s["players"])
print("accented chars in output names:", acc)
print(f"suspicious names: {len(suspicious)}")
for s in suspicious[:30]: print("   ", s)

out = {"updated": None, "note": "Official FIFA squad lists (PDF import); coach preserved from prior data", "squads": out_squads}
json.dump(out, open("data/squads.json.new", "w"), ensure_ascii=False)
print("wrote data/squads.json.new")
