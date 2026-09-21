import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3005);
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f'’. -]/g, "");
}

function decodeHtml(value) {
  return clean(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&nbsp;", " ");
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchSleeperDirectory() {
  return cached("sleeper-players", async () => {
    const response = await fetch("https://api.sleeper.app/v1/players/nhl", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Sleeper NHL directory returned ${response.status}`);
    return response.json();
  });
}

async function fetchFantasyProsAdp() {
  return cached("fantasypros-adp", async () => {
    const url = "https://www.fantasypros.com/nhl/adp/overall.php";
    const response = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 Peanut-Punch-Hockey-Room/1.0",
      },
    });
    if (!response.ok) throw new Error(`FantasyPros ADP returned ${response.status}`);
    const html = await response.text();
    const season = html.match(/Fantasy Hockey ([0-9]{4}-[0-9]{2})/)?.[1] || null;
    const rowPattern =
      /<tr><td>(\d+)<\/td>\s*<td class="player-label"><a[^>]*class="player-name"[^>]*>([^<]+)<\/a>\s*<small>([^<]*)<\/small><\/td>\s*<td class="center">([A-Z]+)\d*<\/td><td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
    const players = [];
    for (const match of html.matchAll(rowPattern)) {
      const adp = Number(match[7]);
      if (!Number.isFinite(adp) || adp <= 0) continue;
      players.push({
        rank: Number(match[1]),
        name: decodeHtml(match[2]),
        team: clean(match[3]).toUpperCase(),
        position: clean(match[4]).toUpperCase(),
        yahooAdp: Number(match[5]) || null,
        espnAdp: Number(match[6]) || null,
        adp,
      });
    }
    if (!players.length) throw new Error("FantasyPros page loaded but its ADP table was empty");
    return { players, season, url };
  });
}

async function buildBoard() {
  const [adpResult, sleeperResult] = await Promise.allSettled([
    fetchFantasyProsAdp(),
    fetchSleeperDirectory(),
  ]);
  const adp =
    adpResult.status === "fulfilled"
      ? adpResult.value
      : { players: [], season: null, url: null };
  const sleeper =
    sleeperResult.status === "fulfilled" ? sleeperResult.value : {};
  const sleeperByName = new Map();
  for (const [id, player] of Object.entries(sleeper)) {
    const name = player.full_name || `${player.first_name || ""} ${player.last_name || ""}`;
    if (clean(name)) sleeperByName.set(normalizeName(name), { ...player, player_id: id });
  }

  const players = adp.players.map((player) => {
    const profile = sleeperByName.get(normalizeName(player.name));
    const injuryStatus = clean(profile?.injury_status);
    return {
      id: profile?.player_id ? `sleeper-${profile.player_id}` : `fp-${normalizeName(player.name)}`,
      sleeperId: profile?.player_id || null,
      ...player,
      team: profile?.team || player.team,
      position: profile?.position || player.position,
      active: typeof profile?.active === "boolean" ? profile.active : null,
      injury: injuryStatus
        ? {
            status: injuryStatus,
            bodyPart: clean(profile?.injury_body_part) || null,
            notes: clean(profile?.injury_notes) || null,
          }
        : null,
    };
  });

  return {
    players,
    season: adp.season,
    fetchedAt: new Date().toISOString(),
    sources: {
      fantasyPros: {
        connected: adpResult.status === "fulfilled",
        count: adp.players.length,
        url: adp.url,
        error: adpResult.status === "rejected" ? adpResult.reason.message : null,
        note: "Consensus ADP combines the Yahoo and ESPN columns published by FantasyPros.",
      },
      sleeper: {
        connected: sleeperResult.status === "fulfilled",
        count: Object.keys(sleeper).length,
        error: sleeperResult.status === "rejected" ? sleeperResult.reason.message : null,
        note: "Used for NHL team, position, active status, and injury fields when present.",
      },
    },
    limitations:
      "Verified player statistics are not wired in v1. Details show directory and market data only.",
  };
}

async function fetchSleeperDraft(draftId) {
  const [draftResponse, picksResponse] = await Promise.all([
    fetch(`https://api.sleeper.app/v1/draft/${encodeURIComponent(draftId)}`),
    fetch(`https://api.sleeper.app/v1/draft/${encodeURIComponent(draftId)}/picks`),
  ]);
  if (!draftResponse.ok || !picksResponse.ok) {
    throw new Error("Sleeper draft was not found or is not publicly readable");
  }
  const [draft, rawPicks] = await Promise.all([draftResponse.json(), picksResponse.json()]);
  if (draft.type && draft.type !== "snake") {
    throw new Error(`This v1 supports snake drafts; Sleeper reports type "${draft.type}"`);
  }
  const players = await fetchSleeperDirectory().catch(() => ({}));
  const picks = rawPicks.map((pick) => {
    const player = players[pick.player_id] || {};
    const metadata = pick.metadata || {};
    return {
      pick: Number(pick.pick_no),
      round: Number(pick.round),
      teamSlot: Number(pick.draft_slot || pick.roster_id),
      playerId: clean(pick.player_id),
      name:
        clean(player.full_name) ||
        clean(`${metadata.first_name || ""} ${metadata.last_name || ""}`) ||
        clean(pick.player_id),
      position: clean(player.position || metadata.position).toUpperCase() || "—",
      team: clean(player.team || metadata.team).toUpperCase(),
    };
  });
  return {
    draftId,
    sport: draft.sport || null,
    status: draft.status,
    teams: Number(draft.settings?.teams) || null,
    picks,
  };
}

async function serveStatic(res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const content = await readFile(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    };
    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, app: "Peanut Punch Hockey Room" });
  }
  if (req.method === "GET" && url.pathname === "/api/players") {
    try {
      return sendJson(res, 200, await buildBoard());
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/sleeper/draft") {
    const draftId = clean(url.searchParams.get("draftId"));
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(draftId)) {
      return sendJson(res, 400, { error: "A valid Sleeper draft ID is required" });
    }
    try {
      return sendJson(res, 200, await fetchSleeperDraft(draftId));
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  if (req.method === "GET") return serveStatic(res, url.pathname);
  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Peanut Punch Hockey Room running at http://localhost:${PORT}`);
});
