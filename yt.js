var previous_tab = 0;
var autopause = true;
var autoresume = true;

function get_shortcut_key(tab) {
    if (tab === undefined || tab.url === undefined) {
        return undefined;
    }

    if (tab.url.includes("youtube.com")) {
        return 75;
    }

    // Default to space
    return 32;
}

function stop(tab) {
    var key = get_shortcut_key(tab);
    if (key === undefined) {
        return;
    }

    chrome.tabs.sendMessage(tab.id, {'action' : 'stop'});
}

function resume(tab) {
    var key = get_shortcut_key(tab);
    if (key === undefined) {
        return;
    }

    chrome.tabs.sendMessage(tab.id, {'action' : 'resume'});
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

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if ('status' in changeInfo && changeInfo.status === 'complete' && !tab.active) {
        stop(tab);
    }
});

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
