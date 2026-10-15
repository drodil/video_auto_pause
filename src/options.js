// Browser
if (new URLSearchParams(window.location.search).has("popup")) {
  document.body.classList.add("popup-view");
}

const env = chrome.runtime ? chrome : browser;
const settingsView = document.querySelector(".wrapper");
if (settingsView) {
  settingsView.inert = true;
  settingsView.setAttribute("aria-busy", "true");
  document.body.classList.add("options-loading");
}
const tabStorage = env.storage.session ?? env.storage.local;
const DEFAULT_OPTIONS = globalThis.VAP_DEFAULT_OPTIONS;
const SETTINGS_SCHEMA_VERSION = 1;
let optionsReady = Promise.resolve();
let profileUpdateQueue = Promise.resolve();
let optionsRestoreQueue = Promise.resolve();
const siteOverrideOptions = Object.entries(DEFAULT_OPTIONS).filter(
  ([option, value]) =>
    !["disabled", "onlyConfiguredSites", "siteRules"].includes(option) &&
    (typeof value === "boolean" ||
      typeof value === "number" ||
      ["quietHoursStart", "quietHoursEnd"].includes(option) ||
      option === "contentShortcutKeys"),
);
let siteRulesCache = [];

async function updateActiveProfileSettings(settingsPatch) {
  await optionsReady;
  const update = profileUpdateQueue.then(() =>
    VAP_UPDATE_ACTIVE_PROFILE_SETTINGS(
      env.storage.sync,
      env.storage.local,
      DEFAULT_OPTIONS,
      settingsPatch,
    ),
  );
  profileUpdateQueue = update.catch(() => {});
  await update;
}

function queueOptionsRestore(changedKeys) {
  const restore = optionsRestoreQueue.then(() => restore_options(changedKeys));
  optionsRestoreQueue = restore.catch(() => {});
  return restore;
}

function localizeUI() {
  if (!env?.i18n) {
    return;
  }
  document.documentElement.lang = env.i18n.getUILanguage();
  document.documentElement.dir = env.i18n.getMessage("@@bidi_dir") || "ltr";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const messageName = element.dataset.i18n;
    const message = env.i18n.getMessage(messageName);
    if (message) {
      element.textContent = message;
    }
  });

  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const message = env.i18n.getMessage(element.dataset.i18nTitle);
    if (message) {
      element.title = message;
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const message = env.i18n.getMessage(element.dataset.i18nPlaceholder);
    if (message) {
      element.placeholder = message;
    }
  });

  document.title = env.i18n.getMessage("extName") ?? "Video Auto Pause";
}

const basicSiteOptions = new Set([
  "autopause",
  "autoresume",
  "focuspause",
  "focusresume",
  "disableOnFullscreen",
]);
let editingSiteDomain = "";

function buildSiteSettingsFields() {
  const groups = [
    {
      key: "settings",
      options: siteOverrideOptions.filter(([option]) =>
        basicSiteOptions.has(option),
      ),
      open: true,
    },
    {
      key: "advancedSettings",
      options: siteOverrideOptions.filter(
        ([option]) => !basicSiteOptions.has(option),
      ),
      open: false,
    },
  ];
  const container = document.getElementById("siteSettingsFields");
  for (const group of groups) {
    const details = document.createElement("details");
    details.open = group.open;
    const summary = document.createElement("summary");
    summary.textContent = env.i18n.getMessage(group.key);
    details.appendChild(summary);
    for (const [option, defaultValue] of group.options) {
      const row = document.createElement("div");
      row.className = "site-setting-row";
      const settingName = document.createElement("strong");
      settingName.textContent = env.i18n.getMessage(option);
      const customizeLabel = document.createElement("label");
      customizeLabel.className = "site-setting-customize";
      const customize = document.createElement("input");
      customize.type = "checkbox";
      customize.dataset.siteOverride = option;
      customizeLabel.append(
        customize,
        document.createTextNode(env.i18n.getMessage("siteRuleCustomize")),
      );
      if (option === "contentShortcutKeys") {
        const shortcutFields = document.createElement("div");
        shortcutFields.className = "site-shortcut-fields";
        for (const [action, defaultKey] of Object.entries(defaultValue)) {
          const label = document.createElement("label");
          const name = document.createElement("span");
          name.textContent = env.i18n.getMessage(`${action}Shortcut`);
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = 20;
          input.value = defaultKey;
          input.dataset.siteShortcutValue = action;
          input.disabled = true;
          input.setAttribute("aria-label", name.textContent);
          label.append(name, input);
          shortcutFields.appendChild(label);
        }
        row.append(settingName, customizeLabel, shortcutFields);
        customize.addEventListener("change", () => {
          shortcutFields.querySelectorAll("input").forEach((input) => {
            input.disabled = !customize.checked;
            if (customize.checked) {
              input.value = defaultValue[input.dataset.siteShortcutValue];
            }
          });
        });
        details.appendChild(row);
        continue;
      }
      const valueInput = document.createElement("input");
      valueInput.dataset.siteValue = option;
      valueInput.setAttribute("aria-label", env.i18n.getMessage(option));
      if (typeof defaultValue === "boolean") {
        valueInput.type = "checkbox";
        const valueLabel = document.createElement("label");
        valueLabel.className = "site-setting-value-label";
        valueLabel.append(
          valueInput,
          document.createTextNode(env.i18n.getMessage("siteRuleValueEnabled")),
        );
        row.append(settingName, customizeLabel, valueLabel);
      } else {
        if (["quietHoursStart", "quietHoursEnd"].includes(option)) {
          valueInput.type = "time";
        } else {
          valueInput.type = "number";
          valueInput.min = "0";
          valueInput.step =
            option === "fadeDuration"
              ? "50"
              : option === "playbackSpeed"
                ? "0.25"
                : "1";
          if (option === "rewindSeconds") {
            valueInput.max = "60";
          } else if (option === "playbackSpeed") {
            valueInput.max = "4";
          } else if (option === "idlePauseMinutes") {
            valueInput.max = "240";
          }
        }
        valueInput.value = String(defaultValue);
        row.append(settingName, customizeLabel, valueInput);
      }
      valueInput.disabled = true;
      customize.addEventListener("change", () => {
        valueInput.disabled = !customize.checked;
        if (customize.checked) {
          if (valueInput.type === "checkbox") {
            valueInput.checked = defaultValue;
          } else {
            valueInput.value = String(defaultValue);
          }
        }
      });
      details.appendChild(row);
    }
    container.appendChild(details);
  }
}

