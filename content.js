document.addEventListener(
  "visibilitychange",
  function () {
    if (document.hidden !== undefined) {
      chrome.runtime.sendMessage({ minimized: document.hidden }, function () {
        void chrome.runtime.lastError;
      });
    }
  },
  false
);

var observer = new IntersectionObserver(
  function (entries) {
    if (entries[0].isIntersecting === true) {
      chrome.runtime.sendMessage({ visible: true }, function () {
        void chrome.runtime.lastError;
      });
    } else {
      chrome.runtime.sendMessage({ visible: false }, function () {
        void chrome.runtime.lastError;
      });
    }
  },
  { threshold: [0] }
);

document.onload = function (e) {
  videoElements = query.querySelectorAll("video");
  for (i = 0; i < videoElements.length; i++) {
    observer.observe(videoElements[i]);
  }
};

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (!("action" in request)) {
    return false;
  }

  var videoElements = document.querySelectorAll("video");

  for (i = 0; i < videoElements.length; i++) {
    if (request.action === "stop" && !videoElements[i].paused) {
      videoElements[i].pause();
    } else if (request.action === "resume" && videoElements[i].paused) {
      videoElements[i].play();
    }
  }
  sendResponse({});
  return true;
});
