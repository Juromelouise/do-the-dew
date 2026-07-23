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

// Full state — only for passcode-authenticated responses.
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

// Public shape (game client). Omits nextMouseDueAt/mouseKeys: the exact time
// of the next guaranteed mouse drop must not be visible to players.
function publicResponseState(state) {
  return {
    inventory: state.inventory,
    multipliers: state.multipliers,
    settings: state.settings,
    chancePercentages: getProductChancePercentages(state)
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const state = await getState();
      sendJson(res, 200, { ok: true, state: publicResponseState(state) });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);

      if (!body || typeof body !== "object" || !isPasscodeValid(body.passcode)) {
        sendJson(res, 401, { ok: false, error: "Invalid passcode" });
        return;
      }

      if (body.verifyOnly) {
        const current = await getState();
        sendJson(res, 200, { ok: true, state: responseState(current) });
        return;
      }

      // CAS retry: the mutator runs against a fresh read each attempt, so
      // concurrent spins can't clobber this save (or vice versa).
      const { state } = await saveStateWithRetry((current) => {
        const wasMouseTimerEnabled = current.settings.mouseTimerEnabled;
        const liveInventory = { ...current.inventory };

        const next = {
          inventory: current.inventory,
          multipliers: current.multipliers,
          settings: current.settings,
          nextMouseDueAt: current.nextMouseDueAt
        };

        // replace: the admin page sends the full maps so items can be
        // removed. Without it, posted keys merge into the existing maps.
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

        // For items whose stock the admin did NOT touch, keep the live count
        // from this read instead of the (possibly stale) posted value, so
        // prizes won while the admin was editing stay decremented.
        if (Array.isArray(body.preserveQtyFor)) {
          for (const name of body.preserveQtyFor) {
            if (
              typeof name === "string" &&
              name in sanitized.inventory &&
              Number.isFinite(liveInventory[name])
            ) {
              sanitized.inventory[name] = liveInventory[name];
            }
          }
        }

        const nowMs = Date.now();

        if (body.mouseTimerAction === "reschedule") {
          sanitized.nextMouseDueAt = null;
        } else if (body.mouseTimerAction === "dueNow") {
          sanitized.nextMouseDueAt = nowMs;
        } else if (
          sanitized.settings.mouseTimerEnabled &&
          !wasMouseTimerEnabled
        ) {
          // Timer just turned on: start a fresh schedule instead of firing on
          // whatever stale (possibly past-due) timestamp was left behind.
          sanitized.nextMouseDueAt = null;
        } else if (
          sanitized.settings.mouseTimerEnabled &&
          Number.isFinite(sanitized.nextMouseDueAt)
        ) {
          // If tightened interval settings left the scheduled drop further
          // away than the new maximum allows, reschedule within the new range.
          const maxDueAt =
            nowMs + sanitized.settings.mouseIntervalMaxMinutes * 60 * 1000;
          if (sanitized.nextMouseDueAt > maxDueAt) {
            sanitized.nextMouseDueAt =
              nowMs + randomMouseIntervalMs(sanitized.settings);
          }
        }

        ensureMouseSchedule(sanitized);

        // Copy the sanitized result back onto the CAS-tracked object.
        current.inventory = sanitized.inventory;
        current.multipliers = sanitized.multipliers;
        current.settings = sanitized.settings;
        current.nextMouseDueAt = sanitized.nextMouseDueAt;
      });

      sendJson(res, 200, { ok: true, state: responseState(state) });
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
