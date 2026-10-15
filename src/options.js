// Browser
const env = chrome.runtime ? chrome : browser;
const tabStorage = env.storage.session ?? env.storage.local;
const DEFAULT_OPTIONS = globalThis.VAP_DEFAULT_OPTIONS;
const siteOverrideOptions = Object.entries(DEFAULT_OPTIONS).filter(
  ([option, value]) =>
    !["disabled", "onlyConfiguredSites", "siteRules"].includes(option) &&
    (typeof value === "boolean" || typeof value === "number"),
);
let siteRulesMigration;
let siteRulesCache = [];

function migrateSiteRules() {
  siteRulesMigration ??= VAP_MIGRATE_DOMAIN_SETTINGS(env.storage.sync).catch(
    (error) => {
      siteRulesMigration = undefined;
      throw error;
    },
  );
  return siteRulesMigration;
}

function localizeUI() {
  if (!env?.i18n) {
    return;
  }
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
    const valueInput = document.querySelector(`[data-site-value="${option}"]`);
    const value = customized
      ? overrides[option]
      : (settings[option] ?? defaultValue);
    customize.checked = customized;
    valueInput.disabled = !customized;
    if (valueInput.type === "checkbox") {
      valueInput.checked = Boolean(value);
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
  const settings = await env.storage.sync.get(DEFAULT_OPTIONS);
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
  const stored = await env.storage.sync.get("siteRules");
  siteRulesCache = Array.isArray(stored.siteRules) ? stored.siteRules : [];
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
  await env.storage.sync.set({ siteRules: updated });
  siteRulesCache = updated;
  document.getElementById("siteSettingsStatus").textContent =
    env.i18n.getMessage("siteRuleSaved");
  await restoreSiteRules();
}

async function deleteSiteRule(domain) {
  const updated = siteRulesCache.filter(
    (rule) => VAP_NORMALIZE_DOMAIN(rule.domain) !== domain,
  );
  await env.storage.sync.set({ siteRules: updated });
  siteRulesCache = updated;
  await restoreSiteRules();
  if (editingSiteDomain === domain) {
    closeSiteSettings();
  }
}

const options = DEFAULT_OPTIONS;

async function getCurrentWebTab() {
  const tabs = await env.tabs.query({ active: true, lastFocusedWindow: true });
  const isWebTab = (tab) => {
    try {
      return ["http:", "https:", "file:"].includes(new URL(tab.url).protocol);
    } catch {
      return false;
    }
  };
  return (
    tabs.find(isWebTab) ??
    (await env.tabs.query({ lastFocusedWindow: true })).find(isWebTab)
  );
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
      await env.storage.sync.set({ [option]: readOption(option, element) });
    }
  }
}

function updateAudioFadingVisibility() {
  const settings = document.getElementById("audioFadingSettings");
  const enabled = document.getElementById("audioFading")?.checked;
  if (settings) {
    settings.hidden = !enabled;
  }
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
    const response = await env.runtime.sendMessage({
      sleepTimerAction: action,
      minutes: 30,
    });
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
  await migrateSiteRules();
  const items = await env.storage.sync.get(options);
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

  updateAudioFadingVisibility();

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
    button.textContent = env.i18n.getMessage("pinCurrentTab");
    return;
  }
  const pinned = (await tabStorage.get("pinnedTabs")).pinnedTabs ?? [];
  const isPinned = pinned.includes(tab.id);
  button.setAttribute("aria-pressed", String(isPinned));
  button.textContent = env.i18n.getMessage(
    isPinned ? "unpinCurrentTab" : "pinCurrentTab",
  );
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
document.addEventListener("DOMContentLoaded", () => {
  void restore_options().catch((error) => {
    console.error("Video Auto Pause could not restore settings:", error);
  });
});

env.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync") {
    void restore_options(Object.keys(changes)).catch((error) => {
      console.error(
        "Video Auto Pause could not restore changed settings:",
        error,
      );
    });
  } else if (namespace === "session" || namespace === "local") {
    void restore_options([]).catch((error) => {
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
});

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
      await env.storage.sync.set(preset);
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

// Listen to changes of options
for (const option in options) {
  const el = document.getElementById(option);
  if (el) {
    el.addEventListener("change", async () => {
      if (option === "audioFading") {
        updateAudioFadingVisibility();
      }
      await save_option(option);
    });
  }
}

buildSiteSettingsFields();
document.getElementById("addSiteRule").addEventListener("click", () => {
  void addCurrentSiteRule().catch((error) => {
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
  void saveSiteSettings().catch((error) => {
    document.getElementById("siteSettingsStatus").textContent =
      env.i18n.getMessage("siteRuleFailed");
    console.error("Video Auto Pause could not save site settings:", error);
  });
});
document.getElementById("deleteSiteSettings").addEventListener("click", () => {
  void deleteSiteRule(editingSiteDomain).catch((error) => {
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

const coll = document.getElementsByClassName("collapsible_button");
let i;

for (i = 0; i < coll.length; i++) {
  coll[i].addEventListener("click", function () {
    this.classList.toggle("active");
    const content = this.nextElementSibling;
    if (content.style.maxHeight) {
      content.style.maxHeight = null;
    } else {
      content.style.maxHeight = content.scrollHeight + "px";
    }
  });
}

document.querySelectorAll(".collapsible_content details").forEach((details) => {
  details.addEventListener("toggle", () => {
    const content = details.closest(".collapsible_content");
    if (content?.style.maxHeight) {
      content.style.maxHeight = `${content.scrollHeight}px`;
    }
  });
});
