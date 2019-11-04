var previous_tab = 0;
var autopause = true;
var autoresume = true;

function is_yt_tab(tab) {
    return tab !== undefined && tab.url !== undefined && tab.url.includes("youtube.com");
}

function stop(tab) {
    if (is_yt_tab(tab)) {
        chrome.tabs.executeScript(tab.id, {"file" : "stop.js"},
                                  function() { void chrome.runtime.lastError; });
    }
}

function resume(tab) {
    if (is_yt_tab(tab)) {
        chrome.tabs.executeScript(tab.id, {"file" : "resume.js"},
                                  function() { void chrome.runtime.lastError; });
    }
}

function handle_tabs(tabId) {
    if (autopause && previous_tab != 0) {
        chrome.tabs.get(previous_tab, function(prev) {
            if (!chrome.runtime.lastError) {
                stop(prev);
            }
        });
    }
    previous_tab = tabId;

    chrome.tabs.get(tabId, function(tab) {
        if (autoresume && !chrome.runtime.lastError) {
            resume(tab);
        }
    });
}

chrome.storage.onChanged.addListener(function(changes, namespace) {
    if ('autoresume' in changes) {
        autoresume = changes.autoresume.newValue;
    }
    if ('autopause' in changes) {
        autopause = changes.autopause.newValue;
    }
});

chrome.tabs.onActivated.addListener(function(info) { handle_tabs(info.tabId); });

chrome.windows.onFocusChanged.addListener(function(info) {
    if (previous_tab != 0) {
        chrome.tabs.get(previous_tab, function(tab) {
            if (tab === undefined || chrome.runtime.lastError) {
                return;
            }
            if (!tab.active && autopause) {
                stop(tab);
            }
        });
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (sender.tab === undefined || chrome.runtime.lastError) {
        return true;
    }

    if (request.minimized && autopause) {
        chrome.tabs.get(sender.tab.id, function(tab) {
            if (!chrome.runtime.lastError) {
                stop(sender.tab);
            }
        });
    } else if (!request.minimized && autoresume) {
        chrome.tabs.get(sender.tab.id, function(tab) {
            if (!chrome.runtime.lastError) {
                resume(sender.tab);
            }
        });
    }

    return true;
});
