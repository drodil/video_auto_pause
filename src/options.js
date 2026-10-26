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
const settingKeys = Object.keys(DEFAULT_SETTINGS);
const timeSettings = new Set(TIME_SETTINGS);
const contentShortcutInputs = [
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
let optionsReady = Promise.resolve();
let settingsUpdateQueue = Promise.resolve();
let optionsRestoreQueue = Promise.resolve();
let siteRulesCache = [];
let editingSiteDomain = "";
let siteDefaultSettings = DEFAULT_SETTINGS;
let sleepTimerExpiresAt = 0;
let sleepTimerActive;
let sleepTimerInterval;
let statisticsDays = 7;

function message(key, substitutions) {
  return env.i18n.getMessage(key, substitutions);
}

function setStatus(id, key) {
  document.getElementById(id).textContent = key ? message(key) : "";
}

// Serializes writes so quick successive changes cannot overwrite each other.
// Settings with writes in flight are not restored from storage change events,
// otherwise the echo of an earlier write could revert a newer user change.
const pendingSettingWrites = new Map();

async function queueSettingsUpdate(settingsPatch) {
  const keys = Object.keys(settingsPatch);
  for (const key of keys) {
    pendingSettingWrites.set(key, (pendingSettingWrites.get(key) ?? 0) + 1);
  }
  try {
    await optionsReady;
    const update = settingsUpdateQueue.then(() =>
      updateActiveProfileSettings(settingsPatch),
    );
    settingsUpdateQueue = update.catch(() => {});
    await update;
  } finally {
    for (const key of keys) {
      const count = pendingSettingWrites.get(key) - 1;
      if (count > 0) {
        pendingSettingWrites.set(key, count);
      } else {
        pendingSettingWrites.delete(key);
      }
    }
  }
}

function queueOptionsRestore(changedKeys) {
  const restore = optionsRestoreQueue.then(() => restoreOptions(changedKeys));
  optionsRestoreQueue = restore.catch(() => {});
  return restore;
}

function localizeUI() {
  if (!env?.i18n) {
    return;
  }
  document.documentElement.lang = env.i18n.getUILanguage();
  document.documentElement.dir = message("@@bidi_dir") || "ltr";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const text = message(element.dataset.i18n);
    if (text) {
      element.textContent = text;
    }
  }
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    const text = message(element.dataset.i18nPlaceholder);
    if (text) {
      element.placeholder = text;
    }
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    const text = message(element.dataset.i18nAriaLabel);
    if (text) {
      element.setAttribute("aria-label", text);
    }
  }
  initTooltips();
  document.title = message("extName") || "Video Auto Pause";
}

function getSettingLabel(setting) {
  if (timeSettings.has(setting)) {
    return `${message("quietHours")}: ${message(setting)}`;
  }
  return message(setting);
}

// The popup targets the active web tab. When settings are opened in their own
// tab, the most recently used web tab is targeted instead.
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

// Site settings

function createSiteValueInput(setting, defaultValue) {
  const input = document.createElement("input");
  input.dataset.siteValue = setting;
  input.setAttribute("aria-label", getSettingLabel(setting));
  if (typeof defaultValue === "boolean") {
    input.type = "checkbox";
  } else if (timeSettings.has(setting)) {
    input.type = "time";
  } else {
    const limits = NUMERIC_SETTING_LIMITS[setting];
    input.type = "number";
    input.min = "0";
    input.step = String(limits.step ?? (setting === "fadeDuration" ? 50 : 1));
    if (Number.isFinite(limits.max)) {
      input.max = String(limits.max);
    }
  }
  return input;
}

function setSiteBooleanState(input, state) {
  input.dataset.siteState = state;
  input.indeterminate = state === "inherit";
  input.checked = state === "enabled";
  input.setAttribute(
    "aria-checked",
    state === "inherit" ? "mixed" : String(input.checked),
  );
  const inherited = siteDefaultSettings[input.dataset.siteValue];
  const description = document
    .getElementById(input.dataset.siteValue)
    ?.closest("[data-tooltip]")?.dataset.tooltip;
  const stateDescription =
    state === "inherit"
      ? `${message("siteRuleInherit")}: ${message(inherited ? "siteRuleEnabledOption" : "siteRuleDisabledOption")}`
      : message(
          input.checked ? "siteRuleEnabledOption" : "siteRuleDisabledOption",
        );
  setTooltip(
    input.closest("label"),
    [description, stateDescription].filter(Boolean).join(" "),
  );
}

