if (!globalThis.DEFAULT_SETTINGS) {
  importScripts("settings.js");
}

// Browser
const env = chrome.runtime ? chrome : browser;
const sessionStorage = env.storage.session ?? env.storage.local;

// Previous tab and window numbers
let previousTabId = -1;
let previousWindowId = env.windows.WINDOW_ID_NONE;
let previousTabs = {};
let disabledTabs = [];
let tabVideos = {}; // { tabId: { frameId: boolean } }
let tabVisibility = {};
let tabMedia = {};
let tabVideoHover = {};
let priorityTabId = -1;
let priorityHistory = [];
let priorityOperation = Promise.resolve();
let statisticsOperation = Promise.resolve();
let pinnedTabs = [];
let safeModeTabs = [];

// Computer state
let state = "active";
let previousIdleState = "active";
const quietHoursTabs = new Map();
let globalSettings = normalizeSettings();
const QUIET_HOURS_ALARM = "vap-quiet-hours";
const SLEEP_TIMER_ALARM = "vap-sleep-timer";

function debugLog(message) {
  if (globalSettings.debugMode) {
    console.log(`Video auto pause: ${message}`);
  }
}

// Initialize settings from storage
let settingsReady = initialize();
void settingsReady.catch((error) => {
  console.error("Video Autopause initialization failed:", error);
});

async function initialize() {
  try {
    // Persist first-run defaults and migrate settings from older releases.
    await loadProfiles(getExtensionStorage(), { persist: true });
  } catch (error) {
    // Keep working from the in-memory migration (e.g. when the migrated
    // profile exceeds the sync quota); legacy keys stay until a write succeeds.
    console.error("Video Autopause could not save migrated settings:", error);
  }
  if (env.storage.session) {
    const currentTabState = await sessionStorage.get("disabledTabs");
    if (
      !Object.prototype.hasOwnProperty.call(currentTabState, "disabledTabs")
    ) {
      const legacyTabState = await env.storage.local.get("disabledTabs");
      if (legacyTabState.disabledTabs) {
        await sessionStorage.set({ disabledTabs: legacyTabState.disabledTabs });
      }
    }
    await env.storage.local.remove("disabledTabs");
  }
  await loadTabLists();
  await loadNavigationState();
  await refreshSettings();
  await registerContentScriptIfNeeded();
  await restoreSleepTimer().catch((error) => {
    console.error("Video Autopause could not restore the sleep timer:", error);
  });
  previousIdleState = await env.idle.queryState(getIdleDetectionInterval());
  state = previousIdleState;
}

function parseClockTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function isWithinQuietHours(start, end, date = new Date()) {
  const startMinute = parseClockTime(start);
  const endMinute = parseClockTime(end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) {
    return false;
  }
  const currentMinute = date.getHours() * 60 + date.getMinutes();
  return startMinute < endMinute
    ? currentMinute >= startMinute && currentMinute < endMinute
    : currentMinute >= startMinute || currentMinute < endMinute;
}

function hasQuietHours(settings) {
  const start = parseClockTime(settings.quietHoursStart);
  const end = parseClockTime(settings.quietHoursEnd);
  return start !== null && end !== null && start !== end;
}

function getIdleDetectionInterval() {
  const configuredTimeouts = [
    Number(globalSettings.idlePauseMinutes),
    ...(Array.isArray(globalSettings.siteRules)
      ? globalSettings.siteRules.map((rule) =>
          Number(rule?.overrides?.idlePauseMinutes),
        )
      : []),
  ].filter((timeout) => Number.isFinite(timeout) && timeout > 0);
  return configuredTimeouts.length
    ? Math.min(240, Math.max(1, Math.min(...configuredTimeouts))) * 60
    : 60;
}

async function applyQuietHours(date = new Date(), force = false, targetTab) {
  const tabs = targetTab ? [targetTab] : await env.tabs.query({});
  for (const tab of tabs) {
    if (!isEnabledForTab(tab)) {
      continue;
    }
    const settings = getTabSettings(tab);
    const active = isWithinQuietHours(
      settings.quietHoursStart,
      settings.quietHoursEnd,
      date,
    );
    const wasActive = quietHoursTabs.get(tab.id) ?? false;
    if (!force && active === wasActive) {
      continue;
    }
    quietHoursTabs.set(tab.id, active);
    if (active && settings.autopause) {
      stop(tab);
    } else if (!active && wasActive && settings.autoresume) {
      resume(tab);
    }
  }
}

