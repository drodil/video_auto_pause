if (!globalThis.VAP_DEFAULT_OPTIONS) {
  importScripts("defaults.js");
}

// Browser
const env = chrome.runtime ? chrome : browser;
const sessionStorage = env.storage.session ?? env.storage.local;
const DEFAULT_OPTIONS = globalThis.VAP_DEFAULT_OPTIONS;

// Previous tab and window numbers
let previous_tab = -1;
let previous_window = env.windows.WINDOW_ID_NONE;
let previousTabs = {};
let disabledTabs = [];
let tabVideos = {}; // { tabId: { frameId: boolean } }
let tabVisibility = {};
let tabMedia = {};
let tabVideoHover = {};
let profiles = [];
let priorityTabId = -1;
let priorityHistory = [];
let priorityOperation = Promise.resolve();
let statisticsOperation = Promise.resolve();
let pinnedTabs = [];

// Computer state
let state = "active";
let previousIdleState = "active";
let quietHoursActive = null;
let options = { ...DEFAULT_OPTIONS };
const QUIET_HOURS_ALARM = "vap-quiet-hours";
const SLEEP_TIMER_ALARM = "vap-sleep-timer";

function debugLog(message) {
  if (options.debugMode) {
    console.log(`Video auto pause: ${message}`);
  }
}

// Initialize settings from storage
let settingsReady = initialize();
void settingsReady.catch((error) => {
  console.error("Video Autopause initialization failed:", error);
});

async function initialize() {
  await VAP_MIGRATE_DOMAIN_SETTINGS(env.storage.sync);
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
  await refresh_settings();
  await registerContentScriptIfNeeded();
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

function getIdleDetectionInterval() {
  const configuredTimeouts = [
    Number(options.idlePauseMinutes),
    ...(Array.isArray(profiles)
      ? profiles.map((profile) => Number(profile?.settings?.idlePauseMinutes))
      : []),
    ...(Array.isArray(options.siteRules)
      ? options.siteRules.map((rule) =>
          Number(rule?.overrides?.idlePauseMinutes),
        )
      : []),
  ].filter((timeout) => Number.isFinite(timeout) && timeout > 0);
  return configuredTimeouts.length
    ? Math.min(240, Math.max(1, Math.min(...configuredTimeouts))) * 60
    : 60;
}

async function applyQuietHours(date = new Date(), force = false) {
  const active = isWithinQuietHours(
    options.quietHoursStart,
    options.quietHoursEnd,
    date,
  );
  const wasActive = quietHoursActive === true;
  if (quietHoursActive === null && !active) {
    quietHoursActive = false;
    return;
  }
  if (!force && active === quietHoursActive) {
    return;
  }
  quietHoursActive = active;
  const tabs = await env.tabs.query({});
  for (const tab of tabs) {
    if (!isEnabledForTab(tab)) {
      continue;
    }
    const settings = tabOptions(tab);
    if (active && settings.autopause) {
      stop(tab);
    } else if (!active && wasActive && settings.autoresume) {
      resume(tab);
    }
  }
}

async function configureContextRules(forceQuietHours = false) {
  await env.idle.setDetectionInterval(getIdleDetectionInterval());
  const start = parseClockTime(options.quietHoursStart);
  const end = parseClockTime(options.quietHoursEnd);
  if (start !== null && end !== null && start !== end) {
    await env.alarms.create(QUIET_HOURS_ALARM, { periodInMinutes: 1 });
  } else {
    await env.alarms.clear(QUIET_HOURS_ALARM);
  }
  await applyQuietHours(new Date(), forceQuietHours);
}

async function setSleepTimer(minutes) {
  if (![15, 30, 60].includes(minutes)) {
    throw new Error("Sleep timer duration must be 15, 30, or 60 minutes.");
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
      "previous_tab",
      "previous_window",
      "previous_tabs",
      "pinnedTabs",
    ]);
  }
});