function setSiteSettingsValues(rule, settings) {
  const overrides = rule?.overrides ?? {};
  document.getElementById("siteRuleEnabled").checked = rule?.enabled !== false;
  for (const [option, defaultValue] of siteOverrideOptions) {
    const customized = Object.prototype.hasOwnProperty.call(overrides, option);
    const customize = document.querySelector(
      `[data-site-override="${option}"]`,
    );
    if (option === "contentShortcutKeys") {
      const values = customized
        ? overrides[option]
        : (settings[option] ?? defaultValue);
      customize.checked = customized;
      for (const [action, fallback] of Object.entries(defaultValue)) {
        const input = document.querySelector(
          `[data-site-shortcut-value="${action}"]`,
        );
        input.disabled = !customized;
        input.value = values?.[action] ?? fallback;
      }
      continue;
    }
    const valueInput = document.querySelector(`[data-site-value="${option}"]`);
    const value = customized
      ? overrides[option]
      : (settings[option] ?? defaultValue);
    customize.checked = customized;
    valueInput.disabled = !customized;
    if (valueInput.type === "checkbox") {
      valueInput.checked = Boolean(value);
    } else if (valueInput.type === "time") {
      valueInput.value = typeof value === "string" ? value : "";
    } else {
      valueInput.value = Math.max(0, Number(value) || 0);
    }
  }
}

async function openSiteSettings(domain) {
  const normalizedDomain = VAP_NORMALIZE_DOMAIN(domain);
  if (!normalizedDomain || !/^[a-z\d.-]+$/i.test(normalizedDomain)) {
    throw new Error("The site rule has an invalid domain.");
  }
  editingSiteDomain = normalizedDomain;
  const rule = siteRulesCache.find(
    (entry) => entry && VAP_NORMALIZE_DOMAIN(entry.domain) === normalizedDomain,
  ) ?? { domain: normalizedDomain, enabled: true, overrides: {} };
  const settings = await VAP_GET_ACTIVE_PROFILE_SETTINGS(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
  );
  document.getElementById("siteSettingsTitle").textContent =
    env.i18n.getMessage("siteSettingsTitle", [normalizedDomain]);
  setSiteSettingsValues(rule, settings);
  document.getElementById("settingsViews").classList.add("site-open");
  document
    .getElementById("globalSettingsView")
    .setAttribute("aria-hidden", "true");
  document
    .getElementById("siteSettingsView")
    .setAttribute("aria-hidden", "false");
  document.getElementById("wrapper").scrollTop = 0;
  document.getElementById("backToGlobal").focus();
}

function closeSiteSettings() {
  const domain = editingSiteDomain;
  document.getElementById("settingsViews").classList.remove("site-open");
  document
    .getElementById("globalSettingsView")
    .setAttribute("aria-hidden", "false");
  document
    .getElementById("siteSettingsView")
    .setAttribute("aria-hidden", "true");
  editingSiteDomain = "";
  const ruleButton = [
    ...document.querySelectorAll("[data-open-site-rule]"),
  ].find((button) => button.dataset.openSiteRule === domain);
  ruleButton?.focus();
}