function buildSiteSettingsFields() {
  const container = document.getElementById("siteSettingsFields");
  for (const group of document.querySelectorAll("[data-settings-group]")) {
    const settings = new Set(
      [...group.querySelectorAll("input[id], [data-setting]")]
        .map((input) => input.dataset.setting ?? input.id)
        .filter((setting) => SITE_OVERRIDE_SETTINGS.includes(setting)),
    );
    const details = document.createElement("details");
    details.className = "settings-disclosure";
    details.dataset.siteSettingsGroup = group.dataset.settingsGroup;
    details.open =
      group
        .querySelector(".collapsible-button")
        .getAttribute("aria-expanded") === "true";
    const summary = document.createElement("summary");
    summary.textContent = message(group.dataset.settingsGroup);
    details.appendChild(summary);
    const content = document.createElement("div");
    content.className = "disclosure-content";
    for (const setting of settings) {
      const defaultValue = DEFAULT_SETTINGS[setting];
      const label = getSettingLabel(setting);
      const row = document.createElement("div");
      row.className = "site-setting-row";
      if (typeof defaultValue === "boolean") {
        row.classList.add("site-setting-boolean");
        const fieldLabel = document.createElement("label");
        const input = createSiteValueInput(setting, defaultValue);
        const name = document.createElement("span");
        name.className = "label-text";
        name.textContent = label;
        fieldLabel.append(input, name);
        row.appendChild(fieldLabel);
        input.addEventListener("click", () => {
          const next = {
            inherit: "enabled",
            enabled: "disabled",
            disabled: "inherit",
          };
          setSiteBooleanState(input, next[input.dataset.siteState]);
        });
        content.appendChild(row);
        continue;
      }
      const settingName = document.createElement("strong");
      settingName.textContent = label;
      const customizeLabel = document.createElement("label");
      customizeLabel.className = "site-setting-customize";
      const customize = document.createElement("input");
      customize.type = "checkbox";
      customize.dataset.siteOverride = setting;
      customize.setAttribute(
        "aria-label",
        `${message("siteRuleCustomize")}: ${label}`,
      );
      customizeLabel.append(
        customize,
        document.createTextNode(message("siteRuleCustomize")),
      );

      let valueInputs;
      if (setting === "contentShortcutKeys") {
        const shortcutFields = document.createElement("div");
        shortcutFields.className = "site-shortcut-fields";
        valueInputs = Object.entries(defaultValue).map(([action, key]) => {
          const fieldLabel = document.createElement("label");
          const name = document.createElement("span");
          name.textContent = message(`${action}Shortcut`);
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = MAX_SHORTCUT_KEY_LENGTH;
          input.value = key;
          input.dataset.siteShortcutValue = action;
          input.setAttribute("aria-label", name.textContent);
          fieldLabel.append(name, input);
          shortcutFields.appendChild(fieldLabel);
          return input;
        });
        row.append(settingName, customizeLabel, shortcutFields);
      } else {
        const input = createSiteValueInput(setting, defaultValue);
        valueInputs = [input];
        row.append(settingName, customizeLabel, input);
      }
      for (const input of valueInputs) {
        input.disabled = true;
      }
      customize.addEventListener("change", () => {
        for (const input of valueInputs) {
          input.disabled = !customize.checked;
        }
        if (customize.checked) {
          setSiteValueInputs(setting, siteDefaultSettings[setting]);
        }
      });
      content.appendChild(row);
    }
    details.appendChild(content);
    container.appendChild(details);
  }
}

function setSiteValueInputs(setting, value) {
  if (setting === "contentShortcutKeys") {
    for (const [action, fallback] of Object.entries(
      DEFAULT_SETTINGS.contentShortcutKeys,
    )) {
      document.querySelector(`[data-site-shortcut-value="${action}"]`).value =
        value?.[action] ?? fallback;
    }
    return;
  }
  const input = document.querySelector(`[data-site-value="${setting}"]`);
  if (input.type === "checkbox") {
    input.checked = Boolean(value);
  } else if (input.type === "time") {
    input.value = typeof value === "string" ? value : "";
  } else {
    input.value = String(Math.max(0, Number(value) || 0));
  }
}

