document.addEventListener("visibilitychange", function() {
    if (document.hidden !== undefined && typeof chrome.runtime !== "undefined") {
        chrome.runtime.sendMessage({minimized : document.hidden});
    }
}, false);
