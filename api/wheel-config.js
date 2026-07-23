const crypto = require("crypto");
const {
  sanitizeState,
  ensureMouseSchedule,
  getMouseKeys,
  getProductChancePercentages,
  randomMouseIntervalMs,
  getState,
  saveStateWithRetry
} = require("./_lib/wheel-state");

// Change the live passcode by setting the ADMIN_PASSCODE environment variable
// in Vercel (Project Settings -> Environment Variables), then redeploying.
const DEFAULT_ADMIN_PASSCODE = "DEW2026";

function getAdminPasscode() {
  return process.env.ADMIN_PASSCODE || DEFAULT_ADMIN_PASSCODE;
}

function isPasscodeValid(supplied) {
  if (typeof supplied !== "string" || !supplied) {
    return false;
  }

  const expected = Buffer.from(getAdminPasscode());
  const given = Buffer.from(supplied);
  if (expected.length !== given.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, given);
}

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
    settings: state.settings,
    nextMouseDueAt: state.nextMouseDueAt,
    mouseKeys: getMouseKeys(state),
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
      const body = await readJsonBody(req);

      if (!body || typeof body !== "object" || !isPasscodeValid(body.passcode)) {
        sendJson(res, 401, { ok: false, error: "Invalid passcode" });
        return;
      }

      const current = await getState();

      if (body.verifyOnly) {
        sendJson(res, 200, { ok: true, state: responseState(current) });
        return;
      }

      const next = {
        inventory: current.inventory,
        multipliers: current.multipliers,
        settings: current.settings,
        nextMouseDueAt: current.nextMouseDueAt
      };

      // replace: the admin page sends the full maps so items can be removed.
      // Without it, posted keys merge into the existing maps (back-compat).
      if (body.replace) {
        if (body.inventory && typeof body.inventory === "object") {
          next.inventory = body.inventory;
        }

        if (body.multipliers && typeof body.multipliers === "object") {
          next.multipliers = body.multipliers;
        }
      } else {
        if (body.inventory && typeof body.inventory === "object") {
          next.inventory = { ...current.inventory, ...body.inventory };
        }

        if (body.multipliers && typeof body.multipliers === "object") {
          next.multipliers = { ...current.multipliers, ...body.multipliers };
        }
      }

      if (body.settings && typeof body.settings === "object") {
        next.settings = { ...current.settings, ...body.settings };
      }

      const sanitized = sanitizeState(next);
      const nowMs = Date.now();

      if (body.mouseTimerAction === "reschedule") {
        sanitized.nextMouseDueAt = null;
      } else if (body.mouseTimerAction === "dueNow") {
        sanitized.nextMouseDueAt = nowMs;
      } else if (
        sanitized.settings.mouseTimerEnabled &&
        Number.isFinite(sanitized.nextMouseDueAt)
      ) {
        // If tightened interval settings left the scheduled drop further away
        // than the new maximum allows, reschedule it within the new range.
        const maxDueAt =
          nowMs + sanitized.settings.mouseIntervalMaxMinutes * 60 * 1000;
        if (sanitized.nextMouseDueAt > maxDueAt) {
          sanitized.nextMouseDueAt =
            nowMs + randomMouseIntervalMs(sanitized.settings);
        }
      }

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
