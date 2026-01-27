// Browser
const env = chrome.runtime ? chrome : browser;

// Previous tab and window numbers
let previous_tab = -1;
let previous_window = env.windows.WINDOW_ID_NONE;
let disabledTabs = [];
let tabVideos = {}; // { tabId: { frameId: boolean } }

// Computer state
let state = "active";
// Default options
let options = {
  autopause: true,
  autoresume: true,

  muteVideo: false,
  scrollpause: false,
  lockpause: true,
  lockresume: true,
  focuspause: false,
  focusresume: false,
  disabled: false,
  cursorTracking: false,
  debugMode: false,
  disableOnFullscreen: true,
  pauseDelay: 0,
  resumeDelay: 0,
  excludedDomains: [],
  includedDomains: [],
};

function debugLog(message) {
  if (options.debugMode) {
    console.log(`Video auto pause: ${message}`);
  }
}

// Initialize settings from storage
refresh_settings();
env.scripting.registerContentScripts([
  {
    id: "video_auto_pause",
    matches: ["<all_urls>"],
    js: ["video_auto_pause.js"],
    runAt: "document_start",
    allFrames: true,
  },
]);

async function refresh_settings() {
  const result = await env.storage.sync.get(Object.keys(options));
  options = Object.assign(options, result);
  debugLog(`Settings refreshed: ${JSON.stringify(options)}`);
  if (options.disabled === true) {
    options.autopause = false;
    options.autoresume = false;
    options.scrollpause = false;
    options.lockpause = false;
    options.lockresume = false;
    options.focuspause = false;
    options.focusresume = false;
    options.cursorTracking = false;
    options.debugMode = false;
    options.disableOnFullscreen = true;
    options.pauseDelay = 0;
    options.resumeDelay = 0;
    options.excludedDomains = [];
    options.includedDomains = [];
  }

  disabledTabs =
    (await env.storage.local.get("disabledTabs")).disabledTabs ?? [];
  debugLog(`Disabled tabs: ${JSON.stringify(disabledTabs)}`);

  // Initialize previous tab & window
  const windows = await env.windows.getAll({
    populate: false,
    windowTypes: ["normal"],
  });
  if (windows.length > 0) {
    const currentWindow = await env.windows.getLastFocused();
    previous_window = currentWindow.id;
  }

  const tabs = await env.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length > 0) {
    previous_tab = tabs[0].id;
  }
}

async function save_settings() {
  await env.storage.sync.set(options);
  await env.storage.local.set({ disabledTabs });
}

function isEnabledForTab(tab) {
  if (!tab || options.disabled) {
    return false;
  }

  if (!disabledTabs.includes(tab.id)) {
    if (tab.url) {
      const url = new URL(tab.url);

      if (
        options.excludedDomains.some((domain) => url.hostname.includes(domain))
      ) {
        return false;
      }

      if (options.includedDomains.length > 0) {
        return options.includedDomains.some((domain) =>
          url.hostname.includes(domain),
        );
      }

      return true;
    }
  }
  return false;
}

// Functionality to send messages to tabs
function sendMessage(tab, message) {
  if (!env.runtime?.id || !isEnabledForTab(tab)) {
    return;
  }

  if (env.runtime.lastError) {
    console.error(`Video Autopause error: ${env.runtime.lastError.toString()}`);
    return;
  }

  debugLog(`Sending message ${JSON.stringify(message)} to tab ${tab.id}`);

  env.tabs.sendMessage(tab.id, message, {}, function () {
    void env.runtime.lastError;
  });
}

// Media conrol functions
let pauseTimeouts = {};
let resumeTimeouts = {};

function stop(tab) {
  if (resumeTimeouts[tab.id]) {
    clearTimeout(resumeTimeouts[tab.id]);
    delete resumeTimeouts[tab.id];
  }

  if (options.pauseDelay > 0) {
    if (pauseTimeouts[tab.id]) {
      return;
    }
    pauseTimeouts[tab.id] = setTimeout(() => {
      const action = options.muteVideo ? "mute" : "stop";
      sendMessage(tab, { action: action });
      delete pauseTimeouts[tab.id];
    }, options.pauseDelay);
  } else {
    const action = options.muteVideo ? "mute" : "stop";
    sendMessage(tab, { action: action });
  }
}

