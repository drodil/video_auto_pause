// Previous tab and window numbers
let previous_tab = -1;
let previous_window = browser.windows.WINDOW_ID_NONE;
let executedTabs = [];
let enabledTabs = [];

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
};

const hosts = browser.runtime.getManifest().host_permissions;
for (const host of hosts) {
  options[host] = true;
}

// Initialize settings from storage
setTimeout(() => {
  refresh_settings();
}, 100);

function refresh_settings() {
  browser.storage.sync.get(Object.keys(options), function (result) {
    options = Object.assign(options, result);
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
      for (var host of hosts) {
        options[host] = false;
      }
    }
    enabledTabs = [];
  });
}

function debugLog(message) {
  if (options.debugMode) {
    console.log(`YouTube auto pause: ${message}`);
  }
}

function isEnabledForTab(tab) {
  if (!tab || !tab.url) {
    return false;
  }

  if (enabledTabs.includes(tab.id)) {
    return true;
  }

  const optionKey = Object.keys(options).find((option) => {
    if (!option.startsWith("http")) {
      return false;
    }
    const reg = option
      .replace(/[.+?^${}()|/[\]\\]/g, "\\$&")
      .replace("*", ".*");
    return new RegExp(reg).test(tab.url);
  });

  if (optionKey) {
    return !!options[optionKey];
  }

  return false;
}

async function injectScript(tab) {
  if (executedTabs.includes(tab.id) || !isEnabledForTab(tab)) {
    return;
  }

  debugLog(`Injecting script into tab ${tab.id} with url ${tab.url}`);
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["yt_auto_pause.js"],
    });
    executedTabs.push(tab.id);
  } catch (e) {
    debugLog(e);
  }
}

// Functionality to send messages to tabs
function sendMessage(tab, message) {
  if (!browser.runtime?.id || !isEnabledForTab(tab)) {
    debugLog(`Not sending message`);
    return;
  }

  if (browser.runtime.lastError) {
    console.error(
      `YouTube Autopause error: ${browser.runtime.lastError.toString()}`
    );
    return;
  }

  debugLog(`Sending message ${JSON.stringify(message)} to tab ${tab.id}`);

  browser.tabs.sendMessage(tab.id, message, {}, function () {
    void browser.runtime.lastError;
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

// Listen options changes
browser.storage.onChanged.addListener(async function (changes) {
  enabledTabs = [];
  for (const key in changes) {
    debugLog(
      `Settings changed for key ${key} from ${changes[key].oldValue} to ${changes[key].newValue}`
    );
    options[key] = changes[key].newValue;
  }

  if ("disabled" in changes) {
    const tabs = await browser.tabs.query({ active: true });
    if (!options.disabled) {
      debugLog(`Extension enabled, resuming active tabs`);
    } else {
      debugLog(`Extension disabled, stopping active tabs`);
    }

    for (let i = 0; i < tabs.length; i++) {
      if (!options.disabled) {
        resume(tabs[i]);
      } else {
        stop(tabs[i]);
      }
    }
  }
});

// Tab change listener
browser.tabs.onActivated.addListener(function (info) {
  if (previous_window !== info.windowId) {
    return;
  }

  browser.tabs.get(info.tabId, async function (tab) {
    if (!isEnabledForTab(tab) || previous_tab === info.tabId) {
      return;
    }

    await injectScript(tab);

    if (options.autopause && previous_tab !== -1) {
      debugLog(`Tab changed, stopping video from tab ${previous_tab}`);
      browser.tabs.get(previous_tab, function (prev) {
        stop(prev);
      });
    }

    if (options.autoresume) {
      debugLog(`Tab changed, resuming video from tab ${info.tabId}`);
      resume(tab);
    }

    previous_tab = info.tabId;
  });
});

// Tab update listener
browser.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  if (!isEnabledForTab(tab)) {
    return;
  }

  await injectScript(tab);

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

browser.tabs.onRemoved.addListener(function (tabId) {
  if (enabledTabs.includes(tabId)) {
    debugLog(`Tab removed, removing tab ${tabId} from enabled tabs`);
    enabledTabs = enabledTabs.filter((e) => e !== tabId);
  }
  if (executedTabs.includes(tabId)) {
    debugLog(`Tab removed, removing tab ${tabId} from executed tabs`);
    executedTabs = executedTabs.filter((e) => e !== tabId);
  }
});

// Window focus listener
browser.windows.onFocusChanged.addListener(async function (window) {
  if (window !== previous_window) {
    if (options.focuspause && state !== "locked") {
      const tabsStop = await browser.tabs.query({ windowId: previous_window });
      debugLog(`Window changed, stopping videos in window ${window}`);
      for (let i = 0; i < tabsStop.length; i++) {
        if (!isEnabledForTab(tabsStop[i])) {
          continue;
        }
        stop(tabsStop[i]);
      }
    }

    if (options.focusresume && window !== browser.windows.WINDOW_ID_NONE) {
      const tabsResume = await browser.tabs.query({ windowId: window });
      debugLog(`Window changed, resuming videos in window ${window}`);
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

    previous_window = window;
  }
});

// Message listener for messages from tabs
browser.runtime.onMessage.addListener(async function (
  request,
  sender,
  sendResponse
) {
  if (!isEnabledForTab(sender.tab) || browser.runtime.lastError) {
    return true;
  }

  if ("minimized" in request) {
    if (request.minimized && options.autopause) {
      debugLog(`Window minimized, stopping videos in tab ${sender.tab.id}`);
      stop(sender.tab);
    } else if (!request.minimized && options.autoresume) {
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
    } else {
      debugLog(`Window is visible, resuming videos in tab ${sender.tab.id}`);
      resume(sender.tab);
    }
  }

  await browser.storage.sync.get("cursorTracking", function (result) {
    if (result.cursorTracking && "cursorNearEdge" in request) {
      // Handle cursor near edge changes
      if (request.cursorNearEdge && options.autopause) {
        debugLog(
          `Nearing window edge, stopping videos in tab ${sender.tab.id}`
        );
        stop(sender.tab);
      } else if (!request.cursorNearEdge && options.autoresume) {
        debugLog(`Returned to window, resuming videos in tab ${sender.tab.id}`);
        resume(sender.tab);
      }
    }
  });

  sendResponse({});
  return true;
});

// Listener for keyboard shortcuts
browser.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-extension") {
    options.disabled = !options.disabled;
    debugLog(
      `Toggle extension command received, extension state ${options.disabled}`
    );
    browser.storage.sync.set({ disabled: options.disabled });
    refresh_settings();
  } else if (command === "toggle-play") {
    debugLog(
      `Toggle play command received, toggling play for all tabs in current window`
    );
    const tabs = await browser.tabs.query({ currentWindow: true });
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
    const tabs = await browser.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (!isEnabledForTab(tabs[i])) {
        continue;
      }
      toggle_mute(tabs[i]);
    }
  }
});

// Listener for computer idle/locked/active
browser.idle.onStateChanged.addListener(async function (s) {
  state = s;
  const tabs = await browser.tabs.query({ active: true });

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

browser.windows.onCreated.addListener(async function (window) {
  const tabs = await browser.tabs.query({ windowId: window.id });
  debugLog(`Window created, stopping all non active videos`);
  for (let i = 0; i < tabs.length; i++) {
    if (!isEnabledForTab(tabs[i])) {
      continue;
    }

    await injectScript(tabs[i]);

    if (tabs[i].active && options.autoresume) {
      resume(tabs[i]);
    } else if (options.autopause) {
      stop(tabs[i]);
    }
  }
});
