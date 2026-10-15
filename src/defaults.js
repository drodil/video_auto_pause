globalThis.VAP_DEFAULT_OPTIONS = Object.freeze({
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
  autoPipOnTabSwitch: false,
  showVideoOverlay: false,
  blockAutoplay: false,
  disableAutoplayNext: false,
  pauseAtEnd: false,
  contentShortcutsEnabled: false,
  contentShortcutKeys: {
    seekBackward: "j",
    seekForward: "l",
    frameBackward: "ArrowLeft",
    frameForward: "ArrowRight",
    toggleLoop: "b",
    bookmark: "m",
    screenshot: "p",
    togglePip: "i",
    toggleCaptions: "c",
  },
  idlePauseMinutes: 0,
  pauseOnLowBattery: false,
  pauseOnAudioOutputDisconnect: false,
  quietHoursStart: "",
  quietHoursEnd: "",
  peekMode: false,
  liveStreamMute: true,
  muteDuringAds: true,
  prioritizeActiveTabMedia: false,
  singleVideoPlayback: true,
  onlyConfiguredSites: false,
  siteRules: [],
});

globalThis.VAP_NORMALIZE_DOMAIN = (entry) => {
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
};

globalThis.VAP_MATCHES_DOMAIN = (hostname, entries) =>
  Array.isArray(entries) &&
  entries.some((entry) => {
    const domain = globalThis.VAP_NORMALIZE_DOMAIN(entry);
    return domain && (hostname === domain || hostname.endsWith(`.${domain}`));
  });

globalThis.VAP_SITE_RULE_FOR = (hostname, settings) =>
  (Array.isArray(settings.siteRules) ? settings.siteRules : [])
    .filter((rule) => rule && VAP_MATCHES_DOMAIN(hostname, [rule.domain]))
    .sort(
      (left, right) =>
        VAP_NORMALIZE_DOMAIN(right.domain).length -
        VAP_NORMALIZE_DOMAIN(left.domain).length,
    )[0];

globalThis.VAP_SITE_ENABLED = (hostname, settings) => {
  const rule = VAP_SITE_RULE_FOR(hostname, settings);
  if (typeof rule?.enabled === "boolean") {
    return rule.enabled;
  }
  if (rule?.behavior === "ignore") {
    return false;
  }
  return !settings.onlyConfiguredSites || Boolean(rule);
};

globalThis.VAP_OPTIONS_FOR_SITE = (hostname, settings) => {
  const rule = VAP_SITE_RULE_FOR(hostname, settings);
  if (!rule) {
    return settings;
  }
  const legacyOverrides = {};
  for (const option of Object.keys(VAP_DEFAULT_OPTIONS)) {
    if (Object.prototype.hasOwnProperty.call(rule, option)) {
      legacyOverrides[option] = rule[option];
    }
  }
  if (rule.behavior === "mute") {
    legacyOverrides.muteVideo = true;
  } else if (rule.behavior === "pause") {
    legacyOverrides.muteVideo = false;
  }
  return {
    ...settings,
    ...legacyOverrides,
    ...(rule.overrides ?? {}),
  };
};

globalThis.VAP_MIGRATE_AUDIO_FADING = async (storage) => {
  const stored = await storage.get(["audioFading", "fadeDuration"]);
  if (typeof stored.audioFading !== "boolean") {
    return;
  }
  const fadeDuration = stored.audioFading
    ? Number.isFinite(stored.fadeDuration)
      ? stored.fadeDuration
      : 200
    : 0;
  await storage.set({ fadeDuration: Math.max(0, fadeDuration) });
  await storage.remove("audioFading");
};