async function registerContentScriptIfNeeded() {
  const registeredScripts = await env.scripting.getRegisteredContentScripts({
    ids: ["video_auto_pause"],
  });
  const currentScript = registeredScripts[0];
  if (currentScript && currentScript.matchOriginAsFallback) {
    return;
  }
  if (currentScript) {
    await env.scripting.unregisterContentScripts({ ids: ["video_auto_pause"] });
  }
  await env.scripting.registerContentScripts([
    {
      id: "video_auto_pause",
      matches: ["<all_urls>"],
      js: ["defaults.js", "video_auto_pause.js"],
      runAt: "document_start",
      allFrames: true,
      matchOriginAsFallback: true,
    },
  ]);
}

async function refresh_settings() {
  const result = await env.storage.sync.get(DEFAULT_OPTIONS);
  options = { ...DEFAULT_OPTIONS, ...result };
  const storedProfiles = await env.storage.local.get("vapProfiles");
  profiles = Array.isArray(storedProfiles.vapProfiles)
    ? storedProfiles.vapProfiles
    : [];
  debugLog(`Settings refreshed: ${JSON.stringify(options)}`);
  disabledTabs = (await sessionStorage.get("disabledTabs")).disabledTabs ?? [];
  pinnedTabs = (await sessionStorage.get("pinnedTabs")).pinnedTabs ?? [];
  debugLog(`Disabled tabs: ${JSON.stringify(disabledTabs)}`);

  const navigationState = await sessionStorage.get([
    "previous_tab",
    "previous_window",
    "previous_tabs",
  ]);
  previousTabs = navigationState.previous_tabs ?? {};
  previous_tab = navigationState.previous_tab ?? -1;
  previous_window =
    navigationState.previous_window ?? env.windows.WINDOW_ID_NONE;
  if (previous_window === env.windows.WINDOW_ID_NONE) {
    const activeTabs = await env.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (activeTabs.length > 0) {
      previous_window = activeTabs[0].windowId;
      previous_tab = activeTabs[0].id;
      previousTabs[previous_window] = previous_tab;
    }
  }
  await sessionStorage.set({
    previous_tab,
    previous_window,
    previous_tabs: previousTabs,
  });
  await configureContextRules(true);
}

