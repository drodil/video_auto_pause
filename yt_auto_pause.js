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

var intersection_observer = new IntersectionObserver(
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

chrome.runtime.onMessage.addListener(async function (
  request,
  sender,
  sendResponse
) {
  if (!("action" in request)) {
    return false;
  }
  var videoElements = document.querySelectorAll("video");

  for (i = 0; i < videoElements.length; i++) {
    if (request.action === "stop" && !videoElements[i].paused) {
      videoElements[i].pause();
    } else if (request.action === "resume" && videoElements[i].paused) {
      await videoElements[i].play();
    } else if (request.action === "toggle_mute") {
      videoElements[i].muted = !videoElements[i].muted;
    } else if (request.action === "mute") {
      videoElements[i].muted = true;
    } else if (request.action === "unmute") {
      videoElements[i].muted = false;
    } else if (request.action === "toggle") {
      if (videoElements[i].paused) {
        await videoElements[i].play();
      } else {
        videoElements[i].pause();
      }
    }
  }
  sendResponse({});
  return true;
});
