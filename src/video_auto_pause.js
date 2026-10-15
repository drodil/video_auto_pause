if (window.autoPauseInjected !== true) {
  const env = chrome.runtime ? chrome : browser;
  const DEFAULT_OPTIONS = globalThis.VAP_DEFAULT_OPTIONS;
  window.autoPauseInjected = true;
  const manuallyPausedVideos = new WeakMap();
  const detectedVideos = new Set();
  const detectedAudio = new Set();
  const extensionPausedVideos = new WeakSet();
  const extensionInitiatedPlays = new WeakSet();
  const automaticallyPausedVideos = new WeakSet();
  const extensionMutedVideos = new WeakMap();
  const scheduledActions = new WeakMap();
  const observedRoots = new WeakSet();
  const observedMedia = new WeakSet();
  const shadowHosts = new Set();
  const visibleVideos = new Set();
  let videoObserver;
  let lastVisibility = null;
  let userInteracted = false;
  let options = { ...DEFAULT_OPTIONS };

  function recordUserInteraction(event) {
    if (!event.isTrusted) {
      return;
    }
    userInteracted = true;
    document.removeEventListener("pointerdown", recordUserInteraction, true);
    document.removeEventListener("keydown", recordUserInteraction, true);
  }

  document.addEventListener("pointerdown", recordUserInteraction, true);
  document.addEventListener("keydown", recordUserInteraction, true);

  function debugLog(message) {
    if (options.debugMode) {
      console.log(`Video auto pause: ${message}`);
    }
  }

  async function refresh_settings() {
    const stored = await env.storage.sync.get(DEFAULT_OPTIONS);
    const savedOptions = { ...DEFAULT_OPTIONS, ...stored };
    options = savedOptions.disabled
      ? {
          ...savedOptions,
          autopause: false,
          autoresume: false,
          muteVideo: false,
          scrollpause: false,
          lockpause: false,
          lockresume: false,
          focuspause: false,
          focusresume: false,
          cursorTracking: false,
          blockAutoplay: false,
          prioritizeActiveTabMedia: false,
          singleVideoPlayback: false,
          debugMode: false,
          audioFading: false,
          showPipButton: false,
        }
      : savedOptions;
    toggleCursorTracking(options.cursorTracking);
    togglePipButtons();
  }

  let settingsReady = refresh_settings();
  void settingsReady.catch((error) => {
    console.error("Video Auto Pause could not load settings:", error);
  });

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

  env.storage.onChanged.addListener((changes, namespace) => {
    if (
      namespace !== "sync" ||
      !Object.keys(changes).some((key) => key in DEFAULT_OPTIONS)
    ) {
      return;
    }
    settingsReady = refresh_settings();
    settingsReady
      .then(() => {
        if (options.disabled) {
          for (const media of allMedia()) {
            const pending = scheduledActions.get(media);
            if (pending) {
              clearTimeout(pending);
              scheduledActions.delete(media);
            }
            videoActionTokens.set(media, {});
            activeFades.get(media)?.cancel();
            if (originalVolumes.has(media)) {
              setVideoVolume(media, originalVolumes.get(media));
              originalVolumes.delete(media);
            }
          }
        }
        scheduleVideoArbitration();
      })
      .catch((error) => {
        console.error("Video Auto Pause could not refresh settings:", error);
      });
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

    debugLog(`Sending message ${JSON.stringify(message)}`);

    try {
      env.runtime.sendMessage(message, function () {
        if (env.runtime.lastError) {
          console.warn(
            `Video Autopause message failed: ${env.runtime.lastError.message}`,
          );
        }
      });
    } catch (error) {
      console.error("Video Autopause extension context is unavailable:", error);
    }
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

  if (window.top === window) {
    window.addEventListener("blur", () =>
      sendMessage({ windowFocused: false }),
    );
    window.addEventListener("focus", () =>
      sendMessage({ windowFocused: true }),
    );
  }

  const hasVideos = () => {
    return allVideos().length > 0;
  };

  function collectVideos(root = document) {
    const videos = new Set(root.querySelectorAll?.("video") ?? []);
    for (const element of root.querySelectorAll?.("*") ?? []) {
      if (element.shadowRoot) {
        for (const video of collectVideos(element.shadowRoot)) {
          videos.add(video);
        }
      }
    }
    return [...videos];
  }

  function collectAudio(root = document) {
    const audioElements = new Set(root.querySelectorAll?.("audio") ?? []);
    for (const element of root.querySelectorAll?.("*") ?? []) {
      if (element.shadowRoot) {
        for (const audio of collectAudio(element.shadowRoot)) {
          audioElements.add(audio);
        }
      }
    }
    return [...audioElements];
  }

  function collectMedia(root = document) {
    return [...new Set([...collectVideos(root), ...collectAudio(root)])];
  }

  function allVideos() {
    return [...new Set([...collectVideos(), ...detectedVideos])].filter(
      (video) => video.isConnected,
    );
  }

  function allMedia() {
    return [
      ...new Set([...allVideos(), ...collectAudio(), ...detectedAudio]),
    ].filter((media) => media.isConnected);
  }

  function reportMediaState() {
    const media = allMedia();
    sendMessage({
      mediaState: {
        hasMedia: media.length > 0,
        playing: media.some((element) => !element.paused && !element.ended),
      },
    });
  }

  function attachMediaStateListeners(media) {
    if (observedMedia.has(media)) {
      return;
    }
    observedMedia.add(media);
    media.addEventListener("play", reportMediaState);
    media.addEventListener("pause", reportMediaState);
    media.addEventListener("ended", reportMediaState);
  }

  const videoActionTokens = new WeakMap();
  const activeFades = new WeakMap();
  const originalVolumes = new WeakMap();
  const setVideoVolume = (video, volume) => {
    try {
      video.volume = volume;
    } catch (error) {
      console.warn("Video Auto Pause could not change video volume:", error);
    }
  };

  const fadeAudio = (video, targetVolume, duration) => {
    if (!options.audioFading || duration <= 0) {
      setVideoVolume(video, targetVolume);
      return Promise.resolve();
    }

    activeFades.get(video)?.cancel();
    return new Promise((resolve) => {
      const startVolume = video.volume;
      const startTime = performance.now();
      const fadeState = {
        cancel: () => {
          activeFades.delete(video);
          resolve();
        },
      };
      activeFades.set(video, fadeState);

      const animate = () => {
        if (activeFades.get(video) !== fadeState) {
          return;
        }
        const elapsed = performance.now() - startTime;
        if (elapsed >= duration) {
          setVideoVolume(video, targetVolume);
          activeFades.delete(video);
          resolve();
          return;
        }
        setVideoVolume(
          video,
          startVolume + (targetVolume - startVolume) * (elapsed / duration),
        );
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

  const pauseVideo = async (video, actionToken, immediate = false) => {
    if (document.pictureInPictureElement === video) {
      debugLog(`Ignoring stop command for ${video} because it is in PiP`);
      return;
    }

    if (video.paused) {
      return;
    }
    extensionPausedVideos.add(video);
    if (immediate) {
      activeFades.get(video)?.cancel();
      if (originalVolumes.has(video)) {
        setVideoVolume(video, originalVolumes.get(video));
        originalVolumes.delete(video);
      }
    } else if (options.audioFading && !document.hidden) {
      const volume = video.volume;
      originalVolumes.set(video, volume);
      await fadeAudio(video, 0, options.fadeDuration);
      if (videoActionTokens.get(video) !== actionToken) {
        return;
      }
      setVideoVolume(video, volume);
    }
    if (videoActionTokens.get(video) === actionToken && !video.paused) {
      automaticallyPausedVideos.add(video);
      video.pause();
    }
  };

  const resumeVideo = async (video, actionToken) => {
    debugLog(`Attempting to resume video: paused=${video.paused}`);
    if (!extensionPausedVideos.has(video) || video.ended) {
      return;
    }

    const targetVolume = originalVolumes.get(video);
    activeFades.get(video)?.cancel();
    if (options.audioFading && targetVolume !== undefined && video.paused) {
      setVideoVolume(video, 0);
    }
    try {
      extensionInitiatedPlays.add(video);
      await video.play();
      if (videoActionTokens.get(video) !== actionToken) {
        return;
      }
      extensionPausedVideos.delete(video);
      automaticallyPausedVideos.delete(video);
      originalVolumes.delete(video);
      if (options.audioFading && targetVolume !== undefined) {
        await fadeAudio(video, targetVolume, options.fadeDuration);
      }
    } catch (error) {
      console.error("Video Auto Pause could not resume a video:", error);
      if (targetVolume !== undefined) {
        setVideoVolume(video, targetVolume);
      }
    }
  };

  const handleMuteAction = async (video, action, actionToken) => {
    if (action === "toggle_mute") {
      activeFades.get(video)?.cancel();
      video.muted = !video.muted;
      extensionMutedVideos.delete(video);
    } else if (
      action === "mute" &&
      !video.muted &&
      !extensionMutedVideos.has(video)
    ) {
      extensionMutedVideos.set(video, {
        muted: video.muted,
        volume: video.volume,
      });
      if (options.audioFading && !document.hidden) {
        await fadeAudio(video, 0, options.fadeDuration);
        if (videoActionTokens.get(video) !== actionToken) {
          return;
        }
        setVideoVolume(video, extensionMutedVideos.get(video).volume);
      }
      if (!video.muted) {
        video.muted = true;
      }
    } else if (action === "unmute" && extensionMutedVideos.has(video)) {
      const original = extensionMutedVideos.get(video);
      extensionMutedVideos.delete(video);
      if (video.muted === true) {
        if (options.audioFading && !document.hidden) {
          setVideoVolume(video, 0);
        }
        video.muted = original.muted;
        if (options.audioFading && !document.hidden) {
          await fadeAudio(video, original.volume, options.fadeDuration);
        } else {
          setVideoVolume(video, original.volume);
        }
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
    if (window.top === window) {
      showToast(`Speed: ${newRate}x`);
    }
  };

  const handleVideoAction = async (video, request) => {
    const actionToken = {};
    videoActionTokens.set(video, actionToken);
    const isManuallyPaused =
      options.manualPause && manuallyPausedVideos.get(video);

    switch (request.action) {
      case "stop":
        if (
          !isManuallyPaused &&
          (!extensionPausedVideos.has(video) || !video.paused)
        ) {
          await pauseVideo(video, actionToken, request.immediate === true);
        }
        break;
      case "resume":
        if (extensionPausedVideos.has(video) && !isManuallyPaused) {
          await resumeVideo(video, actionToken);
        } else {
          debugLog(
            `Resume blocked: paused=${video.paused}, manuallyPaused=${isManuallyPaused}`,
          );
        }
        break;
      case "mute":
      case "unmute":
      case "toggle_mute":
        await handleMuteAction(video, request.action, actionToken);
        break;
      case "toggle":
        if (video.paused) {
          manuallyPausedVideos.delete(video);
          extensionPausedVideos.delete(video);
          if (!video.ended) {
            try {
              extensionInitiatedPlays.add(video);
              await video.play();
            } catch (error) {
              console.error("Video Auto Pause could not play a video:", error);
            }
          }
        } else {
          extensionPausedVideos.delete(video);
          if (options.manualPause) {
            manuallyPausedVideos.set(video, true);
          }
          video.pause();
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

  env.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (!("action" in request)) {
      return false;
    }
    debugLog(`Received message: ${JSON.stringify(request)}`);

    settingsReady
      .then(async () => {
        if (request.action === "check") {
          sendMessage({ hasVideos: allVideos().length > 0 });
          return;
        }

        const automaticActions = ["stop", "resume", "mute", "unmute"];
        if (
          automaticActions.includes(request.action) &&
          document.fullscreenElement &&
          options.disableOnFullscreen
        ) {
          debugLog("Document is in fullscreen mode, ignoring automatic action");
          return;
        }

        const videos = allMedia();
        const delay = Math.max(0, Number(request.delay) || 0);
        const tasks = videos.map((video) => {
          const pending = scheduledActions.get(video);
          if (pending) {
            clearTimeout(pending);
            scheduledActions.delete(video);
          }
          if (delay > 0 && automaticActions.includes(request.action)) {
            const timeout = setTimeout(() => {
              if (scheduledActions.get(video) !== timeout) {
                return;
              }
              scheduledActions.delete(video);
              handleVideoAction(video, request).catch((error) => {
                console.error("Video Auto Pause action failed:", error);
              });
            }, delay);
            scheduledActions.set(video, timeout);
            return Promise.resolve();
          }
          return handleVideoAction(video, request);
        });
        const results = await Promise.allSettled(tasks);
        for (const result of results) {
          if (result.status === "rejected") {
            console.error("Video Auto Pause action failed:", result.reason);
          }
        }
      })
      .then(() => sendResponse({}))
      .catch((error) => {
        console.error("Video Auto Pause message handler failed:", error);
        sendResponse({ error: String(error) });
      });
    return true;
  });

  let videoArbitrationScheduled = false;
  function visibleVideoArea(video) {
    if (!video.isConnected || video.hidden) {
      return 0;
    }
    if (document.pictureInPictureElement === video) {
      return Number.POSITIVE_INFINITY;
    }

    const style = window.getComputedStyle(video);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return 0;
    }
    const rect = video.getBoundingClientRect();
    const width = Math.max(
      0,
      Math.min(rect.right, document.documentElement.clientWidth) -
        Math.max(rect.left, 0),
    );
    const height = Math.max(
      0,
      Math.min(rect.bottom, document.documentElement.clientHeight) -
        Math.max(rect.top, 0),
    );
    return width * height;
  }

  function scheduleVideoArbitration() {
    if (videoArbitrationScheduled) {
      return;
    }
    videoArbitrationScheduled = true;
    requestAnimationFrame(() => {
      videoArbitrationScheduled = false;
      if (
        !options.singleVideoPlayback ||
        options.disabled ||
        document.hidden ||
        (document.fullscreenElement && options.disableOnFullscreen)
      ) {
        return;
      }

      const candidates = allVideos().filter(
        (video) =>
          (!video.paused && !video.ended) || extensionPausedVideos.has(video),
      );
      if (candidates.length < 2) {
        return;
      }

      let winner;
      let greatestArea = -1;
      for (const video of candidates) {
        if (video.paused && manuallyPausedVideos.get(video)) {
          continue;
        }
        const area = visibleVideoArea(video);
        if (
          area > greatestArea ||
          (area === greatestArea && !video.paused && winner?.paused)
        ) {
          winner = video;
          greatestArea = area;
        }
      }
      if (!winner) {
        return;
      }

      const actions = candidates.map((video) => {
        if (video === winner) {
          if (video.paused && extensionPausedVideos.has(video)) {
            return handleVideoAction(video, { action: "resume" });
          }
          return Promise.resolve();
        }
        if (!video.paused) {
          return handleVideoAction(video, {
            action: "stop",
            immediate: true,
          });
        }
        return Promise.resolve();
      });
      void Promise.allSettled(actions).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            console.error(
              "Video Auto Pause could not enforce single-video playback:",
              result.reason,
            );
          }
        }
      });
    });
  }

  const videoResizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleVideoArbitration);

  document.addEventListener("scroll", scheduleVideoArbitration, {
    capture: true,
    passive: true,
  });
  document.addEventListener("fullscreenchange", scheduleVideoArbitration);
  window.addEventListener("resize", scheduleVideoArbitration);

  function attachVideoListeners(videoElement, intersection_observer) {
    detectedVideos.add(videoElement);
    attachMediaStateListeners(videoElement);

    if (videoElement.dataset.autoPauseListenerAttached) {
      return;
    }
    videoElement.dataset.autoPauseListenerAttached = "true";

    if (options.showPipButton) {
      injectPipButton(videoElement);
    }

    intersection_observer.observe(videoElement);
    videoResizeObserver?.observe(videoElement);

    videoElement.addEventListener("pause", () => {
      debugLog(
        `Pause event: automaticallyPaused=${automaticallyPausedVideos.has(videoElement)}, manualPause=${options.manualPause}`,
      );

      if (videoElement.dataset.returningFromPiP === "true") {
        debugLog("Ignoring pause event during PiP exit and enforcing playback");
        if (!document.hidden) {
          videoElement
            .play()
            .catch((e) => debugLog(`Failed to auto-resume from PiP: ${e}`));
        }
        scheduleVideoArbitration();
        return;
      }

      if (automaticallyPausedVideos.has(videoElement)) {
        automaticallyPausedVideos.delete(videoElement);
      } else if (!videoElement.ended) {
        videoActionTokens.set(videoElement, {});
        activeFades.get(videoElement)?.cancel();
        if (originalVolumes.has(videoElement)) {
          setVideoVolume(videoElement, originalVolumes.get(videoElement));
          originalVolumes.delete(videoElement);
        }
        extensionPausedVideos.delete(videoElement);
        if (options.manualPause) {
          debugLog(`Manually paused video`);
          manuallyPausedVideos.set(videoElement, true);
        }
      }
      scheduleVideoArbitration();
    });

    videoElement.addEventListener("play", (_e) => {
      debugLog(`Video resumed`);
      if (
        options.blockAutoplay &&
        !userInteracted &&
        !extensionInitiatedPlays.has(videoElement)
      ) {
        debugLog("Blocking autoplay before user interaction");
        automaticallyPausedVideos.add(videoElement);
        videoElement.pause();
        scheduleVideoArbitration();
        return;
      }
      activeFades.get(videoElement)?.cancel();
      if (!extensionInitiatedPlays.has(videoElement)) {
        videoActionTokens.set(videoElement, {});
        if (originalVolumes.has(videoElement)) {
          setVideoVolume(videoElement, originalVolumes.get(videoElement));
          originalVolumes.delete(videoElement);
        }
      } else {
        extensionInitiatedPlays.delete(videoElement);
      }
      manuallyPausedVideos.delete(videoElement);
      extensionPausedVideos.delete(videoElement);
      scheduleVideoArbitration();
    });
  }

  function attachAudioListeners(audioElement) {
    detectedAudio.add(audioElement);
    attachMediaStateListeners(audioElement);
  }

  function injectPipButton(video) {
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
    if (container.querySelector(".vap-pip-btn")) return;

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
    const videos = allVideos();
    if (options.showPipButton) {
      for (const video of videos) {
        injectPipButton(video);
      }
    } else {
      document.querySelectorAll(".vap-pip-btn").forEach((btn) => btn.remove());
      for (const video of videos) {
        const root = video.getRootNode();
        root.querySelectorAll?.(".vap-pip-btn").forEach((btn) => btn.remove());
      }
    }
  }

  function reportVisibility() {
    if (
      !options.scrollpause ||
      !options.autopause ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const visible = visibleVideos.size > 0;
    if (visible !== lastVisibility) {
      lastVisibility = visible;
      sendMessage({ visible });
    }
  }

  const intersection_observer = new IntersectionObserver(
    function (entries) {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visibleVideos.add(entry.target);
        } else {
          visibleVideos.delete(entry.target);
        }
      }
      reportVisibility();
      scheduleVideoArbitration();
    },
    { threshold: [0] },
  );

  function observeRoot(root) {
    if (observedRoots.has(root)) {
      return;
    }
    observedRoots.add(root);
    videoObserver.observe(root, { childList: true, subtree: true });
    for (const media of collectMedia(root)) {
      if (media instanceof HTMLVideoElement) {
        attachVideoListeners(media, intersection_observer);
      } else {
        attachAudioListeners(media);
      }
    }
    for (const element of root.querySelectorAll?.("*") ?? []) {
      if (element.shadowRoot) {
        observeRoot(element.shadowRoot);
      }
    }
  }

  function discoverShadowHosts(root) {
    const elements = [];
    if (root.nodeType === Node.ELEMENT_NODE) {
      elements.push(root);
    }
    elements.push(...(root.querySelectorAll?.("*") ?? []));
    for (const element of elements) {
      if (element.shadowRoot) {
        observeRoot(element.shadowRoot);
      } else {
        shadowHosts.add(element);
      }
    }
  }

  function forgetShadowHosts(root) {
    const elements = [];
    if (root.nodeType === Node.ELEMENT_NODE) {
      elements.push(root);
    }
    elements.push(...(root.querySelectorAll?.("*") ?? []));
    for (const element of elements) {
      shadowHosts.delete(element);
    }
  }

  setInterval(() => {
    for (const host of shadowHosts) {
      if (!host.isConnected) {
        shadowHosts.delete(host);
      } else if (host.shadowRoot) {
        shadowHosts.delete(host);
        const previousVideoCount = detectedVideos.size;
        observeRoot(host.shadowRoot);
        if (detectedVideos.size !== previousVideoCount) {
          sendMessage({ hasVideos: hasVideos() });
        }
      }
    }
  }, 1000);

  function observeExistingVideos(retries = 5) {
    const videoElements = collectVideos();
    if (videoElements.length > 0) {
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
    for (const audio of collectAudio()) {
      attachAudioListeners(audio);
    }
    reportMediaState();
    reportVisibility();
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
      const host = document.body ?? document.documentElement;
      if (!host) {
        console.warn(
          "Video Auto Pause cannot display a toast without a document root.",
        );
        return;
      }
      container = document.createElement("div");
      container.id = "vap-toast-container";
      Object.assign(container.style, {
        position: "fixed",
        top: "20px",
        right: "20px",
        zIndex: "999999",
        pointerEvents: "none",
      });
      host.appendChild(container);
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

  videoObserver = new MutationObserver(function (mutations) {
    let changed = false;
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        forgetShadowHosts(node);
        const mediaElements = new Set(collectMedia(node));
        if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
          mediaElements.add(node);
        }
        for (const media of mediaElements) {
          if (media instanceof HTMLVideoElement) {
            detectedVideos.delete(media);
            visibleVideos.delete(media);
            intersection_observer.unobserve(media);
            videoResizeObserver?.unobserve(media);
          } else {
            detectedAudio.delete(media);
          }
        }
        changed ||= mediaElements.size > 0;
      }

      for (const node of mutation.addedNodes) {
        const mediaElements = new Set(collectMedia(node));
        discoverShadowHosts(node);
        if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
          mediaElements.add(node);
        }
        for (const media of mediaElements) {
          if (media instanceof HTMLVideoElement) {
            attachVideoListeners(media, intersection_observer);
          } else {
            attachAudioListeners(media);
          }
          const root = media.getRootNode();
          if (root instanceof ShadowRoot) {
            observeRoot(root);
          }
        }
        changed ||= mediaElements.size > 0;
      }
    }

    if (changed) {
      sendMessage({ hasVideos: hasVideos() });
      reportMediaState();
      scheduleVideoArbitration();
    }
  });

  observeRoot(document);
  discoverShadowHosts(document);
  void settingsReady.then(scheduleVideoArbitration).catch((error) => {
    console.error(
      "Video Auto Pause could not arbitrate initial playback:",
      error,
    );
  });
  try {
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = attachShadow.call(this, init);
      shadowHosts.delete(this);
      observeRoot(root);
      return root;
    };
  } catch (error) {
    console.warn(
      "Video Auto Pause could not observe future shadow roots:",
      error,
    );
  }
}