globalThis.VAP_NORMALIZE_LEGACY_SETTINGS = (settings, defaults) => {
  const normalized = { ...defaults, ...settings };
  normalized.siteRules = Array.isArray(normalized.siteRules)
    ? normalized.siteRules
    : [];
  if (
    typeof settings.handleAudio === "boolean" &&
    typeof settings.allowAudio !== "boolean"
  ) {
    normalized.allowAudio = !settings.handleAudio;
  }
  if (settings.handleAudio && typeof settings.audioAllowList === "string") {
    for (const domain of settings.audioAllowList
      .split(/[,\s]+/)
      .map(VAP_NORMALIZE_DOMAIN)
      .filter(Boolean)) {
      const existing = normalized.siteRules.find(
        (rule) => VAP_NORMALIZE_DOMAIN(rule.domain) === domain,
      );
      if (existing) {
        existing.overrides = { ...existing.overrides, allowAudio: true };
      } else {
        normalized.siteRules.push({
          domain,
          enabled: true,
          overrides: { allowAudio: true },
        });
      }
    }
  }
  if (typeof normalized.audioFading === "boolean") {
    normalized.fadeDuration = normalized.audioFading
      ? Number.isFinite(normalized.fadeDuration)
        ? normalized.fadeDuration
        : 200
      : 0;
  }
  delete normalized.audioFading;
  delete normalized.audioAllowList;
  delete normalized.handleAudio;
  normalized.siteRules = (
    Array.isArray(normalized.siteRules) ? normalized.siteRules : []
  ).map((rule) => {
    const overrides = { ...(rule.overrides ?? {}) };
    if (
      typeof overrides.handleAudio === "boolean" &&
      typeof overrides.allowAudio !== "boolean"
    ) {
      overrides.allowAudio = !overrides.handleAudio;
    }
    delete overrides.handleAudio;
    return { ...rule, overrides };
  });
  return normalized;
};

globalThis.VAP_PROFILE_STORAGE_KEY = (profileId) => `vapProfile:${profileId}`;

globalThis.VAP_STORE_PROFILES = async (
  syncStorage,
  localStorage,
  profiles,
  activeProfileId,
) => {
  const current = await syncStorage.get([
    "vapProfileIds",
    "vapActiveProfileId",
  ]);
  const previousIds = Array.isArray(current.vapProfileIds)
    ? current.vapProfileIds
    : [];
  const updatedIds = profiles.map((profile) => profile.id);
  const values = { vapProfileIds: updatedIds };
  for (const profile of profiles) {
    values[VAP_PROFILE_STORAGE_KEY(profile.id)] = profile;
  }
  await syncStorage.set(values);
  await localStorage.set({ vapActiveProfileId: activeProfileId });
  if (Object.prototype.hasOwnProperty.call(current, "vapActiveProfileId")) {
    await syncStorage.remove("vapActiveProfileId");
  }
  const removedKeys = previousIds
    .filter((id) => !updatedIds.includes(id))
    .map(VAP_PROFILE_STORAGE_KEY);
  if (removedKeys.length) {
    await syncStorage.remove(removedKeys);
  }
};

