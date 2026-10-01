const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = {
  inventory: {
    "Mountain Dew Shirt": 2,
    "Mountain Dew Keychain": 10,
    "G102 mouse (black)": 1,
    "G102 mouse (white)": 2,
    "G333 (black)": 0,
    "G333 (white)": 0,
    "G333 (lilac)": 0,
    "G335 (black)": 0,
    "G335 (white)": 1,
  },
  multipliers: {
    "Mountain Dew Shirt": 1.85,
    "Mountain Dew Keychain": 2.75,
    "G102 mouse (black)": 1.0,
    "G102 mouse (white)": 1.0,
    "G333 (black)": 0.9,
    "G333 (white)": 0,
    "G333 (lilac)": 0.9,
    "G335 (black)": 0.5,
    "G335 (white)": 0.01,
  },
  settings: {
    // Percent chance (0-100) that any single spin wins a prize at all,
    // as long as stock remains. The rest of spins land on a loss slice.
    masterWinRate: 95,
    mouseTimerEnabled: true,
    mouseIntervalMinMinutes: 135,
    mouseIntervalMaxMinutes: 240,
    // Relative chance of each loss label whenever a spin lands on a loss.
    // The loss share itself is 100 - masterWinRate; these only split it.
    // Keys must match LOSS_LABELS. A label weighted 0 is never landed on.
    lossWeights: {
      "Better Luck Next Time": 1,
      "Spin The Dew Again": 1,
    },
    // How many slices of each loss label the wheel shows (1 to
    // MAX_LOSS_SLICES). Display only: the odds come from lossWeights.
    lossSlices: {
      "Better Luck Next Time": 3,
      "Spin The Dew Again": 3,
    },
  },
  nextMouseDueAt: null,
};

const EVENT_START_HOUR = 10;
const EVENT_END_HOUR = 22;
const ENFORCE_EVENT_WINDOW = false;
const LOSS_LABELS = ["Better Luck Next Time", "Spin The Dew Again"];
const MAX_LOSS_SLICES = 10;
// Item names matching a loss label would be shown as losses by the game
// client, so they are rejected as inventory keys.
const RESERVED_NAMES = new Set(LOSS_LABELS.map((label) => label.toLowerCase()));
const MOUSE_NAME_PATTERN = /mouse/i;
const MAX_ITEMS = 40;
const MAX_ITEM_NAME_LENGTH = 60;
const WRITE_MAX_ATTEMPTS = 5;
let localStateCache = null;

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const settings = { ...DEFAULT_STATE.settings };

  const rate = Number(source.masterWinRate);
  if (Number.isFinite(rate)) {
    settings.masterWinRate = clamp(rate, 0, 100);
  }

  if (typeof source.mouseTimerEnabled === "boolean") {
    settings.mouseTimerEnabled = source.mouseTimerEnabled;
  }

  const minMinutes = Number(source.mouseIntervalMinMinutes);
  if (Number.isFinite(minMinutes)) {
    settings.mouseIntervalMinMinutes = clamp(Math.round(minMinutes), 1, 24 * 60);
  }

  const maxMinutes = Number(source.mouseIntervalMaxMinutes);
  if (Number.isFinite(maxMinutes)) {
    settings.mouseIntervalMaxMinutes = clamp(Math.round(maxMinutes), 1, 24 * 60);
  }

  if (settings.mouseIntervalMaxMinutes < settings.mouseIntervalMinMinutes) {
    const swap = settings.mouseIntervalMinMinutes;
    settings.mouseIntervalMinMinutes = settings.mouseIntervalMaxMinutes;
    settings.mouseIntervalMaxMinutes = swap;
  }

  // Fresh objects: the spread above would share DEFAULT_STATE's maps.
  const sourceLossWeights =
    source.lossWeights && typeof source.lossWeights === "object"
      ? source.lossWeights
      : {};
  const sourceLossSlices =
    source.lossSlices && typeof source.lossSlices === "object"
      ? source.lossSlices
      : {};
  settings.lossWeights = {};
  settings.lossSlices = {};
  for (const label of LOSS_LABELS) {
    const raw = Number(sourceLossWeights[label]);
    settings.lossWeights[label] =
      Number.isFinite(raw) && raw >= 0
        ? raw
        : DEFAULT_STATE.settings.lossWeights[label];

    const slices = Math.round(Number(sourceLossSlices[label]));
    settings.lossSlices[label] = Number.isFinite(slices)
      ? clamp(slices, 1, MAX_LOSS_SLICES)
      : DEFAULT_STATE.settings.lossSlices[label];
  }

  return settings;
}

