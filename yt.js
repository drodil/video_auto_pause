var previous_tab = 0;
var yt_tabs = [];

function stop_resume(tabId) {
    chrome.tabs.executeScript(tabId, {
        "code" :
            "var evt = new KeyboardEvent('keydown', {'keyCode': 75, 'which': 75}); document.dispatchEvent(evt);"
    });
}

function handle_tabs(tabId) {
    chrome.tabs.get(tabId, function(tab) {
        chrome.tabs.get(previous_tab, function(prev) {
            if (!chrome.runtime.lastError) {
                if (prev !== undefined && prev.url !== undefined &&
                    prev.url.includes("youtube.com")) {
                    stop_resume(prev.id);
                }
            }
        });

        if (tab.url !== undefined && tab.url.includes("youtube.com")) {
            stop_resume(tab.id);
        }

        previous_tab = tab.id;
    });
}

chrome.tabs.onActivated.addListener(function(info) { handle_tabs(info.tabId); });
chrome.tabs.onRemoved.addListener(function(tabId, info) {
    var idx = yt_tabs.indexOf(tabId);
    if (idx > -1) {
        yt_tabs.splice(idx, 1);
    }
});