globalThis.VAP_ENSURE_PROFILES = async (
  syncStorage,
  localStorage,
  defaults,
) => {
  const [storedSync, storedLocal] = await Promise.all([
    syncStorage.get(null),
    localStorage.get(["vapProfiles", "vapActiveProfileId"]),
  ]);
  const legacySettings = Object.fromEntries(
    [...Object.keys(defaults), "audioAllowList", "handleAudio", "audioFading"]
      .filter((key) => Object.prototype.hasOwnProperty.call(storedSync, key))
      .map((key) => [key, storedSync[key]]),
  );
  if (
    typeof storedSync.handleAudio === "boolean" &&
    typeof storedSync.allowAudio !== "boolean"
  ) {
    legacySettings.allowAudio = !storedSync.handleAudio;
  }
  const storedProfiles = Array.isArray(storedSync.vapProfileIds)
    ? storedSync.vapProfileIds
        .map((id) => storedSync[VAP_PROFILE_STORAGE_KEY(id)])
        .filter(Boolean)
    : Array.isArray(storedSync.vapProfiles)
      ? [...storedSync.vapProfiles]
      : [];
  if (Array.isArray(storedLocal.vapProfiles)) {
    for (const profile of storedLocal.vapProfiles) {
      if (
        profile &&
        !storedProfiles.some(
          (existing) =>
            existing?.name?.toLowerCase() === profile.name?.toLowerCase(),
        )
      ) {
        storedProfiles.push(profile);
      }
    }
  }

  const usedNames = new Set();
  const usedIds = new Set();
  const profiles = storedProfiles
    .filter(
      (profile) =>
        profile &&
        typeof profile.name === "string" &&
        profile.settings &&
        typeof profile.settings === "object" &&
        !Array.isArray(profile.settings),
    )
    .filter((profile) => {
      const normalizedName = profile.name.trim().toLowerCase();
      if (!normalizedName || usedNames.has(normalizedName)) {
        return false;
      }
      usedNames.add(normalizedName);
      return true;
    })
    .map((profile, index) => {
      let id =
        profile.name.trim().toLowerCase() === "default"
          ? "default"
          : typeof profile.id === "string" &&
              profile.id !== "default" &&
              /^[a-z\d_-]{1,80}$/i.test(profile.id)
            ? profile.id
            : `profile-${index + 1}`;
      while (usedIds.has(id)) {
        id = `profile-${index + 1}-${usedIds.size + 1}`;
      }
      usedIds.add(id);
      return {
        id,
        name: profile.name.trim(),
        settings: VAP_NORMALIZE_LEGACY_SETTINGS(profile.settings, defaults),
      };
    });

  let defaultProfile = profiles.find((profile) => profile.id === "default");
  if (!defaultProfile) {
    defaultProfile = {
      id: "default",
      name: "Default",
      settings: VAP_NORMALIZE_LEGACY_SETTINGS(legacySettings, defaults),
    };
    profiles.unshift(defaultProfile);
  } else if (Object.keys(legacySettings).length > 0) {
    defaultProfile.settings = VAP_NORMALIZE_LEGACY_SETTINGS(
      { ...defaultProfile.settings, ...legacySettings },
      defaults,
    );
  }
  const defaultIndex = profiles.indexOf(defaultProfile);
  if (defaultIndex > 0) {
    profiles.splice(defaultIndex, 1);
    profiles.unshift(defaultProfile);
  }

  const hasLocalActiveProfileId = Object.prototype.hasOwnProperty.call(
    storedLocal,
    "vapActiveProfileId",
  );
  const activeProfileId = profiles.some(
    (profile) => profile.id === storedLocal.vapActiveProfileId,
  )
    ? storedLocal.vapActiveProfileId
    : !hasLocalActiveProfileId &&
        profiles.some((profile) => profile.id === storedSync.vapActiveProfileId)
      ? storedSync.vapActiveProfileId
      : "default";
  const legacyOptionKeys = [
    ...Object.keys(defaults),
    "audioFading",
    "audioAllowList",
    "handleAudio",
    "includedDomains",
    "excludedDomains",
    "vapProfiles",
  ];
  const storedProfilesJson = JSON.stringify(
    Array.isArray(storedSync.vapProfileIds)
      ? storedSync.vapProfileIds.map(
          (id) => storedSync[VAP_PROFILE_STORAGE_KEY(id)],
        )
      : (storedSync.vapProfiles ?? null),
  );
  if (
    storedProfilesJson !== JSON.stringify(profiles) ||
    JSON.stringify(storedSync.vapProfileIds ?? null) !==
      JSON.stringify(profiles.map((profile) => profile.id)) ||
    Object.prototype.hasOwnProperty.call(storedSync, "vapActiveProfileId") ||
    storedLocal.vapActiveProfileId !== activeProfileId ||
    legacyOptionKeys.some((key) =>
      Object.prototype.hasOwnProperty.call(storedSync, key),
    )
  ) {
    await VAP_STORE_PROFILES(
      syncStorage,
      localStorage,
      profiles,
      activeProfileId,
    );
    await syncStorage.remove(legacyOptionKeys);
  }
  if (Array.isArray(storedLocal.vapProfiles)) {
    await localStorage.remove("vapProfiles");
  }
  return { profiles, activeProfileId };
};

globalThis.VAP_GET_ACTIVE_PROFILE_SETTINGS = async (
  syncStorage,
  localStorage,
  defaults,
) => {
  await VAP_MIGRATE_AUDIO_FADING(syncStorage);
  await VAP_MIGRATE_DOMAIN_SETTINGS(syncStorage);
  const { profiles, activeProfileId } = await VAP_ENSURE_PROFILES(
    syncStorage,
    localStorage,
    defaults,
  );
  const profile = profiles.find((entry) => entry.id === activeProfileId);
  if (!profile) {
    throw new Error("The active settings profile is missing.");
  }
  return profile.settings;
};