function setSiteSettingsValues(rule, settings) {
  siteDefaultSettings = settings;
  const overrides = rule?.overrides ?? {};
  document.getElementById("siteRuleEnabled").checked = rule?.enabled !== false;
  for (const setting of SITE_OVERRIDE_SETTINGS) {
    const customized = Object.prototype.hasOwnProperty.call(overrides, setting);
    if (typeof DEFAULT_SETTINGS[setting] === "boolean") {
      setSiteBooleanState(
        document.querySelector(`[data-site-value="${setting}"]`),
        customized ? (overrides[setting] ? "enabled" : "disabled") : "inherit",
      );
      continue;
    }
    document.querySelector(`[data-site-override="${setting}"]`).checked =
      customized;
    const inputs =
      setting === "contentShortcutKeys"
        ? document.querySelectorAll("[data-site-shortcut-value]")
        : [document.querySelector(`[data-site-value="${setting}"]`)];
    for (const input of inputs) {
      input.disabled = !customized;
    }
    setSiteValueInputs(
      setting,
      customized ? overrides[setting] : settings[setting],
    );
  }
}

function setSettingsViewOpen(siteOpen) {
  document
    .getElementById("settingsViews")
    .classList.toggle("site-open", siteOpen);
  const globalView = document.getElementById("globalSettingsView");
  const siteView = document.getElementById("siteSettingsView");
  globalView.inert = siteOpen;
  globalView.setAttribute("aria-hidden", String(siteOpen));
  siteView.inert = !siteOpen;
  siteView.setAttribute("aria-hidden", String(!siteOpen));
}

async function openSiteSettings(domain) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain || !isValidDomain(normalizedDomain)) {
    throw new Error("The site rule has an invalid domain.");
  }
  editingSiteDomain = normalizedDomain;
  const settings = await getActiveProfileSettings();
  const rule = settings.siteRules.find(
    (entry) => normalizeDomain(entry.domain) === normalizedDomain,
  ) ?? { domain: normalizedDomain, enabled: true, overrides: {} };
  document.getElementById("siteSettingsTitle").textContent = message(
    "siteSettingsTitle",
    [normalizedDomain],
  );
  document.getElementById("siteSettingsDomain").value = normalizedDomain;
  setStatus("siteSettingsStatus");
  setSiteSettingsValues(rule, settings);
  setSettingsViewOpen(true);
  document.getElementById("wrapper").scrollTop = 0;
  document.getElementById("backToGlobal").focus();
}

function closeSiteSettings() {
  const domain = editingSiteDomain;
  setSettingsViewOpen(false);
  editingSiteDomain = "";
  const target =
    document.querySelector(`[data-open-site-rule="${CSS.escape(domain)}"]`) ??
    document.getElementById("newSiteDomain");
  target.focus();
}

