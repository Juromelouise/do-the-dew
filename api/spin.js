const {
  ensureMouseSchedule,
  getProductChancePercentages,
  pickPrizeAndMutateState,
  saveStateWithRetry
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
    // CAS retry: if an admin save (or another spin) lands between our read
    // and write, the whole pick is redone against the fresh state.
    const { state, result: prize } = await saveStateWithRetry((current) => {
      ensureMouseSchedule(current);
      return pickPrizeAndMutateState(current, Date.now());
    });

    sendJson(res, 200, {
      ok: true,
      prize,
      state: {
        inventory: state.inventory,
        multipliers: state.multipliers,
        settings: state.settings,
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
