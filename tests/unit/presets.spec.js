const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadSettingsGlobals, srcDir } = require("./message-usage");

const personalSettings = {
  disabled: true,
  onlyConfiguredSites: true,
  siteRules: [{ domain: "example.com", overrides: { autopause: false } }],
  debugMode: true,
  showPipButton: true,
  showVideoOverlay: true,
  contentShortcutsEnabled: true,
  contentShortcutKeys: { toggleLoop: "k" },
};

const playbackDefaults = {
  autopause: true,
  autoresume: true,
  muteVideo: false,
  allowAudio: true,
  scrollpause: false,
  lockpause: true,
  lockresume: true,
  focuspause: false,
  focusresume: false,
  cursorTracking: false,
  manualPause: true,
  disableOnFullscreen: true,
  pauseDelay: 0,
  resumeDelay: 0,
  rewindSeconds: 0,
  playbackSpeed: 0,
  fadeDuration: 0,
  blockAutoplay: false,
  disableAutoplayNext: false,
  pauseAtEnd: false,
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
};

const expectedPresets = {
  study: {
    ...playbackDefaults,
    focuspause: true,
    focusresume: true,
    rewindSeconds: 5,
  },
  music: {
    ...playbackDefaults,
    autopause: false,
    autoresume: false,
    lockpause: false,
    lockresume: false,
    fadeDuration: 200,
  },
  binge: { ...playbackDefaults },
  saver: {
    ...playbackDefaults,
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
  },
};

function loadPresets() {
  const settings = loadSettingsGlobals();
  vm.runInContext(
    fs.readFileSync(path.join(srcDir, "presets.js"), "utf8"),
    settings,
  );
  return settings;
}

test("classifies every setting as mode-controlled or personal", () => {
  const { DEFAULT_SETTINGS } = loadPresets();
  expect(
    [...Object.keys(playbackDefaults), ...Object.keys(personalSettings)].sort(),
  ).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
});

for (const [name, expected] of Object.entries(expectedPresets)) {
  test(`${name} defines its complete playback and automation policy`, () => {
    const settings = loadPresets();
    const preset = settings.SETTING_PRESETS[name];
    expect(JSON.parse(JSON.stringify(preset))).toEqual(expected);
    expect(Object.isFrozen(preset)).toBe(true);
    const normalized = settings.normalizeSettings(preset);
    for (const [key, value] of Object.entries(expected)) {
      expect(normalized[key], key).toEqual(value);
    }
  });

  test(`${name} replaces conflicting settings without changing personal settings`, () => {
    const { SETTING_PRESETS } = loadPresets();
    const conflicting = Object.fromEntries(
      Object.entries(expected).map(([key, value]) => [
        key,
        typeof value === "boolean"
          ? !value
          : typeof value === "number"
            ? 3
            : "12:00",
      ]),
    );
    for (const previous of [conflicting, ...Object.values(SETTING_PRESETS)]) {
      const current = {
        ...previous,
        ...personalSettings,
        ...SETTING_PRESETS[name],
      };
      expect(JSON.parse(JSON.stringify(current))).toEqual({
        ...expected,
        ...personalSettings,
      });
    }
  });
}

test("keeps same-page limiting on and cross-tab priority off by default", () => {
  const { DEFAULT_SETTINGS } = loadPresets();
  expect(DEFAULT_SETTINGS.singleVideoPlayback).toBe(true);
  expect(DEFAULT_SETTINGS.prioritizeActiveTabMedia).toBe(false);
});
