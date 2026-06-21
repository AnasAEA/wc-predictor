/**
 * Writes data/buzz.json for the WC·26 "Pulse" tab: fan reactions (Reddit match threads) + press headlines (RSS).
 * Runs in GitHub Actions, Node 20+, no deps. The browser NEVER calls these APIs — it only reads the baked JSON,
 * so no keys are exposed and there's nothing to track.
 *
 * Fan reactions come from three sources, merged per match (round-robined so each is represented):
 *   - Reddit r/soccer match threads. Unauthenticated reddit.com/*.json by default; Reddit increasingly returns
 *     403 to datacenter IPs (incl. GitHub Actions). Set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET (a free Reddit
 *     "script" app, no user login) to use the reliable OAuth path instead.
 *   - Bluesky, via the public AppView searchPosts (no auth, no key) — queried per match by team-pair.
 *   - Mastodon, via mastodon.social's public hashtag timelines (no auth, no key) — mapped to matches by team-pair.
 * Bluesky/Mastodon need no credentials at all, so the tab keeps showing reactions even when Reddit is unset/blocked.
 *
 * Headlines: WC-specific RSS (Guardian + BBC) + ESPN soccer, filtered to World-Cup / participating-team content.
 *
 * Moderation: top-scored comments only, length-bounded, markdown/links stripped, a profanity denylist, and NO
 * usernames (avoid PII / harassment). Every reaction and headline links out to its source.
 *
 * Output: { updated, matches: { "<matchId>": { heat:0-100, reactions:[{text,score,src,url}] } }, headlines:[…] }
 * Run:    node scripts/fetch-buzz.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const fixtures = JSON.parse(readFileSync("data/matches.json", "utf8")).matches;
const byId = Object.fromEntries(fixtures.map(f => [f.id, f]));
const teams = JSON.parse(readFileSync("data/teams.json", "utf8"));
const UA = "Mozilla/5.0 (compatible; wc26-bot/1.0; +https://github.com/lavyagarg240294/wc26)";
const now = Date.now();

// team code → lowercased names for spotting a team in a thread title / headline (+ aliases the feeds actually use)
const ALIAS = {
  US: ["usa", "united states"], KR: ["south korea", "korea republic", "korea"], "GB-ENG": ["england"],
  "GB-SCT": ["scotland"], NL: ["netherlands", "holland"], CD: ["dr congo", "congo"], CI: ["ivory coast", "côte d'ivoire"],
  CV: ["cape verde", "cabo verde"], BA: ["bosnia", "bosnia and herzegovina"], CW: ["curaçao", "curacao"], IR: ["iran"], ZA: ["south africa"],
};
const nameOf = {};
for (const [code, t] of Object.entries(teams)) nameOf[code] = [t.name.toLowerCase(), ...(ALIAS[code] || [])];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function codesIn(text) {
  const s = String(text || "");
  return Object.keys(teams).filter(c => nameOf[c].some(n => new RegExp("\\b" + esc(n) + "\\b", "i").test(s)));
}
// marquee players whose surname in a headline almost certainly means World Cup football, so a player-centric title
// ("Mbappe breaks scoring record") still gets through even without a team or "World Cup" in it. Curated to be
// distinctive — deliberately leaving out the ambiguous ones (Salah reads as a name on Al Jazeera, Yamal is a
// Russian peninsula, Gavi is a health body, Kane/Rice/Son are everyday words). Matched accent-insensitively.
const _deb = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STAR_RE = /\b(mbappe|messi|ronaldo|haaland|neymar|bellingham|vinicius|lewandowski|modric|griezmann|musiala|wirtz|kimmich|neuer|tchouameni|saliba|rodrygo|endrick|raphinha|osimhen|kvaratskhelia|gakpo|depay|pulisic|havertz|maignan|dembele|vlahovic|koulibaly|barcola|foden)\b/;
// a country name alone (Iran, US, Korea…) isn't football — pair it with a football signal so general desks (Al
// Jazeera all-news, ESPN, DW) don't leak geopolitics that merely names a country whose name is also a team's.
const FOOTBALL_RE = /\b(footbal|soccer|fifa|world ?cup|wc[\s-]?2026|match(es)?|goals?|scored?|coach|managers?|squads?|line-?ups?|qualif|group ?stage|strikers?|midfield|defenders?|goalkeep|keeper|friendl(y|ies)|fixtures?|kick-?off|penalt|knockout|tournament|equali[sz]|hat-?trick|substitut|stadium|referee|red card|yellow card|caps?|capped|national team|trophy|champions?|finals?|semi-?finals?|quarter-?finals?|round of (16|32)|injur|transfer|forwards?|wingers?|dribbl|free.?kick)\b|\b\d{1,2}\s?[-–]\s?\d{1,2}\b/i;

// drop a comment that trips the profanity / slur denylist (kept small + word-bounded to avoid false positives)
const BLOCK = /\b(f+u+c+k\w*|shit\w*|bitch\w*|cunt\w*|asshole|a-?hole|nigg\w*|fagg?\w*|retard\w*|whore|slut|dick(?:head)?|wank\w*)\b/i;
const clean = s => String(s || "")
  .replace(/<!\[CDATA\[|\]\]>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#0?39;|&rsquo;|&apos;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&nbsp;/g, " ")
  .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // markdown links → their text
  .replace(/<[^>]+>/g, "")                     // any stray tags
  .replace(/[*_~`>#]/g, "")                    // markdown emphasis / quote / heading marks
  .replace(/https?:\/\/\S+/g, "")              // raw URLs
  .replace(/\bRT\s+@[^\s:]+:?/gi, "")          // boosted-post prefix
  .replace(/@[A-Za-z0-9][\w.-]*/g, "")         // @handles — never show a username in a reaction
  .replace(/:[a-z][a-z0-9_]+:/gi, "")          // Mastodon custom-emoji shortcodes (:wc26:)
  .replace(/\s+/g, " ").trim();
