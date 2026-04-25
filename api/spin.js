const {
  ensureMouseSchedule,
  getProductChancePercentages,
  pickPrizeAndMutateState,
  getState,
  setState
} = require("./_lib/wheel-state");

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const state = await getState();
    ensureMouseSchedule(state);

    const prize = pickPrizeAndMutateState(state, Date.now());
    await setState(state);

    sendJson(res, 200, {
      ok: true,
      prize,
      state: {
        inventory: state.inventory,
        multipliers: state.multipliers,
        nextMouseDueAt: state.nextMouseDueAt,
        chancePercentages: getProductChancePercentages(state)
      }
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : "Unexpected server error"
    });
  }
};
