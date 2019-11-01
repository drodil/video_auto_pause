var previous_tab = 0;
var autopause = true;
var autoresume = true;
var pausemin = true;
var minimized = false;

function is_yt_tab(tab) {
    return tab !== undefined && tab.url !== undefined && tab.url.includes("youtube.com");
}

function stop(tab) {
    if (is_yt_tab(tab)) {
        chrome.tabs.executeScript(tab.id, {"file" : "stop.js"});
    }
}

function resume(tab) {
    if (is_yt_tab(tab)) {
        chrome.tabs.executeScript(tab.id, {"file" : "resume.js"});
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
        if (autoresume) {
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
    if ('pausemin' in changes) {
        pausemin = changes.pausemin.newValue;
    }
});

chrome.tabs.onActivated.addListener(function(info) { handle_tabs(info.tabId); });

chrome.windows.onFocusChanged.addListener(function(info) {
    if (previous_tab != 0) {
        chrome.tabs.get(previous_tab, function(tab) {
            if (!tab.active && autopause && !chrome.runtime.lastError) {
                stop(tab);
            }
        });
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (!pausemin || previous_tab == 0) {
        return true;
    }
    chrome.windows.getCurrent(function(win) {
        if (win.state !== "minimized" && request.minimized) {
            request.minimized = false;
        }

        if (request.minimized) {
            chrome.tabs.query({}, function(tabs) { tabs.forEach(tab => { stop(tab); }); });
        } else if (!request.minimized) {
            chrome.tabs.get(previous_tab, function(prev) {
                if (!chrome.runtime.lastError) {
                     resume(prev);
                }
            });
        }
        minimized = request.minimized;
    });
    return true;
});