async function configureContextRules(forceQuietHours = false) {
  await env.idle.setDetectionInterval(getIdleDetectionInterval());
  const hasConfiguredSiteQuietHours = (
    Array.isArray(globalSettings.siteRules) ? globalSettings.siteRules : []
  ).some(
    (rule) =>
      rule?.enabled !== false &&
      hasQuietHours(getSiteSettings(rule?.domain, globalSettings)),
  );
  if (hasQuietHours(globalSettings) || hasConfiguredSiteQuietHours) {
    await env.alarms.create(QUIET_HOURS_ALARM, { periodInMinutes: 1 });
  } else {
    await env.alarms.clear(QUIET_HOURS_ALARM);
  }
  await applyQuietHours(new Date(), forceQuietHours);
}

async function setSleepTimer(minutes) {
  if (![5, 10, 15, 30, 60].includes(minutes)) {
    throw new Error(
      "Sleep timer duration must be 5, 10, 15, 30, or 60 minutes.",
    );
  }
  const expiresAt = Date.now() + minutes * 60 * 1000;
  await env.storage.local.set({ vapSleepTimerExpiresAt: expiresAt });
  await env.alarms.create(SLEEP_TIMER_ALARM, { when: expiresAt });
  return expiresAt;
}

async function cancelSleepTimer() {
  await env.alarms.clear(SLEEP_TIMER_ALARM);
  await env.storage.local.remove("vapSleepTimerExpiresAt");
}

// Firefox does not persist alarms across browser restarts.
async function restoreSleepTimer() {
  const { vapSleepTimerExpiresAt } = await env.storage.local.get(
    "vapSleepTimerExpiresAt",
  );
  if (!Number.isFinite(vapSleepTimerExpiresAt)) {
    return;
  }
  if (vapSleepTimerExpiresAt <= Date.now()) {
    await pauseEverythingForSleepTimer();
  } else if (!(await env.alarms.get(SLEEP_TIMER_ALARM))) {
    await env.alarms.create(SLEEP_TIMER_ALARM, {
      when: vapSleepTimerExpiresAt,
    });
  }
}

async function pauseEverythingForSleepTimer() {
  await cancelSleepTimer();
  const tabs = await env.tabs.query({});
  for (const tab of tabs) {
    if (isEnabledForTab(tab)) {
      stop(tab);
    }
  }
}

env.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUIET_HOURS_ALARM) {
    void applyQuietHours().catch((error) => {
      console.error("Video Auto Pause could not apply quiet hours:", error);
    });
  } else if (alarm.name === SLEEP_TIMER_ALARM) {
    void pauseEverythingForSleepTimer().catch((error) => {
      console.error("Video Auto Pause could not apply the sleep timer:", error);
    });
  }
});

env.runtime.onStartup.addListener(async () => {
  if (!env.storage.session) {
    await env.storage.local.remove([
      "disabledTabs",
      "previousTabId",
      "previousWindowId",
      "previousTabs",
      "pinnedTabs",
      "safeModeTabs",
    ]);
  }
});

const CONTENT_SCRIPT = Object.freeze({
  id: "video_auto_pause",
  matches: ["<all_urls>"],
  js: ["settings.js", "video_auto_pause.js"],
  runAt: "document_start",
  allFrames: true,
  matchOriginAsFallback: true,
});

// Registered content scripts survive extension updates, so re-register when
// the stored registration differs from the current one (e.g. renamed files).
async function registerContentScriptIfNeeded() {
  const [currentScript] = await env.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT.id],
  });
  if (
    currentScript?.matchOriginAsFallback &&
    JSON.stringify(currentScript.js) === JSON.stringify(CONTENT_SCRIPT.js)
  ) {
    return;
  }
  if (currentScript) {
    await env.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT.id] });
  }
  await env.scripting.registerContentScripts([{ ...CONTENT_SCRIPT }]);
}

async function refreshSettings() {
  globalSettings = await getActiveProfileSettings();
  debugLog(`Settings refreshed: ${JSON.stringify(globalSettings)}`);
  await configureContextRules(true);
}

async function loadTabLists() {
  const stored = await sessionStorage.get([
    "disabledTabs",
    "pinnedTabs",
    "safeModeTabs",
  ]);
  disabledTabs = stored.disabledTabs ?? [];
  pinnedTabs = stored.pinnedTabs ?? [];
  safeModeTabs = stored.safeModeTabs ?? [];
  debugLog(`Disabled tabs: ${JSON.stringify(disabledTabs)}`);
}

