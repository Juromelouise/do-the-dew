const STATE_KEY = "dew-wheel-state-v1";

const DEFAULT_STATE = {
  inventory: {
    "Mountain Dew Shirt": 15,
    "Mountain Dew Keychain": 25,
    "G102 mouse (black)": 2,
    "G102 mouse (white)": 1,
    "G333 (black)": 1,
    "G333 (white)": 1,
    "G335 (black)": 1,
    "G335 (white)": 1
  },
  multipliers: {
    "Mountain Dew Shirt": 0.15,
    "Mountain Dew Keychain": 0.25,
    "G102 mouse (black)": 0.03,
    "G102 mouse (white)": 0.025,
    "G333 (black)": 0.02,
    "G333 (white)": 0.02,
    "G335 (black)": 0.01,
    "G335 (white)": 0.01
  },
  nextMouseDueAt: null
};

const EVENT_START_HOUR = 10;
const EVENT_END_HOUR = 22;
const MOUSE_PRIZE_KEYS = ["G102 mouse (black)", "G102 mouse (white)"];
const MOUSE_INTERVAL_MIN_MS = 3 * 60 * 60 * 1000;
const MOUSE_INTERVAL_MAX_MS = 4 * 60 * 60 * 1000;
const LOSS_LABELS = ["Try Again", "Better Luck Next Time"];
const ESTIMATED_SPINS_PER_HOUR = 40;
const MIN_PRODUCT_WIN_RATE = 0.03;
const MAX_PRODUCT_WIN_RATE = 0.95;
let localStateCache = null;

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function sanitizeState(input) {
  const base = cloneDefaults();
  const source = input || {};

  for (const key of Object.keys(base.inventory)) {
    const value = source.inventory && source.inventory[key];
    if (Number.isFinite(value)) {
      base.inventory[key] = Math.max(0, Math.floor(value));
    }
  }

  for (const key of Object.keys(base.multipliers)) {
    const value = source.multipliers && source.multipliers[key];
    if (Number.isFinite(value) && value >= 0) {
      base.multipliers[key] = Number(value);
    }
  }

  if (Number.isFinite(source.nextMouseDueAt)) {
    base.nextMouseDueAt = Number(source.nextMouseDueAt);
  }

  return base;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomMouseIntervalMs() {
  return randomInt(MOUSE_INTERVAL_MIN_MS, MOUSE_INTERVAL_MAX_MS);
}

function getEventWindow(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const start = new Date(now);
  const end = new Date(now);
  start.setHours(EVENT_START_HOUR, 0, 0, 0);
  end.setHours(EVENT_END_HOUR, 0, 0, 0);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function isWithinEventWindow(nowMs = Date.now()) {
  const { startMs, endMs } = getEventWindow(nowMs);
  return nowMs >= startMs && nowMs <= endMs;
}

function getRemainingEventMs(nowMs) {
  const { startMs, endMs } = getEventWindow(nowMs);

  if (nowMs < startMs) {
    return endMs - startMs;
  }

  if (nowMs > endMs) {
    return 0;
  }

  return endMs - nowMs;
}

function getRemainingProductCount(state) {
  return Object.values(state.inventory).reduce((sum, count) => sum + count, 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shouldAwardRegularProduct(state, nowMs) {
  const remainingProducts = getRemainingProductCount(state);
  if (remainingProducts <= 0) {
    return false;
  }

  const remainingEventMs = getRemainingEventMs(nowMs);
  if (remainingEventMs <= 0) {
    return false;
  }

  const remainingHours = remainingEventMs / (60 * 60 * 1000);
  const estimatedRemainingSpins = Math.max(1, Math.ceil(remainingHours * ESTIMATED_SPINS_PER_HOUR));
  const targetWinRate = clamp(
    remainingProducts / estimatedRemainingSpins,
    MIN_PRODUCT_WIN_RATE,
    MAX_PRODUCT_WIN_RATE
  );

  return Math.random() < targetWinRate;
}

function pickLossLabel() {
  return LOSS_LABELS[Math.floor(Math.random() * LOSS_LABELS.length)];
}

function getInventoryCountForKeys(state, keys) {
  return keys.reduce((sum, key) => sum + (state.inventory[key] || 0), 0);
}

function pickWeightedProduct(state, options = {}) {
  const includeOnlyKeys = options.includeOnlyKeys || null;
  const excludeKeys = options.excludeKeys || [];
  const includeSet = includeOnlyKeys ? new Set(includeOnlyKeys) : null;
  const excludeSet = new Set(excludeKeys);

  const candidates = Object.entries(state.inventory)
    .filter(([name, count]) => {
      if (count <= 0) {
        return false;
      }
      if (includeSet && !includeSet.has(name)) {
        return false;
      }
      if (excludeSet.has(name)) {
        return false;
      }
      return true;
    })
    .map(([name, count]) => ({
      name,
      weight: count * (state.multipliers[name] || 1)
    }))
    .filter((item) => item.weight > 0);

  const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
  if (!totalWeight) {
    return null;
  }

  let roll = Math.random() * totalWeight;
  for (const item of candidates) {
    roll -= item.weight;
    if (roll <= 0) {
      return item.name;
    }
  }

  return candidates[candidates.length - 1].name;
}

function getProductChancePercentages(state) {
  const entries = Object.entries(state.inventory).filter(([, count]) => count > 0);
  const totalWeight = entries.reduce((sum, [name, count]) => sum + (count * (state.multipliers[name] || 1)), 0);

  if (!totalWeight) {
    return {};
  }

  return Object.fromEntries(
    entries.map(([name, count]) => {
      const weightedChance = (count * (state.multipliers[name] || 1)) / totalWeight;
      return [name, Number((weightedChance * 100).toFixed(2))];
    })
  );
}

function pickPrizeAndMutateState(state, nowMs = Date.now()) {
  const inEventWindow = isWithinEventWindow(nowMs);
  const mouseAvailable = getInventoryCountForKeys(state, MOUSE_PRIZE_KEYS) > 0;
  const shouldForceMouse = inEventWindow && mouseAvailable && Number.isFinite(state.nextMouseDueAt) && nowMs >= state.nextMouseDueAt;

  if (shouldForceMouse) {
    const forcedMouse = pickWeightedProduct(state, { includeOnlyKeys: MOUSE_PRIZE_KEYS });
    if (!forcedMouse) {
      return pickLossLabel();
    }

    state.inventory[forcedMouse] -= 1;
    state.nextMouseDueAt = nowMs + randomMouseIntervalMs();
    return forcedMouse;
  }

  if (!inEventWindow) {
    return pickLossLabel();
  }

  if (!shouldAwardRegularProduct(state, nowMs)) {
    return pickLossLabel();
  }

  const weightedPick = pickWeightedProduct(state, {
    excludeKeys: inEventWindow && mouseAvailable ? MOUSE_PRIZE_KEYS : []
  });

  if (!weightedPick) {
    return pickLossLabel();
  }

  state.inventory[weightedPick] -= 1;
  return weightedPick;
}

function ensureMouseSchedule(state, nowMs = Date.now()) {
  if (Number.isFinite(state.nextMouseDueAt)) {
    return;
  }

  const { startMs, endMs } = getEventWindow(nowMs);

  if (nowMs < startMs) {
    state.nextMouseDueAt = startMs + randomMouseIntervalMs();
    return;
  }

  if (nowMs > endMs) {
    state.nextMouseDueAt = null;
    return;
  }

  state.nextMouseDueAt = nowMs + randomMouseIntervalMs();
}

async function callKv(parts) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.");
  }

  const path = parts.map((part) => encodeURIComponent(String(part))).join("/");
  const response = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`KV command failed with status ${response.status}.`);
  }

  return response.json();
}

function isKvConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function getLocalFallbackState() {
  if (!localStateCache) {
    localStateCache = cloneDefaults();
    ensureMouseSchedule(localStateCache);
  }

  const sanitized = sanitizeState(localStateCache);
  ensureMouseSchedule(sanitized);
  localStateCache = sanitized;
  return sanitized;
}

async function getState() {
  if (!isKvConfigured()) {
    return getLocalFallbackState();
  }

  const result = await callKv(["get", STATE_KEY]);
  const raw = result && result.result;
  if (!raw) {
    const fresh = cloneDefaults();
    ensureMouseSchedule(fresh);
    await setState(fresh);
    return fresh;
  }

  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const sanitized = sanitizeState(parsed);
  ensureMouseSchedule(sanitized);
  return sanitized;
}

async function setState(state) {
  const sanitized = sanitizeState(state);

  if (!isKvConfigured()) {
    localStateCache = sanitized;
    return;
  }

  await callKv(["set", STATE_KEY, JSON.stringify(sanitized)]);
}

module.exports = {
  DEFAULT_STATE,
  sanitizeState,
  ensureMouseSchedule,
  getProductChancePercentages,
  pickPrizeAndMutateState,
  getState,
  setState
};
