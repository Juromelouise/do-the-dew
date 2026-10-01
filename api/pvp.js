// Sudden-death 1v1 sync for the Do The Dew game.
//
// Two laptops poll this endpoint (action "sync") a couple of times per
// second. Each laptop only ever WRITES its own player slot and READS the
// opponent slot + the match record, so there are no read-modify-write races.
// The Player 1 laptop ("host") creates the match record (action "start")
// once both sides are ready, and clears it (action "clear") when returning
// to the lobby.
//
// Storage is in-memory: both laptops talk to the one local server process
// (scripts/pvp-local-server.js), and match state is short-lived anyway.

const PLAYER_TTL_S = 60;
const MATCH_TTL_S = 900;
const MAX_DATA_JSON = 2000;

// Single-process in-memory store with per-key TTL
const localStore = new Map();

function localGet(key) {
  const entry = localStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    localStore.delete(key);
    return null;
  }
  return entry.value;
}

function localSet(key, value, ttlS) {
  if (localStore.size > 500) {
    const now = Date.now();
    for (const [k, entry] of localStore) {
      if (entry.expiresAt <= now) localStore.delete(k);
    }
  }
  localStore.set(key, { value, expiresAt: Date.now() + ttlS * 1000 });
}

function keyPlayer(room, player) {
  return `pvp:${room}:p${player}`;
}

function keyMatch(room) {
  return `pvp:${room}:match`;
}

function sanitizeRoom(raw) {
  const room = String(raw || "main")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
  return room || "main";
}

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = null;
    }
  }
  if (!body || typeof body !== "object") {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const action = body.action;
  const room = sanitizeRoom(body.room);
  const player = body.player === 1 ? 1 : body.player === 2 ? 2 : null;
  const now = Date.now();

  try {
    if (action === "sync") {
      if (!player) {
        sendJson(res, 400, { ok: false, error: "player must be 1 or 2" });
        return;
      }
      const data = body.data;
      if (!data || typeof data !== "object") {
        sendJson(res, 400, { ok: false, error: "data required" });
        return;
      }
      if (JSON.stringify(data).length > MAX_DATA_JSON) {
        sendJson(res, 400, { ok: false, error: "data too large" });
        return;
      }

      localSet(keyPlayer(room, player), { data, seen: now }, PLAYER_TTL_S);
      const other = player === 1 ? 2 : 1;
      const opp = localGet(keyPlayer(room, other));
      const match = localGet(keyMatch(room));

      sendJson(res, 200, { ok: true, now, opp, match });
      return;
    }

    if (action === "start") {
      if (player !== 1) {
        sendJson(res, 400, { ok: false, error: "only player 1 starts matches" });
        return;
      }
      const m = body.match;
      if (
        !m ||
        typeof m.id !== "number" ||
        typeof m.seed !== "number" ||
        typeof m.startAt !== "number" ||
        Math.abs(m.startAt - now) > 60000
      ) {
        sendJson(res, 400, { ok: false, error: "invalid match record" });
        return;
      }
      localSet(
        keyMatch(room),
        { id: m.id, seed: m.seed, startAt: m.startAt, createdAt: now },
        MATCH_TTL_S
      );
      sendJson(res, 200, { ok: true, now });
      return;
    }

    if (action === "clear") {
      // Only delete the match the caller thinks is over — a delayed clear
      // must not wipe out a newer live match record.
      const matchId = typeof body.matchId === "number" ? body.matchId : null;
      const existing = localGet(keyMatch(room));
      if (!existing || matchId === null || existing.id === matchId) {
        localStore.delete(keyMatch(room));
      }
      sendJson(res, 200, { ok: true, now });
      return;
    }

    sendJson(res, 400, { ok: false, error: "unknown action" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : "Unexpected server error",
    });
  }
};