// Restores tab navigation state after the service worker restarts.
async function loadNavigationState() {
  const navigationState = await sessionStorage.get([
    "previousTabId",
    "previousWindowId",
    "previousTabs",
  ]);
  previousTabs = navigationState.previousTabs ?? {};
  previousTabId = navigationState.previousTabId ?? -1;
  previousWindowId =
    navigationState.previousWindowId ?? env.windows.WINDOW_ID_NONE;
  if (previousWindowId === env.windows.WINDOW_ID_NONE) {
    const activeTabs = await env.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (activeTabs.length > 0) {
      previousWindowId = activeTabs[0].windowId;
      previousTabId = activeTabs[0].id;
      previousTabs[previousWindowId] = previousTabId;
    }
  }
  await sessionStorage.set({ previousTabId, previousWindowId, previousTabs });
}

async function saveTabState() {
  await sessionStorage.set({ disabledTabs, pinnedTabs });
}

async function toggleTabPin(tab) {
  if (!tab?.id) {
    return false;
  }
  if (pinnedTabs.includes(tab.id)) {
    pinnedTabs = pinnedTabs.filter((tabId) => tabId !== tab.id);
  } else {
    pinnedTabs = [...pinnedTabs, tab.id];
  }
  await saveTabState();
  await refreshIcon(tab.id);
  return pinnedTabs.includes(tab.id);
}

function recordStatistic(event, preventedSeconds = 0) {
  const operation = statisticsOperation.then(async () => {
    const stored = await env.storage.local.get("vapStats");
    const stats = stored.vapStats ?? {};
    const date = new Date().toISOString().slice(0, 10);
    stats.totalPauses ??= 0;
    stats[date] ??= {
      pauses: 0,
      resumes: 0,
      autoplayBlocked: 0,
      preventedSeconds: 0,
    };
    if (event === "pause") {
      stats[date].pauses += 1;
      stats.totalPauses += 1;
    } else if (event === "resume") {
      stats[date].resumes += 1;
      stats[date].preventedSeconds += Number.isFinite(preventedSeconds)
        ? Math.max(0, preventedSeconds)
        : 0;
    } else if (event === "autoplayBlocked") {
      stats[date].autoplayBlocked += 1;
    } else {
      throw new Error(`Unknown statistics event: ${event}`);
    }
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const day of Object.keys(stats)) {
      if (Date.parse(`${day}T00:00:00Z`) < cutoff) {
        delete stats[day];
      }
    }
    await env.storage.local.set({ vapStats: stats });
  });
  statisticsOperation = operation.catch((error) => {
    console.error("Video Autopause could not record local statistics:", error);
  });
  return operation;
}

function isEnabledForTab(tab) {
  if (!tab || globalSettings.disabled) {
    return false;
  }

  if (disabledTabs.includes(tab.id) || !tab.url) {
    return false;
  }

  let hostname;
  try {
    hostname = new URL(tab.url).hostname.toLowerCase();
  } catch (error) {
    debugLog(`Unable to parse tab URL ${tab.url}: ${error}`);
    return false;
  }

  return isSiteEnabled(hostname, globalSettings);
}

function getTabHostname(tab) {
  try {
    return new URL(tab.url).hostname.toLowerCase();
  } catch (error) {
    debugLog(`Unable to parse tab URL ${tab?.url}: ${error}`);
    return "";
  }
}

function getTabSettings(tab) {
  const hostname = tab?.url ? getTabHostname(tab) : "";
  return hostname ? getSiteSettings(hostname, globalSettings) : globalSettings;
}

// Functionality to send messages to tabs
function sendMessage(tab, message) {
  if (!env.runtime?.id || !isEnabledForTab(tab)) {
    return;
  }

  debugLog(`Sending message ${JSON.stringify(message)} to tab ${tab.id}`);

  try {
    env.tabs.sendMessage(tab.id, message, {}, function () {
      if (env.runtime.lastError) {
        console.warn(
          `Video Autopause could not message tab ${tab.id}: ${env.runtime.lastError.message}`,
        );
      }
    });
  } catch (error) {
    console.error(`Video Autopause could not message tab ${tab.id}:`, error);
  }
}

// Media control functions

function stop(tab, pausePendingPlay = false) {
  if (pinnedTabs.includes(tab.id)) {
    return;
  }
  const settings = getTabSettings(tab);
  const action = settings.muteVideo ? "mute" : "stop";
  sendMessage(tab, {
    action,
    delay: settings.pauseDelay,
    pausePendingPlay,
  });
}

function resume(tab) {
  const settings = getTabSettings(tab);
  const action = settings.muteVideo ? "unmute" : "resume";
  sendMessage(tab, { action, delay: settings.resumeDelay });
}