function renderSiteRules() {
  const list = document.getElementById("siteRuleList");
  const focusedButton = list.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusedAttribute = focusedButton?.hasAttribute("data-open-site-rule")
    ? "data-open-site-rule"
    : "data-remove-site-rule";
  const focusedDomain = focusedButton?.getAttribute(focusedAttribute);
  const items = [];
  for (const rule of siteRulesCache) {
    const domain = normalizeDomain(rule.domain);
    if (!domain) {
      continue;
    }
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.dataset.openSiteRule = domain;
    open.textContent = domain;
    open.setAttribute("aria-label", message("siteSettingsTitle", [domain]));
    open.addEventListener("click", () => {
      void openSiteSettings(domain).catch((error) => {
        console.error("Video Auto Pause could not open site settings:", error);
      });
    });
    const state = document.createElement("span");
    state.textContent = message(
      rule.enabled === false
        ? "siteRuleDisabledOption"
        : "siteRuleEnabledOption",
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-danger";
    remove.dataset.removeSiteRule = domain;
    remove.textContent = message("siteRuleRemove");
    remove.setAttribute("aria-label", `${remove.textContent}: ${domain}`);
    remove.addEventListener("click", () => {
      void deleteSiteRule(domain).catch((error) => {
        setStatus("siteRuleStatus", "siteRuleFailed");
        console.error(
          "Video Auto Pause could not remove the site rule:",
          error,
        );
      });
    });
    item.append(open, state, remove);
    items.push(item);
  }
  list.replaceChildren(...items);
  if (focusedDomain) {
    const target =
      list.querySelector(
        `[${focusedAttribute}="${CSS.escape(focusedDomain)}"]`,
      ) ?? document.getElementById("newSiteDomain");
    target.focus();
  }
}

async function restoreSiteRules(settings) {
  siteRulesCache = (settings ?? (await getActiveProfileSettings())).siteRules;
  renderSiteRules();
}

async function addCurrentSiteRule() {
  const tab = await getCurrentWebTab();
  if (!tab) {
    throw new Error("No supported web page is available.");
  }
  await openSiteSettings(new URL(tab.url).hostname);
}

function readSiteOverrides() {
  const overrides = {};
  for (const setting of SITE_OVERRIDE_SETTINGS) {
    if (typeof DEFAULT_SETTINGS[setting] === "boolean") {
      const input = document.querySelector(`[data-site-value="${setting}"]`);
      if (input.dataset.siteState !== "inherit") {
        overrides[setting] = input.checked;
      }
      continue;
    }
    if (!document.querySelector(`[data-site-override="${setting}"]`).checked) {
      continue;
    }
    if (setting === "contentShortcutKeys") {
      const keys = Object.fromEntries(
        [...document.querySelectorAll("[data-site-shortcut-value]")].map(
          (input) => [input.dataset.siteShortcutValue, input.value.trim()],
        ),
      );
      if (hasDuplicateShortcutKeys(keys)) {
        throw new Error("Site shortcut keys must be unique.");
      }
      overrides[setting] = keys;
      continue;
    }
    overrides[setting] = readSettingInput(
      setting,
      document.querySelector(`[data-site-value="${setting}"]`),
    );
  }
  return overrides;
}

async function saveSiteSettings() {
  if (!editingSiteDomain) {
    throw new Error("No site is currently selected.");
  }
  const domainInput = document.getElementById("siteSettingsDomain");
  const domain = normalizeDomain(domainInput.value);
  if (!domainInput.reportValidity() || !isValidDomain(domain)) {
    throw new Error("The site rule has an invalid domain.");
  }
  if (
    domain !== editingSiteDomain &&
    siteRulesCache.some((rule) => rule.domain === domain)
  ) {
    throw new Error("A rule already exists for this site.");
  }
  const updated = upsertSiteRule(
    siteRulesCache.filter((rule) => rule.domain !== editingSiteDomain),
    {
      domain,
      enabled: document.getElementById("siteRuleEnabled").checked,
      overrides: readSiteOverrides(),
    },
  );
  await queueSettingsUpdate({ siteRules: updated });
  siteRulesCache = updated;
  editingSiteDomain = domain;
  domainInput.value = domain;
  document.getElementById("siteSettingsTitle").textContent = message(
    "siteSettingsTitle",
    [domain],
  );
  renderSiteRules();
  setStatus("siteRuleStatus", "siteRuleSaved");
  closeSiteSettings();
}

async function deleteSiteRule(domain) {
  const updated = siteRulesCache.filter(
    (rule) => normalizeDomain(rule.domain) !== domain,
  );
  await queueSettingsUpdate({ siteRules: updated });
  siteRulesCache = updated;
  renderSiteRules();
  setStatus("siteRuleStatus");
  if (editingSiteDomain === domain) {
    closeSiteSettings();
  }
}

// Reports and diagnostics

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
  const [settings, { vapLastContentScriptError }] = await Promise.all([
    getActiveProfileSettings(),
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

// Import, export, and profiles

async function exportSettings() {
  const { profiles, activeProfileId } = await loadProfiles();
  const payload = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: profiles.find((profile) => profile.id === activeProfileId)
      .settings,
    profiles,
    activeProfileId,
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
}

async function importSettingsFile(file) {
  await optionsReady;
  const imported = validateSettingsPayload(JSON.parse(await file.text()));
  if (imported.profiles) {
    await storeProfiles(imported.profiles, imported.activeProfileId);
    await restoreProfiles();
    await queueOptionsRestore();
  } else {
    await queueSettingsUpdate(imported.settings);
  }
}

async function restoreProfiles() {
  const { profiles, activeProfileId } = await loadProfiles();
  const activeSelect = document.getElementById("activeProfileSelect");
  const list = document.getElementById("profileList");
  const focusedProfileId = list.contains(document.activeElement)
    ? document.activeElement.dataset.removeProfile
    : undefined;
  const createOption = (value, text) =>
    Object.assign(document.createElement("option"), {
      value,
      textContent: text,
    });
  const profileLabel = (profile) =>
    profile.id === DEFAULT_PROFILE_ID
      ? message("profileDefault") || profile.name
      : profile.name;
  const customProfiles = profiles.filter(
    (profile) => profile.id !== DEFAULT_PROFILE_ID,
  );
  if (
    activeSelect.options.length !== profiles.length ||
    profiles.some(
      (profile, index) =>
        activeSelect.options[index].value !== profile.id ||
        activeSelect.options[index].textContent !== profileLabel(profile),
    )
  ) {
    activeSelect.replaceChildren(
      ...profiles.map((profile) =>
        createOption(profile.id, profileLabel(profile)),
      ),
    );
  }
  list.replaceChildren(
    ...customProfiles.map((profile) => {
      const item = document.createElement("li");
      item.dataset.profileId = profile.id;
      if (profile.id === activeProfileId) {
        item.setAttribute("aria-current", "true");
      }
      const name = document.createElement("span");
      name.textContent = profileLabel(profile);
      item.appendChild(name);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-danger";
      remove.dataset.removeProfile = profile.id;
      remove.textContent = message("siteRuleRemove");
      remove.setAttribute(
        "aria-label",
        `${remove.textContent}: ${profileLabel(profile)}`,
      );
      remove.addEventListener("click", () => {
        void optionsReady
          .then(() => deleteSavedProfile(profile.id))
          .then(
            () => setStatus("profileStatus", "profileDeleted"),
            (error) => {
              setStatus("profileStatus", "profileFailed");
              console.error(
                "Video Auto Pause could not remove a profile:",
                error,
              );
            },
          );
      });
      item.appendChild(remove);
      return item;
    }),
  );
  list.hidden = customProfiles.length === 0;
  if (activeSelect.value !== activeProfileId) {
    activeSelect.value = activeProfileId;
  }
  document.getElementById("activeProfileControl").hidden = profiles.length < 2;
  if (focusedProfileId) {
    const target =
      list.querySelector(
        `[data-remove-profile="${CSS.escape(focusedProfileId)}"]`,
      ) ?? document.getElementById("profileName");
    target.focus();
  }
}

async function saveProfile() {
  await createProfile(document.getElementById("profileName").value);
  document.getElementById("profileName").value = "";
  await restoreProfiles();
}

async function applySelectedProfile(profileId) {
  if (!profileId) {
    throw new Error("Select a saved profile first.");
  }
  await activateProfile(profileId);
  await restoreProfiles();
  await queueOptionsRestore();
}

async function deleteSavedProfile(profileId) {
  const { activeProfileId } = await loadProfiles();
  await deleteProfile(profileId);
  await restoreProfiles();
  if (activeProfileId === profileId) {
    await queueOptionsRestore();
  }
}

// Global settings

function readSettingInput(setting, element) {
  if (setting in NUMERIC_SETTING_LIMITS) {
    return clampNumericSetting(setting, element.value);
  }
  if (timeSettings.has(setting)) {
    return element.value;
  }
  return element.checked;
}

function writeSettingInput(setting, element, value) {
  if (setting in NUMERIC_SETTING_LIMITS) {
    element.value = String(Math.max(0, Number(value) || 0));
  } else if (timeSettings.has(setting)) {
    element.value = value || "";
  } else {
    element.checked = Boolean(value);
  }
}

async function saveDisabledTab(disabled) {
  await optionsReady;
  const tab = await getCurrentWebTab();
  if (!tab) {
    return;
  }
  const stored = (await tabStorage.get("disabledTabs")).disabledTabs ?? [];
  await tabStorage.set({
    disabledTabs: disabled
      ? [...new Set([...stored, tab.id])]
      : stored.filter((id) => id !== tab.id),
  });
}

function restoreContentShortcutKeys(keys = {}) {
  for (const [action, id] of contentShortcutInputs) {
    document.getElementById(id).value =
      keys[action] ?? DEFAULT_SETTINGS.contentShortcutKeys[action];
  }
  setContentShortcutInputsDisabled();
}

function setContentShortcutInputsDisabled() {
  const enabled = document.getElementById("contentShortcutsEnabled").checked;
  const container = document.getElementById("contentShortcutSettings");
  document.getElementById("contentShortcutsDescription").hidden = !enabled;
  container.hidden = !enabled;
  for (const input of container.querySelectorAll("input")) {
    input.disabled = !enabled;
  }
}

async function saveContentShortcutKeys() {
  const keys = Object.fromEntries(
    contentShortcutInputs.map(([action, id]) => [
      action,
      document.getElementById(id).value.trim(),
    ]),
  );
  if (hasDuplicateShortcutKeys(keys)) {
    setStatus("contentShortcutsStatus", "contentShortcutsConflict");
    return;
  }
  await queueSettingsUpdate({ contentShortcutKeys: keys });
  setStatus("contentShortcutsStatus", "contentShortcutsSaved");
}

async function restoreTabControls(tab) {
  const [{ disabledTabs = [] }, { pinnedTabs = [] }] = tab
    ? await Promise.all([
        tabStorage.get("disabledTabs"),
        tabStorage.get("pinnedTabs"),
      ])
    : [{}, {}];
  const disabledTabsInput = document.getElementById("disabledTabs");
  disabledTabsInput.disabled = !tab;
  disabledTabsInput.checked = Boolean(tab) && disabledTabs.includes(tab.id);

  const pinButton = document.getElementById("pinCurrentTab");
  const isPinned = Boolean(tab) && pinnedTabs.includes(tab.id);
  pinButton.disabled = !tab;
  pinButton.setAttribute("aria-pressed", String(isPinned));
  pinButton.classList.toggle("is-pinned", isPinned);
  setTooltip(
    pinButton,
    message(isPinned ? "unpinCurrentTab" : "pinCurrentTab"),
  );
}

async function restoreOptions(changedKeys = settingKeys) {
  const [settings, tab] = await Promise.all([
    getActiveProfileSettings(),
    getCurrentWebTab(),
  ]);
  for (const setting of changedKeys) {
    const element = document.getElementById(setting);
    if (
      element &&
      setting in DEFAULT_SETTINGS &&
      !pendingSettingWrites.has(setting)
    ) {
      writeSettingInput(setting, element, settings[setting]);
    }
  }
  if (!pendingSettingWrites.has("contentShortcutKeys")) {
    restoreContentShortcutKeys(settings.contentShortcutKeys);
  } else {
    setContentShortcutInputsDisabled();
  }
  for (const setting of settingKeys) {
    const element = document.getElementById(setting);
    if (element) {
      element.disabled = settings.disabled && setting !== "disabled";
    }
  }
  await restoreTabControls(tab);
  await restoreSiteRules(settings);
}

// Statistics and sleep timer

function getPeriodStats(stats, days) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const today = new Date().toISOString().slice(0, 10);
  const summary = {
    pauses: 0,
    resumes: 0,
    autoplayBlocked: 0,
    preventedSeconds: 0,
    lifetimePauses: stats.totalPauses ?? 0,
  };
  for (const [day, values] of Object.entries(stats)) {
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      day <= today &&
      Date.parse(`${day}T00:00:00Z`) >= cutoff.getTime()
    ) {
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
  const stats = getPeriodStats(vapStats, statisticsDays);
  for (const [id, value] of Object.entries({
    statsPauses: stats.pauses,
    statsResumes: stats.resumes,
    statsAutoplayBlocks: stats.autoplayBlocked,
    statsPreventedMinutes: Math.floor(stats.preventedSeconds / 60),
  })) {
    document.getElementById(id).textContent = new Intl.NumberFormat(
      document.documentElement.lang,
    ).format(value);
  }
  document.getElementById("statsSummary").textContent = message(
    "statsSummary",
    [
      String(stats.pauses),
      String(stats.resumes),
      String(stats.autoplayBlocked),
      String(Math.floor(stats.preventedSeconds / 60)),
    ],
  );
  document.getElementById("rateExtension").hidden = stats.lifetimePauses < 50;
}

async function restoreSleepTimer() {
  const { vapSleepTimerExpiresAt } = await env.storage.local.get(
    "vapSleepTimerExpiresAt",
  );
  sleepTimerExpiresAt = Number.isFinite(vapSleepTimerExpiresAt)
    ? vapSleepTimerExpiresAt
    : 0;
  clearInterval(sleepTimerInterval);
  renderSleepTimer();
  if (sleepTimerExpiresAt > Date.now()) {
    sleepTimerInterval = setInterval(renderSleepTimer, 1000);
  }
}

function renderSleepTimer() {
  const seconds = Math.max(
    0,
    Math.ceil((sleepTimerExpiresAt - Date.now()) / 1000),
  );
  const active = seconds > 0;
  if (sleepTimerActive !== active) {
    document.getElementById("sleepTimerSection").open = active;
    sleepTimerActive = active;
  }
  const remaining = document.getElementById("sleepTimerRemaining");
  remaining.hidden = !active;
  remaining.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  document.getElementById("sleepTimerDurationControl").hidden = active;
  document.getElementById("startSleepTimer").hidden = active;
  document.getElementById("cancelSleepTimer").hidden = !active;
  const status = active
    ? message("sleepTimerSet", [String(Math.ceil(seconds / 60))])
    : "";
  if (document.getElementById("sleepTimerStatus").textContent !== status) {
    document.getElementById("sleepTimerStatus").textContent = status;
  }
  if (!active) {
    clearInterval(sleepTimerInterval);
  }
}

async function updateSleepTimer(action) {
  try {
    const request = { sleepTimerAction: action };
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
    setStatus("sleepTimerStatus", "sleepTimerFailed");
    console.error("Video Auto Pause could not update the sleep timer:", error);
  }
}

function handleStorageChanged(changes, areaName) {
  const logError = (error) => {
    console.error(
      "Video Auto Pause could not restore changed settings:",
      error,
    );
  };
  if (areaName === "sync" && isSettingsStorageChange(changes, areaName)) {
    void (async () => {
      const { activeProfileId } = await loadProfiles();
      const changedProfile = changes[getProfileStorageKey(activeProfileId)];
      if (PROFILE_IDS_KEY in changes || changedProfile) {
        await restoreProfiles();
      }
      if (PROFILE_IDS_KEY in changes) {
        await queueOptionsRestore();
      } else if (changedProfile) {
        const oldSettings = changedProfile.oldValue?.settings ?? {};
        const newSettings = changedProfile.newValue?.settings ?? {};
        const changedSettings = settingKeys.filter(
          (key) =>
            JSON.stringify(oldSettings[key]) !==
            JSON.stringify(newSettings[key]),
        );
        if (changedSettings.length) {
          await queueOptionsRestore(changedSettings);
        }
      }
    })().catch(logError);
    return;
  }
  if (areaName === "local" && isSettingsStorageChange(changes, areaName)) {
    void Promise.all([restoreProfiles(), queueOptionsRestore()]).catch(
      logError,
    );
  }
  if (
    (areaName === "session" || areaName === "local") &&
    ("disabledTabs" in changes || "pinnedTabs" in changes)
  ) {
    void getCurrentWebTab().then(restoreTabControls).catch(logError);
  }
  if (areaName === "local" && "vapStats" in changes) {
    void restoreStats().catch(logError);
  }
  if (areaName === "local" && "vapSleepTimerExpiresAt" in changes) {
    void restoreSleepTimer().catch(logError);
  }
}

// Runs an async UI action and reports success or failure in a status element.
function bindAction(elementId, statusId, successKey, failureKey, action) {
  document.getElementById(elementId)?.addEventListener("click", () => {
    void (async () => {
      try {
        await optionsReady;
        await action();
        setStatus(statusId, successKey);
      } catch (error) {
        setStatus(statusId, failureKey);
        console.error(`Video Auto Pause action ${elementId} failed:`, error);
      }
    })();
  });
}

function showHotkeys() {
  env.commands.getAll((commands) => {
    const hotkeys = document.getElementById("hotkeys");
    for (const command of commands) {
      if (!command.shortcut || !command.description) {
        continue;
      }
      const row = document.createElement("p");
      row.textContent = `${command.shortcut} - ${command.description}`;
      hotkeys.appendChild(row);
    }
  });
}

document.getElementById("version").textContent =
  `v${env.runtime.getManifest().version}`;
localizeUI();
buildSiteSettingsFields();
showHotkeys();
for (const button of document.querySelectorAll("[data-stats-days]")) {
  button.textContent = message("statsDays", [button.dataset.statsDays]);
  button.addEventListener("click", () => {
    statisticsDays = Number(button.dataset.statsDays);
    for (const period of document.querySelectorAll("[data-stats-days]")) {
      period.setAttribute("aria-pressed", String(period === button));
    }
    void restoreStats().catch((error) =>
      console.error("Video Auto Pause could not restore statistics:", error),
    );
  });
}

optionsReady = (async () => {
  try {
    await restoreOptions();
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

if (env.runtime.getManifest().browser_specific_settings?.gecko) {
  document.getElementById("rateExtension").href =
    "https://addons.mozilla.org/firefox/addon/video-auto-pause/";
}
void restoreStats();
void restoreSleepTimer();
void updateSiteReportLink().catch((error) => {
  console.error(
    "Video Auto Pause could not prepare the site report link:",
    error,
  );
});

for (const setting of settingKeys) {
  const element = document.getElementById(setting);
  element?.addEventListener("change", () => {
    // Read the value now: awaiting optionsReady first could observe a value
    // reset by the initial restore.
    const value = readSettingInput(setting, element);
    if (setting === "contentShortcutsEnabled") {
      setContentShortcutInputsDisabled();
    }
    void queueSettingsUpdate({ [setting]: value }).then(
      () => setStatus("settingsSaveStatus"),
      (error) => {
        setStatus("settingsSaveStatus", "settingsSaveFailed");
        console.error(`Video Auto Pause could not save ${setting}:`, error);
      },
    );
  });
}
for (const [, id] of contentShortcutInputs) {
  document.getElementById(id).addEventListener("change", () => {
    void saveContentShortcutKeys().catch((error) => {
      setStatus("contentShortcutsStatus", "settingsSaveFailed");
      console.error(
        "Video Auto Pause could not save content shortcuts:",
        error,
      );
    });
  });
}
document.getElementById("disabledTabs").addEventListener("change", (event) => {
  const disabled = event.currentTarget.checked;
  void saveDisabledTab(disabled).catch((error) => {
    setStatus("settingsSaveStatus", "settingsSaveFailed");
    console.error("Video Auto Pause could not update this tab:", error);
  });
});

bindAction("pinCurrentTab", "pinStatus", null, "pinFailure", async () => {
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
  await restoreTabControls(tab);
});
for (const button of document.querySelectorAll("[data-preset]")) {
  button.addEventListener("click", () => {
    void queueSettingsUpdate(SETTING_PRESETS[button.dataset.preset]).then(
      () => setStatus("presetStatus", "presetApplied"),
      (error) => {
        setStatus("presetStatus", "presetFailed");
        console.error("Video Auto Pause could not apply the preset:", error);
      },
    );
  });
}
document.getElementById("startSleepTimer").addEventListener("click", () => {
  void updateSleepTimer("start");
});
document.getElementById("cancelSleepTimer").addEventListener("click", () => {
  void updateSleepTimer("cancel");
});
bindAction(
  "exportSettings",
  "settingsImportStatus",
  "settingsExported",
  "settingsExportFailed",
  exportSettings,
);
document.getElementById("importSettings").addEventListener("click", () => {
  document.getElementById("importSettingsFile").click();
});
document
  .getElementById("importSettingsFile")
  .addEventListener("change", (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return;
    }
    void importSettingsFile(file).then(
      () => setStatus("settingsImportStatus", "settingsImported"),
      (error) => {
        setStatus("settingsImportStatus", "settingsImportFailed");
        console.error("Video Auto Pause could not import settings:", error);
      },
    );
  });
bindAction(
  "saveProfile",
  "profileStatus",
  "profileSaved",
  "profileFailed",
  saveProfile,
);
bindAction(
  "copyDiagnostics",
  "diagnosticsStatus",
  "diagnosticsCopied",
  "diagnosticsFailed",
  copyDiagnostics,
);
document
  .getElementById("activeProfileSelect")
  .addEventListener("change", (event) => {
    const profileId = event.currentTarget.value;
    void (async () => {
      await optionsReady;
      await applySelectedProfile(profileId);
    })().then(
      () => setStatus("profileStatus", "profileApplied"),
      (error) => {
        setStatus("profileStatus", "profileFailed");
        console.error("Video Auto Pause could not switch profiles:", error);
      },
    );
  });

document.getElementById("addSiteRule").addEventListener("click", () => {
  void optionsReady.then(addCurrentSiteRule).catch((error) => {
    setStatus("siteRuleStatus", "siteRuleFailed");
    console.error("Video Auto Pause could not add a site rule:", error);
  });
});
document.getElementById("newSiteForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("newSiteDomain");
  void optionsReady
    .then(() => openSiteSettings(input.value))
    .then(
      () => {
        input.value = "";
        setStatus("siteRuleStatus");
      },
      (error) => {
        setStatus("siteRuleStatus", "siteRuleFailed");
        console.error("Video Auto Pause could not add a site:", error);
      },
    );
});
document
  .getElementById("backToGlobal")
  .addEventListener("click", closeSiteSettings);
document.getElementById("saveSiteSettings").addEventListener("click", () => {
  void optionsReady.then(saveSiteSettings).catch((error) => {
    setStatus("siteSettingsStatus", "siteRuleFailed");
    console.error("Video Auto Pause could not save site settings:", error);
  });
});
document.getElementById("deleteSiteSettings").addEventListener("click", () => {
  void optionsReady
    .then(() => deleteSiteRule(editingSiteDomain))
    .catch((error) => {
      setStatus("siteSettingsStatus", "siteRuleFailed");
      console.error("Video Auto Pause could not delete site settings:", error);
    });
});
for (const button of document.querySelectorAll(".collapsible-button")) {
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.classList.toggle("active", expanded);
    button.nextElementSibling.classList.toggle("expanded", expanded);
  });
}