function resume(tab) {
  if (pauseTimeouts[tab.id]) {
    clearTimeout(pauseTimeouts[tab.id]);
    delete pauseTimeouts[tab.id];
  }

  if (options.resumeDelay > 0) {
    if (resumeTimeouts[tab.id]) {
      return;
    }
    resumeTimeouts[tab.id] = setTimeout(() => {
      const action = options.muteVideo ? "unmute" : "resume";
      sendMessage(tab, { action: action });
      delete resumeTimeouts[tab.id];
    }, options.resumeDelay);
  } else {
    const action = options.muteVideo ? "unmute" : "resume";
    sendMessage(tab, { action: action });
  }
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

let iconTimeout;
function changeIcon(disabled) {
  if (iconTimeout) {
    clearTimeout(iconTimeout);
  }

  iconTimeout = setTimeout(() => {
    if (disabled) {
      env.action.setIcon({
        path: {
          16: "/images/icon_disabled_16.png",
          32: "/images/icon_disabled_32.png",
          64: "/images/icon_disabled_64.png",
          128: "/images/icon_disabled_128.png",
        },
      });
    } else {
      env.action.setIcon({
        path: {
          16: "/images/icon_16.png",
          32: "/images/icon_32.png",
          64: "/images/icon_64.png",
          128: "/images/icon_128.png",
        },
      });
    }
  }, 200);
}

async function refreshIcon(tabId) {
  let tab;
  if (tabId) {
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
  changeIcon(!(enabled && hasVideosInTab));
}

// Listen options changes
env.storage.onChanged.addListener(async function () {
  await refresh_settings();

  const tabs = await env.tabs.query({ active: true });

  await refreshIcon();

  for (const element of tabs) {
    if (isEnabledForTab(element) && element.active) {
      resume(element);
    }
  }
});

// Tab change listener
env.tabs.onActivated.addListener(async function (info) {
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

  if (!isEnabledForTab(tab) || previous_tab === info.tabId) {
    return;
  }

  if (options.autopause && previous_tab !== -1) {
    try {
      const prev = await env.tabs.get(previous_tab);
      if (prev && prev.windowId === tab.windowId) {
        debugLog(`Tab changed, stopping video from tab ${previous_tab}`);
        stop(prev);
      }
    } catch (e) {
      debugLog(`Could not get previous tab ${previous_tab}: ${e}`);
    }
  }

  if (options.autoresume && tab.active) {
    debugLog(`Tab changed, resuming video from tab ${info.tabId}`);
    resume(tab);
  }

  previous_tab = info.tabId;
  await refreshIcon(info.tabId);
});

env.tabs.onCreated.addListener(async function (tab) {
  if (!tab.url) {
    await refreshIcon(tab.id);
  }
});

// Tab update listener
env.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  sendMessage(tab, { action: "check" });

  if (changeInfo.status === "loading") {
    delete tabVideos[tabId];
  }

  if (tab.active) {
    await refreshIcon(tabId);
  }

  if (
    "status" in changeInfo &&
    changeInfo.status === "complete" &&
    !tab.active
  ) {
    debugLog(
      `Tab updated, stopping video in tab ${tabId} with status ${changeInfo.status}, active ${tab.active}`,
    );
    stop(tab);
  }
});

env.tabs.onRemoved.addListener(function (tabId) {
  delete tabVideos[tabId];
  if (disabledTabs.includes(tabId)) {
    disabledTabs = disabledTabs.filter((tab) => tab !== tabId);
    save_settings();
  }

  if (previous_tab === tabId) {
    previous_tab = -1;
  }
});