function hasMedia(tabId) {
  return Object.values(tabMedia[tabId] ?? {}).some((state) => state.hasMedia);
}

function isMediaPlaying(tabId) {
  return Object.values(tabMedia[tabId] ?? {}).some((state) => state.playing);
}

function queuePriorityOperation(operation) {
  const nextOperation = priorityOperation.then(operation, operation);
  priorityOperation = nextOperation.catch((error) => {
    console.error("Video Autopause priority update failed:", error);
  });
  return nextOperation;
}

function rememberPriorMediaTab(tabId) {
  priorityHistory = [...priorityHistory.filter((id) => id !== tabId), tabId];
}

// Gives tabId media priority and pauses media elsewhere. Runs again when the
// current owner starts playing, so media that started meanwhile is paused.
function prioritizeMediaTab(tabId) {
  return queuePriorityOperation(async () => {
    const previousOwnerId = priorityTabId;
    const tabs = await env.tabs.query({});
    const competingTabs = tabs.filter(
      (tab) =>
        tab.id !== tabId &&
        tab.id !== previousOwnerId &&
        isMediaPlaying(tab.id) &&
        isEnabledForTab(tab),
    );
    if (previousOwnerId === tabId && competingTabs.length === 0) {
      return;
    }

    for (const tab of competingTabs) {
      rememberPriorMediaTab(tab.id);
    }
    if (
      previousOwnerId !== tabId &&
      previousOwnerId !== -1 &&
      hasMedia(previousOwnerId)
    ) {
      rememberPriorMediaTab(previousOwnerId);
    }
    priorityHistory = priorityHistory.filter((id) => id !== tabId);
    priorityTabId = tabId;

    for (const tab of tabs) {
      if (
        tab.id !== tabId &&
        hasMedia(tab.id) &&
        isEnabledForTab(tab) &&
        getTabSettings(tab).autopause
      ) {
        stop(tab);
      }
    }

    if (previousOwnerId === tabId) {
      return;
    }
    try {
      const tab = await env.tabs.get(tabId);
      if (getTabSettings(tab).autoresume && isEnabledForTab(tab)) {
        resume(tab);
      }
    } catch (error) {
      debugLog(`Could not prioritize media tab ${tabId}: ${error}`);
    }
  });
}

function resumePriorMediaTab() {
  return queuePriorityOperation(async () => {
    priorityTabId = -1;
    while (priorityHistory.length > 0) {
      const tabId = priorityHistory.pop();
      if (!hasMedia(tabId)) {
        continue;
      }
      try {
        const tab = await env.tabs.get(tabId);
        if (isEnabledForTab(tab)) {
          priorityTabId = tabId;
          if (getTabSettings(tab).autoresume) {
            resume(tab);
          }
          return;
        }
      } catch (error) {
        debugLog(`Could not resume previous media tab ${tabId}: ${error}`);
      }
    }
  });
}

function toggle(tab) {
  sendMessage(tab, { action: "toggle" });
}

function mute(tab) {
  sendMessage(tab, { action: "mute" });
}

function unmute(tab) {
  sendMessage(tab, { action: "unmute" });
}

function toggleMute(tab) {
  sendMessage(tab, { action: "toggleMute" });
}

function speed(tab, command) {
  sendMessage(tab, { action: "speed", command: command });
}

async function changeIcon(disabled, tabId) {
  const path = disabled
    ? {
        16: "/images/icon_disabled_16.png",
        32: "/images/icon_disabled_32.png",
        64: "/images/icon_disabled_64.png",
        128: "/images/icon_disabled_128.png",
      }
    : {
        16: "/images/icon_16.png",
        32: "/images/icon_32.png",
        64: "/images/icon_64.png",
        128: "/images/icon_128.png",
      };
  await env.action.setIcon({ path, tabId });
}

async function refreshIcon(tabId) {
  let tab;
  if (tabId !== undefined) {
    try {
      tab = await env.tabs.get(tabId);
    } catch (e) {
      return;
    }
  } else {
    const tabs = await env.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs.length > 0) {
      tab = tabs[0];
    }
  }

  if (!tab) {
    return;
  }

  const hasVideosInTab = tabVideos[tab.id]
    ? Object.values(tabVideos[tab.id]).some((v) => v)
    : false;
  const enabled = isEnabledForTab(tab);

  debugLog(
    `Refreshing icon for tab ${tab.id}: enabled=${enabled}, hasVideos=${hasVideosInTab}`,
  );
  await changeIcon(!(enabled && hasVideosInTab), tab.id);
  if (env.action.setBadgeText) {
    await env.action.setBadgeText({
      text: safeModeTabs.includes(tab.id)
        ? "ERR"
        : pinnedTabs.includes(tab.id)
          ? "PIN"
          : "",
      tabId: tab.id,
    });
    if (env.action.setBadgeBackgroundColor) {
      await env.action.setBadgeBackgroundColor({
        color: safeModeTabs.includes(tab.id) ? "#c53030" : "#5b5bd6",
        tabId: tab.id,
      });
    }
  }
}

