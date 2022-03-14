var previous_tab = 0;
var autopause = true;
var autoresume = true;
var scrollpause = false;
var toggled = false;
refresh_settings();

function refresh_settings() {
  chrome.storage.sync.get(
    ["autopause", "autoresume", "scrollpause", "toggled"],
    function (result) {
      if ("autopause" in result) {
        autopause = result.autopause;
      }
      if ("autoresume" in result) {
        autoresume = result.autoresume;
      }
      if ("scrollpause" in result) {
        scrollpause = result.scrollpause;
      }
      if ("toggled" in result && result.toggled === true) {
        autopause = false;
        autoresume = false;
        scrollpause = false;
        toggled = result.toggled;
      }
    }
  );
}

function stop(tab) {
  chrome.tabs.sendMessage(tab.id, { action: "stop" });
}

function resume(tab) {
  chrome.tabs.sendMessage(tab.id, { action: "resume" });
}

function handle_tabs(tabId) {
  refresh_settings();
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

chrome.storage.onChanged.addListener(function (changes, namespace) {
  if ("autoresume" in changes) {
    autoresume = changes.autoresume.newValue;
  }
  if ("autopause" in changes) {
    autopause = changes.autopause.newValue;
  }
  if ("scrollpause" in changes) {
    scrollpause = changes.scrollpause.newValue;
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

chrome.windows.onFocusChanged.addListener(function (info) {
  refresh_settings();
  if (previous_tab != 0) {
    chrome.tabs.get(previous_tab, function (tab) {
      if (tab === undefined || chrome.runtime.lastError) {
        return;
      }
      if (!tab.active && autopause) {
        stop(tab);
      }
    });
  }
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (sender.tab === undefined || chrome.runtime.lastError) {
    return true;
  }

  refresh_settings();
  if ("minimized" in request) {
    if (request.minimized && autopause) {
      chrome.tabs.get(sender.tab.id, function (tab) {
        if (!chrome.runtime.lastError) {
          stop(sender.tab);
        }
      });
    } else if (!request.minimized && autoresume) {
      chrome.tabs.get(sender.tab.id, function (tab) {
        if (!chrome.runtime.lastError) {
          resume(sender.tab);
        }
      });
    }
  }
  if ("visible" in request && scrollpause) {
    if (!request.visible) {
      chrome.tabs.get(sender.tab.id, function (tab) {
        if (!chrome.runtime.lastError) {
          stop(sender.tab);
        }
      });
    } else {
      chrome.tabs.get(sender.tab.id, function (tab) {
        if (!chrome.runtime.lastError) {
          resume(sender.tab);
        }
      });
    }
  }

  sendResponse({});
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-auto-pause") {
    toggled = !toggled;
    chrome.storage.sync.set({ toggled: toggled });
    refresh_settings();
  }
});

async function getTabs() {
  let queryOptions = { currentWindow: true };
  return await chrome.tabs.query(queryOptions);
}

chrome.runtime.onInstalled.addListener(installScript);

async function installScript(details) {
  let tabs = await getTabs();
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
