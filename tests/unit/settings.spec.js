const { test, expect } = require("@playwright/test");
const { loadSettingsGlobals } = require("./message-usage");

const plain = (value) => JSON.parse(JSON.stringify(value));

function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      if (keys === null) {
        return structuredClone(data);
      }
      const list = typeof keys === "string" ? [keys] : keys;
      return structuredClone(
        Object.fromEntries(
          list.filter((key) => key in data).map((key) => [key, data[key]]),
        ),
      );
    },
    async set(values) {
      writes.push(["set", Object.keys(values)]);
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      writes.push(["remove", [].concat(keys)]);
      for (const key of [].concat(keys)) {
        delete data[key];
      }
    },
  };
}

// Mimics chrome.storage.sync's per-item quota (key + JSON value length).
function withItemQuota(area, quota = 8192) {
  const set = area.set;
  area.set = async (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (key.length + JSON.stringify(value).length > quota) {
        throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      }
    }
    return set(values);
  };
  return area;
}

function createStorage({ sync = {}, local = {} } = {}) {
  return { sync: createStorageArea(sync), local: createStorageArea(local) };
}

let s;
test.beforeEach(() => {
  s = loadSettingsGlobals();
});

test.describe("domains and site rules", () => {
  test("validates domain labels and length", () => {
    for (const domain of [
      "example.com",
      "localhost",
      "my-site.example",
      "127.0.0.1",
    ]) {
      expect(s.isValidDomain(domain), domain).toBe(true);
    }
    for (const domain of [
      "",
      ".",
      ".example.com",
      "example..com",
      "-example.com",
      "example-.com",
      "bad domain",
      `${"a".repeat(64)}.com`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
    ]) {
      expect(s.isValidDomain(domain), domain).toBe(false);
    }
  });

  test("normalizes domains from URLs, wildcards, and ports", () => {
    expect(s.normalizeDomain(" HTTPS://WWW.Example.com:8080/path?q#x ")).toBe(
      "www.example.com",
    );
    expect(s.normalizeDomain("*.example.com.")).toBe("example.com");
    expect(s.normalizeDomain(42)).toBe("");
  });

  test("matches subdomains and picks the most specific rule", () => {
    const settings = {
      siteRules: [
        { domain: "example.com", overrides: { autopause: false } },
        { domain: "video.example.com", overrides: { muteVideo: true } },
      ],
    };
    expect(s.matchesDomain("a.example.com", "example.com")).toBe(true);
    expect(s.matchesDomain("badexample.com", "example.com")).toBe(false);
    expect(s.findSiteRule("www.video.example.com", settings).domain).toBe(
      "video.example.com",
    );
    expect(s.findSiteRule("other.org", settings)).toBeUndefined();
  });

  test("merges site overrides over global settings", () => {
    const settings = s.normalizeSettings({
      autopause: true,
      siteRules: [{ domain: "example.com", overrides: { autopause: false } }],
    });
    expect(s.getSiteSettings("example.com", settings).autopause).toBe(false);
    expect(s.getSiteSettings("example.org", settings)).toBe(settings);
  });

  test("decides whether the extension is enabled on a site", () => {
    const rules = [
      { domain: "on.example", enabled: true },
      { domain: "off.example", enabled: false },
      { domain: "custom.example" },
    ];
    const open = { onlyConfiguredSites: false, siteRules: rules };
    const restricted = { onlyConfiguredSites: true, siteRules: rules };
    expect(s.isSiteEnabled("other.example", open)).toBe(true);
    expect(s.isSiteEnabled("off.example", open)).toBe(false);
    expect(s.isSiteEnabled("other.example", restricted)).toBe(false);
    expect(s.isSiteEnabled("on.example", restricted)).toBe(true);
    expect(s.isSiteEnabled("custom.example", restricted)).toBe(true);
  });

  test("replaces existing rules for the same domain", () => {
    const rules = s.upsertSiteRule(
      [
        { domain: "Example.com", enabled: true, overrides: {} },
        { domain: "other.org", enabled: true, overrides: {} },
      ],
      { domain: "https://example.com/", enabled: false, overrides: {} },
    );
    expect(plain(rules)).toEqual([
      { domain: "example.com", enabled: false, overrides: {} },
      { domain: "other.org", enabled: true, overrides: {} },
    ]);
  });
});

