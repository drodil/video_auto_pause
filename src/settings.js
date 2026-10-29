// Shared settings model for the background worker, content scripts, and
// extension pages. This classic script can be injected more than once into the
// same content-script world, so it only uses function declarations and
// globalThis assignments (top-level const/let would throw on re-injection).

globalThis.DEFAULT_SETTINGS = Object.freeze({
  autopause: true,
  autoresume: true,
  muteVideo: false,
  allowAudio: true,
  scrollpause: false,
  lockpause: true,
  lockresume: true,
  focuspause: false,
  focusresume: false,
  disabled: false,
  cursorTracking: false,
  manualPause: true,
  debugMode: false,
  disableOnFullscreen: true,
  pauseDelay: 0,
  resumeDelay: 0,
  rewindSeconds: 0,
  playbackSpeed: 0,
  fadeDuration: 0,
  showPipButton: false,
  showVideoOverlay: false,
  blockAutoplay: false,
  disableAutoplayNext: false,
  pauseAtEnd: false,
  contentShortcutsEnabled: false,
  contentShortcutKeys: Object.freeze({
    seekBackward: "j",
    seekForward: "l",
    frameBackward: "ArrowLeft",
    frameForward: "ArrowRight",
    toggleLoop: "b",
    bookmark: "m",
    screenshot: "p",
    togglePip: "i",
    toggleCaptions: "c",
  }),
  idlePauseMinutes: 0,
  pauseOnLowBattery: false,
  pauseOnAudioOutputDisconnect: false,
  quietHoursStart: "",
  quietHoursEnd: "",
  peekMode: false,
  liveStreamMute: true,
  muteDuringAds: true,
  pauseAfterAdEnds: false,
  autoSkipAds: true,
  speedUpAds: true,
  prioritizeActiveTabMedia: false,
  singleVideoPlayback: true,
  onlyConfiguredSites: false,
  siteRules: Object.freeze([]),
});

globalThis.SETTINGS_SCHEMA_VERSION = 1;
globalThis.DEFAULT_PROFILE_ID = "default";
globalThis.PROFILE_IDS_KEY = "vapProfileIds";
globalThis.ACTIVE_PROFILE_KEY = "vapActiveProfileId";
globalThis.MAX_PROFILE_NAME_LENGTH = 40;
globalThis.MAX_SHORTCUT_KEY_LENGTH = 20;

// Numeric settings are clamped to [0, max]; playbackSpeed uses 0.25 steps and
// every other numeric setting is a whole number.
globalThis.NUMERIC_SETTING_LIMITS = Object.freeze({
  pauseDelay: Object.freeze({ max: Number.POSITIVE_INFINITY }),
  resumeDelay: Object.freeze({ max: Number.POSITIVE_INFINITY }),
  fadeDuration: Object.freeze({ max: Number.POSITIVE_INFINITY }),
  rewindSeconds: Object.freeze({ max: 60 }),
  playbackSpeed: Object.freeze({ max: 4, step: 0.25 }),
  idlePauseMinutes: Object.freeze({ max: 240 }),
});

globalThis.TIME_SETTINGS = Object.freeze(["quietHoursStart", "quietHoursEnd"]);

// Settings that can be customized per site (everything that is not global).
globalThis.SITE_OVERRIDE_SETTINGS = Object.freeze(
  Object.keys(DEFAULT_SETTINGS).filter(
    (setting) =>
      !["disabled", "onlyConfiguredSites", "siteRules"].includes(setting),
  ),
);

// Flat sync keys written by releases before settings profiles (<= 1.14.x).
globalThis.LEGACY_SETTING_KEYS = Object.freeze([
  ...Object.keys(DEFAULT_SETTINGS),
  "audioFading",
  "includedDomains",
  "excludedDomains",
]);

function getExtensionApi() {
  return globalThis.chrome?.runtime ? globalThis.chrome : globalThis.browser;
}

