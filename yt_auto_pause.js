// Send message to service worker
function sendMessage(message) {
  if (!chrome.runtime.lastError) {
    chrome.runtime.sendMessage(message, function () {
      void chrome.runtime.lastError;
    });
  }
}

// Listen to visibilitychange event of the page
document.addEventListener(
  "visibilitychange",
  function () {
    if (document.hidden !== undefined) {
      sendMessage({ minimized: document.hidden });
    }
  },
  false
);

// Intersection observer for the video elements in page
// can be used to determine when video goes out of viewport
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

// Start observing video elements
window.addEventListener("load", function (e) {
  videoElements = document.querySelectorAll("video");
  for (i = 0; i < videoElements.length; i++) {
    intersection_observer.observe(videoElements[i]);
  }
});

// Listen media commands from the service worker
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