// Window focus listener
env.windows.onFocusChanged.addListener(async function (windowId) {
  if (windowId !== previous_window) {
    if (options.focuspause && state !== "locked") {
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
    await refreshIcon();
  }
});

env.windows.onRemoved.addListener(function (windowId) {
  if (previous_window === windowId) {
    previous_window = env.windows.WINDOW_ID_NONE;
  }
});

// Message listener for messages from tabs
env.runtime.onMessage.addListener(
  async function (request, sender, sendResponse) {
    if ("hasVideos" in request && sender.tab.active) {
      if (!tabVideos[sender.tab.id]) {
        tabVideos[sender.tab.id] = {};
      }
      tabVideos[sender.tab.id][sender.frameId] = request.hasVideos;

      const anyFrameHasVideos = Object.values(tabVideos[sender.tab.id]).some(
        (v) => v,
      );
      debugLog(
        `Tab ${sender.tab.id} has videos: ${anyFrameHasVideos} (frame ${sender.frameId}: ${request.hasVideos})`,
      );
      await refreshIcon(sender.tab.id);
    }

    if ("windowFocused" in request) {
      if (!request.windowFocused && options.focuspause) {
        debugLog(`Window blurred, stopping videos in tab ${sender.tab.id}`);
        stop(sender.tab);
      } else if (
        request.windowFocused &&
        options.focusresume &&
        sender.tab.active
      ) {
        debugLog(`Window focused, resuming videos in tab ${sender.tab.id}`);
        resume(sender.tab);
      }
    }

    if (!isEnabledForTab(sender.tab) || env.runtime.lastError) {
      return true;
    }

    if ("minimized" in request) {
      if (request.minimized && options.autopause) {
        debugLog(`Window minimized, stopping videos in tab ${sender.tab.id}`);
        stop(sender.tab);
      } else if (
        !request.minimized &&
        options.autoresume &&
        sender.tab.active
      ) {
        debugLog(`Window returned, resuming videos in tab ${sender.tab.id}`);
        resume(sender.tab);
      }
    }

    if ("visible" in request && options.scrollpause) {
      if (!request.visible) {
        debugLog(
          `Window is not visible, stopping videos in tab ${sender.tab.id}`,
        );
        stop(sender.tab);
      } else if (request.visible && sender.tab.active) {
        debugLog(`Window is visible, resuming videos in tab ${sender.tab.id}`);
        resume(sender.tab);
      }
    }

    if (options.cursorTracking && "cursorNearEdge" in request) {
      if (request.cursorNearEdge && options.autopause) {
        debugLog(
          `Nearing window edge, stopping videos in tab ${sender.tab.id}`,
        );
        stop(sender.tab);
      } else if (
        !request.cursorNearEdge &&
        options.autoresume &&
        sender.tab.active
      ) {
        debugLog(`Returned to window, resuming videos in tab ${sender.tab.id}`);
        resume(sender.tab);
      }
    }

    sendResponse({});
    return true;
  },
);

// Listener for keyboard shortcuts
env.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-extension") {
    options.disabled = !options.disabled;
    debugLog(
      `Toggle extension command received, extension state ${options.disabled}`,
    );
    env.storage.sync.set({ disabled: options.disabled });
    await refresh_settings();
  } else if (command === "toggle-tab") {
    const tabs = await env.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    debugLog(`Toggle tab command received for tab ${tab.id}`);
    if (disabledTabs.includes(tab.id)) {
      disabledTabs = disabledTabs.filter((t) => t !== tab.id);
    } else {
      disabledTabs.push(tab.id);
    }
    await save_settings();
  } else if (command === "toggle-play") {
    debugLog(
      `Toggle play command received, toggling play for all tabs in current window`,
    );
    const tabs = await env.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (!isEnabledForTab(tabs[i])) {
        continue;
      }
      toggle(tabs[i]);
    }
  } else if (command === "toggle_mute") {
    debugLog(
      `Toggle mute command received, toggling mute for all tabs in current window`,
    );
    const tabs = await env.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (!isEnabledForTab(tabs[i])) {
        continue;
      }
      toggle_mute(tabs[i]);
    }
  } else if (
    command === "speed-up" ||
    command === "speed-down" ||
    command === "speed-reset"
  ) {
    debugLog(`Speed command received: ${command}`);
    const tabs = await env.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (!isEnabledForTab(tabs[i])) {
        continue;
      }
      speed(tabs[i], command);
    }
  }
});

// Listener for computer idle/locked/active
env.idle.onStateChanged.addListener(async function (s) {
  state = s;
  const tabs = await env.tabs.query({ active: true });

  for (let i = 0; i < tabs.length; i++) {
    if (!isEnabledForTab(tabs[i])) {
      continue;
    }

    if (state === "locked" && options.lockpause) {
      debugLog(`Computer locked, stopping all videos`);
      stop(tabs[i]);
    } else if (state !== "locked" && options.lockresume) {
      if (!tabs[i].active && options.autopause) {
        continue;
      }
      debugLog(`Computer unlocked, resuming videos`);
      resume(tabs[i]);
    }
  }
});

env.windows.onCreated.addListener(async function (window) {
  const tabs = await env.tabs.query({ windowId: window.id });
  debugLog(`Window created, stopping all non active videos`);
  for (let i = 0; i < tabs.length; i++) {
    if (!isEnabledForTab(tabs[i])) {
      continue;
    }

    if (tabs[i].active && options.autoresume) {
      resume(tabs[i]);
    } else if (options.autopause) {
      stop(tabs[i]);
    }
  }
});
