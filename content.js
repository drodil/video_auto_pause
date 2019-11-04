document.addEventListener("visibilitychange", function() {
    if (document.hidden !== undefined) {
        chrome.runtime.sendMessage({minimized : document.hidden},
                                   function() { void chrome.runtime.lastError; });
    }
}, false);

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (!('action' in request)) {
        return;
    }

    var videoElement = document.querySelector('video');
    if (videoElement === null) {
        return;
    }

    if (request.action === 'stop' && !videoElement.paused) {
        videoElement.pause();

    } else if (request.action === 'resume' && videoElement.paused) {
        videoElement.play();
    }
});
