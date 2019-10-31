var previous_tab = 0;
var autopause = true;
var autoresume = true;

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

chrome.storage.onChanged.addListener(function(changes, namespace) {
    if ('autoresume' in changes) {
        autoresume = changes.autoresume.newValue;
    }
    if ('autopause' in changes) {
        autopause = changes.autopause.newValue;
    }
});

chrome.tabs.onActivated.addListener(function(info) { handle_tabs(info.tabId); });
