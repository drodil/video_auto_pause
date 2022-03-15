function sendMessage(message) {
  if (!chrome.runtime.lastError) {
    chrome.runtime.sendMessage(message, function () {
      void chrome.runtime.lastError;
    });
  }
}

document.addEventListener(
  "visibilitychange",
  function () {
    if (document.hidden !== undefined) {
      sendMessage({ minimized: document.hidden });
    }
  },
  false
);

var intersection_observer = new IntersectionObserver(
  function (entries) {
    if (entries[0].isIntersecting === true) {
      sendMessage({ visible: true });
    } else {
      sendMessage({ visible: false });
    }
  },
  { threshold: [0] }
);

window.addEventListener("load", function (e) {
  videoElements = document.querySelectorAll("video");
  for (i = 0; i < videoElements.length; i++) {
    intersection_observer.observe(videoElements[i]);
  }
});

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