env.storage.onChanged.addListener(async function (changes, areaName) {
  const settingsChanged = isSettingsStorageChange(changes, areaName);
  const tabListsChanged =
    (areaName === "session" || areaName === "local") &&
    ("disabledTabs" in changes ||
      "pinnedTabs" in changes ||
      "safeModeTabs" in changes);
  if (!settingsChanged && !tabListsChanged) {
    return;
  }
  await settingsReady;
  const wasDisabled = globalSettings.disabled;
  settingsReady = (async () => {
    if (tabListsChanged) {
      await loadTabLists();
    }
    if (settingsChanged) {
      await refreshSettings();
    }
  })();
  await settingsReady;

  const tabs = await env.tabs.query({ active: true, lastFocusedWindow: true });
  for (const tab of tabs) {
    await refreshIcon(tab.id);
    if (
      wasDisabled &&
      !globalSettings.disabled &&
      getTabSettings(tab).autoresume &&
      isEnabledForTab(tab)
    ) {
      resume(tab);
    }
  }
});

// Tab activation and window focus handlers read and update the shared
// navigation state, so they must run one at a time in event order.
let navigationOperation = Promise.resolve();
function queueNavigationOperation(operation, description) {
  const nextOperation = navigationOperation.then(operation);
  navigationOperation = nextOperation.catch((error) => {
    console.error(`Video Autopause could not handle ${description}:`, error);
  });
  return navigationOperation;
}

// Tab change listener
env.tabs.onActivated.addListener((info) =>
  queueNavigationOperation(() => handleTabActivated(info), "tab activation"),
);

async function handleTabActivated(info) {
  await settingsReady;

  let tab;
  try {
    tab = await env.tabs.get(info.tabId);
  } catch (e) {
    debugLog(`Could not get current tab ${info.tabId}: ${e}`);
    return;
  }
  if (!tab) {
    return;
  }

  sendMessage(tab, { action: "check" });
  const activeTabSettings = getTabSettings(tab);
  if (
    isWithinQuietHours(
      activeTabSettings.quietHoursStart,
      activeTabSettings.quietHoursEnd,
    ) &&
    activeTabSettings.autopause
  ) {
    stop(tab);
  }

  const lastTabId =
    previousTabs[info.windowId] ??
    (previousWindowId === info.windowId ? previousTabId : -1);

  if (getTabSettings(tab).prioritizeActiveTabMedia) {
    if (priorityTabId === -1 && lastTabId !== -1 && hasMedia(lastTabId)) {
      priorityTabId = lastTabId;
    }
    if (hasMedia(info.tabId) && priorityTabId !== info.tabId) {
      await prioritizeMediaTab(info.tabId);
    }
  } else if (lastTabId !== info.tabId) {
    // The previous tab is paused based on its own settings, even when the
    // newly active tab is not a controlled web page.
    if (lastTabId !== -1) {
      try {
        const previousTab = await env.tabs.get(lastTabId);
        if (
          previousTab &&
          previousTab.windowId === tab.windowId &&
          getTabSettings(previousTab).autopause
        ) {
          stop(previousTab, true);
        }
      } catch (error) {
        debugLog(`Could not get previous tab ${lastTabId}: ${error}`);
      }
    }
    if (getTabSettings(tab).autoresume && tab.active) {
      resume(tab);
    }
  }

  previousTabId = info.tabId;
  previousWindowId = info.windowId;
  previousTabs[info.windowId] = info.tabId;
  await sessionStorage.set({
    previousTabId,
    previousWindowId,
    previousTabs,
  });
  await refreshIcon(info.tabId);
}

env.tabs.onCreated.addListener(async function (tab) {
  await settingsReady;
  if (!tab.url) {
    await refreshIcon(tab.id);
  }
});

