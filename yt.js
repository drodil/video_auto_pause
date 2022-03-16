// Previous tab and window numbers
var previous_tab = 0;
var previous_window = chrome.windows.WINDOW_ID_NONE;
// Computer state
var state = "active";
// Default options
var options = {
  autopause: true,
  autoresume: true,
  scrollpause: false,
  lockpause: true,
  lockresume: true,
  focuspause: false,
  focusresume: false,
  disabled: false,
};

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
    }
  });
}

// Functionality to send messages to tabs
function sendMessage(tab, message) {
  if (!chrome.runtime.lastError) {
    chrome.tabs.sendMessage(tab.id, message, {}, function () {
      void chrome.runtime.lastError;
    });
  }
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
  for (var key in changes) {
    options[key] = changes[key].newValue;
  }

  if ("disabled" in changes) {
    refresh_settings();
    let tabs = await chrome.tabs.query({ currentWindow: true });
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
      let tabsStop = await chrome.tabs.query({ windowId: previous_window });
      for (let i = 0; i < tabsStop.length; i++) {
        stop(tabsStop[i]);
      }
    }

    if (options.focusresume && window !== chrome.windows.WINDOW_ID_NONE) {
      let tabsResume = await chrome.tabs.query({ windowId: window });
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
    disabled = !disabled;
    chrome.storage.sync.set({ disabled: disabled });
    refresh_settings();
  } else if (command === "toggle-play") {
    let tabs = await chrome.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      toggle(tabs[i]);
    }
  } else if (command === "toggle_mute") {
    let tabs = await chrome.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      toggle_mute(tabs[i]);
    }
  }
});

// Listener for computer idle/locked/active
chrome.idle.onStateChanged.addListener(async function (s) {
  state = s;
  let tabs = await chrome.tabs.query({ currentWindow: true });

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

// Installer
chrome.runtime.onInstalled.addListener(async function installScript(details) {
  let tabs = await chrome.tabs.query({ currentWindow: true });
  let window = await chrome.windows.getCurrent();
  previous_window = window.id;
  let contentFiles = chrome.runtime.getManifest().content_scripts[0].js;
  let matches = chrome.runtime.getManifest().content_scripts[0].matches;

  for (let index = 0; index < tabs.length; index++) {
    let execute = false;
    matches.forEach(function (match) {
      let reg = match.replace(/[.+?^${}()|/[\]\\]/g, "\\$&").replace("*", ".*");
      if (new RegExp(reg).test(tabs[index].url) === true) {
        execute = true;
        return;
      }
    });

    if (execute) {
      try {
        chrome.scripting.executeScript({
          target: { tabId: tabs[index].id },
          files: contentFiles,
        });
      } catch (e) {}
    }
  }
});
