globalThis.VAP_DEFAULT_OPTIONS = Object.freeze({
  autopause: true,
  autoresume: true,
  muteVideo: false,
  handleAudio: false,
  audioAllowList: "open.spotify.com, music.youtube.com, soundcloud.com",
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
  audioFading: false,
  fadeDuration: 200,
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

globalThis.VAP_PROFILE_FOR_SITE = (hostname, profiles) =>
  (Array.isArray(profiles) ? profiles : [])
    .filter(
      (profile) =>
        profile &&
        profile.settings &&
        Array.isArray(profile.domains) &&
        profile.domains.some((domain) =>
          VAP_MATCHES_DOMAIN(hostname, [domain]),
        ),
    )
    .sort((left, right) => {
      const longestMatch = (profile) =>
        Math.max(
          ...profile.domains
            .filter((domain) => VAP_MATCHES_DOMAIN(hostname, [domain]))
            .map((domain) => VAP_NORMALIZE_DOMAIN(domain).length),
        );
      return longestMatch(right) - longestMatch(left);
    })[0];

globalThis.VAP_SETTINGS_FOR_PROFILE = (settings, profiles, hostname) => {
  const profile = VAP_PROFILE_FOR_SITE(hostname, profiles);
  if (!profile) {
    return settings;
  }
  return {
    ...settings,
    ...profile.settings,
    disabled: settings.disabled,
  };
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