// Item names are dynamic: whatever keys exist in `inventory` define the prize
// list. A missing/invalid inventory object falls back to the defaults, but an
// explicit object (even a smaller one) is respected so items can be removed.
function sanitizeState(input) {
  const source = input || {};
  const state = {
    inventory: {},
    multipliers: {},
    settings: sanitizeSettings(source.settings),
    nextMouseDueAt: null,
    version: Number.isFinite(source && source.version)
      ? Math.max(0, Math.floor(source.version))
      : 0,
  };

  const sourceInventory =
    source.inventory && typeof source.inventory === "object"
      ? source.inventory
      : cloneDefaults().inventory;

  for (const rawName of Object.keys(sourceInventory)) {
    if (Object.keys(state.inventory).length >= MAX_ITEMS) {
      break;
    }

    const name = String(rawName).trim().slice(0, MAX_ITEM_NAME_LENGTH);
    if (!name || RESERVED_NAMES.has(name.toLowerCase())) {
      continue;
    }

    const value = Number(sourceInventory[rawName]);
    state.inventory[name] = Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  }

  const sourceMultipliers =
    source.multipliers && typeof source.multipliers === "object"
      ? source.multipliers
      : {};

  for (const name of Object.keys(state.inventory)) {
    const raw = Number(sourceMultipliers[name]);
    if (Number.isFinite(raw) && raw >= 0) {
      state.multipliers[name] = raw;
    } else if (Number.isFinite(DEFAULT_STATE.multipliers[name])) {
      state.multipliers[name] = DEFAULT_STATE.multipliers[name];
    } else {
      state.multipliers[name] = 1;
    }
  }

  if (Number.isFinite(source.nextMouseDueAt)) {
    state.nextMouseDueAt = Number(source.nextMouseDueAt);
  }

  return state;
}

function getMouseKeys(state) {
  return Object.keys(state.inventory).filter((name) =>
    MOUSE_NAME_PATTERN.test(name)
  );
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomMouseIntervalMs(settings) {
  const minMs = settings.mouseIntervalMinMinutes * 60 * 1000;
  const maxMs = settings.mouseIntervalMaxMinutes * 60 * 1000;
  return randomInt(minMs, maxMs);
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

function isPrizeWindowOpen(nowMs = Date.now()) {
  if (!ENFORCE_EVENT_WINDOW) {
    return true;
  }

  return isWithinEventWindow(nowMs);
}

function getRemainingProductCount(state) {
  return Object.values(state.inventory).reduce((sum, count) => sum + count, 0);
}

function shouldAwardRegularProduct(state) {
  if (getRemainingProductCount(state) <= 0) {
    return false;
  }

  return Math.random() * 100 < state.settings.masterWinRate;
}

function getLossWeightEntries(state) {
  const configured =
    state && state.settings && state.settings.lossWeights
      ? state.settings.lossWeights
      : {};

  return LOSS_LABELS.map((label) => {
    const raw = Number(configured[label]);
    return { label, weight: Number.isFinite(raw) && raw > 0 ? raw : 0 };
  }).filter((entry) => entry.weight > 0);
}

// Which loss label a losing spin shows, weighted by the admin-set
// settings.lossWeights. If every label is weighted 0 the split falls back
// to even, so a loss can always be displayed.
function pickLossLabel(state) {
  const entries = getLossWeightEntries(state);
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!totalWeight) {
    return LOSS_LABELS[Math.floor(Math.random() * LOSS_LABELS.length)];
  }

  let roll = Math.random() * totalWeight;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) {
      return entry.label;
    }
  }

  return entries[entries.length - 1].label;
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
      weight: count * (state.multipliers[name] || 1),
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
  const entries = Object.entries(state.inventory).filter(
    ([, count]) => count > 0
  );
  const totalWeight = entries.reduce(
    (sum, [name, count]) => sum + count * (state.multipliers[name] || 1),
    0
  );

  if (!totalWeight) {
    return {};
  }

  return Object.fromEntries(
    entries.map(([name, count]) => {
      const weightedChance =
        (count * (state.multipliers[name] || 1)) / totalWeight;
      return [name, Number((weightedChance * 100).toFixed(2))];
    })
  );
}

