// Previous tab and window numbers
let previous_tab = 0;
let previous_window = chrome.windows.WINDOW_ID_NONE;

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
};

var hosts = chrome.runtime.getManifest().host_permissions;
for (var host of hosts) {
  options[host] = true;
}

// Initialize settings from storage
refresh_settings();

function refresh_settings() {
  chrome.storage.sync.get(Object.keys(options), function (result) {
    options = Object.assign(options, result);
    if (options.disabled === true) {
      options.autopause = false;
      options.autoresume = false;
      options.scrollpause = false;
      options.lockpause = false;
      options.lockresume = false;
      options.focuspause = false;
      options.focusresume = false;
      for (var host of hosts) {
        options[host] = false;
      }
    }
  });
}

function isEnabledForTab(tab) {
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
    return options[optionKey];
  }
  return true;
}

// Functionality to send messages to tabs
function sendMessage(tab, message) {
  if (!chrome.runtime?.id || !isEnabledForTab(tab)) {
    return;
  }

  if (chrome.runtime.lastError) {
    console.error(
      `Youtube Autopause error: ${chrome.runtime.lastError.toString()}`
    );
    return;
  }

  chrome.tabs.sendMessage(tab.id, message, {}, function () {
    void chrome.runtime.lastError;
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
chrome.storage.onChanged.addListener(async function (changes, namespace) {
  for (const key in changes) {
    options[key] = changes[key].newValue;
  }

  if ("disabled" in changes) {
    refresh_settings();
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (options.disabled === true) {
        resume(tabs[i]);
      } else {
        if (!tabs[i].active) {
          stop(tabs[i]);
        }
      }
    }
  }
});

// Tab change listener
chrome.tabs.onActivated.addListener(function (info) {
  if (options.autopause && previous_tab != 0) {
    chrome.tabs.get(previous_tab, function (prev) {
      stop(prev);
    });
  }

  if (previous_tab === info.tab) {
    return;
  }

  previous_tab = info.tabId;

  chrome.tabs.get(info.tabId, function (tab) {
    if (options.autoresume) {
      resume(tab);
    }
  });
});

// Tab update listener
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (
    "status" in changeInfo &&
    changeInfo.status === "complete" &&
    !tab.active
  ) {
    stop(tab);
  }
});

// Window focus listener
chrome.windows.onFocusChanged.addListener(async function (window) {
  if (window !== previous_window) {
    if (
      options.focuspause &&
      state !== "locked" &&
      previous_window !== chrome.windows.WINDOW_ID_NONE
    ) {
      const tabsStop = await chrome.tabs.query({ windowId: previous_window });
      for (let i = 0; i < tabsStop.length; i++) {
        stop(tabsStop[i]);
      }
    }

    if (options.focusresume && window !== chrome.windows.WINDOW_ID_NONE) {
      const tabsResume = await chrome.tabs.query({ windowId: previous_window });
      for (let i = 0; i < tabsResume.length; i++) {
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
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (sender.tab === undefined || chrome.runtime.lastError) {
    return true;
  }

  if ("minimized" in request) {
    if (request.minimized && options.autopause) {
      stop(sender.tab);
    } else if (!request.minimized && options.autoresume) {
      resume(sender.tab);
    }
  }
  if ("visible" in request && options.scrollpause) {
    if (!request.visible) {
      stop(sender.tab);
    } else {
      resume(sender.tab);
    }
  }

  sendResponse({});
  return true;
});

// Listener for keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-extension") {
    options.disabled = !options.disabled;
    chrome.storage.sync.set({ disabled: options.disabled });
    refresh_settings();
  } else if (command === "toggle-play") {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      toggle(tabs[i]);
    }
  } else if (command === "toggle_mute") {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      toggle_mute(tabs[i]);
    }
  }
});

// Listener for computer idle/locked/active
chrome.idle.onStateChanged.addListener(async function (s) {
  state = s;
  const tabs = await chrome.tabs.query({ currentWindow: true });

  for (let i = 0; i < tabs.length; i++) {
    if (state === "locked" && options.lockpause) {
      stop(tabs[i]);
    } else if (state !== "locked" && options.lockresume) {
      if (!tabs[i].active && options.autopause) {
        continue;
      }
      resume(tabs[i]);
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    let execute = false;
    hosts.forEach(function (host) {
      const reg = host
        .replace(/[.+?^${}()|/[\]\\]/g, "\\$&")
        .replace("*", ".*");
      if (new RegExp(reg).test(tab.url) === true) {
        execute = true;
        return;
      }
    });

    if (execute) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["yt_auto_pause.js"],
      });
    }
  }
});
