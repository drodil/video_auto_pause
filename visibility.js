document.addEventListener("visibilitychange", function() {
    if (document.hidden !== undefined) {
        chrome.runtime.sendMessage({minimized : document.hidden});
    }
}, false);
