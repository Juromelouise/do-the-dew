const {
  sanitizeState,
  ensureMouseSchedule,
  getProductChancePercentages,
  getState,
  setState
} = require("./_lib/wheel-state");

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function responseState(state) {
  return {
    inventory: state.inventory,
    multipliers: state.multipliers,
    nextMouseDueAt: state.nextMouseDueAt,
    chancePercentages: getProductChancePercentages(state)
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const state = await getState();
      sendJson(res, 200, { ok: true, state: responseState(state) });
      return;
    }

    if (req.method === "POST") {
      const current = await getState();
      const body = await readJsonBody(req);

      const next = {
        inventory: current.inventory,
        multipliers: current.multipliers,
        nextMouseDueAt: current.nextMouseDueAt
      };

      if (body && typeof body === "object") {
        if (body.inventory && typeof body.inventory === "object") {
          next.inventory = { ...current.inventory, ...body.inventory };
        }

        if (body.multipliers && typeof body.multipliers === "object") {
          next.multipliers = { ...current.multipliers, ...body.multipliers };
        }
      }

      const sanitized = sanitizeState(next);
      ensureMouseSchedule(sanitized);
      await setState(sanitized);
      sendJson(res, 200, { ok: true, state: responseState(sanitized) });
      return;
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : "Unexpected server error"
    });
  }
};
