document.addEventListener("visibilitychange", function() {
    if (document.hidden !== undefined) {
        chrome.runtime.sendMessage({minimized : document.hidden},
                                   function() { void chrome.runtime.lastError; });
    }
}, false);

var observer = new IntersectionObserver(function(entries) {
    if(entries[0].isIntersecting === true) {
        chrome.runtime.sendMessage({visible: true}, function() { void chrome.runtime.lastError;  })
    } else {
        chrome.runtime.sendMessage({visible: false}, function() { void chrome.runtime.lastError;  })
    }
}, {threshold: [0]});

observer.observe(document.querySelector('video'));

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
