function createSettingPreset(overrides) {
  const preservedSettings = [
    "disabled",
    "onlyConfiguredSites",
    "siteRules",
    "debugMode",
    "showPipButton",
    "showVideoOverlay",
    "contentShortcutsEnabled",
    "contentShortcutKeys",
  ];
  const playbackDefaults = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(
      ([key]) => !preservedSettings.includes(key),
    ),
  );
  return Object.freeze({ ...playbackDefaults, ...overrides });
}

globalThis.SETTING_PRESETS = Object.freeze({
  study: createSettingPreset({
    focuspause: true,
    focusresume: true,
    rewindSeconds: 5,
  }),
  music: createSettingPreset({
    autopause: false,
    autoresume: false,
    fadeDuration: 200,
    lockpause: false,
    lockresume: false,
  }),
  binge: createSettingPreset({}),
  saver: createSettingPreset({
    autoresume: false,
    allowAudio: false,
    focuspause: true,
    lockresume: false,
    scrollpause: true,
    disableOnFullscreen: false,
    blockAutoplay: true,
    disableAutoplayNext: true,
    pauseAtEnd: true,
    pauseOnLowBattery: true,
    pauseOnAudioOutputDisconnect: true,
    liveStreamMute: false,
    muteDuringAds: false,
  }),
});