// Tab update listener
env.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  // Ignore title, favicon, audible, and other cosmetic updates.
  if (!changeInfo.status && !changeInfo.url) {
    return;
  }
  await settingsReady;
  sendMessage(tab, { action: "check" });
  if (changeInfo.status === "complete") {
    await applyQuietHours(new Date(), true, tab);
  }

  if (changeInfo.status === "loading") {
    delete tabVideos[tabId];
    delete tabVisibility[tabId];
    delete tabVideoHover[tabId];
  }

  if (
    !getTabSettings(tab).prioritizeActiveTabMedia &&
    changeInfo.status === "complete" &&
    !tab.active &&
    getTabSettings(tab).autopause
  ) {
    stop(tab);
  }

  if (tab.active) {
    await refreshIcon(tabId);
  }
});

env.tabs.onRemoved.addListener(async function (tabId) {
  await settingsReady;
  quietHoursTabs.delete(tabId);
  delete tabVideos[tabId];
  delete tabVisibility[tabId];
  delete tabMedia[tabId];
  delete tabVideoHover[tabId];
  priorityHistory = priorityHistory.filter((id) => id !== tabId);
  if (pinnedTabs.includes(tabId)) {
    pinnedTabs = pinnedTabs.filter((id) => id !== tabId);
    await saveTabState();
  }
  if (globalSettings.prioritizeActiveTabMedia && priorityTabId === tabId) {
    await resumePriorMediaTab();
  }
  if (disabledTabs.includes(tabId)) {
    disabledTabs = disabledTabs.filter((tab) => tab !== tabId);
    await saveTabState();
  }
  if (safeModeTabs.includes(tabId)) {
    safeModeTabs = safeModeTabs.filter((tab) => tab !== tabId);
    await sessionStorage.set({ safeModeTabs });
  }

  for (const [windowId, storedTabId] of Object.entries(previousTabs)) {
    if (storedTabId === tabId) {
      delete previousTabs[windowId];
    }
  }

  if (previousTabId === tabId) {
    previousTabId = -1;
  }
  await sessionStorage.set({ previousTabId, previousTabs });
});

// Window focus listener
env.windows.onFocusChanged.addListener((windowId) =>
  queueNavigationOperation(
    () => handleWindowFocusChanged(windowId),
    "window focus change",
  ),
);

async function handleWindowFocusChanged(windowId) {
  await settingsReady;

  if (windowId !== previousWindowId) {
    if (state !== "locked" && previousWindowId !== env.windows.WINDOW_ID_NONE) {
      const tabsStop = await env.tabs.query({ windowId: previousWindowId });
      debugLog(`Window changed, stopping videos in window ${previousWindowId}`);
      for (let i = 0; i < tabsStop.length; i++) {
        if (
          !isEnabledForTab(tabsStop[i]) ||
          !getTabSettings(tabsStop[i]).focuspause
        ) {
          continue;
        }
        if (
          getTabSettings(tabsStop[i]).peekMode &&
          Object.values(tabVideoHover[tabsStop[i].id] ?? {}).some(Boolean)
        ) {
          continue;
        }
        stop(tabsStop[i]);
      }
    }

    if (windowId !== env.windows.WINDOW_ID_NONE) {
      const tabsResume = await env.tabs.query({ windowId: windowId });
      debugLog(`Window changed, resuming videos in window ${windowId}`);
      for (let i = 0; i < tabsResume.length; i++) {
        const settings = getTabSettings(tabsResume[i]);
        if (!isEnabledForTab(tabsResume[i]) || !settings.focusresume) {
          continue;
        }
        if (!tabsResume[i].active && settings.autopause) {
          continue;
        }
        resume(tabsResume[i]);
      }
    }

    previousWindowId = windowId;
    await sessionStorage.set({ previousWindowId, previousTabs });
    await refreshIcon();
  }
}

env.windows.onRemoved.addListener(function (windowId) {
  delete previousTabs[windowId];
  if (previousWindowId === windowId) {
    previousWindowId = env.windows.WINDOW_ID_NONE;
  }
  void sessionStorage.set({ previousWindowId, previousTabs });
});