async function restoreSiteRules() {
  const settings = await VAP_GET_ACTIVE_PROFILE_SETTINGS(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
  );
  siteRulesCache = Array.isArray(settings.siteRules) ? settings.siteRules : [];
  const list = document.getElementById("siteRuleList");
  list.replaceChildren();
  const filter = VAP_NORMALIZE_DOMAIN(
    document.getElementById("siteRuleFilter").value,
  );
  for (const rule of siteRulesCache) {
    if (!rule || typeof rule.domain !== "string") {
      continue;
    }
    const domain = VAP_NORMALIZE_DOMAIN(rule.domain);
    if (filter && !domain.includes(filter)) {
      continue;
    }
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.dataset.openSiteRule = domain;
    open.textContent = domain;
    open.setAttribute(
      "aria-label",
      env.i18n.getMessage("siteSettingsTitle", [domain]),
    );
    open.addEventListener("click", () => {
      void openSiteSettings(domain).catch((error) => {
        console.error("Video Auto Pause could not open site settings:", error);
      });
    });
    const state = document.createElement("span");
    state.textContent = env.i18n.getMessage(
      rule.enabled === false
        ? "siteRuleDisabledOption"
        : "siteRuleEnabledOption",
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.removeSiteRule = domain;
    remove.textContent = env.i18n.getMessage("siteRuleRemove");
    remove.setAttribute("aria-label", `${remove.textContent}: ${domain}`);
    remove.addEventListener("click", () => {
      void deleteSiteRule(domain).catch((error) => {
        document.getElementById("siteRuleStatus").textContent =
          env.i18n.getMessage("siteRuleFailed");
        console.error(
          "Video Auto Pause could not remove the site rule:",
          error,
        );
      });
    });
    item.append(open, state, remove);
    list.appendChild(item);
  }
}

async function addCurrentSiteRule() {
  const tab = await getCurrentWebTab();
  if (!tab) {
    throw new Error("No supported web page is available.");
  }
  const domain = VAP_NORMALIZE_DOMAIN(new URL(tab.url).hostname);
  const existing = siteRulesCache.find(
    (rule) => rule && VAP_NORMALIZE_DOMAIN(rule.domain) === domain,
  );
  if (existing) {
    await restoreSiteRules();
  }
  await openSiteSettings(domain);
}

async function saveSiteSettings() {
  if (!editingSiteDomain) {
    throw new Error("No site is currently selected.");
  }
  const overrides = {};
  for (const [option] of siteOverrideOptions) {
    if (!document.querySelector(`[data-site-override="${option}"]`).checked) {
      continue;
    }
    const valueInput = document.querySelector(`[data-site-value="${option}"]`);
    if (option === "contentShortcutKeys") {
      const keys = Object.fromEntries(
        Object.entries(DEFAULT_OPTIONS.contentShortcutKeys).map(([action]) => [
          action,
          document
            .querySelector(`[data-site-shortcut-value="${action}"]`)
            .value.trim(),
        ]),
      );
      const assignedKeys = Object.values(keys)
        .filter(Boolean)
        .map((key) => key.toLowerCase());
      if (new Set(assignedKeys).size !== assignedKeys.length) {
        throw new Error("Site shortcut keys must be unique.");
      }
      overrides[option] = keys;
      continue;
    }
    overrides[option] =
      valueInput.type === "checkbox"
        ? valueInput.checked
        : readOption(option, valueInput);
  }
  const updated = siteRulesCache.filter(
    (rule) => !rule || VAP_NORMALIZE_DOMAIN(rule.domain) !== editingSiteDomain,
  );
  updated.push({
    domain: editingSiteDomain,
    enabled: document.getElementById("siteRuleEnabled").checked,
    overrides,
  });
  await updateActiveProfileSettings({ siteRules: updated });
  siteRulesCache = updated;
  document.getElementById("siteSettingsStatus").textContent =
    env.i18n.getMessage("siteRuleSaved");
  await restoreSiteRules();
}

async function deleteSiteRule(domain) {
  const updated = siteRulesCache.filter(
    (rule) => VAP_NORMALIZE_DOMAIN(rule.domain) !== domain,
  );
  await updateActiveProfileSettings({ siteRules: updated });
  siteRulesCache = updated;
  await restoreSiteRules();
  if (editingSiteDomain === domain) {
    closeSiteSettings();
  }
}

const options = DEFAULT_OPTIONS;
const contentShortcutActions = [
  ["seekBackward", "contentShortcutSeekBackward"],
  ["seekForward", "contentShortcutSeekForward"],
  ["frameBackward", "contentShortcutFrameBackward"],
  ["frameForward", "contentShortcutFrameForward"],
  ["toggleLoop", "contentShortcutToggleLoop"],
  ["bookmark", "contentShortcutBookmark"],
  ["screenshot", "contentShortcutScreenshot"],
  ["togglePip", "contentShortcutTogglePip"],
  ["toggleCaptions", "contentShortcutToggleCaptions"],
];

async function getCurrentWebTab() {
  const isWebTab = (tab) => {
    try {
      return ["http:", "https:", "file:"].includes(new URL(tab.url).protocol);
    } catch {
      return false;
    }
  };
  const currentWindowTabs = await env.tabs.query({ lastFocusedWindow: true });
  const currentWindowWebTab =
    currentWindowTabs.find((tab) => tab.active && isWebTab(tab)) ??
    currentWindowTabs.find(isWebTab);
  if (currentWindowWebTab) {
    return currentWindowWebTab;
  }
  const allTabs = await env.tabs.query({});
  return (
    allTabs.find((tab) => tab.active && isWebTab(tab)) ?? allTabs.find(isWebTab)
  );
}

async function updateSiteReportLink() {
  const link = document.getElementById("reportSite");
  const issueUrl = new URL(
    "https://github.com/drodil/video_auto_pause/issues/new",
  );
  issueUrl.searchParams.set("title", "Site compatibility report");
  const tab = await getCurrentWebTab();
  const site = tab?.url ? new URL(tab.url).origin : "Not available";
  issueUrl.searchParams.set(
    "body",
    `Site: ${site}\nBrowser: ${navigator.userAgent}\n\nDescribe what did not work:`,
  );
  link.href = issueUrl.toString();
}

async function copyDiagnostics() {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable.");
  }
  const [settings, { vapLastContentScriptError = null }] = await Promise.all([
    VAP_GET_ACTIVE_PROFILE_SETTINGS(
      env.storage.sync,
      env.storage.local,
      DEFAULT_OPTIONS,
    ),
    env.storage.local.get("vapLastContentScriptError"),
  ]);
  const diagnostics = {
    extensionVersion: env.runtime.getManifest().version,
    browser: navigator.userAgent,
    settings,
    lastContentScriptError: vapLastContentScriptError,
  };
  await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
}

