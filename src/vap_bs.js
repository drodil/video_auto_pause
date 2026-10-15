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
let priorityTabId = -1;
let priorityHistory = [];
let priorityOperation = Promise.resolve();
let statisticsOperation = Promise.resolve();
let pinnedTabs = [];

// Computer state
let state = "active";
let previousIdleState = "active";
let options = { ...DEFAULT_OPTIONS };

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
  previousIdleState = await env.idle.queryState(60);
  state = previousIdleState;
}

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

  const matchesDomain = (entries) =>
    entries.some((entry) => {
      const normalized = entry
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z\d+.-]*:\/\//, "")
        .split(/[/?#]/, 1)[0]
        .replace(/^\*\./, "")
        .replace(/:\d+$/, "")
        .replace(/\.$/, "");
      return (
        normalized &&
        (hostname === normalized || hostname.endsWith(`.${normalized}`))
      );
    });

  if (matchesDomain(options.excludedDomains)) {
    return false;
  }
  return (
    options.includedDomains.length === 0 ||
    matchesDomain(options.includedDomains)
  );
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
  const action = options.muteVideo ? "mute" : "stop";
  sendMessage(tab, { action, delay: options.pauseDelay });
}

function resume(tab) {
  const action = options.muteVideo ? "unmute" : "resume";
  sendMessage(tab, { action, delay: options.resumeDelay });
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
        if (options.autopause) {
          stop(tab);
        }
      }
    }

    try {
      const tab = await env.tabs.get(tabId);
      if (options.autoresume && isEnabledForTab(tab)) {
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
          if (options.autoresume) {
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
    ("disabledTabs" in changes || "pinnedTabs" in changes);
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
      options.autoresume &&
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

  const previousTabId =
    previousTabs[info.windowId] ??
    (previous_window === info.windowId ? previous_tab : -1);

  if (options.prioritizeActiveTabMedia) {
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
    if (options.autopause && previousTabId !== -1) {
      try {
        const previousTab = await env.tabs.get(previousTabId);
        if (previousTab && previousTab.windowId === tab.windowId) {
          stop(previousTab);
        }
      } catch (error) {
        debugLog(`Could not get previous tab ${previousTabId}: ${error}`);
      }
    }
    if (options.autoresume && tab.active) {
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

  if (changeInfo.status === "loading") {
    delete tabVideos[tabId];
    delete tabVisibility[tabId];
  }

  if (
    !options.prioritizeActiveTabMedia &&
    changeInfo.status === "complete" &&
    !tab.active &&
    options.autopause
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
    if (
      options.focuspause &&
      state !== "locked" &&
      previous_window !== env.windows.WINDOW_ID_NONE
    ) {
      const tabsStop = await env.tabs.query({ windowId: previous_window });
      debugLog(`Window changed, stopping videos in window ${previous_window}`);
      for (let i = 0; i < tabsStop.length; i++) {
        if (!isEnabledForTab(tabsStop[i])) {
          continue;
        }
        stop(tabsStop[i]);
      }
    }

    if (options.focusresume && windowId !== env.windows.WINDOW_ID_NONE) {
      const tabsResume = await env.tabs.query({ windowId: windowId });
      debugLog(`Window changed, resuming videos in window ${windowId}`);
      for (let i = 0; i < tabsResume.length; i++) {
        if (!isEnabledForTab(tabsResume[i])) {
          continue;
        }
        if (!tabsResume[i].active && options.autopause) {
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
    if (
      state === "locked" &&
      options.lockpause &&
      request.mediaState.playing &&
      isEnabledForTab(tab)
    ) {
      stop(tab);
      return;
    }
    if (!options.prioritizeActiveTabMedia || !isEnabledForTab(tab)) {
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
      if (options.autopause) {
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

  if ("minimized" in request) {
    if (
      !options.prioritizeActiveTabMedia &&
      request.minimized &&
      options.autopause
    ) {
      stop(tab);
    } else if (
      !options.prioritizeActiveTabMedia &&
      !request.minimized &&
      options.autoresume &&
      tab.active
    ) {
      resume(tab);
    }
  }

  if ("windowFocused" in request) {
    if (!request.windowFocused && options.focuspause) {
      stop(tab);
    } else if (request.windowFocused && options.focusresume && tab.active) {
      resume(tab);
    }
  }

  if ("visible" in request && options.scrollpause && tab.active) {
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
    if (allVideoFramesReported && !anyVideoFrameVisible && options.autopause) {
      stop(tab);
    } else if (anyVideoFrameVisible && options.autoresume) {
      resume(tab);
    }
  }

  if (options.cursorTracking && "cursorNearEdge" in request) {
    if (request.cursorNearEdge && options.autopause) {
      stop(tab);
    } else if (!request.cursorNearEdge && options.autoresume && tab.active) {
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
  previousIdleState = s;
  state = s;
  const tabs = await env.tabs.query({ active: true, lastFocusedWindow: true });

  for (let i = 0; i < tabs.length; i++) {
    if (!isEnabledForTab(tabs[i])) {
      continue;
    }

    if (state === "locked" && options.lockpause) {
      debugLog(`Computer locked, stopping all videos`);
      stop(tabs[i]);
    } else if (state === "active" && wasLocked && options.lockresume) {
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
      console.error("Video Autopause could not open the onboarding page:", error);
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
