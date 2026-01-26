if (window.autoPauseInjected !== true) {
  const env = chrome.runtime ? chrome : browser;
  window.autoPauseInjected = true;
  const manuallyPausedVideos = new WeakMap();
  let automaticallyPaused = false;

  let options = {
    autopause: true,
    autoresume: true,
    scrollpause: false,
    lockpause: true,
    lockresume: true,
    focuspause: false,
    focusresume: false,
    disabled: false,
    cursorTracking: false,
    manualPause: true,
    debugMode: false,
    disableOnFullscreen: true,
  };

  function debugLog(message) {
    if (options.debugMode) {
      console.log(`Video auto pause: ${message}`);
    }
  }

  // Initialize settings from storage
  refresh_settings();

  function refresh_settings() {
    env.storage.sync.get(Object.keys(options), function (result) {
      options = Object.assign(options, result);
      if (options.disabled === true) {
        options.autopause = false;
        options.autoresume = false;
        options.scrollpause = false;
        options.lockpause = false;
        options.lockresume = false;
        options.focuspause = false;
        options.focusresume = false;
        options.cursorTracking = false;
        options.debugMode = false;
        options.disableOnFullscreen = true;
      }
    });
  }

  env.storage.onChanged.addListener(async function (changes, namespace) {
    for (const key in changes) {
      debugLog(
        `Settings changed for key ${key} from ${changes[key].oldValue} to ${changes[key].newValue}`,
      );
      options[key] = changes[key].newValue;
    }

    if (!options.manualPause) {
      const videoElements = document.getElementsByTagName("video");
      for (const element of videoElements) {
        manuallyPausedVideos.delete(element);
      }
      automaticallyPaused = true;
    }

    if ("disabled" in changes) {
      refresh_settings();
    }
  });

  // Function to check if the cursor is near the edge of the window
  function isCursorNearEdge(event) {
    const threshold = 50; // pixels from the edge
    return (
      event.clientX < threshold ||
      event.clientX > window.innerWidth - threshold ||
      event.clientY < threshold ||
      event.clientY > window.innerHeight - threshold
    );
  }

  let cursorNearEdgeTimeout;
  let cursorOutsideWindow = false;

  // Listen for mousemove events
  window.addEventListener("mousemove", async function (event) {
    if (!options.cursorTracking) {
      return;
    }
    if (isCursorNearEdge(event)) {
      // If the cursor is near the edge, set a timeout
      if (!cursorNearEdgeTimeout) {
        cursorNearEdgeTimeout = setTimeout(function () {
          debugLog(`Cursor near window edge, sending message`);
          sendMessage({ cursorNearEdge: true });
          cursorNearEdgeTimeout = null;
        }, 200); // Wait for 200ms to infer user intention
      }
    } else {
      // If the cursor moves away from the edge, clear the timeout
      clearTimeout(cursorNearEdgeTimeout);
      cursorNearEdgeTimeout = null;
      if (!cursorOutsideWindow) {
        debugLog(`Cursor not near window edge, sending message`);
        sendMessage({ cursorNearEdge: false });
      }
    }
  });

  // Listen for mouse leaving the window
  document.addEventListener("mouseleave", function (event) {
    if (!options.cursorTracking) {
      return;
    }
    if (
      event.relatedTarget === null ||
      event.relatedTarget.nodeName === "HTML"
    ) {
      debugLog(`Cursor left the window, sending message`);
      cursorOutsideWindow = true;
      clearTimeout(cursorNearEdgeTimeout);
      cursorNearEdgeTimeout = null;
      sendMessage({ cursorNearEdge: true });
    }
  });

  // Listen for mouse entering the window
  document.addEventListener("mouseenter", function (_event) {
    if (!options.cursorTracking) {
      return;
    }
    if (cursorOutsideWindow) {
      debugLog(`Cursor entered the window, sending message`);
      cursorOutsideWindow = false;
      clearTimeout(cursorNearEdgeTimeout);
      cursorNearEdgeTimeout = null;
      sendMessage({ cursorNearEdge: false });
    }
  });

  // Send message to service worker
  function sendMessage(message) {
    if (!env.runtime?.id) {
      return;
    }

    if (env.runtime.lastError) {
      console.error(
        `Video Autopause error: ${env.runtime.lastError.toString()}`,
      );
      return;
    }

    debugLog(`Sending message ${JSON.stringify(message)}`);

    env.runtime.sendMessage(message, function () {
      void env.runtime.lastError;
    });
  }

  // Listen to visibilitychange event of the page
  document.addEventListener(
    "visibilitychange",
    function () {
      if (document.hidden !== undefined) {
        debugLog(`Document hidden, sending minimized ${document.hidden}`);
        sendMessage({ minimized: document.hidden });
      }
    },
    false,
  );

  const hasVideos = () => {
    return document.getElementsByTagName("video").length >= 1;
  };

  // Listen media commands from the service worker
  env.runtime.onMessage.addListener(
    async function (request, sender, sendResponse) {
      if (!("action" in request)) {
        return false;
      }
      debugLog(`Received message: ${JSON.stringify(request)}`);

      const videoElements = document.getElementsByTagName("video");
      sendMessage({ hasVideos: hasVideos() });

      if (document.fullscreenElement && options.disableOnFullscreen) {
        debugLog(`Document is in fullscreen mode, ignoring all commands`);
        return true;
      }

      const iframeElements = document.getElementsByTagName("iframe");

      for (const element of iframeElements) {
        const iframe = element;
        try {
          if (request.action === "stop") {
            iframe.contentWindow.postMessage(
              JSON.stringify({ event: "command", func: "pauseVideo" }),
              "*",
            );
          } else if (request.action === "resume") {
            iframe.contentWindow.postMessage(
              JSON.stringify({ event: "command", func: "playVideo" }),
              "*",
            );
          }
        } catch (e) {
          debugLog(e);
        }
      }

      for (const element of videoElements) {
        try {
          const video = element;
          const isManuallyPaused = manuallyPausedVideos.get(video);

          if (request.action === "stop" && !isManuallyPaused) {
            automaticallyPaused = true;
            video.pause();
          } else if (
            request.action === "resume" &&
            video.paused &&
            !isManuallyPaused
          ) {
            debugLog(
              `Attempting to resume video: paused=${video.paused}, manuallyPaused=${isManuallyPaused}`,
            );
            automaticallyPaused = false;
            if (!video.ended) {
              await video.play();
            }
          } else if (request.action === "resume") {
            debugLog(
              `Resume blocked: paused=${video.paused}, manuallyPaused=${isManuallyPaused}`,
            );
          } else if (request.action === "toggle_mute") {
            video.muted = !video.muted;
          } else if (request.action === "mute") {
            video.muted = true;
          } else if (request.action === "unmute") {
            video.muted = false;
          } else if (request.action === "toggle") {
            if (video.paused && !isManuallyPaused) {
              if (!video.ended) {
                await video.play();
              }
              automaticallyPaused = false;
            } else if (!isManuallyPaused) {
              video.pause();
              automaticallyPaused = true;
            }
          }
        } catch (e) {
          debugLog(e);
        }
      }
      sendResponse({});
      return true;
    },
  );

  function attachVideoListeners(videoElement, intersection_observer) {
    if (videoElement.dataset.autoPauseListenerAttached) {
      return;
    }
    videoElement.dataset.autoPauseListenerAttached = "true";

    intersection_observer.observe(videoElement);

    videoElement.addEventListener("pause", async (_e) => {
      debugLog(
        `Pause event: automaticallyPaused=${automaticallyPaused}, manualPause=${options.manualPause}`,
      );
      if (!automaticallyPaused && options.manualPause) {
        debugLog(`Manually paused video`);
        manuallyPausedVideos.set(videoElement, true);
        automaticallyPaused = false;
      }
    });

    videoElement.addEventListener("play", (_e) => {
      if (options.manualPause) {
        debugLog(`Manually resumed video`);
        manuallyPausedVideos.delete(videoElement);
      }
      automaticallyPaused = false;
    });
  }

  // Intersection observer for the video elements in page
  // can be used to determine when video goes out of viewport
  const intersection_observer = new IntersectionObserver(
    function (entries) {
      if (!options.scrollpause) {
        return;
      }
      for (const entry of entries) {
        if (entry.isIntersecting === true) {
          debugLog(`Video in viewport`);
          sendMessage({ visible: true });
        } else {
          debugLog(`Video scrolled out of viewport`);
          sendMessage({ visible: false });
        }
      }
    },
    { threshold: [0] },
  );

  // Function to observe all current video elements
  function observeExistingVideos() {
    let videoElements = document.getElementsByTagName("video");
    sendMessage({ hasVideos: hasVideos() });

    for (const element of videoElements) {
      attachVideoListeners(element, intersection_observer);
    }
  }

  // Initial observation when DOM is loaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeExistingVideos);
  } else {
    observeExistingVideos();
  }

  // Watch for dynamically added video elements
  const videoObserver = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.tagName === "VIDEO") {
          debugLog(`New video element detected`);
          attachVideoListeners(node, intersection_observer);
          sendMessage({ hasVideos: hasVideos() });
        } else if (node.getElementsByTagName) {
          const videos = node.getElementsByTagName("video");
          if (videos.length > 0) {
            debugLog(`New video elements detected in added node`);
            for (const element of videos) {
              attachVideoListeners(element, intersection_observer);
            }
            sendMessage({ hasVideos: hasVideos() });
          }
        }
      }
    }
  });

  // Start observing the document for video element additions
  videoObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