function validateSettingsObject(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Settings must be an object.");
  }
  const imported = {};
  for (const [option, defaultValue] of Object.entries(DEFAULT_OPTIONS)) {
    if (!Object.prototype.hasOwnProperty.call(settings, option)) {
      continue;
    }
    const value = settings[option];
    if (option === "siteRules") {
      if (!Array.isArray(value)) {
        throw new Error("Site rules must be an array.");
      }
      imported.siteRules = value.map((rule) => {
        const domain = VAP_NORMALIZE_DOMAIN(rule?.domain);
        if (!domain || !/^[a-z\d.-]+$/i.test(domain)) {
          throw new Error("A site rule has an invalid domain.");
        }
        if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
          throw new Error(`Site rule ${domain} has an invalid enabled value.`);
        }
        if (
          rule.overrides !== undefined &&
          (!rule.overrides ||
            typeof rule.overrides !== "object" ||
            Array.isArray(rule.overrides))
        ) {
          throw new Error(`Site rule ${domain} has invalid overrides.`);
        }
        const overrides = {};
        for (const [name, override] of Object.entries(rule.overrides ?? {})) {
          const optionDefault = DEFAULT_OPTIONS[name];
          if (
            !siteOverrideOptions.some(([option]) => option === name) ||
            (name !== "contentShortcutKeys" &&
              typeof optionDefault !== typeof override)
          ) {
            throw new Error(
              `Site rule ${domain} has an invalid ${name} value.`,
            );
          }
          if (name === "contentShortcutKeys") {
            if (
              !override ||
              typeof override !== "object" ||
              Array.isArray(override)
            ) {
              throw new Error(`Site rule ${domain} has invalid shortcut keys.`);
            }
            const shortcutKeys = { ...DEFAULT_OPTIONS.contentShortcutKeys };
            for (const [action, key] of Object.entries(override)) {
              if (
                !Object.prototype.hasOwnProperty.call(shortcutKeys, action) ||
                typeof key !== "string" ||
                key.length > 20
              ) {
                throw new Error(
                  `Site rule ${domain} has invalid shortcut keys.`,
                );
              }
              shortcutKeys[action] = key.trim();
            }
            const assignedKeys = Object.values(shortcutKeys)
              .filter(Boolean)
              .map((key) => key.toLowerCase());
            if (new Set(assignedKeys).size !== assignedKeys.length) {
              throw new Error(
                `Site rule ${domain} has duplicate shortcut keys.`,
              );
            }
            overrides[name] = shortcutKeys;
            continue;
          }
          if (typeof optionDefault === "number") {
            if (!Number.isFinite(override) || override < 0) {
              throw new Error(
                `Site rule ${domain} has an invalid ${name} value.`,
              );
            }
            const maximum =
              name === "rewindSeconds"
                ? 60
                : name === "playbackSpeed"
                  ? 4
                  : name === "idlePauseMinutes"
                    ? 240
                    : Number.POSITIVE_INFINITY;
            const bounded = Math.min(maximum, override);
            overrides[name] =
              name === "playbackSpeed"
                ? Math.round(bounded * 4) / 4
                : Math.floor(bounded);
          } else {
            if (
              ["quietHoursStart", "quietHoursEnd"].includes(name) &&
              override !== "" &&
              !/^([01]\d|2[0-3]):[0-5]\d$/.test(override)
            ) {
              throw new Error(
                `Site rule ${domain} has an invalid ${name} value.`,
              );
            }
            overrides[name] = override;
          }
        }
        return {
          domain,
          enabled: rule.enabled !== false,
          overrides,
        };
      });
      continue;
    }
    if (option === "contentShortcutKeys") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("The content shortcut keys setting is invalid.");
      }
      const shortcutKeys = { ...DEFAULT_OPTIONS.contentShortcutKeys };
      for (const [action, key] of Object.entries(value)) {
        if (
          !Object.prototype.hasOwnProperty.call(shortcutKeys, action) ||
          typeof key !== "string" ||
          key.length > 20
        ) {
          throw new Error("The content shortcut keys setting is invalid.");
        }
        shortcutKeys[action] = key.trim();
      }
      const assignedKeys = Object.values(shortcutKeys)
        .filter(Boolean)
        .map((key) => key.toLowerCase());
      if (new Set(assignedKeys).size !== assignedKeys.length) {
        throw new Error("The content shortcut keys must be unique.");
      }
      imported[option] = shortcutKeys;
      continue;
    }
    if (typeof value !== typeof defaultValue) {
      throw new Error(`The ${option} setting has an invalid type.`);
    }
    if (typeof defaultValue === "number") {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`The ${option} setting has an invalid value.`);
      }
      const maximum =
        option === "rewindSeconds"
          ? 60
          : option === "playbackSpeed"
            ? 4
            : option === "idlePauseMinutes"
              ? 240
              : Number.POSITIVE_INFINITY;
      imported[option] = Math.min(maximum, value);
      if (option === "playbackSpeed") {
        imported[option] = Math.round(imported[option] * 4) / 4;
      } else {
        imported[option] = Math.floor(imported[option]);
      }
      continue;
    }
    if (
      ["quietHoursStart", "quietHoursEnd"].includes(option) &&
      value !== "" &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ) {
      throw new Error(`The ${option} setting must use 24-hour time.`);
    }
    imported[option] = value;
  }
  if (Object.keys(imported).length === 0) {
    throw new Error("The settings file does not contain supported settings.");
  }
  if (typeof settings.audioFading === "boolean") {
    imported.fadeDuration = settings.audioFading
      ? imported.fadeDuration || 200
      : 0;
  }
  if (
    typeof settings.handleAudio === "boolean" &&
    !Object.prototype.hasOwnProperty.call(settings, "allowAudio")
  ) {
    imported.allowAudio = !settings.handleAudio;
  }
  if (settings.handleAudio && typeof settings.audioAllowList === "string") {
    const siteRules = Array.isArray(imported.siteRules)
      ? imported.siteRules
      : [];
    for (const domain of settings.audioAllowList
      .split(/[,\s]+/)
      .map(VAP_NORMALIZE_DOMAIN)
      .filter(Boolean)) {
      const existing = siteRules.find(
        (rule) => VAP_NORMALIZE_DOMAIN(rule.domain) === domain,
      );
      if (existing) {
        existing.overrides.allowAudio = true;
      } else {
        siteRules.push({
          domain,
          enabled: true,
          overrides: { allowAudio: true },
        });
      }
    }
    imported.siteRules = siteRules;
  }
  return imported;
}