// a comment is shown only if it's substantial, civil and self-contained
function okComment(text, score) {
  if (!text || score < 25) return false;
  if (text.length < 25 || text.length > 280) return false;
  if (BLOCK.test(text)) return false;
  if (/^(http|www\.|\/?r\/|\/?u\/|edit:|deleted|removed|\[)/i.test(text)) return false;
  if ((text.match(/[A-Z]/g) || []).length > text.length * 0.5) return false;   // SHOUTY / mostly-caps
  return true;
}
// social posts (Bluesky/Mastodon) engage at a lower scale than Reddit upvotes, so a gentler bar
function okSocial(text, score, minScore = 4) {
  if (!text || score < minScore) return false;
  if (text.length < 15 || text.length > 280) return false;
  if (BLOCK.test(text)) return false;
  if ((text.match(/[A-Z]/g) || []).length > text.length * 0.5) return false;
  return true;
}

/* ---------------- Reddit (fan reactions) ---------------- */
async function redditToken() {
  const id = process.env.REDDIT_CLIENT_ID, sec = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !sec) return null;
  try {
    const r = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(id + ":" + sec).toString("base64"), "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    return r.ok ? ((await r.json()).access_token || null) : null;
  } catch { return null; }
}
async function rget(path, token) {
  const base = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const r = await fetch(base + path, { headers: { "User-Agent": UA, Accept: "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
  if (!r.ok) throw new Error("reddit HTTP " + r.status);
  return r.json();
}
async function fetchReactions() {
  const token = await redditToken();
  console.log(token ? "reddit: OAuth" : "reddit: unauthenticated (may be rate-limited / 403 from datacenter IPs)");
  const search = await rget("/r/soccer/search.json?q=" + encodeURIComponent('"Match Thread"') + "&restrict_sr=1&sort=new&limit=100&t=week", token);
  const posts = (search.data?.children || []).map(c => c.data).filter(p => /match thread/i.test(p.link_flair_text || p.title));
  const out = {};
  let calls = 0;
  for (const m of fixtures) {
    const hc = m.home?.team, ac = m.away?.team;
    if (!hc || !ac || out[m.id]) continue;
    const ko = +new Date(m.utc);
    if (ko > now + 3 * 3600e3 || ko < now - 4 * 86400e3) continue;   // only matches around now (last 4 days … next 3h)
    const cand = posts
      .filter(p => { const c = codesIn(p.title); return c.includes(hc) && c.includes(ac) && Math.abs(p.created_utc * 1000 - ko) < 36 * 3600e3; })
      .sort((a, b) => (/post/i.test(b.link_flair_text || b.title) ? 1 : 0) - (/post/i.test(a.link_flair_text || a.title) ? 1 : 0) || b.num_comments - a.num_comments);
    const post = cand[0];
    if (!post || calls >= 12) continue;   // cap thread fetches per run (unauth rate limits)
    calls++;
    let thread;
    try { thread = await rget(`/r/soccer/comments/${post.id}.json?sort=top&limit=40`, token); } catch { continue; }
    const reactions = (thread[1]?.data?.children || []).map(c => c.data).filter(c => c && c.body)
      .map(c => ({ text: clean(c.body), score: c.score || 0 }))
      .filter(c => okComment(c.text, c.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(c => ({ text: c.text, score: c.score, src: "r/soccer", url: "https://www.reddit.com" + post.permalink }));
    if (reactions.length) out[m.id] = { heatHint: post.num_comments, reactions };   // heat is computed uniformly in mergeSources
  }
  return out;
}

/* ---------------- Bluesky (fan reactions) ---------------- */
// Bluesky's keyword search (searchPosts) requires a session — the public AppView 403s it unauthenticated, even
// though profile/feed reads are open. A free app password (Settings → App Passwords, no approval) is enough; we
// trade it for a short-lived token. No creds → search is skipped and the tab runs on the other sources.
async function bskyToken() {
  const id = process.env.BLUESKY_IDENTIFIER, pw = process.env.BLUESKY_APP_PASSWORD;
  if (!id || !pw) return null;
  try {
    const r = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ identifier: id, password: pw }),
    });
    return r.ok ? ((await r.json()).accessJwt || null) : null;
  } catch { return null; }
}
// query each recent match by its team pair, keep only posts that name BOTH teams in the kickoff window so a
// post can't be misattributed (one team name is ambiguous across a side's several matches).
async function fetchBluesky(recent, token) {
  if (!token) { console.log("bluesky: no app password (set BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD) — skipping search"); return {}; }
  const out = {};
  let calls = 0;
  for (const m of recent) {
    if (calls >= 14) break;
    const hc = m.home.team, ac = m.away.team, ko = +new Date(m.utc);
    const q = `${teams[hc].name} ${teams[ac].name}`;
    let posts;
    try {
      const r = await fetch(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=top&lang=en&limit=25`, { headers: { "User-Agent": UA, Accept: "application/json", Authorization: "Bearer " + token } });
      calls++;
      if (!r.ok) { if (calls === 1) console.log("bluesky HTTP " + r.status); continue; }
      posts = (await r.json()).posts || [];
    } catch (e) { console.log("bluesky skipped:", e.message); continue; }
    const reactions = posts.map(p => {
      const text = clean(p.record?.text || "");
      const rkey = (p.uri || "").split("/").pop(), handle = p.author?.handle;
      return {
        text, codes: codesIn(text),
        score: (p.likeCount || 0) + (p.repostCount || 0) * 2,
        created: +new Date(p.record?.createdAt || p.indexedAt || 0),
        url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null,
      };
    })
      .filter(p => p.url && p.codes.includes(hc) && p.codes.includes(ac) && Math.abs(p.created - ko) < 36 * 3600e3 && okSocial(p.text, p.score, 2))
      .sort((a, b) => b.score - a.score).slice(0, 4)
      .map(p => ({ text: p.text, score: p.score, src: "Bluesky", url: p.url }));
    if (reactions.length) out[m.id] = { heatHint: reactions.reduce((s, r) => s + r.score, 0), reactions };
  }
  return out;
}

/* ---------------- Mastodon (fan reactions, no auth) ---------------- */
// FIFA tricodes, so we can decode the #FediFC match hashtags (#FRASEN, #FRAvsSEN, or a #FRA + #SEN pair) that
// most football posts use instead of spelling out both team names. This roughly doubles what we can attribute.
const TRI = { MX: "MEX", ZA: "RSA", KR: "KOR", CZ: "CZE", CA: "CAN", BA: "BIH", QA: "QAT", CH: "SUI", BR: "BRA",
  MA: "MAR", HT: "HAI", "GB-SCT": "SCO", US: "USA", PY: "PAR", AU: "AUS", TR: "TUR", DE: "GER", CW: "CUW",
  CI: "CIV", EC: "ECU", NL: "NED", JP: "JPN", TN: "TUN", NZ: "NZL", BE: "BEL", EG: "EGY", IR: "IRN", UZ: "UZB",
  ES: "ESP", CV: "CPV", SA: "KSA", UY: "URU", FR: "FRA", SN: "SEN", IQ: "IRQ", NO: "NOR", AR: "ARG", DZ: "ALG",
  AT: "AUT", JO: "JOR", PT: "POR", CD: "COD", CO: "COL", SE: "SWE", "GB-ENG": "ENG", HR: "CRO", GH: "GHA", PA: "PAN" };
// the set of hashtags (lowercased) that unambiguously denote a given match
const matchHashtags = m => {
  const h = (TRI[m.home.team] || "").toLowerCase(), a = (TRI[m.away.team] || "").toLowerCase();
  return h && a ? [h + a, a + h, h + "vs" + a, a + "vs" + h, h + "v" + a, a + "v" + h] : [];
};
// mastodon.social's hashtag timelines are public. We pull a few WC tags once, then attribute each post to a recent
// match it refers to — by naming both teams (prose or team-name tags) OR by a match hashtag. Federated + lower-volume.
async function fetchMastodon(recent) {
  const tagged = recent.map(m => ({ m, ko: +new Date(m.utc), tags: new Set(matchHashtags(m)),
    htri: (TRI[m.home.team] || "").toLowerCase(), atri: (TRI[m.away.team] || "").toLowerCase() }));
  const out = {}, statuses = [], seen = new Set(), seenIds = new Set();
  // pull a hashtag timeline once, de-duplicating statuses we've already seen from another tag
  const pull = async tag => {
    if (!tag) return;
    try {
      const r = await fetch(`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=40`, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) { console.log("mastodon HTTP " + r.status, tag); return; }
      for (const st of await r.json()) if (st?.id && !seenIds.has(st.id)) { seenIds.add(st.id); statuses.push(st); }
    } catch (e) { console.log("mastodon skipped:", tag, e.message); }
  };
  for (const tag of ["worldcup", "fifaworldcup", "worldcup2026", "wc2026", "worldcup26", "mensworldcup"]) await pull(tag);
  // the #FediFC convention tags each match #FRASEN-style, so pulling each recent match's own tag timeline gets
  // match-specific reactions directly (far richer than relying on the broad tags alone)
  for (const t of tagged) if (t.htri && t.atri) await pull(t.htri + t.atri);
  // wider tag pulls bring noise: news live-blog link-shares, promo bots, off-topic posts. Drop the obvious ones.
  const NOISE = /world cup 2026\s*[–—-]\s*live|\blive(?:\s|-)?(?:blog|updates?|stream|score)|praat mee|👇|join us|watch live|full[- ]time:|how to watch|line-?ups?:/i;
  for (const st of statuses) {
    if (st.language && st.language !== "en") continue;
    // drop the hashtag-link anchors before cleaning so the shown text is prose, not a trailing tag-soup
    const text = clean(String(st.content || "").replace(/<a[^>]*hashtag[^>]*>[\s\S]*?<\/a>/gi, "")), score = (st.favourites_count || 0) + (st.reblogs_count || 0) * 2;
    // fresh posts usually have 0 favourites, so gate on civility/length, not score; rank by score later
    if (!st.url || st.card || !okSocial(text, score, 0) || NOISE.test(text)) continue;   // st.card => a link/article share, not a reaction
    const codesText = codesIn(text);   // a team named in the PROSE (not just a tag) — kills off-topic + non-English
    if (!codesText.length) continue;
    const k = text.toLowerCase().slice(0, 60); if (seen.has(k)) continue;
    const tagNames = (st.tags || []).map(t => String(t.name || "").toLowerCase()), tagSet = new Set(tagNames);
    const codes = codesIn(text + " " + tagNames.join(" "));   // team-name hashtags count as a mention too
    const created = +new Date(st.created_at || 0);
    const hit = tagged.find(t => Math.abs(created - t.ko) < 36 * 3600e3 && (
      (codes.includes(t.m.home.team) && codes.includes(t.m.away.team))   // both teams named (prose or name-tag)
      // a #FRASEN-style match hashtag, but only when the prose also names one of the two sides (guards mis-tagged posts)
      || ((tagNames.some(n => t.tags.has(n)) || (t.htri && t.atri && tagSet.has(t.htri) && tagSet.has(t.atri)))
        && (codesText.includes(t.m.home.team) || codesText.includes(t.m.away.team)))
    ));
    if (!hit) continue;
    seen.add(k);
    (out[hit.m.id] ||= { reactions: [] }).reactions.push({ text, score, src: "Mastodon", url: st.url });
  }
  for (const id of Object.keys(out)) {
    out[id].reactions = out[id].reactions.sort((a, b) => b.score - a.score).slice(0, 4);
    out[id].heatHint = out[id].reactions.reduce((s, r) => s + r.score, 0);
  }
  return out;
}

// merge the per-match reaction maps from every source. Round-robin (top from each, then seconds, …) so each
// source is represented rather than swamped by whichever scores highest, dedup near-identical text, cap at 5.
function mergeSources(...maps) {
  const out = {}, ids = new Set(maps.flatMap(m => Object.keys(m)));
  for (const id of ids) {
    const present = maps.filter(m => m[id]);
    const lists = present.map(m => [...m[id].reactions].sort((a, b) => b.score - a.score));
    const heatHint = Math.max(0, ...present.map(m => m[id].heatHint || 0));
    const reactions = [], seen = new Set();
    for (let i = 0; i < 6 && reactions.length < 5; i++) for (const list of lists) {
      const r = list[i]; if (!r) continue;
      const key = r.text.toLowerCase().replace(/\s+/g, " ").slice(0, 70); if (seen.has(key)) continue;
      seen.add(key); reactions.push(r);
      if (reactions.length >= 5) break;
    }
    if (reactions.length) out[id] = { heat: Math.min(100, Math.round(18 + Math.log2(1 + heatHint) * 9)), reactions };
  }
  return out;
}

/* ---------------- RSS (press headlines) ---------------- */
// a spread of outlets, deliberately weighted away from UK-only (Guardian/BBC) toward global desks (France 24,
// Al Jazeera, DW) so the headline mix reads worldwide, not London. The round-robin below takes one per source.
const FEEDS = [
  ["The Guardian", "https://www.theguardian.com/football/world-cup-2026/rss", true],
  ["BBC Sport", "https://feeds.bbci.co.uk/sport/football/world-cup/rss.xml", true],
  ["France 24", "https://www.france24.com/en/sport/rss", false],     // general feeds below → keep only WC / team items
  ["Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", false],
  ["DW", "https://rss.dw.com/rdf/rss-en-sports", false],
  ["ESPN", "https://www.espn.com/espn/rss/soccer/news", false],
];
function parseRSS(xml, src, wcFeed) {
  return [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map(m => m[0]).flatMap(it => {
    const title = clean(it.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/^\s*copy of\s+/i, "");
    const link = (it.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").trim();
    // some desks (ESPN live blogs) ship a title the source already truncated with "…" — skip it so the News tab only
    // ever shows complete headlines
    if (!title || /(?:…|\.\.\.)\s*$/.test(title) || !link || !/^https?:/.test(link)) return [];
    const codes = codesIn(title);
    if (!wcFeed && !/world cup|wc[\s-]?2026/i.test(title) && !(codes.length && FOOTBALL_RE.test(title)) && !STAR_RE.test(_deb(title))) return [];
    // pubDate (RSS) / dc:date (RDF) / published (Atom) → ISO, for the chronological News tab
    const dRaw = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || it.match(/<dc:date>([\s\S]*?)<\/dc:date>/i) || it.match(/<published>([\s\S]*?)<\/published>/i) || [])[1] || "";
    let date = ""; try { const dt = new Date(dRaw.trim()); if (!isNaN(+dt)) date = dt.toISOString(); } catch { /* leave blank */ }
    return [{ title, src, url: link, date, ...(codes.length === 1 ? { team: codes[0] } : {}) }];
  });
}
// the News tab is a chronological feed: gather every outlet, de-dup by title, sort newest-first. A per-feed cap
// keeps one prolific desk from flooding the top while still ordering by time.
async function fetchHeadlines() {
  const all = [];
  for (const [src, url, wcFeed] of FEEDS) {
    try { all.push(...parseRSS(await (await fetch(url, { headers: { "User-Agent": UA } })).text(), src, wcFeed).slice(0, 30)); }
    catch (e) { console.log("rss skipped", src, e.message); }
  }
  const seen = new Set(), out = [];
  for (const h of all.sort((a, b) => (b.date || "").localeCompare(a.date || ""))) {
    const k = h.title.toLowerCase(); if (seen.has(k)) continue;
    seen.add(k); out.push(h);
  }
  return out.slice(0, 70);
}

/* ---------------- Phase 3: derived signals ---------------- */
// trending teams: which sides are most mentioned right now (headline titles + the teams of buzzing matches)
function computeTrending(headlines, matches) {
  const count = {};
  const bump = (c, n) => { if (c && teams[c]) count[c] = (count[c] || 0) + n; };
  for (const h of headlines) for (const c of codesIn(h.title)) bump(c, 1);
  for (const [id, d] of Object.entries(matches)) {
    const m = byId[id]; if (!m) continue;
    bump(m.home?.team, 1 + Math.round((d.heat || 0) / 35));
    bump(m.away?.team, 1 + Math.round((d.heat || 0) / 35));
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([code, n]) => ({ code, n }));
}
// storylines: a tiny LLM pass that synthesises the headlines (+ any reactions) into a few talking points.
// Gated on ANTHROPIC_API_KEY — skipped (and the tab is fine without it) when the secret isn't set.
async function fetchStorylines(headlines, matches) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !headlines.length) return [];
  const reactions = Object.values(matches).flatMap(d => d.reactions.map(r => r.text)).slice(0, 15);
  const material = "Headlines:\n" + headlines.map(h => "- " + h.title).join("\n")
    + (reactions.length ? "\n\nFan comments:\n" + reactions.map(r => "- " + r).join("\n") : "");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 350,
        messages: [{ role: "user", content: `These are today's FIFA World Cup 2026 headlines${reactions.length ? " and fan comments" : ""}. Write the 3 biggest storylines as punchy, neutral, one-sentence talking points a fan would care about. One per line, no numbering, no preamble, no markdown.\n\n${material}` }],
      }),
    });
    if (!r.ok) { console.log("storylines: anthropic HTTP " + r.status); return []; }
    const txt = (await r.json()).content?.[0]?.text || "";
    return txt.split("\n").map(l => l.replace(/^[-•\d.)\s]+/, "").trim()).filter(l => l.length > 12).slice(0, 3);
  } catch (e) { console.log("storylines skipped:", e.message); return []; }
}

