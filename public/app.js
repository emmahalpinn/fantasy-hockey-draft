const STORAGE_KEY = "peanut-punch-hockey-room-v2";
const TARGETS = { C: 2, LW: 2, RW: 2, D: 4, G: 2 };
const BENCH_TARGET = 5;

const state = {
  players: [],
  drafted: new Set(),
  myTeam: new Set(),
  history: [],
  sort: { key: "rank", direction: "asc" },
  activeView: "board",
  sleeperDraftId: "",
  pollTimer: null,
  sources: null,
  activeDetailId: null,
  settings: { teams: 12, slot: 1, scoring: "custom", currentPick: 1 },
};

const $ = (id) => document.getElementById(id);
const els = {
  teams: $("teams"), slot: $("slot"), scoring: $("scoring"), currentPick: $("currentPick"),
  prevPick: $("prevPick"), nextPick: $("nextPick"), pickLabel: $("pickLabel"),
  pickOwner: $("pickOwner"), nextMine: $("nextMine"), sleeperInput: $("sleeperInput"),
  syncSleeper: $("syncSleeper"), syncStatus: $("syncStatus"), sourceStatus: $("sourceStatus"),
  refreshData: $("refreshData"), resetDraft: $("resetDraft"), positionFilter: $("positionFilter"),
  search: $("search"), availableOnly: $("availableOnly"), playerCount: $("playerCount"),
  boardStatus: $("boardStatus"), playerRows: $("playerRows"), recommendationGrid: $("recommendationGrid"),
  needsSummary: $("needsSummary"), rosterCount: $("rosterCount"), rosterTargets: $("rosterTargets"),
  rosterList: $("rosterList"), historyList: $("historyList"), playerDialog: $("playerDialog"),
  detailName: $("detailName"), detailContent: $("detailContent"), closeDialog: $("closeDialog"),
  compareSelect: $("compareSelect"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function normalizeName(value) {
  return String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f'’. -]/g, "");
}

function groupFor(position) {
  if (position === "W") return "LW";
  return ["C", "LW", "RW", "D", "G"].includes(position) ? position : "LW";
}

function pickLabel(pick) {
  const round = Math.floor((pick - 1) / state.settings.teams) + 1;
  const slot = ((pick - 1) % state.settings.teams) + 1;
  return `${round}.${String(slot).padStart(2, "0")}`;
}

function teamForPick(pick) {
  const round = Math.floor((pick - 1) / state.settings.teams) + 1;
  const inRound = ((pick - 1) % state.settings.teams) + 1;
  return round % 2 ? inRound : state.settings.teams - inRound + 1;
}

function isMyPick(pick) {
  return teamForPick(pick) === state.settings.slot;
}

function findNextMine(from = state.settings.currentPick) {
  for (let pick = from; pick < from + state.settings.teams * 3; pick += 1) {
    if (isMyPick(pick)) return pick;
  }
  return from;
}

function valueAtPick(player) {
  return state.settings.currentPick - Math.round(player.adp);
}

function valueText(player) {
  const gap = valueAtPick(player);
  if (gap >= state.settings.teams) return `<span class="value">+${gap} value</span>`;
  if (gap <= -state.settings.teams) return `<span class="reach">${gap} reach</span>`;
  return gap > 0 ? `<span class="value">+${gap}</span>` : String(gap);
}

function getPlayer(id) {
  return state.players.find((player) => player.id === id);
}

function playerStatus(id) {
  if (state.myTeam.has(id)) return "My pick";
  if (state.drafted.has(id)) return "Taken";
  return "Available";
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    drafted: [...state.drafted],
    myTeam: [...state.myTeam],
    history: state.history,
    sleeperDraftId: state.sleeperDraftId,
    settings: state.settings,
  }));
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return;
    state.drafted = new Set(saved.drafted || []);
    state.myTeam = new Set(saved.myTeam || []);
    state.history = saved.history || [];
    state.sleeperDraftId = saved.sleeperDraftId || "";
    state.settings = { ...state.settings, ...(saved.settings || {}) };
    state.settings.teams = 12;
    state.settings.scoring = "custom";
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function renderSlots() {
  els.slot.innerHTML = Array.from({ length: state.settings.teams }, (_, i) =>
    `<option value="${i + 1}" ${i + 1 === state.settings.slot ? "selected" : ""}>${i + 1}</option>`,
  ).join("");
}