test.describe("normalization and validation", () => {
  test("clamps numeric settings to their limits", () => {
    expect(s.clampNumericSetting("pauseDelay", -5)).toBe(0);
    expect(s.clampNumericSetting("pauseDelay", "250.9")).toBe(250);
    expect(s.clampNumericSetting("rewindSeconds", 99)).toBe(60);
    expect(s.clampNumericSetting("playbackSpeed", 1.6)).toBe(1.5);
    expect(s.clampNumericSetting("idlePauseMinutes", 1000)).toBe(240);
    expect(s.clampNumericSetting("idlePauseMinutes", "abc")).toBe(0);
    expect(s.clampNumericSetting("pauseDelay", 2 ** 31)).toBe(2 ** 31 - 1);
    expect(s.clampNumericSetting("resumeDelay", 1e15)).toBe(2 ** 31 - 1);
  });

  test("fills defaults and drops unknown or malformed data", () => {
    const settings = s.normalizeSettings({
      autopause: false,
      unknownSetting: true,
      contentShortcutKeys: { seekBackward: "k" },
      siteRules: [null, { domain: 5 }, { domain: "ok.example" }],
    });
    expect(settings.autopause).toBe(false);
    expect(settings.lockpause).toBe(s.DEFAULT_SETTINGS.lockpause);
    expect(settings).not.toHaveProperty("unknownSetting");
    expect(settings.contentShortcutKeys).toMatchObject({
      seekBackward: "k",
      seekForward: "l",
    });
    expect(plain(settings.siteRules)).toEqual([
      { domain: "ok.example", enabled: true, overrides: {} },
    ]);
  });

  test("validates and sanitizes imported settings", () => {
    const validated = s.validateSettings({
      autopause: false,
      rewindSeconds: 61.7,
      playbackSpeed: 1.3,
      quietHoursStart: "21:30",
      contentShortcutKeys: { seekBackward: " k " },
      siteRules: [
        {
          domain: "Media.Example",
          overrides: { playbackSpeed: 2, quietHoursEnd: "" },
        },
      ],
      notASetting: true,
    });
    expect(plain(validated)).toEqual({
      autopause: false,
      rewindSeconds: 60,
      playbackSpeed: 1.25,
      quietHoursStart: "21:30",
      contentShortcutKeys: {
        ...plain(s.DEFAULT_SETTINGS.contentShortcutKeys),
        seekBackward: "k",
      },
      siteRules: [
        {
          domain: "media.example",
          enabled: true,
          overrides: { playbackSpeed: 2, quietHoursEnd: "" },
        },
      ],
    });
  });

  for (const [name, settings] of [
    ["non-object settings", []],
    ["no supported settings", { foo: 1 }],
    ["wrong types", { autopause: "yes" }],
    ["negative numbers", { pauseDelay: -1 }],
    ["invalid times", { quietHoursStart: "25:00" }],
    ["duplicate shortcuts", { contentShortcutKeys: { seekBackward: "l" } }],
    ["unknown shortcut actions", { contentShortcutKeys: { jump: "x" } }],
    ["invalid domains", { siteRules: [{ domain: "bad domain" }] }],
    [
      "global-only overrides",
      { siteRules: [{ domain: "a.b", overrides: { disabled: true } }] },
    ],
    [
      "invalid enabled flags",
      { siteRules: [{ domain: "a.b", enabled: "no" }] },
    ],
    [
      "duplicate site rule domains",
      {
        siteRules: [
          { domain: "EXAMPLE.com", enabled: true },
          { domain: "https://example.com/", enabled: false },
        ],
      },
    ],
  ]) {
    test(`rejects ${name}`, () => {
      expect(() => s.validateSettings(settings)).toThrow();
    });
  }

  test("validates settings files with profiles", () => {
    const imported = s.validateSettingsPayload({
      schemaVersion: 1,
      settings: { autopause: false },
      profiles: [{ id: "work", name: " Work ", settings: { muteVideo: true } }],
      activeProfileId: "missing",
    });
    expect(imported.profiles.map((profile) => profile.id)).toEqual([
      "default",
      "work",
    ]);
    expect(imported.profiles[0].settings.autopause).toBe(false);
    expect(imported.profiles[1]).toMatchObject({
      name: "Work",
      settings: { muteVideo: true, autopause: true },
    });
    expect(imported.activeProfileId).toBe("default");
    expect(() =>
      s.validateSettingsPayload({ schemaVersion: 2, settings: {} }),
    ).toThrow();
    expect(() =>
      s.validateSettingsPayload({
        schemaVersion: 1,
        settings: { autopause: true },
        profiles: [
          { name: "A", settings: { autopause: true } },
          { name: "a", settings: { autopause: true } },
        ],
      }),
    ).toThrow("unique");
  });
});