/* ---------------- main ---------------- */
// Fan reactions are PARKED — the tab is "News" (headlines only) for now. The whole social pipeline (Reddit /
// Bluesky / Mastodon + storylines + trending) is kept intact below; flip SOCIAL back to true to re-enable it
// once there are better sources. While off we skip those fetches entirely, so the Action stays fast.
const SOCIAL = false;
let matches = {}, trending = [], storylines = [];
if (SOCIAL) {
  const recent = fixtures.filter(m => {
    const hc = m.home?.team, ac = m.away?.team; if (!hc || !ac) return false;
    const ko = +new Date(m.utc); return ko <= now + 3 * 3600e3 && ko >= now - 4 * 86400e3;
  });
  const bskytok = await bskyToken();
  const [reddit, bsky, masto] = await Promise.all([
    fetchReactions().catch(e => { console.log("reddit skipped:", e.message); return {}; }),
    fetchBluesky(recent, bskytok).catch(e => { console.log("bluesky skipped:", e.message); return {}; }),
    fetchMastodon(recent).catch(e => { console.log("mastodon skipped:", e.message); return {}; }),
  ]);
  matches = mergeSources(reddit, bsky, masto);
  console.log(`reactions: reddit ${Object.keys(reddit).length}, bluesky ${Object.keys(bsky).length}, mastodon ${Object.keys(masto).length} → ${Object.keys(matches).length} merged`);
}
const headlines = await fetchHeadlines().catch(e => { console.log("headlines skipped:", e.message); return []; });
if (SOCIAL) { trending = computeTrending(headlines, matches); storylines = await fetchStorylines(headlines, matches); }
const buzz = { updated: new Date().toISOString(), storylines, trending, matches, headlines };
console.log(`buzz: ${Object.keys(matches).length} match(es) w/reactions, ${headlines.length} headline(s), ${trending.length} trending, ${storylines.length} storyline(s)`);
if (DRY) console.log(JSON.stringify(buzz, null, 2).slice(0, 2200));
else { writeFileSync("data/buzz.json", JSON.stringify(buzz)); console.log("wrote data/buzz.json"); }