function renderSettings() {
  els.teams.value = String(state.settings.teams);
  els.scoring.value = state.settings.scoring;
  els.currentPick.value = String(state.settings.currentPick);
  els.sleeperInput.value = state.sleeperDraftId;
  renderSlots();
}

function rosterCounts() {
  const counts = { C: 0, LW: 0, RW: 0, D: 0, G: 0, BN: 0 };
  for (const id of state.myTeam) {
    const player = getPlayer(id);
    if (!player) continue;
    if (player.position === "W") {
      const wing = counts.LW <= counts.RW ? "LW" : "RW";
      counts[wing] += 1;
    } else {
      counts[groupFor(player.position)] += 1;
    }
  }
  const startersUsed = Object.entries(TARGETS)
    .reduce((total, [position, target]) => total + Math.min(counts[position], target), 0);
  counts.BN = Math.max(0, state.myTeam.size - startersUsed);
  return counts;
}

function needScore(player) {
  const counts = rosterCounts();
  const group = groupFor(player.position);
  const deficit = Math.max(0, TARGETS[group] - counts[group]);
  const round = Math.floor((state.settings.currentPick - 1) / state.settings.teams) + 1;
  let score =
    -Math.abs(player.adp - state.settings.currentPick) +
    deficit * 8 +
    (Number.isFinite(player.fantasyPoints) ? player.fantasyPoints / 100 : 0);
  if (round <= 3 && group === "G" && counts.G === 0) score += 1.5;
  if (round >= 6 && group === "D" && counts.D < 2) score += 4;
  if (round >= 8 && group === "G" && counts.G < 2) score += 7;
  if (counts[group] >= TARGETS[group] && counts.BN < BENCH_TARGET) score -= 3;
  if (counts.BN >= BENCH_TARGET && state.myTeam.size >= 17) score -= 50;
  return score;
}

function recommendationReason(player) {
  const group = groupFor(player.position);
  const counts = rosterCounts();
  const gap = valueAtPick(player);
  if (gap >= state.settings.teams) return `${gap} picks past ADP`;
  if (counts[group] < TARGETS[group]) return `Need ${group}: ${counts[group]}/${TARGETS[group]}`;
  if (counts.BN < BENCH_TARGET) return `Best bench value · ${counts.BN}/${BENCH_TARGET} BN`;
  return "Best market value";
}

function availablePlayers() {
  return state.players.filter((player) => !state.drafted.has(player.id));
}

function renderRecommendations() {
  const top = availablePlayers()
    .map((player) => ({ player, score: needScore(player) }))
    .sort((a, b) => b.score - a.score || a.player.rank - b.player.rank)
    .slice(0, 5);
  const counts = rosterCounts();
  els.needsSummary.textContent =
    `C ${counts.C}/${TARGETS.C} · LW ${counts.LW}/${TARGETS.LW} · RW ${counts.RW}/${TARGETS.RW} · ` +
    `D ${counts.D}/${TARGETS.D} · G ${counts.G}/${TARGETS.G} · BN ${counts.BN}/${BENCH_TARGET}`;
  els.recommendationGrid.innerHTML = top.length ? top.map(({ player }, index) => `
    <article class="recommendation" data-rank="${index + 1}">
      <span class="pos">${escapeHtml(player.position)}</span>
      <h3>${escapeHtml(player.name)}</h3>
      <p>${escapeHtml(player.team || "FA")} · ADP ${player.adp.toFixed(1)}${Number.isFinite(player.fantasyPoints) ? ` · ${player.fantasyPoints.toFixed(1)} FPts` : ""}</p>
      <p class="fit">${escapeHtml(recommendationReason(player))}</p>
      <button data-action="mine" data-id="${escapeHtml(player.id)}">Draft to my team</button>
    </article>`).join("") : `<p class="status">No available ranked players match the board.</p>`;
}

