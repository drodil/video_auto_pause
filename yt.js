var previous_tab = 0;
var previous_window = chrome.windows.WINDOW_ID_NONE;
var autopause = true;
var autoresume = true;
var lockpause = true;
var lockresume = true;
var focuspause = true;
var focusresume = true;
var scrollpause = false;
var disabled = false;
var state = "active";

refresh_settings();
function refresh_settings() {
  chrome.storage.sync.get(
    [
      "autopause",
      "autoresume",
      "scrollpause",
      "disabled",
      "lockpause",
      "lockresume",
      "focuspause",
      "focusresume",
    ],
    function (result) {
      if ("autopause" in result) {
        autopause = result.autopause;
      }
      if ("autoresume" in result) {
        autoresume = result.autoresume;
      }
      if ("lockpause" in result) {
        lockpause = result.lockpause;
      }
      if ("lockresume" in result) {
        lockresume = result.lockresume;
      }
      if ("focuspause" in result) {
        focuspause = result.focuspause;
      }
      if ("focusresume" in result) {
        focusresume = result.focusresume;
      }
      if ("scrollpause" in result) {
        scrollpause = result.scrollpause;
      }
      if ("disabled" in result) {
        disabled = result.disabled;
      }
      if (disabled === true) {
        autopause = false;
        autoresume = false;
        scrollpause = false;
        lockpause = false;
        lockresume = false;
        focuspause = false;
        focusresume = false;
      }
    }
  );
}

function sendMessage(tab, message) {
  if (!chrome.runtime.lastError) {
    chrome.tabs.sendMessage(tab.id, message, {}, function () {
      void chrome.runtime.lastError;
    });
  }
}

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

function handle_tabs(tabId) {
  if (autopause && previous_tab != 0) {
    chrome.tabs.get(previous_tab, function (prev) {
      if (!chrome.runtime.lastError) {
        stop(prev);
      }
    });
  }
  previous_tab = tabId;

  chrome.tabs.get(tabId, function (tab) {
    if (autoresume && !chrome.runtime.lastError) {
      resume(tab);
    }
  });
}

chrome.storage.onChanged.addListener(async function (changes, namespace) {
  if ("autopause" in changes) {
    autopause = changes.autopause.newValue;
  }

  if ("autoresume" in changes) {
    autoresume = changes.autoresume.newValue;
  }

  if ("scrollpause" in changes) {
    scrollpause = changes.scrollpause.newValue;
  }

  if ("lockpause" in changes) {
    lockpause = changes.lockpause.newValue;
  }

  if ("lockresume" in changes) {
    lockresume = changes.lockresume.newValue;
  }

  if ("focuspause" in changes) {
    focuspause = changes.focuspause.newValue;
  }

  if ("focusresume" in changes) {
    focusresume = changes.focusresume.newValue;
  }

  if ("disabled" in changes) {
    refresh_settings();
    disabled = changes.disabled.newValue;
    let tabs = await chrome.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (disabled === true) {
        resume(tabs[i]);
      } else {
        if (!tabs[i].active) {
          stop(tabs[i]);
        }
      }
    }
  }
});

chrome.tabs.onActivated.addListener(function (info) {
  handle_tabs(info.tabId);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (
    "status" in changeInfo &&
    changeInfo.status === "complete" &&
    !tab.active
  ) {
    stop(tab);
  }
});

chrome.windows.onFocusChanged.addListener(async function (window) {
  console.log(window, previous_window);
  if (window !== previous_window) {
    if (
      focuspause &&
      state !== "locked" &&
      previous_window !== chrome.windows.WINDOW_ID_NONE
    ) {
      let tabsStop = await chrome.tabs.query({ windowId: previous_window });
      for (let i = 0; i < tabsStop.length; i++) {
        stop(tabsStop[i]);
      }
    }

    if (focusresume && window !== chrome.windows.WINDOW_ID_NONE) {
      let tabsResume = await chrome.tabs.query({ windowId: window });
      for (let i = 0; i < tabsResume.length; i++) {
        if (!tabsResume[i].active && autopause) {
          continue;
        }
        resume(tabsResume[i]);
      }
    }

    previous_window = window;
  }
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (sender.tab === undefined || chrome.runtime.lastError) {
    return true;
  }

  if ("minimized" in request) {
    if (request.minimized && autopause) {
      stop(sender.tab);
    } else if (!request.minimized && autoresume) {
      resume(sender.tab);
    }
  }
  if ("visible" in request && scrollpause) {
    if (!request.visible) {
      stop(sender.tab);
    } else {
      resume(sender.tab);
    }
  }

  sendResponse({});
  return true;
});

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

chrome.idle.onStateChanged.addListener(async function (s) {
  state = s;
  let tabs = await chrome.tabs.query({ currentWindow: true });

  for (let i = 0; i < tabs.length; i++) {
    if (state === "locked" && lockpause) {
      stop(tabs[i]);
    } else if (state !== "locked" && lockresume) {
      if (!tabs[i].active && autopause) {
        continue;
      }
      resume(tabs[i]);
    }
  }
});

chrome.runtime.onInstalled.addListener(installScript);

async function installScript(details) {
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
}
