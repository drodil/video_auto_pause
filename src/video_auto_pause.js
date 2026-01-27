if (window.autoPauseInjected !== true) {
  const env = chrome.runtime ? chrome : browser;
  window.autoPauseInjected = true;
  const manuallyPausedVideos = new WeakMap();
  const detectedVideos = new Set();
  let automaticallyPaused = false;

  let options = {
    autopause: true,
    autoresume: true,
    muteVideo: false,
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
    excludedDomains: [],
    includedDomains: [],
    audioFading: false,
    fadeDuration: 200,
    showPipButton: false,
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
        options.muteVideo = false;
        options.scrollpause = false;
        options.lockpause = false;
        options.lockresume = false;
        options.focuspause = false;
        options.focusresume = false;
        options.cursorTracking = false;
        options.debugMode = false;
        options.disableOnFullscreen = true;
        options.excludedDomains = [];
        options.includedDomains = [];
        options.audioFading = false;
        options.fadeDuration = 200;
        options.showPipButton = false;
      }
      toggleCursorTracking(options.cursorTracking);
    });
  }

  function onMouseMove(event) {
    if (isCursorNearEdge(event)) {
      if (!cursorNearEdgeTimeout) {
        cursorNearEdgeTimeout = setTimeout(function () {
          debugLog(`Cursor near window edge, sending message`);
          sendMessage({ cursorNearEdge: true });
          cursorNearEdgeTimeout = null;
        }, 200);
      }
    } else {
      clearTimeout(cursorNearEdgeTimeout);
      cursorNearEdgeTimeout = null;
      if (!cursorOutsideWindow) {
        debugLog(`Cursor not near window edge, sending message`);
        sendMessage({ cursorNearEdge: false });
      }
    }
  }

  function onMouseLeave(event) {
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
  }

  function onMouseEnter(_event) {
    if (cursorOutsideWindow) {
      debugLog(`Cursor entered the window, sending message`);
      cursorOutsideWindow = false;
      clearTimeout(cursorNearEdgeTimeout);
      cursorNearEdgeTimeout = null;
      sendMessage({ cursorNearEdge: false });
    }
  }

  let cursorTrackingEnabled = false;
  function toggleCursorTracking(enable) {
    if (enable && !cursorTrackingEnabled) {
      debugLog("Enabling cursor tracking listeners");
      window.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseleave", onMouseLeave);
      document.addEventListener("mouseenter", onMouseEnter);
      cursorTrackingEnabled = true;
    } else if (!enable && cursorTrackingEnabled) {
      debugLog("Disabling cursor tracking listeners");
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseleave", onMouseLeave);
      document.removeEventListener("mouseenter", onMouseEnter);
      cursorTrackingEnabled = false;
      clearTimeout(cursorNearEdgeTimeout);
      cursorNearEdgeTimeout = null;
    }
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

    if ("showPipButton" in changes) {
      togglePipButtons();
    }

    if ("disabled" in changes || "cursorTracking" in changes) {
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

  window.addEventListener("blur", function () {
    debugLog("Window blur");
    sendMessage({ windowFocused: false });
  });

  window.addEventListener("focus", function () {
    debugLog("Window focus");
    sendMessage({ windowFocused: true });
  });

  const hasVideos = () => {
    return detectedVideos.size > 0;
  };

  const activeFades = new WeakMap();
  const originalVolumes = new WeakMap();

  const fadeAudio = (video, targetVolume, duration) => {
    if (!options.audioFading) return Promise.resolve();

    debugLog(`Fading audio for ${video} to ${targetVolume} over ${duration}ms`);
    if (activeFades.has(video)) {
      const activeFade = activeFades.get(video);
      activeFade.cancelled = true;
      activeFades.delete(video);
    }

    const fadeState = {
      cancelled: false,
      startTime: performance.now(),
      targetVolume: targetVolume,
    };
    activeFades.set(video, fadeState);

    return new Promise((resolve) => {
      const startVolume = video.volume;
      const volumeChange = targetVolume - startVolume;
      const startTime = fadeState.startTime;

      const animate = () => {
        if (fadeState.cancelled) {
          return;
        }

        const currentTime = performance.now();
        const elapsed = currentTime - startTime;

        if (elapsed >= duration) {
          video.volume = targetVolume;
          activeFades.delete(video);
          resolve();
          return;
        }

        const newVolume = startVolume + volumeChange * (elapsed / duration);
        video.volume = Math.max(0, Math.min(1, newVolume));

        if (document.hidden) {
          setTimeout(animate, 16);
        } else {
          requestAnimationFrame(animate);
        }
      };

      if (document.hidden) {
        setTimeout(animate, 16);
      } else {
        requestAnimationFrame(animate);
      }
    });
  };

  const propagateToIframes = (action) => {
    const iframeElements = document.getElementsByTagName("iframe");
    for (const element of iframeElements) {
      try {
        if (action === "stop") {
          element.contentWindow.postMessage(
            JSON.stringify({ event: "command", func: "pauseVideo" }),
            "*",
          );
        } else if (action === "resume") {
          element.contentWindow.postMessage(
            JSON.stringify({ event: "command", func: "playVideo" }),
            "*",
          );
        }
      } catch (e) {
        debugLog(e);
      }
    }
  };

  const pauseVideo = async (video) => {
    if (document.pictureInPictureElement === video) {
      debugLog(`Ignoring stop command for ${video} because it is in PiP`);
      return;
    }

    automaticallyPaused = true;
    if (options.audioFading && !video.paused) {
      if (!originalVolumes.has(video)) {
        originalVolumes.set(video, video.volume);
      }

      await fadeAudio(video, 0, options.fadeDuration);
      video.pause();

      if (options.fadeDuration > 1000) {
        video.currentTime = Math.max(
          0,
          video.currentTime - options.fadeDuration / 1000,
        );
      }

      if (originalVolumes.has(video)) {
        video.volume = originalVolumes.get(video);
        originalVolumes.delete(video);
      }
    } else {
      video.pause();
    }
  };

  const resumeVideo = async (video) => {
    debugLog(`Attempting to resume video: paused=${video.paused}`);
    automaticallyPaused = false;

    let targetVolume = video.volume;
    if (originalVolumes.has(video)) {
      targetVolume = originalVolumes.get(video);
      originalVolumes.delete(video);
    } else if (video.volume === 0 && !activeFades.has(video)) {
      targetVolume = 1.0;
    }

    if (!video.ended) {
      if (options.audioFading) {
        if (video.paused) {
          video.volume = 0;
        }

        await video.play();
        await fadeAudio(video, targetVolume, options.fadeDuration);
      } else {
        await video.play();
      }
    }
  };

  const handleMuteAction = async (video, action) => {
    if (action === "toggle_mute") {
      video.muted = !video.muted;
    } else if (action === "mute" && !video.muted) {
      automaticallyPaused = true;
      if (options.audioFading) {
        if (!originalVolumes.has(video)) {
          originalVolumes.set(video, video.volume);
        }
        await fadeAudio(video, 0, options.fadeDuration);
        video.muted = true;
        if (originalVolumes.has(video)) {
          video.volume = originalVolumes.get(video);
          originalVolumes.delete(video);
        }
      } else {
        video.muted = true;
      }
    } else if (action === "unmute" && video.muted) {
      automaticallyPaused = false;
      let targetVolume = video.volume;
      if (originalVolumes.has(video)) {
        targetVolume = originalVolumes.get(video);
        originalVolumes.delete(video);
      } else if (video.volume === 0 && !activeFades.has(video)) {
        targetVolume = 1.0;
      }

      if (options.audioFading) {
        video.volume = 0;
        video.muted = false;
        await fadeAudio(video, targetVolume, options.fadeDuration);
      } else {
        video.muted = false;
      }
    }
  };

  const handleSpeedAction = (video, command) => {
    let newRate = video.playbackRate;
    if (command === "speed-up") {
      newRate += 0.25;
    } else if (command === "speed-down") {
      newRate = Math.max(0.25, newRate - 0.25);
    } else if (command === "speed-reset") {
      newRate = 1.0;
    }
    video.playbackRate = newRate;
    showToast(`Speed: ${newRate}x`);
  };

  const handleVideoAction = async (video, request) => {
    const isManuallyPaused = manuallyPausedVideos.get(video);

    switch (request.action) {
      case "stop":
        if (!isManuallyPaused) {
          await pauseVideo(video);
        }
        break;
      case "resume":
        if ((video.paused || activeFades.has(video)) && !isManuallyPaused) {
          await resumeVideo(video);
        } else {
          debugLog(
            `Resume blocked: paused=${video.paused}, manuallyPaused=${isManuallyPaused}`,
          );
        }
        break;
      case "mute":
      case "unmute":
      case "toggle_mute":
        await handleMuteAction(video, request.action);
        break;
      case "toggle":
        if (video.paused && !isManuallyPaused) {
          if (!video.ended) {
            await video.play();
          }
          automaticallyPaused = false;
        } else if (!isManuallyPaused) {
          video.pause();
          automaticallyPaused = true;
        }
        break;
      case "speed":
        handleSpeedAction(video, request.command);
        break;
      case "check":
        break;
      default:
        debugLog(`Unknown action: ${request.action}`);
        break;
    }
  };

  env.runtime.onMessage.addListener(
    async function (request, sender, sendResponse) {
      if (!("action" in request)) {
        return false;
      }
      debugLog(`Received message: ${JSON.stringify(request)}`);

      if (request.action === "check") {
        sendMessage({ hasVideos: hasVideos() });
        sendResponse({});
        return true;
      }

      if (document.fullscreenElement && options.disableOnFullscreen) {
        debugLog(`Document is in fullscreen mode, ignoring all commands`);
        return true;
      }

      propagateToIframes(request.action);

      const videoElements = document.getElementsByTagName("video");
      for (const video of videoElements) {
        try {
          await handleVideoAction(video, request);
        } catch (e) {
          debugLog(e);
        }
      }
      sendResponse({});
      return true;
    },
  );

  function attachVideoListeners(videoElement, intersection_observer) {
    detectedVideos.add(videoElement);

    if (videoElement.dataset.autoPauseListenerAttached) {
      return;
    }
    videoElement.dataset.autoPauseListenerAttached = "true";

    if (options.showPipButton) {
      injectPipButton(videoElement);
    }

    intersection_observer.observe(videoElement);

    videoElement.addEventListener("pause", async (_e) => {
      debugLog(
        `Pause event: automaticallyPaused=${automaticallyPaused}, manualPause=${options.manualPause}`,
      );

      if (videoElement.dataset.returningFromPiP === "true") {
        debugLog("Ignoring pause event during PiP exit and enforcing playback");
        if (!document.hidden) {
          videoElement
            .play()
            .catch((e) => debugLog(`Failed to auto-resume from PiP: ${e}`));
        }
        return;
      }

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
    });
  }

  function injectPipButton(video) {
    if (
      video.parentElement &&
      video.parentElement.querySelector(".vap-pip-btn")
    )
      return;

    if (!document.pictureInPictureEnabled || video.disablePictureInPicture)
      return;

    const btn = document.createElement("button");
    btn.className = "vap-pip-btn";
    btn.title = env.i18n.getMessage("pipTitle");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/></svg>';

    Object.assign(btn.style, {
      position: "absolute",
      top: "15px",
      left: "15px",
      zIndex: "2147483647",
      background: "rgba(0, 0, 0, 0.7)",
      border: "1px solid rgba(255, 255, 255, 0.2)",
      borderRadius: "8px",
      cursor: "pointer",
      padding: "8px",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "auto",
      boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
    });

    let hideTimeout;
    const showBtn = () => {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      btn.style.display = "flex";
    };
    const hideBtn = () => {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
      }
      hideTimeout = setTimeout(() => {
        if (!btn.matches(":hover") && !video.matches(":hover")) {
          btn.style.display = "none";
        }
        hideTimeout = null;
      }, 2000);
    };

    // Try to find a player container (especially for YouTube)
    let container = video.parentElement;
    if (container && container.classList.contains("html5-video-container")) {
      container = container.parentElement;
    }

    if (!container) return;

    container.addEventListener("mouseenter", showBtn);
    container.addEventListener("mouseleave", hideBtn);
    container.addEventListener("mousemove", showBtn);
    btn.addEventListener("mouseenter", showBtn);
    btn.addEventListener("mouseleave", hideBtn);

    video.addEventListener("enterpictureinpicture", () => {
      debugLog("Entered Picture-in-Picture");
      btn.style.display = "none";
    });

    video.addEventListener("leavepictureinpicture", () => {
      debugLog("Left Picture-in-Picture");
      video.dataset.returningFromPiP = "true";
      setTimeout(() => {
        delete video.dataset.returningFromPiP;
      }, 1000);

      if (!video.paused) {
        manuallyPausedVideos.delete(video);
      }
    });

    btn.addEventListener("click", async (e) => {
      debugLog("PiP button clicked");
      e.preventDefault();
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        console.error("PiP failed", err);
      }
    });

    if (window.getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(btn);
  }

  function togglePipButtons() {
    const videos = document.getElementsByTagName("video");
    if (options.showPipButton) {
      for (const video of videos) {
        injectPipButton(video);
      }
    } else {
      const btns = document.querySelectorAll(".vap-pip-btn");
      btns.forEach((btn) => btn.remove());
    }
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
  function observeExistingVideos(retries = 5) {
    let videoElements = document.getElementsByTagName("video");
    const found = videoElements.length > 0;

    if (found) {
      sendMessage({ hasVideos: true });
      for (const element of videoElements) {
        attachVideoListeners(element, intersection_observer);
      }
    } else {
      sendMessage({ hasVideos: hasVideos() });
      if (retries > 0) {
        setTimeout(() => observeExistingVideos(retries - 1), 1000);
      }
    }
  }

  // Initial observation when DOM is loaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      observeExistingVideos(),
    );
  } else {
    observeExistingVideos();
  }

  function showToast(message) {
    let container = document.getElementById("vap-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "vap-toast-container";
      Object.assign(container.style, {
        position: "fixed",
        top: "20px",
        right: "20px",
        zIndex: "999999",
        pointerEvents: "none",
      });
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.textContent = message;
    Object.assign(toast.style, {
      background: "rgba(0, 0, 0, 0.7)",
      color: "white",
      padding: "8px 12px",
      marginBottom: "8px",
      borderRadius: "4px",
      fontFamily: "sans-serif",
      fontSize: "14px",
      boxShadow: "0 2px 5px rgba(0,0,0,0.3)",
      opacity: "0",
      transition: "opacity 0.3s ease-in-out",
    });

    container.appendChild(toast);

    void toast.offsetWidth;

    toast.style.opacity = "1";

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => {
        toast.remove();
        if (container.childNodes.length === 0) {
          container.remove();
        }
      }, 300);
    }, 1000);
  }

  // Watch for dynamically added video elements
  const videoObserver = new MutationObserver(function (mutations) {
    let changed = false;
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node.tagName === "VIDEO") {
          detectedVideos.delete(node);
          changed = true;
        } else if (node.getElementsByTagName) {
          const videos = node.getElementsByTagName("video");
          for (const video of videos) {
            detectedVideos.delete(video);
          }
          if (videos.length > 0) changed = true;
        }
      }

      for (const node of mutation.addedNodes) {
        if (node.tagName === "VIDEO") {
          debugLog(`New video element detected`);
          attachVideoListeners(node, intersection_observer);
          changed = true;
        } else if (node.getElementsByTagName) {
          const videos = node.getElementsByTagName("video");
          if (videos.length > 0) {
            debugLog(`New video elements detected in added node`);
            for (const element of videos) {
              attachVideoListeners(element, intersection_observer);
            }
            changed = true;
          }
        }
        if (node.shadowRoot) {
          const videos = node.shadowRoot.querySelectorAll("video");
          if (videos.length > 0) {
            for (const video of videos) {
              attachVideoListeners(video, intersection_observer);
            }
            changed = true;
          }
        }
      }
    }

    if (changed) {
      sendMessage({ hasVideos: hasVideos() });
    }
  });

  // Start observing the document for video element additions
  videoObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