function matchesPosition(player, filter) {
  if (filter === "ALL") return true;
  if (filter === "W") return ["LW", "RW", "W"].includes(player.position);
  return player.position === filter;
}

function filteredPlayers() {
  const query = normalizeName(els.search.value);
  const position = els.positionFilter.value;
  const players = state.players.filter((player) => {
    if (els.availableOnly.checked && state.drafted.has(player.id)) return false;
    if (!matchesPosition(player, position)) return false;
    return !query || normalizeName(`${player.name} ${player.team}`).includes(query);
  });
  const { key, direction } = state.sort;
  const multiplier = direction === "asc" ? 1 : -1;
  return players.sort((a, b) => {
    const aValue = key === "value" ? valueAtPick(a) : a[key];
    const bValue = key === "value" ? valueAtPick(b) : b[key];
    if (aValue == null && bValue != null) return 1;
    if (bValue == null && aValue != null) return -1;
    if (typeof aValue === "number") return (aValue - bValue) * multiplier;
    return String(aValue || "").localeCompare(String(bValue || "")) * multiplier;
  });
}

function renderBoard() {
  const players = filteredPlayers();
  els.playerCount.textContent = `${players.length} players`;
  els.boardStatus.textContent = state.sources?.fantasyPros?.connected
    ? `${state.sources.fantasyPros.count} verified ADP rows loaded`
    : "ADP source unavailable";
  els.playerRows.innerHTML = players.length ? players.map((player) => {
    const status = playerStatus(player.id);
    return `<tr class="${state.drafted.has(player.id) ? "drafted" : ""}">
      <td>${player.rank}</td>
      <td><button class="player-link" data-action="detail" data-id="${escapeHtml(player.id)}">
        <strong>${escapeHtml(player.name)}</strong>
        ${player.injury ? `<span class="sub">${escapeHtml(player.injury.status)}</span>` : ""}
      </button></td>
      <td><span class="pos">${escapeHtml(player.position)}</span></td>
      <td>${escapeHtml(player.team || "—")}</td>
      <td><strong>${player.adp.toFixed(1)}</strong><span class="sub">FP consensus</span></td>
      <td>${Number.isFinite(player.fantasyPoints)
        ? `<strong>${player.fantasyPoints.toFixed(1)}</strong><span class="sub">${player.statsSeason}</span>`
        : "—"}</td>
      <td>${valueText(player)}</td>
      <td><span class="badge ${status === "My pick" ? "mine" : ""}">${status}</span>
        ${player.injury ? `<span class="badge injury">INJ</span>` : ""}</td>
      <td><div class="row-actions">
        ${state.drafted.has(player.id)
          ? `<button data-action="undo" data-id="${escapeHtml(player.id)}">Undo</button>`
          : `<button class="mine" data-action="mine" data-id="${escapeHtml(player.id)}">My pick</button>
             <button data-action="taken" data-id="${escapeHtml(player.id)}">Taken</button>`}
      </div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9" class="empty">No players match these filters.</td></tr>`;
}

function renderClock() {
  const pick = state.settings.currentPick;
  els.pickLabel.textContent = pickLabel(pick);
  els.pickOwner.textContent = isMyPick(pick) ? "Your pick" : `Draft slot ${teamForPick(pick)}`;
  const next = findNextMine(pick);
  els.nextMine.textContent = next === pick ? "You are on the clock" : `Your next pick: ${pickLabel(next)} (${next})`;
}

function renderRoster() {
  const counts = rosterCounts();
  els.rosterCount.textContent = String(state.myTeam.size);
  els.rosterTargets.innerHTML = [...Object.entries(TARGETS), ["BN", BENCH_TARGET]].map(([position, target]) => `
    <article class="target ${counts[position] >= target ? "complete" : ""}">
      <span>${position} target</span><strong>${counts[position]} / ${target}</strong>
    </article>`).join("");
  const players = [...state.myTeam].map(getPlayer).filter(Boolean);
  els.rosterList.innerHTML = players.length ? players.map((player) => `
    <article class="draft-card">
      <div><h3>${escapeHtml(player.name)}</h3><p>${escapeHtml(player.team)} · ${escapeHtml(player.position)} · ADP ${player.adp.toFixed(1)}</p></div>
      <button data-action="detail" data-id="${escapeHtml(player.id)}">Details</button>
    </article>`).join("") : `<p class="status">Mark a player “My pick” to start your roster.</p>`;
}

function renderHistory() {
  const items = [...state.history].sort((a, b) => b.pick - a.pick);
  els.historyList.innerHTML = items.length ? items.map((entry) => `
    <article class="draft-card">
      <div><h3>${escapeHtml(entry.name)}</h3>
      <p>Pick ${entry.pick} (${pickLabel(entry.pick)}) · ${escapeHtml(entry.position)} · ${escapeHtml(entry.team || "—")}</p></div>
      <span class="badge ${entry.mine ? "mine" : ""}">${entry.mine ? "Peanut Punch" : `Slot ${entry.teamSlot || "—"}`}</span>
    </article>`).join("") : `<p class="status">Draft selections will appear here.</p>`;
}

function renderSources() {
  if (!state.sources) return;
  const fp = state.sources.fantasyPros;
  const sleeper = state.sources.sleeper;
  const stats = state.sources.nhlStats;
  els.sourceStatus.innerHTML = [
    fp.connected ? `● FantasyPros: ${fp.count} ADP rows` : `○ FantasyPros: ${escapeHtml(fp.error)}`,
    sleeper.connected ? `● Sleeper: ${sleeper.count} profiles` : `○ Sleeper: ${escapeHtml(sleeper.error)}`,
    stats?.connected
      ? `● NHL: ${stats.count} stat lines · ${stats.seasonId}`
      : `○ NHL stats: ${escapeHtml(stats?.error || "unavailable")}`,
  ].join("<br>");
}

function render() {
  renderClock();
  renderRecommendations();
  renderBoard();
  renderRoster();
  renderHistory();
  renderSources();
}

function recordPick(player, mine, pick = state.settings.currentPick, teamSlot = teamForPick(pick)) {
  state.drafted.add(player.id);
  if (mine) state.myTeam.add(player.id);
  state.history = state.history.filter((entry) => entry.playerId !== player.id);
  state.history.push({
    playerId: player.id, name: player.name, position: player.position, team: player.team,
    pick, mine, teamSlot,
  });
}

function markPlayer(id, action) {
  const player = getPlayer(id);
  if (!player) return;
  if (action === "mine" && !state.myTeam.has(id) && state.myTeam.size >= 17) {
    alert("Your roster is full: 12 starters and 5 bench players.");
    return;
  }
  if (action === "undo") {
    state.drafted.delete(id);
    state.myTeam.delete(id);
    state.history = state.history.filter((entry) => entry.playerId !== id);
  } else {
    recordPick(player, action === "mine");
    state.settings.currentPick += 1;
    els.currentPick.value = state.settings.currentPick;
  }
  save();
  render();
}

const STAT_DEFINITIONS = [
  ["fantasyPoints", "Fantasy points", true],
  ["gamesPlayed", "Games played", true],
  ["goals", "Goals", true],
  ["assists", "Assists", true],
  ["plusMinus", "+/-", true],
  ["powerPlayPoints", "Power-play points", true],
  ["shots", "Shots on goal", true],
  ["blocks", "Blocks", true],
  ["wins", "Wins", true],
  ["goalsAgainst", "Goals against", false],
  ["saves", "Saves", true],
  ["shutouts", "Shutouts", true],
];

function playerMetric(player, key) {
  if (key === "fantasyPoints") return player.fantasyPoints;
  return player.stats?.[key] ?? null;
}

function statCard(player, comparePlayer = null) {
  const rows = STAT_DEFINITIONS
    .filter(([key]) => playerMetric(player, key) != null || (comparePlayer && playerMetric(comparePlayer, key) != null))
    .map(([key, label, higherIsBetter]) => {
      const value = playerMetric(player, key);
      const other = comparePlayer ? playerMetric(comparePlayer, key) : null;
      const leads =
        Number.isFinite(value) &&
        Number.isFinite(other) &&
        value !== other &&
        (higherIsBetter ? value > other : value < other);
      const formatted =
        value == null ? "—" : key === "fantasyPoints" ? Number(value).toFixed(1) : String(value);
      return `<div class="compare-stat ${leads ? "leader" : ""}"><span>${label}</span><strong>${formatted}</strong></div>`;
    })
    .join("");
  return `<article class="compare-player">
    <header><span class="pos">${escapeHtml(player.position)}</span><div>
      <h3>${escapeHtml(player.name)}</h3>
      <p>${escapeHtml(player.team || "—")} · ADP ${player.adp.toFixed(1)} · Rank ${player.rank}</p>
    </div></header>
    <div class="compare-stats">${rows || `<p class="status">No verified NHL stats matched this player.</p>`}</div>
    ${player.injury ? `<p class="stats-note"><strong>Injury:</strong> ${escapeHtml(player.injury.status)}
      ${player.injury.bodyPart ? ` · ${escapeHtml(player.injury.bodyPart)}` : ""}</p>` : ""}
  </article>`;
}

function renderDetailComparison(compareId = "") {
  const player = getPlayer(state.activeDetailId);
  const comparePlayer = compareId ? getPlayer(compareId) : null;
  if (!player) return;
  els.detailName.textContent = comparePlayer ? `${player.name} vs. ${comparePlayer.name}` : player.name;
  els.detailContent.innerHTML = `<div class="compare-grid ${comparePlayer ? "two-up" : ""}">
    ${statCard(player, comparePlayer)}
    ${comparePlayer ? statCard(comparePlayer, player) : ""}
  </div>
  <p class="stats-note">Official NHL regular-season stats (${player.statsSeason || comparePlayer?.statsSeason || "unavailable"}).
    Green highlights the better comparable number. Fantasy points use your league scoring.</p>`;
}

function showDetail(id) {
  const player = getPlayer(id);
  if (!player) return;
  state.activeDetailId = id;
  els.compareSelect.innerHTML = `<option value="">Choose another player…</option>${state.players
    .filter((candidate) => candidate.id !== id)
    .map((candidate) => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)} (${escapeHtml(candidate.position)})</option>`)
    .join("")}`;
  renderDetailComparison();
  els.playerDialog.showModal();
}

async function loadPlayers(force = false) {
  els.boardStatus.textContent = "Loading verified data…";
  els.refreshData.disabled = true;
  try {
    const response = await fetch(`/api/players${force ? `?t=${Date.now()}` : ""}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Player feed failed");
    state.players = data.players || [];
    state.sources = data.sources;
    const idsByName = new Map(state.players.map((player) => [normalizeName(player.name), player.id]));
    // Reconnect synced picks after a data refresh, including older IDs.
    for (const entry of state.history) {
      const currentId = idsByName.get(normalizeName(entry.name));
      if (!currentId || currentId === entry.playerId) continue;
      if (state.drafted.delete(entry.playerId)) state.drafted.add(currentId);
      if (state.myTeam.delete(entry.playerId)) state.myTeam.add(currentId);
      entry.playerId = currentId;
    }
    render();
  } catch (error) {
    els.boardStatus.textContent = error.message;
    els.sourceStatus.textContent = `Data load failed: ${error.message}`;
    els.playerRows.innerHTML = `<tr><td colspan="9" class="empty">No verified ADP is available. Refresh to retry.</td></tr>`;
  } finally {
    els.refreshData.disabled = false;
  }
}