async function save_settings() {
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
  await save_settings();
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
  if (!tab || options.disabled) {
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

  const settings = VAP_SETTINGS_FOR_PROFILE(options, profiles, hostname);
  return VAP_SITE_ENABLED(hostname, settings);
}

function tabOptions(tab) {
  if (!tab?.url) {
    return options;
  }
  const hostname = new URL(tab.url).hostname.toLowerCase();
  const settings = VAP_SETTINGS_FOR_PROFILE(options, profiles, hostname);
  return VAP_OPTIONS_FOR_SITE(hostname, settings);
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

function stop(tab) {
  if (pinnedTabs.includes(tab.id)) {
    return;
  }
  const settings = tabOptions(tab);
  const action = settings.muteVideo ? "mute" : "stop";
  sendMessage(tab, { action, delay: settings.pauseDelay });
}

function resume(tab) {
  const settings = tabOptions(tab);
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

function prioritizeMediaTab(tabId) {
  return queuePriorityOperation(async () => {
    if (priorityTabId === tabId) {
      return;
    }

    const previousOwnerId = priorityTabId;
    const tabs = await env.tabs.query({});
    const playingTabIds = tabs
      .filter(
        (tab) =>
          tab.id !== tabId &&
          tab.id !== previousOwnerId &&
          isMediaPlaying(tab.id) &&
          isEnabledForTab(tab),
      )
      .map((tab) => tab.id);

    for (const playingTabId of playingTabIds) {
      priorityHistory = priorityHistory.filter((id) => id !== playingTabId);
      priorityHistory.push(playingTabId);
    }
    if (previousOwnerId !== -1 && hasMedia(previousOwnerId)) {
      priorityHistory = priorityHistory.filter((id) => id !== previousOwnerId);
      priorityHistory.push(previousOwnerId);
    }
    priorityHistory = priorityHistory.filter((id) => id !== tabId);
    priorityTabId = tabId;

    for (const tab of tabs) {
      if (tab.id !== tabId && hasMedia(tab.id) && isEnabledForTab(tab)) {
        if (tabOptions(tab).autopause) {
          stop(tab);
        }
      }
    }

    try {
      const tab = await env.tabs.get(tabId);
      if (tabOptions(tab).autoresume && isEnabledForTab(tab)) {
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
          if (tabOptions(tab).autoresume) {
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

function toggle_mute(tab) {
  sendMessage(tab, { action: "toggle_mute" });
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
      text: pinnedTabs.includes(tab.id) ? "PIN" : "",
      tabId: tab.id,
    });
    if (pinnedTabs.includes(tab.id) && env.action.setBadgeBackgroundColor) {
      await env.action.setBadgeBackgroundColor({
        color: "#5b5bd6",
        tabId: tab.id,
      });
    }
  }
}

// Listen options changes
env.storage.onChanged.addListener(async function (changes, areaName) {
  const relevantSyncChange =
    areaName === "sync" &&
    Object.keys(changes).some((key) => key in DEFAULT_OPTIONS);
  const relevantTabChange =
    (areaName === "session" || areaName === "local") &&
    ("disabledTabs" in changes ||
      "pinnedTabs" in changes ||
      (areaName === "local" && "vapProfiles" in changes));
  if (!relevantSyncChange && !relevantTabChange) {
    return;
  }
  await settingsReady;
  const wasDisabled =
    areaName === "sync" && "disabled" in changes
      ? (changes.disabled.oldValue ?? false)
      : options.disabled;
  settingsReady = refresh_settings();
  await settingsReady;

  const tabs = await env.tabs.query({ active: true, lastFocusedWindow: true });
  for (const element of tabs) {
    await refreshIcon(element.id);
    if (
      wasDisabled &&
      !options.disabled &&
      tabOptions(element).autoresume &&
      isEnabledForTab(element)
    ) {
      resume(element);
    }
  }
});

// Tab change listener
env.tabs.onActivated.addListener(async function (info) {
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
  if (
    isWithinQuietHours(options.quietHoursStart, options.quietHoursEnd) &&
    tabOptions(tab).autopause
  ) {
    stop(tab);
  }

  const previousTabId =
    previousTabs[info.windowId] ??
    (previous_window === info.windowId ? previous_tab : -1);

  if (tabOptions(tab).prioritizeActiveTabMedia) {
    if (
      priorityTabId === -1 &&
      previousTabId !== -1 &&
      hasMedia(previousTabId)
    ) {
      priorityTabId = previousTabId;
    }
    if (hasMedia(info.tabId) && priorityTabId !== info.tabId) {
      await prioritizeMediaTab(info.tabId);
    }
  } else if (isEnabledForTab(tab) && previousTabId !== info.tabId) {
    if (previousTabId !== -1) {
      try {
        const previousTab = await env.tabs.get(previousTabId);
        if (
          previousTab &&
          previousTab.windowId === tab.windowId &&
          tabOptions(previousTab).autopause
        ) {
          stop(previousTab);
        }
      } catch (error) {
        debugLog(`Could not get previous tab ${previousTabId}: ${error}`);
      }
    }
    if (tabOptions(tab).autoresume && tab.active) {
      resume(tab);
    }
  }

  previous_tab = info.tabId;
  previous_window = info.windowId;
  previousTabs[info.windowId] = info.tabId;
  await sessionStorage.set({
    previous_tab,
    previous_window,
    previous_tabs: previousTabs,
  });
  await refreshIcon(info.tabId);
});

env.tabs.onCreated.addListener(async function (tab) {
  await settingsReady;
  if (!tab.url) {
    await refreshIcon(tab.id);
  }
});

// Tab update listener
env.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  await settingsReady;
  sendMessage(tab, { action: "check" });
  if (
    changeInfo.status === "complete" &&
    isWithinQuietHours(options.quietHoursStart, options.quietHoursEnd) &&
    tabOptions(tab).autopause
  ) {
    stop(tab);
  }

  if (changeInfo.status === "loading") {
    delete tabVideos[tabId];
    delete tabVisibility[tabId];
    delete tabVideoHover[tabId];
  }

  if (
    !tabOptions(tab).prioritizeActiveTabMedia &&
    changeInfo.status === "complete" &&
    !tab.active &&
    tabOptions(tab).autopause
  ) {
    stop(tab);
  }

  if (tab.active) {
    await refreshIcon(tabId);
  }
});

env.tabs.onRemoved.addListener(async function (tabId) {
  await settingsReady;
  delete tabVideos[tabId];
  delete tabVisibility[tabId];
  delete tabMedia[tabId];
  delete tabVideoHover[tabId];
  priorityHistory = priorityHistory.filter((id) => id !== tabId);
  if (pinnedTabs.includes(tabId)) {
    pinnedTabs = pinnedTabs.filter((id) => id !== tabId);
    await save_settings();
  }
  if (options.prioritizeActiveTabMedia && priorityTabId === tabId) {
    await resumePriorMediaTab();
  }
  if (disabledTabs.includes(tabId)) {
    disabledTabs = disabledTabs.filter((tab) => tab !== tabId);
    await save_settings();
  }

  for (const [windowId, previousTabId] of Object.entries(previousTabs)) {
    if (previousTabId === tabId) {
      delete previousTabs[windowId];
    }
  }

  if (previous_tab === tabId) {
    previous_tab = -1;
  }
  await sessionStorage.set({ previous_tab, previous_tabs: previousTabs });
});

// Window focus listener
env.windows.onFocusChanged.addListener(async function (windowId) {
  await settingsReady;

  if (windowId !== previous_window) {
    if (state !== "locked" && previous_window !== env.windows.WINDOW_ID_NONE) {
      const tabsStop = await env.tabs.query({ windowId: previous_window });
      debugLog(`Window changed, stopping videos in window ${previous_window}`);
      for (let i = 0; i < tabsStop.length; i++) {
        if (
          !isEnabledForTab(tabsStop[i]) ||
          !tabOptions(tabsStop[i]).focuspause
        ) {
          continue;
        }
        if (
          tabOptions(tabsStop[i]).peekMode &&
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
        const settings = tabOptions(tabsResume[i]);
        if (!isEnabledForTab(tabsResume[i]) || !settings.focusresume) {
          continue;
        }
        if (!tabsResume[i].active && settings.autopause) {
          continue;
        }
        resume(tabsResume[i]);
      }
    }

    previous_window = windowId;
    await sessionStorage.set({ previous_window, previous_tabs: previousTabs });
    await refreshIcon();
  }
});

env.windows.onRemoved.addListener(function (windowId) {
  delete previousTabs[windowId];
  if (previous_window === windowId) {
    previous_window = env.windows.WINDOW_ID_NONE;
  }
  void sessionStorage.set({ previous_window, previous_tabs: previousTabs });
});

async function handlePageMessage(request, sender) {
  await settingsReady;
  if (request.sleepTimerAction) {
    if (sender.url !== env.runtime.getURL("options.html")) {
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
    tabMedia[tab.id] ??= {};
    tabMedia[tab.id][sender.frameId ?? 0] = request.mediaState;
    const settings = tabOptions(tab);
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
      (previous_window === tab.windowId && previous_tab === tab.id);
    if (
      isActiveTab &&
      request.mediaState.hasMedia &&
      priorityTabId !== tab.id
    ) {
      await prioritizeMediaTab(tab.id);
    } else if (priorityTabId === tab.id && !isMediaPlaying(tab.id)) {
      await resumePriorMediaTab();
    } else if (
      !tab.active &&
      tab.id !== priorityTabId &&
      request.mediaState.playing &&
      isMediaPlaying(priorityTabId)
    ) {
      if (settings.autopause) {
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
  const settings = tabOptions(tab);

  if ("videoHovered" in request) {
    tabVideoHover[tab.id] ??= {};
    tabVideoHover[tab.id][sender.frameId ?? 0] = request.videoHovered;
    if (
      !request.videoHovered &&
      settings.peekMode &&
      settings.focuspause &&
      tab.windowId !== previous_window
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
    const disabled = !options.disabled;
    debugLog(`Toggle extension command received, extension state ${disabled}`);
    await env.storage.sync.set({ disabled });
    settingsReady = refresh_settings();
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
    await save_settings();
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
      toggle_mute(tab);
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

    const settings = tabOptions(tabs[i]);
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
        files: ["defaults.js", "video_auto_pause.js"],
      });
    } catch (error) {
      console.warn(
        `Video Autopause could not inject into tab ${tab.id}:`,
        error,
      );
    }
  }
});
