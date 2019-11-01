var previous_tab = 0;
var autopause = true;
var autoresume = true;

function stop(tab) {
    if (tab !== undefined && tab.url !== undefined && tab.url.includes("youtube.com")) {
        chrome.tabs.executeScript(tab.id, {"file" : "stop.js"});
    }
}

function resume(tab) {
    if (tab !== undefined && tab.url !== undefined && tab.url.includes("youtube.com")) {
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
});

chrome.tabs.onActivated.addListener(function(info) { handle_tabs(info.tabId); });

chrome.windows.onFocusChanged.addListener(function() {
    if (autopause) {
        chrome.tabs.getCurrent(function(cur) { stop(cur); });
    }
});
