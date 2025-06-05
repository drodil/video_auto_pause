// Browser
const env = chrome.runtime ? chrome : browser;

// Previous tab and window numbers
let previous_tab = -1;
let previous_window = env.windows.WINDOW_ID_NONE;
let disabledTabs = [];

// Computer state
let state = "active";
// Default options
let options = {
  autopause: true,
  autoresume: true,
  scrollpause: false,
  lockpause: true,
  lockresume: true,
  focuspause: false,
  focusresume: false,
  disabled: false,
  cursorTracking: false,
  debugMode: false,
  disableOnFullscreen: true,
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
  }

  disabledTabs =
    (await env.storage.local.get("disabledTabs")).disabledTabs ?? [];
  debugLog(`Disabled tabs: ${JSON.stringify(disabledTabs)}`);
}

async function save_settings() {
  await env.storage.sync.set(options);
  await env.storage.local.set({ disabledTabs });
}

function isEnabledForTab(tab) {
  if (!tab || options.disabled) {
    return false;
  }

  return !disabledTabs.includes(tab.id);
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
function stop(tab) {
  sendMessage(tab, { action: "stop" });
}

function resume(tab) {
  sendMessage(tab, { action: "resume" });
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
  }, 150);
}

// Listen options changes
env.storage.onChanged.addListener(async function () {
  await refresh_settings();

  const tabs = await env.tabs.query({ active: true });

  const enabledTab = tabs.find((t) => isEnabledForTab(t) && t.active);
  if (enabledTab) {
    changeIcon(false);
  } else {
    changeIcon(true);
  }

  for (let i = 0; i < tabs.length; i++) {
    if (isEnabledForTab(tabs[i]) && tabs[i].active) {
      resume(tabs[i]);
    }
  }
});

// Tab change listener
env.tabs.onActivated.addListener(async function (info) {
  const tab = await env.tabs.get(info.tabId);
  if (!tab) {
    return;
  }

  sendMessage(tab, { action: "check" });

  if (!isEnabledForTab(tab) || previous_tab === info.tabId) {
    return;
  }

  if (options.autopause && previous_tab !== -1) {
    debugLog(`Tab changed, stopping video from tab ${previous_tab}`);
    const prev = await env.tabs.get(previous_tab);
    if (prev) {
      stop(prev);
    }
  }

  if (options.autoresume && tab.active) {
    debugLog(`Tab changed, resuming video from tab ${info.tabId}`);
    resume(tab);
  }

  previous_tab = info.tabId;
});

env.tabs.onCreated.addListener(async function (tab) {
  if (!tab.url) {
    changeIcon(true);
  }
});

// Tab update listener
env.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  sendMessage(tab, { action: "check" });

  if (!isEnabledForTab(tab)) {
    return;
  }

  if (tab.active) {
    changeIcon(false);
  }

  if (
    "status" in changeInfo &&
    changeInfo.status === "complete" &&
    !tab.active
  ) {
    debugLog(
      `Tab updated, stopping video in tab ${tabId} with status ${changeInfo.status}, active ${tab.active}`
    );
    stop(tab);
  }
});

env.tabs.onRemoved.addListener(function (tabId) {
  if (disabledTabs.includes(tabId)) {
    disabledTabs = disabledTabs.filter((tab) => tab !== tabId);
    save_settings();
  }
});

// Window focus listener
env.windows.onFocusChanged.addListener(async function (windowId) {
  if (windowId !== previous_window) {
    if (options.focuspause && state !== "locked") {
      const tabsStop = await env.tabs.query({ windowId: previous_window });
      debugLog(`Window changed, stopping videos in window ${windowId}`);
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
  }
});

// Message listener for messages from tabs
env.runtime.onMessage.addListener(async function (
  request,
  sender,
  sendResponse
) {
  if ("hasVideos" in request && sender.tab.active) {
    debugLog(`Tab has videos: ${request.hasVideos}`);
    changeIcon(!(request.hasVideos && isEnabledForTab(sender.tab)));
  }

  if (!isEnabledForTab(sender.tab) || env.runtime.lastError) {
    return true;
  }

  if ("minimized" in request) {
    if (request.minimized && options.autopause) {
      debugLog(`Window minimized, stopping videos in tab ${sender.tab.id}`);
      stop(sender.tab);
    } else if (!request.minimized && options.autoresume && sender.tab.active) {
      debugLog(`Window returned, resuming videos in tab ${sender.tab.id}`);
      resume(sender.tab);
    }
  }

  if ("visible" in request && options.scrollpause) {
    if (!request.visible) {
      debugLog(
        `Window is not visible, stopping videos in tab ${sender.tab.id}`
      );
      stop(sender.tab);
    } else if (request.visible && sender.tab.active) {
      debugLog(`Window is visible, resuming videos in tab ${sender.tab.id}`);
      resume(sender.tab);
    }
  }

  await env.storage.sync.get("cursorTracking", function (result) {
    if (result.cursorTracking && "cursorNearEdge" in request) {
      // Handle cursor near edge changes
      if (request.cursorNearEdge && options.autopause) {
        debugLog(
          `Nearing window edge, stopping videos in tab ${sender.tab.id}`
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
  });

  sendResponse({});
  return true;
});

// Listener for keyboard shortcuts
env.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-extension") {
    options.disabled = !options.disabled;
    debugLog(
      `Toggle extension command received, extension state ${options.disabled}`
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
      `Toggle play command received, toggling play for all tabs in current window`
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
      `Toggle mute command received, toggling mute for all tabs in current window`
    );
    const tabs = await env.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (!isEnabledForTab(tabs[i])) {
        continue;
      }
      toggle_mute(tabs[i]);
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