function validateSettingsPayload(payload) {
  if (
    !payload ||
    payload.schemaVersion !== SETTINGS_SCHEMA_VERSION ||
    !payload.settings
  ) {
    throw new Error("Unsupported or invalid settings file.");
  }
  const settings = validateSettingsObject(payload.settings);
  if (payload.profiles === undefined) {
    return { settings };
  }
  if (!Array.isArray(payload.profiles)) {
    throw new Error("Profiles must be an array.");
  }
  const profileNames = new Set();
  const profiles = payload.profiles.map((profile, index) => {
    if (
      !profile ||
      typeof profile.name !== "string" ||
      profile.name.trim().length === 0 ||
      profile.name.trim().length > 40
    ) {
      throw new Error("A profile has an invalid name.");
    }
    const name = profile.name.trim();
    if (profileNames.has(name.toLowerCase())) {
      throw new Error("Profile names must be unique.");
    }
    profileNames.add(name.toLowerCase());
    const id =
      name.toLowerCase() === "default"
        ? "default"
        : typeof profile.id === "string" && profile.id
          ? profile.id
          : `profile-${index + 1}`;
    if (!/^[a-z\d_-]{1,80}$/i.test(id)) {
      throw new Error("A profile has an invalid identifier.");
    }
    return {
      id,
      name: id === "default" ? "Default" : name,
      settings: {
        ...DEFAULT_OPTIONS,
        ...validateSettingsObject(profile.settings),
      },
    };
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("Profile identifiers must be unique.");
  }
  if (!profiles.some((profile) => profile.id === "default")) {
    profiles.unshift({
      id: "default",
      name: "Default",
      settings: { ...DEFAULT_OPTIONS, ...settings },
    });
  }
  const activeProfileId =
    typeof payload.activeProfileId === "string" &&
    profiles.some((profile) => profile.id === payload.activeProfileId)
      ? payload.activeProfileId
      : "default";
  return { settings, profiles, activeProfileId };
}

async function exportSettings() {
  const status = document.getElementById("settingsImportStatus");
  try {
    const profileData = await VAP_ENSURE_PROFILES(
      env.storage.sync,
      env.storage.local,
      DEFAULT_OPTIONS,
    );
    const settings = await VAP_GET_ACTIVE_PROFILE_SETTINGS(
      env.storage.sync,
      env.storage.local,
      DEFAULT_OPTIONS,
    );
    const payload = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      profiles: profileData.profiles,
      activeProfileId: profileData.activeProfileId,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `video-auto-pause-settings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = env.i18n.getMessage("settingsExported");
  } catch (error) {
    status.textContent = env.i18n.getMessage("settingsExportFailed");
    console.error("Video Auto Pause could not export settings:", error);
  }
}

async function importSettingsFile(file) {
  const status = document.getElementById("settingsImportStatus");
  try {
    await optionsReady;
    const payload = JSON.parse(await file.text());
    const imported = validateSettingsPayload(payload);
    if (imported.profiles) {
      await VAP_STORE_PROFILES(
        env.storage.sync,
        env.storage.local,
        imported.profiles,
        imported.activeProfileId,
      );
      await restoreProfiles();
      await restore_options();
    } else {
      await updateActiveProfileSettings(imported.settings);
    }
    status.textContent = env.i18n.getMessage("settingsImported");
  } catch (error) {
    status.textContent = env.i18n.getMessage("settingsImportFailed");
    console.error("Video Auto Pause could not import settings:", error);
  }
}

async function restoreProfiles() {
  const { profiles, activeProfileId } = await VAP_ENSURE_PROFILES(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
  );
  const activeSelect = document.getElementById("activeProfileSelect");
  const activeControl = document.getElementById("activeProfileControl");
  const select = document.getElementById("profileSelect");
  const profileLabel = (profile) =>
    profile.id === "default"
      ? env.i18n.getMessage("profileDefault") || "Default"
      : profile.name;
  activeSelect.replaceChildren();
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = env.i18n.getMessage("profileSelectPlaceholder");
  select.setAttribute("aria-label", placeholder.textContent);
  select.appendChild(placeholder);
  for (const profile of profiles) {
    for (const destination of [activeSelect, select]) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profileLabel(profile);
      destination.appendChild(option);
    }
  }
  activeSelect.value = activeProfileId;
  activeControl.hidden = profiles.length < 2;
  select.value = activeProfileId;
  document.getElementById("applyProfile").disabled = true;
  document.getElementById("deleteProfile").disabled =
    activeProfileId === "default";
}

async function saveProfile() {
  const name = document.getElementById("profileName").value.trim();
  if (!name || name.length > 40) {
    throw new Error("Profile names must contain 1 to 40 characters.");
  }
  const { profiles } = await VAP_ENSURE_PROFILES(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
  );
  if (
    name.toLowerCase() === "default" ||
    profiles.some(
      (profile) => profile.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new Error("A profile with that name already exists.");
  }
  const settings = await VAP_GET_ACTIVE_PROFILE_SETTINGS(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
  );
  const id = crypto.randomUUID();
  const updated = [
    ...profiles,
    {
      id,
      name,
      settings: { ...DEFAULT_OPTIONS, ...settings },
    },
  ];
  await VAP_STORE_PROFILES(env.storage.sync, env.storage.local, updated, id);
  await restoreProfiles();
  document.getElementById("activeProfileSelect").value = id;
  document.getElementById("profileSelect").value = id;
  document.getElementById("applyProfile").disabled = true;
  document.getElementById("deleteProfile").disabled = false;
}

async function applySelectedProfile(profileId = "") {
  const id = profileId || document.getElementById("profileSelect").value;
  if (!id) {
    throw new Error("Select a saved profile first.");
  }
  await VAP_ACTIVATE_PROFILE(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
    id,
  );
  await restoreProfiles();
  await restore_options();
}

async function deleteSelectedProfile() {
  const id = document.getElementById("profileSelect").value;
  const { profiles, activeProfileId } = await VAP_ENSURE_PROFILES(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
  );
  if (id === "default" || !profiles.some((profile) => profile.id === id)) {
    throw new Error("The Default profile cannot be deleted.");
  }
  const updated = profiles.filter((profile) => profile.id !== id);
  const nextActiveProfileId =
    activeProfileId === id ? "default" : activeProfileId;
  await VAP_STORE_PROFILES(
    env.storage.sync,
    env.storage.local,
    updated,
    nextActiveProfileId,
  );
  await restoreProfiles();
  if (activeProfileId === id) {
    await restore_options();
  }
}

function readOption(option, element) {
  if (
    [
      "pauseDelay",
      "resumeDelay",
      "fadeDuration",
      "rewindSeconds",
      "playbackSpeed",
      "idlePauseMinutes",
    ].includes(option)
  ) {
    const value = Number(element.value);
    const maximum =
      option === "rewindSeconds"
        ? 60
        : option === "playbackSpeed"
          ? 4
          : option === "idlePauseMinutes"
            ? 240
            : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(value)) {
      return 0;
    }
    const bounded = Math.min(maximum, Math.max(0, value));
    return option === "playbackSpeed"
      ? Math.round(bounded * 4) / 4
      : Math.floor(bounded);
  }
  if (["quietHoursStart", "quietHoursEnd"].includes(option)) {
    return element.value;
  }
  return element.checked;
}

async function save_option(option) {
  await optionsReady;
  if (option === "disabledTabs") {
    const tab = await getCurrentWebTab();
    if (!tab) {
      return;
    }
    const disabled = (await tabStorage.get("disabledTabs")).disabledTabs ?? [];
    const updated = document.getElementById("disabledTabs").checked
      ? [...new Set([...disabled, tab.id])]
      : disabled.filter((id) => id !== tab.id);
    await tabStorage.set({ disabledTabs: updated });
  } else {
    const element = document.getElementById(option);
    if (element) {
      await updateActiveProfileSettings({
        [option]: readOption(option, element),
      });
    }
  }
}

function restoreContentShortcutKeys(keys = {}) {
  for (const [action, id] of contentShortcutActions) {
    const input = document.getElementById(id);
    input.value = keys[action] ?? DEFAULT_OPTIONS.contentShortcutKeys[action];
  }
  setContentShortcutInputsDisabled();
}

function setContentShortcutInputsDisabled() {
  const enabled = document.getElementById("contentShortcutsEnabled").checked;
  document.getElementById("contentShortcutsDescription").hidden = !enabled;
  document.getElementById("contentShortcutSettings").hidden = !enabled;
  document
    .getElementById("contentShortcutSettings")
    .querySelectorAll("input")
    .forEach((input) => {
      input.disabled = !enabled;
    });
}

async function saveContentShortcutKeys() {
  await optionsReady;
  const keys = {};
  for (const [action, id] of contentShortcutActions) {
    keys[action] = document.getElementById(id).value.trim();
  }
  const assignedKeys = Object.values(keys)
    .filter(Boolean)
    .map((key) => key.toLowerCase());
  if (new Set(assignedKeys).size !== assignedKeys.length) {
    document.getElementById("contentShortcutsStatus").textContent =
      env.i18n.getMessage("contentShortcutsConflict");
    return;
  }
  await updateActiveProfileSettings({ contentShortcutKeys: keys });
  document.getElementById("contentShortcutsStatus").textContent =
    env.i18n.getMessage("contentShortcutsSaved");
}

function getWeeklyStats(stats) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - 6);
  const summary = {
    pauses: 0,
    resumes: 0,
    autoplayBlocked: 0,
    preventedSeconds: 0,
    lifetimePauses: stats.totalPauses ?? 0,
  };
  for (const [day, values] of Object.entries(stats)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      continue;
    }
    if (Date.parse(`${day}T00:00:00Z`) >= cutoff.getTime()) {
      summary.pauses += values.pauses ?? 0;
      summary.resumes += values.resumes ?? 0;
      summary.autoplayBlocked += values.autoplayBlocked ?? 0;
      summary.preventedSeconds += values.preventedSeconds ?? 0;
    }
  }
  return summary;
}

async function restoreStats() {
  const { vapStats = {} } = await env.storage.local.get("vapStats");
  const stats = getWeeklyStats(vapStats);
  const values = [
    stats.pauses.toString(),
    stats.resumes.toString(),
    stats.autoplayBlocked.toString(),
    Math.floor(stats.preventedSeconds / 60).toString(),
  ];
  const summary = env.i18n.getMessage("statsSummary", values);
  document.getElementById("statsSummary").textContent =
    summary ||
    `${values[0]} pauses · ${values[1]} resumes · ${values[2]} autoplay blocks · ${values[3]} min saved`;
  document.getElementById("rateExtension").hidden = stats.lifetimePauses < 50;
}

async function restoreSleepTimer() {
  const { vapSleepTimerExpiresAt } = await env.storage.local.get(
    "vapSleepTimerExpiresAt",
  );
  const active =
    Number.isFinite(vapSleepTimerExpiresAt) &&
    vapSleepTimerExpiresAt > Date.now();
  document.getElementById("sleepTimerDurationControl").hidden = active;
  document.getElementById("startSleepTimer").hidden = active;
  document.getElementById("cancelSleepTimer").hidden = !active;
  document.getElementById("sleepTimerStatus").textContent = active
    ? env.i18n.getMessage("sleepTimerSet", [
        String(Math.ceil((vapSleepTimerExpiresAt - Date.now()) / 60000)),
      ])
    : "";
}

async function updateSleepTimer(action) {
  const status = document.getElementById("sleepTimerStatus");
  try {
    const request = {
      sleepTimerAction: action,
    };
    if (action === "start") {
      request.minutes = Number(
        document.getElementById("sleepTimerMinutes").value,
      );
    }
    const response = await env.runtime.sendMessage(request);
    if (response?.error) {
      throw new Error(response.error);
    }
    await restoreSleepTimer();
  } catch (error) {
    status.textContent = env.i18n.getMessage("sleepTimerFailed");
    console.error("Video Auto Pause could not update the sleep timer:", error);
  }
}

async function restore_options(changedKeys = Object.keys(options)) {
  const items = await VAP_GET_ACTIVE_PROFILE_SETTINGS(
    env.storage.sync,
    env.storage.local,
    DEFAULT_OPTIONS,
  );
  for (const opt of changedKeys) {
    if (!(opt in options)) {
      continue;
    }
    const element = document.getElementById(opt);
    if (!element) {
      continue;
    }
    if (
      [
        "pauseDelay",
        "resumeDelay",
        "fadeDuration",
        "rewindSeconds",
        "playbackSpeed",
        "idlePauseMinutes",
      ].includes(opt)
    ) {
      element.value = Math.max(0, Number(items[opt]) || 0);
    } else if (["quietHoursStart", "quietHoursEnd"].includes(opt)) {
      element.value = items[opt] || "";
    } else {
      element.checked = Boolean(items[opt]);
    }
  }
  restoreContentShortcutKeys(items.contentShortcutKeys);

  if (changedKeys.includes("disabled")) {
    for (const option of Object.keys(options)) {
      const element = document.getElementById(option);
      if (element) {
        element.disabled = items.disabled && option !== "disabled";
      }
    }
  }

  const disabledTabsInput = document.getElementById("disabledTabs");
  if (disabledTabsInput) {
    const tab = await getCurrentWebTab();
    disabledTabsInput.disabled = !tab;
    if (tab) {
      const disabled =
        (await tabStorage.get("disabledTabs")).disabledTabs ?? [];
      disabledTabsInput.checked = disabled.includes(tab.id);
    } else {
      disabledTabsInput.checked = false;
    }
  }

  await restoreCurrentTabPin();
  await restoreSiteRules();
}

async function restoreCurrentTabPin() {
  const button = document.getElementById("pinCurrentTab");
  const tab = await getCurrentWebTab();
  button.disabled = !tab;
  if (!tab) {
    button.setAttribute("aria-pressed", "false");
    button.classList.remove("is-pinned");
    button.setAttribute("aria-label", env.i18n.getMessage("pinCurrentTab"));
    button.title = env.i18n.getMessage("pinCurrentTab");
    return;
  }
  const pinned = (await tabStorage.get("pinnedTabs")).pinnedTabs ?? [];
  const isPinned = pinned.includes(tab.id);
  button.setAttribute("aria-pressed", String(isPinned));
  button.classList.toggle("is-pinned", isPinned);
  const label = env.i18n.getMessage(
    isPinned ? "unpinCurrentTab" : "pinCurrentTab",
  );
  button.setAttribute("aria-label", label);
  button.title = label;
}

// Show shortcuts in the options window
env.commands.getAll(function (commands) {
  const hotkeysDiv = document.getElementById("hotkeys");
  for (let i = 0; i < commands.length; i++) {
    if (
      commands[i].shortcut.length === 0 ||
      commands[i].description.length === 0
    ) {
      continue;
    }
    const tag = document.createElement("p");
    const text = document.createTextNode(
      commands[i].shortcut + " - " + commands[i].description,
    );
    tag.appendChild(text);
    hotkeysDiv.appendChild(tag);
  }
});

// Show version in the options window
const version = document.getElementById("version");
version.textContent = "v" + env.runtime.getManifest().version;

// Localize UI elements
localizeUI();

// Restore options on load and when they change in the store
optionsReady = (async () => {
  try {
    await restore_options();
    await restoreProfiles();
    env.storage.onChanged.addListener(handleStorageChanged);
  } catch (error) {
    console.error("Video Auto Pause could not restore settings:", error);
    throw error;
  } finally {
    if (settingsView) {
      settingsView.inert = false;
      settingsView.removeAttribute("aria-busy");
    }
    document.body.classList.remove("options-loading");
    document.body.dataset.settingsReady = "true";
  }
})();
void optionsReady.catch(() => {});

function handleStorageChanged(changes, namespace) {
  if (namespace === "sync") {
    void (async () => {
      const activeProfileId =
        (await env.storage.local.get("vapActiveProfileId"))
          .vapActiveProfileId ?? "default";
      const activeProfileKey = `vapProfile:${activeProfileId}`;
      const changedProfile = changes[activeProfileKey];
      const changedOptionKeys = Object.keys(changes).filter(
        (key) => key in options,
      );

      if ("vapProfileIds" in changes || changedProfile) {
        await restoreProfiles();
      }

      if ("vapProfileIds" in changes) {
        await queueOptionsRestore(Object.keys(options));
      } else if (changedProfile) {
        const oldSettings = changedProfile.oldValue?.settings ?? {};
        const newSettings = changedProfile.newValue?.settings ?? {};
        const changedSettings = [
          ...new Set([
            ...Object.keys(oldSettings),
            ...Object.keys(newSettings),
          ]),
        ].filter(
          (key) =>
            key in options &&
            JSON.stringify(oldSettings[key]) !==
              JSON.stringify(newSettings[key]),
        );
        if (changedSettings.length) {
          await queueOptionsRestore(changedSettings);
        }
      } else if (changedOptionKeys.length) {
        await queueOptionsRestore(changedOptionKeys);
      }
    })().catch((error) => {
      console.error("Video Auto Pause could not restore changed settings:", error);
    });
  } else if (namespace === "local" && "vapActiveProfileId" in changes) {
    void Promise.all([restoreProfiles(), queueOptionsRestore(Object.keys(options))]).catch((error) => {
      console.error(
        "Video Auto Pause could not restore changed settings:",
        error,
      );
    });
  } else if (namespace === "session" || namespace === "local") {
    void queueOptionsRestore([]).catch((error) => {
      console.error(
        "Video Auto Pause could not restore changed settings:",
        error,
      );
    });
    if (namespace === "local" && "vapStats" in changes) {
      void restoreStats();
    }
    if (namespace === "local" && "vapSleepTimerExpiresAt" in changes) {
      void restoreSleepTimer();
    }
  }
}

document
  .getElementById("pinCurrentTab")
  ?.addEventListener("click", async () => {
    const status = document.getElementById("pinStatus");
    try {
      const tab = await getCurrentWebTab();
      if (!tab) {
        throw new Error("No supported tab is active.");
      }
      const pinned = (await tabStorage.get("pinnedTabs")).pinnedTabs ?? [];
      await tabStorage.set({
        pinnedTabs: pinned.includes(tab.id)
          ? pinned.filter((tabId) => tabId !== tab.id)
          : [...pinned, tab.id],
      });
      status.textContent = "";
      await restoreCurrentTabPin();
    } catch (error) {
      status.textContent = env.i18n.getMessage("pinFailure");
      console.error("Video Auto Pause could not update the tab pin:", error);
    }
  });

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", async () => {
    const preset = globalThis.VAP_PRESETS[button.dataset.preset];
    const status = document.getElementById("presetStatus");
    try {
      await optionsReady;
      await updateActiveProfileSettings(preset);
      status.textContent = env.i18n.getMessage("presetApplied");
    } catch (error) {
      status.textContent = env.i18n.getMessage("presetFailed");
      console.error(
        "Video Auto Pause could not apply the selected preset:",
        error,
      );
    }
  });
});

if (env.runtime.getManifest().browser_specific_settings?.gecko) {
  document.getElementById("rateExtension").href =
    "https://addons.mozilla.org/firefox/addon/video-auto-pause/";
}

void restoreStats();
void restoreSleepTimer();

document.getElementById("startSleepTimer")?.addEventListener("click", () => {
  void updateSleepTimer("start");
});
document.getElementById("cancelSleepTimer")?.addEventListener("click", () => {
  void updateSleepTimer("cancel");
});
document.getElementById("exportSettings")?.addEventListener("click", () => {
  void exportSettings();
});
document.getElementById("importSettings")?.addEventListener("click", () => {
  document.getElementById("importSettingsFile").click();
});
document
  .getElementById("importSettingsFile")
  ?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file) {
      void importSettingsFile(file);
    }
    input.value = "";
  });
document.getElementById("saveProfile")?.addEventListener("click", async () => {
  const status = document.getElementById("profileStatus");
  try {
    await optionsReady;
    await saveProfile();
    status.textContent = env.i18n.getMessage("profileSaved");
  } catch (error) {
    status.textContent = env.i18n.getMessage("profileFailed");
    console.error("Video Auto Pause could not save a profile:", error);
  }
});
document.getElementById("applyProfile")?.addEventListener("click", async () => {
  const status = document.getElementById("profileStatus");
  try {
    await optionsReady;
    await applySelectedProfile();
    status.textContent = env.i18n.getMessage("profileApplied");
  } catch (error) {
    status.textContent = env.i18n.getMessage("profileFailed");
    console.error("Video Auto Pause could not apply a profile:", error);
  }
});
document
  .getElementById("deleteProfile")
  ?.addEventListener("click", async () => {
    const status = document.getElementById("profileStatus");
    try {
      await optionsReady;
      await deleteSelectedProfile();
      status.textContent = env.i18n.getMessage("profileDeleted");
    } catch (error) {
      status.textContent = env.i18n.getMessage("profileFailed");
      console.error("Video Auto Pause could not delete a profile:", error);
    }
  });
document.getElementById("copyDiagnostics").addEventListener("click", () => {
  const status = document.getElementById("diagnosticsStatus");
  void copyDiagnostics()
    .then(() => {
      status.textContent = env.i18n.getMessage("diagnosticsCopied");
    })
    .catch((error) => {
      status.textContent = env.i18n.getMessage("diagnosticsFailed");
      console.error("Video Auto Pause could not copy diagnostics:", error);
    });
});
document
  .getElementById("profileSelect")
  ?.addEventListener("change", (event) => {
    const selected = Boolean(event.currentTarget.value);
    const profileId = event.currentTarget.value;
    document.getElementById("applyProfile").disabled =
      !selected ||
      profileId === document.getElementById("activeProfileSelect").value;
    document.getElementById("deleteProfile").disabled =
      !selected || profileId === "default";
  });

document
  .getElementById("activeProfileSelect")
  ?.addEventListener("change", async (event) => {
    const status = document.getElementById("profileStatus");
    const profileId = event.currentTarget.value;
    try {
      await optionsReady;
      await applySelectedProfile(profileId);
      status.textContent = env.i18n.getMessage("profileApplied");
    } catch (error) {
      status.textContent = env.i18n.getMessage("profileFailed");
      console.error("Video Auto Pause could not switch profiles:", error);
    }
  });

// Listen to changes of options
for (const option in options) {
  const el = document.getElementById(option);
  if (el) {
    el.addEventListener("change", async () => {
      try {
        if (option === "contentShortcutsEnabled") {
          setContentShortcutInputsDisabled();
        }
        await save_option(option);
        document.getElementById("settingsSaveStatus").textContent = "";
      } catch (error) {
        document.getElementById("settingsSaveStatus").textContent =
          env.i18n.getMessage("settingsSaveFailed");
        console.error(`Video Auto Pause could not save ${option}:`, error);
      }
    });
  }
}

for (const [, id] of contentShortcutActions) {
  document.getElementById(id).addEventListener("change", () => {
    void saveContentShortcutKeys().catch((error) => {
      console.error(
        "Video Auto Pause could not save content shortcuts:",
        error,
      );
    });
  });
}

buildSiteSettingsFields();
void updateSiteReportLink().catch((error) => {
  console.error(
    "Video Auto Pause could not prepare the site report link:",
    error,
  );
});
document.getElementById("addSiteRule").addEventListener("click", () => {
  void optionsReady.then(addCurrentSiteRule).catch((error) => {
    document.getElementById("siteRuleStatus").textContent =
      env.i18n.getMessage("siteRuleFailed");
    console.error("Video Auto Pause could not add a site rule:", error);
  });
});
document.getElementById("siteRuleFilter").addEventListener("input", () => {
  void restoreSiteRules().catch((error) => {
    console.error("Video Auto Pause could not filter site rules:", error);
  });
});
document.getElementById("backToGlobal").addEventListener("click", () => {
  closeSiteSettings();
});
document.getElementById("saveSiteSettings").addEventListener("click", () => {
  void optionsReady.then(saveSiteSettings).catch((error) => {
    document.getElementById("siteSettingsStatus").textContent =
      env.i18n.getMessage("siteRuleFailed");
    console.error("Video Auto Pause could not save site settings:", error);
  });
});
document.getElementById("deleteSiteSettings").addEventListener("click", () => {
  void optionsReady
    .then(() => deleteSiteRule(editingSiteDomain))
    .catch((error) => {
      document.getElementById("siteSettingsStatus").textContent =
        env.i18n.getMessage("siteRuleFailed");
      console.error("Video Auto Pause could not delete site settings:", error);
    });
});

document
  .getElementById("disabledTabs")
  ?.addEventListener("change", async () => {
    await save_option("disabledTabs");
  });

document.querySelectorAll(".collapsible_button").forEach((button) => {
  button.addEventListener("click", () => {
    const content = button.nextElementSibling;
    const expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.classList.toggle("active", expanded);
    content.classList.toggle("expanded", expanded);
  });
});