function getExtensionStorage() {
  const { storage } = getExtensionApi();
  return { sync: storage.sync, local: storage.local };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getProfileStorageKey(profileId) {
  return `vapProfile:${profileId}`;
}

function isSettingsStorageChange(changes, areaName) {
  if (areaName === "sync") {
    return Object.keys(changes).some(
      (key) => key === PROFILE_IDS_KEY || key.startsWith("vapProfile:"),
    );
  }
  return areaName === "local" && ACTIVE_PROFILE_KEY in changes;
}

function isValidClockTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function clampNumericSetting(setting, value) {
  const limits = NUMERIC_SETTING_LIMITS[setting];
  const number = Number(value);
  if (!limits || !Number.isFinite(number)) {
    return 0;
  }
  const bounded = Math.min(limits.max, Math.max(0, number));
  return limits.step
    ? Math.round(bounded / limits.step) * limits.step
    : Math.floor(bounded);
}

// Domains

function normalizeDomain(entry) {
  if (typeof entry !== "string") {
    return "";
  }
  return entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, "")
    .split(/[/?#]/, 1)[0]
    .replace(/^\*\./, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

function isValidDomain(domain) {
  return (
    typeof domain === "string" &&
    domain.length <= 253 &&
    domain
      .split(".")
      .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  );
}

function matchesDomain(hostname, domain) {
  const normalizedHostname = normalizeDomain(hostname);
  const normalizedDomain = normalizeDomain(domain);
  return (
    Boolean(normalizedDomain) &&
    (normalizedHostname === normalizedDomain ||
      normalizedHostname.endsWith(`.${normalizedDomain}`))
  );
}

// Returns the most specific site rule matching the hostname.
function findSiteRule(hostname, settings) {
  let bestRule;
  let bestLength = -1;
  for (const rule of Array.isArray(settings?.siteRules)
    ? settings.siteRules
    : []) {
    if (!rule || !matchesDomain(hostname, rule.domain)) {
      continue;
    }
    const length = normalizeDomain(rule.domain).length;
    if (length > bestLength) {
      bestRule = rule;
      bestLength = length;
    }
  }
  return bestRule;
}

function isSiteEnabled(hostname, settings) {
  const rule = findSiteRule(hostname, settings);
  if (typeof rule?.enabled === "boolean") {
    return rule.enabled;
  }
  return !settings.onlyConfiguredSites || Boolean(rule);
}

function getSiteSettings(hostname, settings) {
  const rule = findSiteRule(hostname, settings);
  return rule ? { ...settings, ...(rule.overrides ?? {}) } : settings;
}

// Adds a rule or replaces the rule for the same domain in place.
function upsertSiteRule(siteRules, rule) {
  const domain = normalizeDomain(rule.domain);
  const rules = Array.isArray(siteRules) ? [...siteRules] : [];
  const index = rules.findIndex(
    (existing) => existing && normalizeDomain(existing.domain) === domain,
  );
  const updatedRule = { ...rule, domain };
  if (index === -1) {
    rules.push(updatedRule);
  } else {
    rules.splice(index, 1, updatedRule);
  }
  return rules.filter(
    (existing, position) =>
      position === rules.indexOf(updatedRule) ||
      !existing ||
      normalizeDomain(existing.domain) !== domain,
  );
}

// Normalization and validation

function normalizeSettings(settings = {}) {
  const source = isPlainObject(settings) ? settings : {};
  const normalized = {};
  for (const [setting, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    normalized[setting] = hasOwn(source, setting)
      ? source[setting]
      : defaultValue;
  }
  normalized.contentShortcutKeys = {
    ...DEFAULT_SETTINGS.contentShortcutKeys,
    ...(isPlainObject(source.contentShortcutKeys)
      ? source.contentShortcutKeys
      : {}),
  };
  normalized.siteRules = (
    Array.isArray(source.siteRules) ? source.siteRules : []
  )
    .filter((rule) => isPlainObject(rule) && typeof rule.domain === "string")
    .map((rule) => ({
      ...rule,
      enabled: rule.enabled !== false,
      overrides: isPlainObject(rule.overrides) ? { ...rule.overrides } : {},
    }));
  return normalized;
}

// Stores only values that differ from the defaults (normalizeSettings fills
// them back in) to stay well within the sync storage per-item quota.
function compactSettings(settings) {
  const compact = {};
  for (const [setting, value] of Object.entries(normalizeSettings(settings))) {
    if (setting === "siteRules") {
      if (value.length) {
        compact.siteRules = value.map(({ enabled, overrides, ...rule }) => ({
          ...rule,
          ...(enabled === false ? { enabled } : {}),
          ...(Object.keys(overrides).length ? { overrides } : {}),
        }));
      }
    } else if (
      JSON.stringify(value) !== JSON.stringify(DEFAULT_SETTINGS[setting])
    ) {
      compact[setting] = value;
    }
  }
  return compact;
}

function toStoredProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    settings: compactSettings(profile.settings),
  };
}

function validateShortcutKeys(value, context) {
  if (!isPlainObject(value)) {
    throw new Error(`${context} has invalid shortcut keys.`);
  }
  const shortcutKeys = { ...DEFAULT_SETTINGS.contentShortcutKeys };
  for (const [action, key] of Object.entries(value)) {
    if (
      !hasOwn(shortcutKeys, action) ||
      typeof key !== "string" ||
      key.length > MAX_SHORTCUT_KEY_LENGTH
    ) {
      throw new Error(`${context} has invalid shortcut keys.`);
    }
    shortcutKeys[action] = key.trim();
  }
  if (hasDuplicateShortcutKeys(shortcutKeys)) {
    throw new Error(`${context} has duplicate shortcut keys.`);
  }
  return shortcutKeys;
}

function hasDuplicateShortcutKeys(shortcutKeys) {
  const assignedKeys = Object.values(shortcutKeys)
    .filter(Boolean)
    .map((key) => key.toLowerCase());
  return new Set(assignedKeys).size !== assignedKeys.length;
}

// Validates one setting value and returns its sanitized form or throws.
function validateSettingValue(setting, value, context) {
  const defaultValue = DEFAULT_SETTINGS[setting];
  if (setting === "contentShortcutKeys") {
    return validateShortcutKeys(value, context);
  }
  if (typeof value !== typeof defaultValue) {
    throw new Error(`${context} has an invalid ${setting} value.`);
  }
  if (typeof defaultValue === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${context} has an invalid ${setting} value.`);
    }
    return clampNumericSetting(setting, value);
  }
  if (
    TIME_SETTINGS.includes(setting) &&
    value !== "" &&
    !isValidClockTime(value)
  ) {
    throw new Error(`${context} must use 24-hour time for ${setting}.`);
  }
  return value;
}

function validateSiteRule(rule) {
  const domain = normalizeDomain(rule?.domain);
  if (!domain || !isValidDomain(domain)) {
    throw new Error("A site rule has an invalid domain.");
  }
  const context = `Site rule ${domain}`;
  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
    throw new Error(`${context} has an invalid enabled value.`);
  }
  if (rule.overrides !== undefined && !isPlainObject(rule.overrides)) {
    throw new Error(`${context} has invalid overrides.`);
  }
  const overrides = {};
  for (const [setting, value] of Object.entries(rule.overrides ?? {})) {
    if (!SITE_OVERRIDE_SETTINGS.includes(setting)) {
      throw new Error(`${context} has an invalid ${setting} value.`);
    }
    overrides[setting] = validateSettingValue(setting, value, context);
  }
  return { domain, enabled: rule.enabled !== false, overrides };
}

// Validates imported settings and returns only the supported, sanitized keys.
function validateSettings(settings) {
  if (!isPlainObject(settings)) {
    throw new Error("Settings must be an object.");
  }
  const validated = {};
  for (const setting of Object.keys(DEFAULT_SETTINGS)) {
    if (!hasOwn(settings, setting)) {
      continue;
    }
    if (setting === "siteRules") {
      if (!Array.isArray(settings.siteRules)) {
        throw new Error("Site rules must be an array.");
      }
      validated.siteRules = settings.siteRules.map(validateSiteRule);
      continue;
    }
    validated[setting] = validateSettingValue(
      setting,
      settings[setting],
      "The settings file",
    );
  }
  if (Object.keys(validated).length === 0) {
    throw new Error("The settings file does not contain supported settings.");
  }
  return validated;
}

function validateProfileName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(
      `Profile names must contain 1 to ${MAX_PROFILE_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function isValidProfileId(id) {
  return typeof id === "string" && /^[a-z\d_-]{1,80}$/i.test(id);
}

function validateSettingsPayload(payload) {
  if (
    !isPlainObject(payload) ||
    payload.schemaVersion !== SETTINGS_SCHEMA_VERSION ||
    !payload.settings
  ) {
    throw new Error("Unsupported or invalid settings file.");
  }
  const settings = validateSettings(payload.settings);
  if (payload.profiles === undefined) {
    return { settings };
  }
  if (!Array.isArray(payload.profiles)) {
    throw new Error("Profiles must be an array.");
  }
  const profileNames = new Set();
  const profiles = payload.profiles.map((profile, index) => {
    const name = validateProfileName(profile?.name);
    if (profileNames.has(name.toLowerCase())) {
      throw new Error("Profile names must be unique.");
    }
    profileNames.add(name.toLowerCase());
    const id =
      name.toLowerCase() === DEFAULT_PROFILE_ID
        ? DEFAULT_PROFILE_ID
        : typeof profile.id === "string" && profile.id
          ? profile.id
          : `profile-${index + 1}`;
    if (!isValidProfileId(id)) {
      throw new Error("A profile has an invalid identifier.");
    }
    return {
      id,
      name: id === DEFAULT_PROFILE_ID ? "Default" : name,
      settings: normalizeSettings(validateSettings(profile.settings)),
    };
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("Profile identifiers must be unique.");
  }
  if (!profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID)) {
    profiles.unshift({
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      settings: normalizeSettings(settings),
    });
  }
  const activeProfileId = profiles.some(
    (profile) => profile.id === payload.activeProfileId,
  )
    ? payload.activeProfileId
    : DEFAULT_PROFILE_ID;
  return { settings, profiles, activeProfileId };
}

// Legacy migration (flat sync settings from releases up to 1.14.x)

function readLegacySettings(storedSync) {
  if (!LEGACY_SETTING_KEYS.some((key) => hasOwn(storedSync, key))) {
    return null;
  }
  const settings = {};
  for (const setting of Object.keys(DEFAULT_SETTINGS)) {
    if (hasOwn(storedSync, setting)) {
      settings[setting] = storedSync[setting];
    }
  }
  if (hasOwn(storedSync, "audioFading") || hasOwn(storedSync, "fadeDuration")) {
    // Audio fading was opt-in with a 200 ms default before 0 meant "off".
    settings.fadeDuration =
      storedSync.audioFading === true
        ? Number.isFinite(storedSync.fadeDuration)
          ? Math.max(0, Math.floor(storedSync.fadeDuration))
          : 200
        : 0;
  }
  const domainList = (value) =>
    (Array.isArray(value) ? value : [])
      .map(normalizeDomain)
      .filter((domain) => domain && isValidDomain(domain));
  const includedDomains = domainList(storedSync.includedDomains);
  const excludedDomains = domainList(storedSync.excludedDomains);
  if (includedDomains.length || excludedDomains.length) {
    let siteRules = Array.isArray(settings.siteRules) ? settings.siteRules : [];
    for (const domain of includedDomains) {
      if (!siteRules.some((rule) => normalizeDomain(rule?.domain) === domain)) {
        siteRules = upsertSiteRule(siteRules, {
          domain,
          enabled: true,
          overrides: {},
        });
      }
    }
    for (const domain of excludedDomains) {
      const existing = siteRules.find(
        (rule) => normalizeDomain(rule?.domain) === domain,
      );
      siteRules = upsertSiteRule(siteRules, {
        overrides: {},
        ...existing,
        domain,
        enabled: false,
      });
    }
    settings.siteRules = siteRules;
    if (includedDomains.length) {
      settings.onlyConfiguredSites = true;
    }
  }
  return settings;
}

// Profiles

function isStoredProfile(profile, id) {
  return (
    isPlainObject(profile) &&
    profile.id === id &&
    typeof profile.name === "string" &&
    profile.name.trim().length > 0 &&
    isPlainObject(profile.settings)
  );
}

// Resolves profiles from raw storage without writing. needsWrite tells
// whether persisting would change storage (first run or legacy migration).
function resolveProfiles(storedSync, storedLocal) {
  const storedIds = Array.isArray(storedSync[PROFILE_IDS_KEY])
    ? storedSync[PROFILE_IDS_KEY]
    : [];
  const profiles = [];
  for (const id of new Set(storedIds)) {
    const profile = storedSync[getProfileStorageKey(id)];
    if (isValidProfileId(id) && isStoredProfile(profile, id)) {
      profiles.push({
        id,
        name: id === DEFAULT_PROFILE_ID ? "Default" : profile.name.trim(),
        settings: normalizeSettings(profile.settings),
      });
    }
  }
  const legacySettings = readLegacySettings(storedSync);
  let needsWrite =
    Boolean(legacySettings) || profiles.length !== storedIds.length;
  let defaultProfile = profiles.find(
    (profile) => profile.id === DEFAULT_PROFILE_ID,
  );
  if (!defaultProfile) {
    defaultProfile = {
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      settings: normalizeSettings(legacySettings ?? {}),
    };
    needsWrite = true;
  } else {
    profiles.splice(profiles.indexOf(defaultProfile), 1);
    needsWrite ||= storedIds[0] !== DEFAULT_PROFILE_ID;
    if (legacySettings) {
      // Another device still running an old release wrote flat settings.
      defaultProfile.settings = normalizeSettings({
        ...defaultProfile.settings,
        ...legacySettings,
        siteRules: (legacySettings.siteRules ?? []).reduce(
          upsertSiteRule,
          defaultProfile.settings.siteRules,
        ),
      });
    }
  }
  profiles.unshift(defaultProfile);
  const activeProfileId = profiles.some(
    (profile) => profile.id === storedLocal?.[ACTIVE_PROFILE_KEY],
  )
    ? storedLocal[ACTIVE_PROFILE_KEY]
    : DEFAULT_PROFILE_ID;
  return { profiles, activeProfileId, needsWrite };
}

async function storeProfiles(
  profiles,
  activeProfileId,
  storage = getExtensionStorage(),
) {
  if (!profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID)) {
    throw new Error("The Default profile is required.");
  }
  if (!profiles.some((profile) => profile.id === activeProfileId)) {
    throw new Error("The active settings profile is missing.");
  }
  const current = await storage.sync.get([
    PROFILE_IDS_KEY,
    ...LEGACY_SETTING_KEYS,
  ]);
  const profileIds = profiles.map((profile) => profile.id);
  const values = { [PROFILE_IDS_KEY]: profileIds };
  for (const profile of profiles) {
    values[getProfileStorageKey(profile.id)] = toStoredProfile(profile);
  }
  await storage.sync.set(values);
  await storage.local.set({ [ACTIVE_PROFILE_KEY]: activeProfileId });
  const obsoleteKeys = [
    ...(Array.isArray(current[PROFILE_IDS_KEY]) ? current[PROFILE_IDS_KEY] : [])
      .filter((id) => !profileIds.includes(id))
      .map(getProfileStorageKey),
    ...LEGACY_SETTING_KEYS.filter((key) => hasOwn(current, key)),
  ];
  if (obsoleteKeys.length) {
    await storage.sync.remove(obsoleteKeys);
  }
}

// Reads all profiles. Pass { persist: true } from code paths that write
// settings so first-run defaults and legacy migrations are saved first.
async function loadProfiles(
  storage = getExtensionStorage(),
  { persist = false } = {},
) {
  const [storedSync, storedLocal] = await Promise.all([
    storage.sync.get(null),
    storage.local.get(ACTIVE_PROFILE_KEY),
  ]);
  const { profiles, activeProfileId, needsWrite } = resolveProfiles(
    storedSync,
    storedLocal,
  );
  if (persist && needsWrite) {
    await storeProfiles(profiles, activeProfileId, storage);
  }
  return { profiles, activeProfileId };
}

async function getActiveProfileSettings(storage = getExtensionStorage()) {
  const { profiles, activeProfileId } = await loadProfiles(storage);
  return profiles.find((profile) => profile.id === activeProfileId).settings;
}

async function updateActiveProfileSettings(
  settingsPatch,
  storage = getExtensionStorage(),
) {
  const { profiles, activeProfileId } = await loadProfiles(storage, {
    persist: true,
  });
  const profile = profiles.find((entry) => entry.id === activeProfileId);
  const updatedProfile = {
    ...profile,
    settings: normalizeSettings({ ...profile.settings, ...settingsPatch }),
  };
  await storage.sync.set({
    [getProfileStorageKey(profile.id)]: toStoredProfile(updatedProfile),
  });
  return updatedProfile.settings;
}

async function activateProfile(profileId, storage = getExtensionStorage()) {
  const { profiles } = await loadProfiles(storage, { persist: true });
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error("The selected settings profile does not exist.");
  }
  await storage.local.set({ [ACTIVE_PROFILE_KEY]: profileId });
}

// Saves the active settings as a new profile and activates it.
async function createProfile(name, storage = getExtensionStorage()) {
  const profileName = validateProfileName(name);
  const { profiles, activeProfileId } = await loadProfiles(storage, {
    persist: true,
  });
  if (
    profileName.toLowerCase() === DEFAULT_PROFILE_ID ||
    profiles.some(
      (profile) => profile.name.toLowerCase() === profileName.toLowerCase(),
    )
  ) {
    throw new Error("A profile with that name already exists.");
  }
  const activeProfile = profiles.find(
    (profile) => profile.id === activeProfileId,
  );
  const id = crypto.randomUUID();
  await storeProfiles(
    [
      ...profiles,
      { id, name: profileName, settings: { ...activeProfile.settings } },
    ],
    id,
    storage,
  );
  return id;
}

async function deleteProfile(profileId, storage = getExtensionStorage()) {
  const { profiles, activeProfileId } = await loadProfiles(storage, {
    persist: true,
  });
  if (profileId === DEFAULT_PROFILE_ID) {
    throw new Error("The Default profile cannot be deleted.");
  }
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error("The selected settings profile does not exist.");
  }
  const nextActiveProfileId =
    activeProfileId === profileId ? DEFAULT_PROFILE_ID : activeProfileId;
  await storeProfiles(
    profiles.filter((profile) => profile.id !== profileId),
    nextActiveProfileId,
    storage,
  );
  return nextActiveProfileId;
}
