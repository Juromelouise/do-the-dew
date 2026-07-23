const STATE_KEY = "dew-wheel-state-v16";

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
  },
  nextMouseDueAt: null,
};

const EVENT_START_HOUR = 10;
const EVENT_END_HOUR = 22;
const ENFORCE_EVENT_WINDOW = false;
const LOSS_LABELS = ["Try Again", "Better Luck Next Time"];
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
      return pickLossLabel();
    }

    state.inventory[forcedMouse] -= 1;
    state.nextMouseDueAt = nowMs + randomMouseIntervalMs(state.settings);
    return forcedMouse;
  }

  if (!inEventWindow) {
    return pickLossLabel();
  }

  if (!shouldAwardRegularProduct(state)) {
    return pickLossLabel();
  }

  // While the timer is reserving mice for its forced drops, regular spins
  // cannot win them. With the timer disabled, mice behave like normal prizes.
  const weightedPick = pickWeightedProduct(state, {
    excludeKeys: mouseTimerActive ? mouseKeys : [],
  });

  if (!weightedPick) {
    return pickLossLabel();
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

async function callKv(parts) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error(
      "KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN."
    );
  }

  const path = parts.map((part) => encodeURIComponent(String(part))).join("/");
  const response = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`KV command failed with status ${response.status}.`);
  }

  return response.json();
}

// Single command sent as a JSON-array body (Upstash REST format). Used for
// EVAL, whose script/payload arguments don't fit the path-segment form.
async function callKvCommand(command) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error(
      "KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN."
    );
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`KV command failed with status ${response.status}.`);
  }

  return response.json();
}

// Writes the blob only if the stored version still matches expectedVersion
// (legacy blobs without a version always match). Returns 1 on write, 0 on
// conflict.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, decoded = pcall(cjson.decode, cur)
  if ok and type(decoded) == 'table' and decoded.version ~= nil then
    if tonumber(decoded.version) ~= tonumber(ARGV[2]) then
      return 0
    end
  end
end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

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
    const fresh = sanitizeState(cloneDefaults());
    ensureMouseSchedule(fresh);
    // SET NX: only the first concurrent initializer wins; a plain SET here
    // could land late and clobber a CAS write that already happened.
    const setResult = await callKvCommand([
      "SET",
      STATE_KEY,
      JSON.stringify(fresh),
      "NX",
    ]);
    if (setResult && setResult.result === "OK") {
      return fresh;
    }

    // Someone else initialized (and possibly mutated) the state first.
    const retry = await callKv(["get", STATE_KEY]);
    const retryRaw = retry && retry.result;
    if (retryRaw) {
      const parsedRetry =
        typeof retryRaw === "string" ? JSON.parse(retryRaw) : retryRaw;
      const sanitizedRetry = sanitizeState(parsedRetry);
      ensureMouseSchedule(sanitizedRetry);
      return sanitizedRetry;
    }

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

// Compare-and-swap write: succeeds only if nobody else wrote since this state
// was read (state.version unchanged). Returns the persisted sanitized state,
// or null on version conflict.
async function tryWriteState(state) {
  const expectedVersion = Number.isFinite(state.version) ? state.version : 0;
  const sanitized = sanitizeState(state);
  sanitized.version = expectedVersion + 1;

  if (!isKvConfigured()) {
    const currentVersion =
      localStateCache && Number.isFinite(localStateCache.version)
        ? localStateCache.version
        : 0;
    if (localStateCache && currentVersion !== expectedVersion) {
      return null;
    }
    localStateCache = sanitized;
    return sanitized;
  }

  const result = await callKvCommand([
    "EVAL",
    CAS_SCRIPT,
    "1",
    STATE_KEY,
    JSON.stringify(sanitized),
    String(expectedVersion),
  ]);

  return result && Number(result.result) === 1 ? sanitized : null;
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
  setState,
  saveStateWithRetry,
};