function pickPrizeAndMutateState(state, nowMs = Date.now()) {
  const inEventWindow = isPrizeWindowOpen(nowMs);
  const mouseKeys = getMouseKeys(state);
  const mouseAvailable = getInventoryCountForKeys(state, mouseKeys) > 0;
  const mouseTimerActive = state.settings.mouseTimerEnabled && mouseAvailable;
  const shouldForceMouse =
    inEventWindow &&
    mouseTimerActive &&
    Number.isFinite(state.nextMouseDueAt) &&
    nowMs >= state.nextMouseDueAt;

  if (shouldForceMouse) {
    const forcedMouse = pickWeightedProduct(state, {
      includeOnlyKeys: mouseKeys,
    });
    if (!forcedMouse) {
      return pickLossLabel(state);
    }

    state.inventory[forcedMouse] -= 1;
    state.nextMouseDueAt = nowMs + randomMouseIntervalMs(state.settings);
    return forcedMouse;
  }

  if (!inEventWindow) {
    return pickLossLabel(state);
  }

  if (!shouldAwardRegularProduct(state)) {
    return pickLossLabel(state);
  }

  // While the timer is reserving mice for its forced drops, regular spins
  // cannot win them. With the timer disabled, mice behave like normal prizes.
  const weightedPick = pickWeightedProduct(state, {
    excludeKeys: mouseTimerActive ? mouseKeys : [],
  });

  if (!weightedPick) {
    return pickLossLabel(state);
  }

  state.inventory[weightedPick] -= 1;
  return weightedPick;
}

function ensureMouseSchedule(state, nowMs = Date.now()) {
  if (!state.settings.mouseTimerEnabled) {
    return;
  }

  if (Number.isFinite(state.nextMouseDueAt)) {
    return;
  }

  if (!ENFORCE_EVENT_WINDOW) {
    state.nextMouseDueAt = nowMs + randomMouseIntervalMs(state.settings);
    return;
  }

  const { startMs, endMs } = getEventWindow(nowMs);

  if (nowMs < startMs) {
    state.nextMouseDueAt = startMs + randomMouseIntervalMs(state.settings);
    return;
  }

  if (nowMs > endMs) {
    state.nextMouseDueAt = null;
    return;
  }

  state.nextMouseDueAt = nowMs + randomMouseIntervalMs(state.settings);
}

// State lives in memory and is mirrored to this file after every write, so
// prize stock survives server restarts. Delete the file to reset to
// DEFAULT_STATE. Single process only (scripts/pvp-local-server.js).
const STATE_FILE = path.join(__dirname, "..", "..", "data", "wheel-state.json");

// Missing file = first run. A corrupt file throws instead of falling back to
// defaults, which would overwrite the real stock counts on the next spin.
function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// Temp file + rename so a crash mid-write can't leave a half-written file.
function writeStateFile(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tempFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, STATE_FILE);
}

async function getState() {
  if (!localStateCache) {
    localStateCache = readStateFile() || cloneDefaults();
  }

  localStateCache = sanitizeState(localStateCache);
  ensureMouseSchedule(localStateCache);
  // Copy: callers mutate the result before tryWriteState decides whether the
  // write lands, so a failed write must not leak into the cache.
  return sanitizeState(localStateCache);
}

// Compare-and-swap write: succeeds only if nobody else wrote since this state
// was read (state.version unchanged). Returns the persisted sanitized state,
// or null on version conflict.
async function tryWriteState(state) {
  if (state.version !== localStateCache.version) {
    return null;
  }

  const sanitized = sanitizeState(state);
  sanitized.version = state.version + 1;
  writeStateFile(sanitized);
  localStateCache = sanitized;
  return sanitized;
}

// Read-modify-write with optimistic concurrency: `mutate(state)` is applied to
// a fresh read each attempt, and the write only lands if no concurrent writer
// interleaved. Prevents spins and admin saves from silently clobbering each
// other. Returns { state, result } where result is mutate's return value.
async function saveStateWithRetry(mutate) {
  let lastError = null;

  for (let attempt = 0; attempt < WRITE_MAX_ATTEMPTS; attempt++) {
    const state = await getState();
    const result = mutate(state);

    try {
      const written = await tryWriteState(state);
      if (written) {
        return { state: written, result };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("State write conflicted too many times.");
}

module.exports = {
  DEFAULT_STATE,
  MAX_ITEMS,
  LOSS_LABELS,
  sanitizeState,
  ensureMouseSchedule,
  getMouseKeys,
  getProductChancePercentages,
  pickPrizeAndMutateState,
  randomMouseIntervalMs,
  getState,
  saveStateWithRetry,
};