test.describe("profiles", () => {
  test("creates the Default profile on first run without writing on reads", async () => {
    const storage = createStorage();
    const settings = await s.getActiveProfileSettings(storage);
    expect(plain(settings)).toEqual(plain(s.normalizeSettings()));
    expect(storage.sync.writes).toEqual([]);
    expect(storage.local.writes).toEqual([]);

    await s.loadProfiles(storage, { persist: true });
    expect(storage.sync.data.vapProfileIds).toEqual(["default"]);
    expect(storage.sync.data["vapProfile:default"].name).toBe("Default");
    expect(storage.local.data.vapActiveProfileId).toBe("default");

    const writes = storage.sync.writes.length;
    await s.loadProfiles(storage, { persist: true });
    expect(storage.sync.writes.length).toBe(writes);
  });

  test("migrates flat settings from release 1.14", async () => {
    const storage = createStorage({
      sync: {
        autopause: false,
        audioFading: true,
        fadeDuration: 350,
        pauseDelay: 500,
        includedDomains: ["Allowed.example.com", "both.example"],
        excludedDomains: ["blocked.example.com", "both.example", "bad domain"],
      },
    });
    const { profiles } = await s.loadProfiles(storage, { persist: true });
    expect(profiles).toHaveLength(1);
    expect(plain(profiles[0].settings)).toMatchObject({
      autopause: false,
      fadeDuration: 350,
      pauseDelay: 500,
      onlyConfiguredSites: true,
      siteRules: [
        { domain: "allowed.example.com", enabled: true, overrides: {} },
        { domain: "both.example", enabled: false, overrides: {} },
        { domain: "blocked.example.com", enabled: false, overrides: {} },
      ],
    });
    expect(Object.keys(storage.sync.data).sort()).toEqual([
      "vapProfile:default",
      "vapProfileIds",
    ]);
  });

  for (const [stored, expected] of [
    [{ audioFading: false, fadeDuration: 350 }, 0],
    [{ fadeDuration: 350 }, 0],
    [{ audioFading: true }, 200],
  ]) {
    test(`converts legacy audio fading ${JSON.stringify(stored)}`, async () => {
      const storage = createStorage({ sync: stored });
      const settings = await s.getActiveProfileSettings(storage);
      expect(settings.fadeDuration).toBe(expected);
    });
  }

  test("merges flat settings written later by an older release", async () => {
    const storage = createStorage();
    await s.updateActiveProfileSettings(
      {
        rewindSeconds: 5,
        siteRules: [{ domain: "kept.example", enabled: true, overrides: {} }],
      },
      storage,
    );
    await storage.sync.set({
      autopause: false,
      excludedDomains: ["blocked.example"],
    });
    const settings = await s.getActiveProfileSettings(storage);
    expect(settings).toMatchObject({ autopause: false, rewindSeconds: 5 });
    expect(settings.siteRules.map((rule) => rule.domain)).toEqual([
      "kept.example",
      "blocked.example",
    ]);
  });

  test("updates only the active profile", async () => {
    const storage = createStorage();
    const workId = await s.createProfile("Work", storage);
    await s.updateActiveProfileSettings({ muteVideo: true }, storage);
    const { profiles, activeProfileId } = await s.loadProfiles(storage);
    expect(activeProfileId).toBe(workId);
    expect(profiles.find((p) => p.id === workId).settings.muteVideo).toBe(true);
    expect(profiles.find((p) => p.id === "default").settings.muteVideo).toBe(
      false,
    );
    expect(storage.sync.writes.at(-1)).toEqual([
      "set",
      [`vapProfile:${workId}`],
    ]);
  });

  test("keeps concurrent updates from overwriting each other", async () => {
    s.navigator = globalThis.navigator;
    const storage = createStorage();
    await s.loadProfiles(storage, { persist: true });
    const get = storage.sync.get;
    storage.sync.get = async (keys) => {
      const result = await get(keys);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    };
    await Promise.all([
      s.updateActiveProfileSettings({ muteVideo: true }, storage),
      s.updateActiveProfileSettings({ rewindSeconds: 5 }, storage),
      s.updateActiveProfileSettingsWith(
        (settings) => ({ disabled: !settings.disabled }),
        storage,
      ),
    ]);
    expect(await s.getActiveProfileSettings(storage)).toMatchObject({
      muteVideo: true,
      rewindSeconds: 5,
      disabled: true,
    });
  });

  test("keeps the active profile per device while syncing profiles", async () => {
    const storage = createStorage();
    const workId = await s.createProfile("Work", storage);
    expect(storage.sync.data).not.toHaveProperty("vapActiveProfileId");
    expect(storage.local.data.vapActiveProfileId).toBe(workId);

    const secondDevice = {
      sync: storage.sync,
      local: createStorageArea(),
    };
    const { profiles, activeProfileId } = await s.loadProfiles(secondDevice);
    expect(profiles.map((profile) => profile.name)).toEqual([
      "Default",
      "Work",
    ]);
    expect(activeProfileId).toBe("default");
  });

  test("activates, deletes, and protects profiles", async () => {
    const storage = createStorage();
    const workId = await s.createProfile("Work", storage);
    await expect(s.createProfile("work", storage)).rejects.toThrow("exists");
    await expect(s.createProfile("Default", storage)).rejects.toThrow();
    await expect(s.createProfile(" ", storage)).rejects.toThrow();
    await s.activateProfile("default", storage);
    expect(storage.local.data.vapActiveProfileId).toBe("default");
    await expect(s.activateProfile("missing", storage)).rejects.toThrow();
    await expect(s.deleteProfile("default", storage)).rejects.toThrow();

    await s.activateProfile(workId, storage);
    expect(await s.deleteProfile(workId, storage)).toBe("default");
    expect(storage.sync.data.vapProfileIds).toEqual(["default"]);
    expect(storage.sync.data).not.toHaveProperty(`vapProfile:${workId}`);
    expect(storage.local.data.vapActiveProfileId).toBe("default");
  });

  test("ignores corrupt profile entries", async () => {
    const storage = createStorage({
      sync: {
        vapProfileIds: ["default", "broken", "bad id!"],
        "vapProfile:default": {
          id: "default",
          name: "Default",
          settings: { autopause: false },
        },
        "vapProfile:broken": { id: "broken", name: "", settings: {} },
      },
      local: { vapActiveProfileId: "broken" },
    });
    const { profiles, activeProfileId } = await s.loadProfiles(storage);
    expect(profiles.map((profile) => profile.id)).toEqual(["default"]);
    expect(activeProfileId).toBe("default");
    expect(profiles[0].settings.autopause).toBe(false);
  });

  test("detects settings storage changes", () => {
    expect(s.isSettingsStorageChange({ "vapProfile:x": {} }, "sync")).toBe(
      true,
    );
    expect(s.isSettingsStorageChange({ vapProfileIds: {} }, "sync")).toBe(true);
    expect(s.isSettingsStorageChange({ vapStats: {} }, "local")).toBe(false);
    expect(s.isSettingsStorageChange({ vapActiveProfileId: {} }, "local")).toBe(
      true,
    );
    expect(
      s.isSettingsStorageChange({ vapActiveProfileId: {} }, "session"),
    ).toBe(false);
  });

  test("stores only settings that differ from the defaults", async () => {
    const storage = createStorage();
    await s.updateActiveProfileSettings(
      {
        autopause: false,
        siteRules: [
          { domain: "on.example", enabled: true, overrides: {} },
          {
            domain: "off.example",
            enabled: false,
            overrides: { muteVideo: true },
          },
        ],
      },
      storage,
    );
    expect(storage.sync.data["vapProfile:default"].settings).toEqual({
      autopause: false,
      siteRules: [
        { domain: "on.example" },
        {
          domain: "off.example",
          enabled: false,
          overrides: { muteVideo: true },
        },
      ],
    });
    const settings = await s.getActiveProfileSettings(storage);
    expect(settings.autopause).toBe(false);
    expect(s.isSiteEnabled("on.example", settings)).toBe(true);
    expect(s.isSiteEnabled("off.example", settings)).toBe(false);
    expect(plain(s.normalizeSettings(s.compactSettings(settings)))).toEqual(
      plain(settings),
    );
  });

  test("keeps long migrated domain lists within the sync item quota", async () => {
    const excludedDomains = Array.from(
      { length: 150 },
      (_, index) => `site${index}.example.com`,
    );
    const storage = createStorage({ sync: { excludedDomains } });
    withItemQuota(storage.sync);
    await s.loadProfiles(storage, { persist: true });
    const settings = await s.getActiveProfileSettings(storage);
    expect(settings.siteRules).toHaveLength(150);
    expect(storage.sync.data).not.toHaveProperty("excludedDomains");
  });

  test("still reads migrated settings when they cannot be saved", async () => {
    const excludedDomains = Array.from(
      { length: 400 },
      (_, index) => `site${index}.example.com`,
    );
    const storage = createStorage({ sync: { excludedDomains } });
    withItemQuota(storage.sync);
    await expect(s.loadProfiles(storage, { persist: true })).rejects.toThrow(
      "QUOTA",
    );
    const settings = await s.getActiveProfileSettings(storage);
    expect(settings.siteRules).toHaveLength(400);
    expect(storage.sync.data.excludedDomains).toHaveLength(400);
  });
});
