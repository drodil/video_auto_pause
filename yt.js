var previous_tab = 0;
var yt_tabs = [];
var autopause = true;
var autoresume = true;

function restore_options() {
    chrome.storage.sync.get({autopause : autopause, autoresume : autoresume}, function(items) {
        autopause = items.autopause;
        autoresume = items.autoresume;
    });
}

function stop(tabId) {
    chrome.tabs.executeScript(tabId, {
        "code" :
            "if(!document.querySelector('video').paused) { var evt = new KeyboardEvent('keydown', {'keyCode': 75, 'which': 75}); document.dispatchEvent(evt); }"
    });
}

function resume(tabId) {
    chrome.tabs.executeScript(tabId, {
        "code" :
            "if(document.querySelector('video').paused) { var evt = new KeyboardEvent('keydown', {'keyCode': 75, 'which': 75}); document.dispatchEvent(evt); }"
    });
}

function handle_tabs(tabId) {
    if (autopause) {
        chrome.tabs.get(previous_tab, function(prev) {
            if (!chrome.runtime.lastError) {
                if (prev.url !== undefined && prev.url.includes("youtube.com")) {
                    stop(prev.id);
                }
            }
        });
    }

    chrome.tabs.get(tabId, function(tab) {
        if (autoresume && tab.url !== undefined && tab.url.includes("youtube.com")) {
            resume(tab.id);
        }

        previous_tab = tab.id;
    });
}

chrome.tabs.onActivated.addListener(function(info) {
    restore_options();
    handle_tabs(info.tabId);
});

chrome.tabs.onRemoved.addListener(function(tabId, info) {
    var idx = yt_tabs.indexOf(tabId);
    if (idx > -1) {
        yt_tabs.splice(idx, 1);
    }
});