async function handlePageMessage(request, sender) {
  await settingsReady;
  if (request.sleepTimerAction) {
    const senderUrl = new URL(sender.url);
    const optionsUrl = new URL(env.runtime.getURL("options.html"));
    if (
      senderUrl.origin !== optionsUrl.origin ||
      senderUrl.pathname !== optionsUrl.pathname
    ) {
      throw new Error("Sleep timer actions are only available in settings.");
    }
    if (request.sleepTimerAction === "start") {
      return {
        expiresAt: await setSleepTimer(Number(request.minutes)),
      };
    }
    if (request.sleepTimerAction === "cancel") {
      await cancelSleepTimer();
      return { cancelled: true };
    }
    throw new Error("Unknown sleep timer action.");
  }
  const tab = sender.tab;
  if (!tab) {
    return;
  }

  if (request.contentScriptError) {
    const error = request.contentScriptError;
    safeModeTabs = [...new Set([...safeModeTabs, tab.id])];
    disabledTabs = [...new Set([...disabledTabs, tab.id])];
    await sessionStorage.set({ safeModeTabs, disabledTabs });
    await env.storage.local.set({
      vapLastContentScriptError: {
        message:
          typeof error.message === "string"
            ? error.message.slice(0, 240)
            : "Uncaught content script error",
        source:
          typeof error.source === "string" ? error.source.slice(-160) : "",
        timestamp: Date.now(),
      },
    });
    await refreshIcon(tab.id);
    return;
  }

  if (request.pinAction === "get") {
    return { pinned: pinnedTabs.includes(tab.id) };
  }
  if (request.pinAction === "toggle") {
    return { pinned: await toggleTabPin(tab) };
  }

  if ("statsEvent" in request) {
    await recordStatistic(request.statsEvent, request.preventedSeconds);
    return;
  }

  if ("mediaState" in request) {
    const wasPlaying = isMediaPlaying(tab.id);
    tabMedia[tab.id] ??= {};
    tabMedia[tab.id][sender.frameId ?? 0] = request.mediaState;
    const settings = getTabSettings(tab);
    if (
      state === "locked" &&
      settings.lockpause &&
      request.mediaState.playing &&
      isEnabledForTab(tab)
    ) {
      stop(tab);
      return;
    }
    if (!settings.prioritizeActiveTabMedia || !isEnabledForTab(tab)) {
      return;
    }
    const isActiveTab =
      tab.active ||
      previousTabs[tab.windowId] === tab.id ||
      (previousWindowId === tab.windowId && previousTabId === tab.id);
    if (
      isActiveTab &&
      request.mediaState.hasMedia &&
      (priorityTabId !== tab.id || request.mediaState.playing)
    ) {
      await prioritizeMediaTab(tab.id);
    } else if (
      priorityTabId === tab.id &&
      wasPlaying &&
      !isMediaPlaying(tab.id)
    ) {
      // Only hand priority back once the owner actually stops playing, not
      // while its media is still loading.
      await resumePriorMediaTab();
    } else if (
      !tab.active &&
      tab.id !== priorityTabId &&
      request.mediaState.playing &&
      isMediaPlaying(priorityTabId)
    ) {
      if (settings.autopause) {
        // Remember the tab so it resumes when the priority media stops.
        rememberPriorMediaTab(tab.id);
        stop(tab);
      }
    }
    return;
  }

  if ("hasVideos" in request && tab.active) {
    tabVideos[tab.id] ??= {};
    tabVideos[tab.id][sender.frameId] = request.hasVideos;
    await refreshIcon(tab.id);
  }

  if (!isEnabledForTab(tab)) {
    return;
  }
  const settings = getTabSettings(tab);

  if ("videoHovered" in request) {
    tabVideoHover[tab.id] ??= {};
    tabVideoHover[tab.id][sender.frameId ?? 0] = request.videoHovered;
    if (
      !request.videoHovered &&
      settings.peekMode &&
      settings.focuspause &&
      tab.windowId !== previousWindowId
    ) {
      stop(tab);
    }
  }

  if ("minimized" in request) {
    if (
      !settings.prioritizeActiveTabMedia &&
      request.minimized &&
      settings.autopause
    ) {
      stop(tab);
    } else if (
      !settings.prioritizeActiveTabMedia &&
      !request.minimized &&
      settings.autoresume &&
      tab.active
    ) {
      resume(tab);
    }
  }

  if ("windowFocused" in request) {
    if (
      !request.windowFocused &&
      settings.focuspause &&
      !(
        settings.peekMode &&
        Object.values(tabVideoHover[tab.id] ?? {}).some(Boolean)
      )
    ) {
      stop(tab);
    } else if (request.windowFocused && settings.focusresume && tab.active) {
      resume(tab);
    }
  }

  if ("visible" in request && settings.scrollpause && tab.active) {
    tabVisibility[tab.id] ??= {};
    tabVisibility[tab.id][sender.frameId] = request.visible;
    const videoFrames = Object.entries(tabVideos[tab.id] ?? {})
      .filter(([, hasVideos]) => hasVideos)
      .map(([frameId]) => frameId);
    const allVideoFramesReported =
      videoFrames.length > 0 &&
      videoFrames.every((frameId) =>
        Object.prototype.hasOwnProperty.call(tabVisibility[tab.id], frameId),
      );
    const anyVideoFrameVisible = videoFrames.some(
      (frameId) => tabVisibility[tab.id][frameId],
    );
    if (allVideoFramesReported && !anyVideoFrameVisible && settings.autopause) {
      stop(tab);
    } else if (anyVideoFrameVisible && settings.autoresume) {
      resume(tab);
    }
  }

  if (settings.cursorTracking && "cursorNearEdge" in request) {
    if (request.cursorNearEdge && settings.autopause) {
      stop(tab);
    } else if (!request.cursorNearEdge && settings.autoresume && tab.active) {
      resume(tab);
    }
  }
}