function draftIdFromInput(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:draft\/|drafts\/)([a-zA-Z0-9_-]+)/);
  return match?.[1] || (/^[a-zA-Z0-9_-]{1,64}$/.test(text) ? text : "");
}

async function syncSleeper({ quiet = false } = {}) {
  const draftId = draftIdFromInput(els.sleeperInput.value);
  if (!draftId) {
    els.syncStatus.textContent = "Paste a valid Sleeper draft URL or ID.";
    return;
  }
  if (!quiet) els.syncStatus.textContent = "Syncing Sleeper picks…";
  try {
    const response = await fetch(`/api/sleeper/draft?draftId=${encodeURIComponent(draftId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Sleeper sync failed");
    if (data.sport && data.sport !== "nhl") throw new Error(`Sleeper reports this as a ${data.sport.toUpperCase()} draft, not NHL.`);
    if (data.teams && data.teams !== 12) {
      throw new Error(`This room is locked to 12 teams; Sleeper reports ${data.teams}.`);
    }
    const bySleeperId = new Map(state.players.filter((p) => p.sleeperId).map((p) => [String(p.sleeperId), p]));
    const byName = new Map(state.players.map((p) => [normalizeName(p.name), p]));
    for (const pick of data.picks) {
      const player = bySleeperId.get(String(pick.playerId)) || byName.get(normalizeName(pick.name));
      if (player) recordPick(player, pick.teamSlot === state.settings.slot, pick.pick, pick.teamSlot);
    }
    state.settings.currentPick = Math.max(state.settings.currentPick, data.picks.length + 1);
    state.sleeperDraftId = draftId;
    els.currentPick.value = state.settings.currentPick;
    els.syncStatus.textContent = `${data.picks.length} picks synced · ${data.status || "status unknown"} · polling every 15s`;
    save();
    render();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => syncSleeper({ quiet: true }), 15_000);
  } catch (error) {
    els.syncStatus.textContent = error.message;
  }
}

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (action) {
    const type = action.dataset.action;
    if (type === "detail") showDetail(action.dataset.id);
    else markPlayer(action.dataset.id, type);
  }
  const sort = event.target.closest("[data-sort]");
  if (sort) {
    const key = sort.dataset.sort;
    state.sort = {
      key,
      direction: state.sort.key === key && state.sort.direction === "asc" ? "desc" : "asc",
    };
    renderBoard();
  }
  const tab = event.target.closest(".tab");
  if (tab) {
    state.activeView = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((node) => node.classList.toggle("active", node === tab));
    document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === `${state.activeView}View`));
  }
});

els.teams.addEventListener("change", () => {
  state.settings.teams = Number(els.teams.value);
  if (state.settings.slot > state.settings.teams) state.settings.slot = 1;
  renderSlots(); save(); render();
});
els.slot.addEventListener("change", () => { state.settings.slot = Number(els.slot.value); save(); render(); });
els.scoring.addEventListener("change", () => { state.settings.scoring = els.scoring.value; save(); render(); });
els.currentPick.addEventListener("input", () => {
  state.settings.currentPick = Math.max(1, Number(els.currentPick.value) || 1); save(); render();
});
els.prevPick.addEventListener("click", () => {
  state.settings.currentPick = Math.max(1, state.settings.currentPick - 1);
  els.currentPick.value = state.settings.currentPick; save(); render();
});
els.nextPick.addEventListener("click", () => {
  state.settings.currentPick += 1; els.currentPick.value = state.settings.currentPick; save(); render();
});
[els.positionFilter, els.availableOnly].forEach((element) => element.addEventListener("change", renderBoard));
els.search.addEventListener("input", renderBoard);
els.refreshData.addEventListener("click", () => loadPlayers(true));
els.syncSleeper.addEventListener("click", () => syncSleeper());
els.compareSelect.addEventListener("change", () => renderDetailComparison(els.compareSelect.value));
els.closeDialog.addEventListener("click", () => els.playerDialog.close());
els.playerDialog.addEventListener("click", (event) => {
  if (event.target === els.playerDialog) els.playerDialog.close();
});
els.resetDraft.addEventListener("click", () => {
  if (!confirm("Reset all hockey draft picks, roster state, and settings?")) return;
  clearInterval(state.pollTimer);
  localStorage.removeItem(STORAGE_KEY);
  state.drafted.clear(); state.myTeam.clear(); state.history = []; state.sleeperDraftId = "";
  state.settings = { teams: 12, slot: 1, scoring: "custom", currentPick: 1 };
  renderSettings(); render();
});

restore();
renderSettings();
render();
loadPlayers().then(() => {
  if (state.sleeperDraftId) syncSleeper({ quiet: true });
});
