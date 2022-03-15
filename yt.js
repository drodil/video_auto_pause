var previous_tab = 0;
var autopause = true;
var autoresume = true;
var scrollpause = false;
var disabled = false;

refresh_settings();
function refresh_settings() {
  chrome.storage.sync.get(
    ["autopause", "autoresume", "scrollpause", "disabled"],
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
      if ("disabled" in result) {
        disabled = result.disabled;
      }
      if (disabled === true) {
        autopause = false;
        autoresume = false;
        scrollpause = false;
      }
    }
  );
}

function stop(tab) {
  chrome.tabs.sendMessage(tab.id, { action: "stop" }, {}, function () {
    void chrome.runtime.lastError;
  });
}

function resume(tab) {
  chrome.tabs.sendMessage(tab.id, { action: "resume" }, {}, function () {
    void chrome.runtime.lastError;
  });
}

function toggle(tab) {
  chrome.tabs.sendMessage(tab.id, { action: "toggle" }, {}, function () {
    void chrome.runtime.lastError;
  });
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

  if ("disabled" in changes) {
    refresh_settings();
    disabled = changes.disabled.newValue;
    let tabs = await chrome.tabs.query({ currentWindow: true });
    for (let i = 0; i < tabs.length; i++) {
      if (disabled === true) {
        resume(tabs[i]);
      } else {
        if (!tabs[i].active && autopause) {
          stop(tabs[i]);
        } else if (tabs[i].active && autoresume) {
          resume(tabs[i]);
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

chrome.windows.onFocusChanged.addListener(function (info) {
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
  }
});

chrome.runtime.onInstalled.addListener(installScript);

async function installScript(details) {
  let tabs = await chrome.tabs.query({ currentWindow: true });
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