env.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handlePageMessage(request, sender).then(
    (response) => sendResponse(response ?? {}),
    (error) => {
      console.error("Video Autopause message handler failed:", error);
      sendResponse({ error: String(error) });
    },
  );
  return true;
});

// Listener for keyboard shortcuts
async function handleCommand(command) {
  await settingsReady;
  if (command === "toggle-extension") {
    const disabled = !globalSettings.disabled;
    debugLog(`Toggle extension command received, extension state ${disabled}`);
    await updateActiveProfileSettings({ disabled });
    settingsReady = refreshSettings();
    await settingsReady;
  } else if (command === "toggle-tab") {
    const tabs = await env.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const tab = tabs.find((candidate) => {
      try {
        return ["http:", "https:", "file:"].includes(
          new URL(candidate.url).protocol,
        );
      } catch {
        return false;
      }
    });
    if (!tab) {
      console.error("Video Autopause could not find a web tab to toggle.");
      return;
    }
    debugLog(`Toggle tab command received for tab ${tab.id}`);
    if (disabledTabs.includes(tab.id)) {
      disabledTabs = disabledTabs.filter((t) => t !== tab.id);
    } else {
      disabledTabs.push(tab.id);
    }
    await saveTabState();
    await refreshIcon(tab.id);
  } else if (
    command === "toggle-play" ||
    command === "toggle_mute" ||
    command === "speed-up" ||
    command === "speed-down" ||
    command === "speed-reset"
  ) {
    const tabs = await env.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const tab = tabs[0];
    if (!tab || !isEnabledForTab(tab)) {
      return;
    }
    if (command === "toggle-play") {
      toggle(tab);
    } else if (command === "toggle_mute") {
      toggleMute(tab);
    } else {
      speed(tab, command);
    }
  }
}
env.commands.onCommand.addListener(handleCommand);

// Listener for computer idle/locked/active
async function handleIdleStateChanged(s) {
  await settingsReady;
  const wasLocked = previousIdleState === "locked";
  const wasIdle = previousIdleState === "idle";
  previousIdleState = s;
  state = s;
  const tabs =
    s === "idle" || (s === "active" && wasIdle)
      ? await env.tabs.query({})
      : await env.tabs.query({ active: true, lastFocusedWindow: true });

  for (let i = 0; i < tabs.length; i++) {
    if (!isEnabledForTab(tabs[i])) {
      continue;
    }

    const settings = getTabSettings(tabs[i]);
    if (state === "locked" && settings.lockpause) {
      debugLog(`Computer locked, stopping all videos`);
      stop(tabs[i]);
    } else if (state === "idle" && settings.idlePauseMinutes > 0) {
      debugLog(`User idle, stopping videos`);
      stop(tabs[i]);
    } else if (
      state === "active" &&
      wasIdle &&
      settings.idlePauseMinutes > 0 &&
      settings.autoresume
    ) {
      debugLog(`User active, resuming videos`);
      resume(tabs[i]);
    } else if (state === "active" && wasLocked && settings.lockresume) {
      debugLog(`Computer unlocked, resuming videos`);
      resume(tabs[i]);
    }
  }
}
env.idle.onStateChanged.addListener(handleIdleStateChanged);

env.runtime.onInstalled.addListener(async (details) => {
  await settingsReady;
  if (details.reason === "install") {
    try {
      await env.tabs.create({
        url: env.runtime.getURL("onboarding.html"),
        active: true,
      });
    } catch (error) {
      console.error(
        "Video Autopause could not open the onboarding page:",
        error,
      );
    }
  }
  const tabs = await env.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith("http")) {
      continue;
    }
    try {
      await env.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: CONTENT_SCRIPT.js,
      });
    } catch (error) {
      console.warn(
        `Video Autopause could not inject into tab ${tab.id}:`,
        error,
      );
    }
  }
});