globalThis.VAP_UPDATE_ACTIVE_PROFILE_SETTINGS = async (
  syncStorage,
  localStorage,
  defaults,
  settingsPatch,
) => {
  await VAP_MIGRATE_AUDIO_FADING(syncStorage);
  await VAP_MIGRATE_DOMAIN_SETTINGS(syncStorage);
  const { profiles, activeProfileId } = await VAP_ENSURE_PROFILES(
    syncStorage,
    localStorage,
    defaults,
  );
  const activeProfile = profiles.find(
    (profile) => profile.id === activeProfileId,
  );
  if (!activeProfile) {
    throw new Error("The active settings profile is missing.");
  }
  const updatedProfiles = profiles.map((profile) =>
    profile.id === activeProfileId
      ? {
          ...profile,
          settings: VAP_NORMALIZE_LEGACY_SETTINGS(
            { ...profile.settings, ...settingsPatch },
            defaults,
          ),
        }
      : profile,
  );
  await syncStorage.set({
    [VAP_PROFILE_STORAGE_KEY(activeProfile.id)]: updatedProfiles.find(
      (profile) => profile.id === activeProfile.id,
    ),
  });
};

globalThis.VAP_ACTIVATE_PROFILE = async (
  syncStorage,
  localStorage,
  defaults,
  profileId,
) => {
  await VAP_MIGRATE_AUDIO_FADING(syncStorage);
  await VAP_MIGRATE_DOMAIN_SETTINGS(syncStorage);
  const { profiles } = await VAP_ENSURE_PROFILES(
    syncStorage,
    localStorage,
    defaults,
  );
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error("The selected settings profile does not exist.");
  }
  await localStorage.set({ vapActiveProfileId: profileId });
};

globalThis.VAP_MIGRATE_DOMAIN_SETTINGS = async (storage) => {
  const stored = await storage.get(null);
  if (stored.vapSiteRulesVersion >= 1) {
    return;
  }

  const siteRules = [];
  const findRule = (domain) =>
    siteRules.find(
      (rule) =>
        VAP_NORMALIZE_DOMAIN(rule.domain) === VAP_NORMALIZE_DOMAIN(domain),
    );

  for (const legacyRule of Array.isArray(stored.siteRules)
    ? stored.siteRules
    : []) {
    if (!legacyRule || typeof legacyRule.domain !== "string") {
      continue;
    }
    const overrides = { ...(legacyRule.overrides ?? {}) };
    if (
      typeof overrides.handleAudio === "boolean" &&
      typeof overrides.allowAudio !== "boolean"
    ) {
      overrides.allowAudio = !overrides.handleAudio;
    }
    delete overrides.handleAudio;
    for (const option of Object.keys(VAP_DEFAULT_OPTIONS)) {
      if (
        !["onlyConfiguredSites", "siteRules"].includes(option) &&
        Object.prototype.hasOwnProperty.call(legacyRule, option)
      ) {
        overrides[option] = legacyRule[option];
      }
    }
    if (legacyRule.behavior === "mute") {
      overrides.muteVideo = true;
    } else if (legacyRule.behavior === "pause") {
      overrides.muteVideo = false;
    }
    if (
      typeof legacyRule.handleAudio === "boolean" &&
      typeof legacyRule.allowAudio !== "boolean"
    ) {
      overrides.allowAudio = !legacyRule.handleAudio;
    }
    if (
      Number.isFinite(legacyRule.speed) &&
      legacyRule.speed >= 0.25 &&
      legacyRule.speed <= 4
    ) {
      overrides.playbackSpeed = legacyRule.speed;
    }
    const rule = { domain: legacyRule.domain, overrides };
    if (typeof legacyRule.enabled === "boolean") {
      rule.enabled = legacyRule.enabled;
    } else if (legacyRule.behavior === "ignore") {
      rule.enabled = false;
    }
    siteRules.push(rule);
  }

  for (const domain of stored.includedDomains ?? []) {
    if (typeof domain !== "string" || !VAP_NORMALIZE_DOMAIN(domain)) {
      continue;
    }
    const rule = findRule(domain);
    if (!rule) {
      siteRules.push({ domain, enabled: true, overrides: {} });
    }
  }
  for (const domain of stored.excludedDomains ?? []) {
    if (typeof domain !== "string" || !VAP_NORMALIZE_DOMAIN(domain)) {
      continue;
    }
    const rule = findRule(domain);
    if (rule) {
      rule.enabled = false;
    } else {
      siteRules.push({ domain, enabled: false, overrides: {} });
    }
  }

  await storage.set({
    siteRules,
    onlyConfiguredSites:
      stored.onlyConfiguredSites ?? (stored.includedDomains ?? []).length > 0,
    vapSiteRulesVersion: 1,
  });
  await storage.remove(["includedDomains", "excludedDomains"]);
};
