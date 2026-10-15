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
  const automaticPauseStartedAt = new WeakMap();
  const automaticPausePositions = new WeakMap();
  const scheduledActions = new WeakMap();
  const observedRoots = new WeakSet();
  const observedMedia = new WeakSet();
  const shadowHosts = new Set();
  const visibleVideos = new Set();
  const overlayPinRefreshers = new Set();
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
    const hostname = location.hostname.toLowerCase();
    const effectiveOptions = VAP_OPTIONS_FOR_SITE(hostname, savedOptions);
    const siteEnabled = VAP_SITE_ENABLED(hostname, savedOptions);
    options = savedOptions.disabled
      ? {
          ...effectiveOptions,
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
          liveStreamMute: false,
          muteDuringAds: false,
          prioritizeActiveTabMedia: false,
          singleVideoPlayback: false,
          debugMode: false,
          audioFading: false,
          showPipButton: false,
          showVideoOverlay: false,
        }
      : siteEnabled
        ? effectiveOptions
        : {
            ...effectiveOptions,
            autopause: false,
            autoresume: false,
            muteVideo: false,
            scrollpause: false,
            lockpause: false,
            lockresume: false,
            focuspause: false,
            focusresume: false,
            blockAutoplay: false,
            liveStreamMute: false,
            muteDuringAds: false,
            prioritizeActiveTabMedia: false,
            singleVideoPlayback: false,
          };
    toggleCursorTracking(options.cursorTracking);
    togglePipButtons();
    toggleVideoOverlays();
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
      (namespace === "session" || namespace === "local") &&
      "pinnedTabs" in changes
    ) {
      for (const refreshPinState of overlayPinRefreshers) {
        refreshPinState();
      }
    }
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
        for (const video of allVideos()) {
          applySiteSpeed(video);
        }
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
      automaticPauseStartedAt.set(video, Date.now());
      automaticPausePositions.set(video, {
        time: video.currentTime,
        pausedAt: Date.now(),
      });
      video.pause();
      sendMessage({ statsEvent: "pause" });
    }
  };

  const resumeVideo = async (video, actionToken) => {
    debugLog(`Attempting to resume video: paused=${video.paused}`);
    if (video.ended || (!extensionPausedVideos.has(video) && !video.paused)) {
      return;
    }

    const targetVolume = originalVolumes.get(video);
    activeFades.get(video)?.cancel();
    if (options.audioFading && targetVolume !== undefined && video.paused) {
      setVideoVolume(video, 0);
    }
    const pausePosition = automaticPausePositions.get(video);
    if (
      pausePosition &&
      options.rewindSeconds > 0 &&
      Number.isFinite(video.duration) &&
      video.duration > 0
    ) {
      const awaySeconds = Math.max(
        0,
        (Date.now() - pausePosition.pausedAt) / 1000,
      );
      const rewindSeconds = Math.min(
        options.rewindSeconds * 2,
        options.rewindSeconds * (1 + awaySeconds / 60),
      );
      try {
        video.currentTime = Math.max(0, pausePosition.time - rewindSeconds);
      } catch (error) {
        console.error("Video Auto Pause could not rewind the video:", error);
      }
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
      automaticPausePositions.delete(video);
      const pauseStartedAt = automaticPauseStartedAt.get(video);
      if (pauseStartedAt !== undefined) {
        automaticPauseStartedAt.delete(video);
        sendMessage({
          statsEvent: "resume",
          preventedSeconds: Math.max(0, (Date.now() - pauseStartedAt) / 1000),
        });
      }
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

  const activeAdMarkers = [
    ".ad-showing",
    ".ad-playing",
    ".vjs-ad-playing",
    ".jw-flag-ads",
    '[data-ad-playing="true"]',
    '[data-ad-state="playing"]',
    '[data-is-ad="true"]',
    '[data-testid="ad-playing"]',
    'video[data-ad="true"]',
    ".atvwebplayersdk-adOverlay",
    ".player-ad-overlay",
    ".video-player__ad-overlay",
  ];
  const visibleAdMarkers = [
    ".ytp-ad-player-overlay",
    ".ytp-ad-preview-container",
    ".ytp-ad-skip-button",
    ".ima-ad-container",
    ".vp-ad",
  ];

  function isVisibleAdMarker(element) {
    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      element.getClientRects().length > 0
    );
  }

  function isAdPlaying() {
    if (activeAdMarkers.some((selector) => document.querySelector(selector))) {
      return true;
    }
    if (
      visibleAdMarkers.some((selector) =>
        [...document.querySelectorAll(selector)].some(isVisibleAdMarker),
      )
    ) {
      return true;
    }
    const youtubeAdModule = document.querySelector(".video-ads.ytp-ad-module");
    return Boolean(
      youtubeAdModule && [...youtubeAdModule.children].some(isVisibleAdMarker),
    );
  }

  const waitForAdToFinish = (video, actionToken) => {
    if (videoActionTokens.get(video) !== actionToken || !video.isConnected) {
      return Promise.resolve(false);
    }
    if (!isAdPlaying()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (
          videoActionTokens.get(video) !== actionToken ||
          !video.isConnected ||
          !isAdPlaying()
        ) {
          observer.disconnect();
          resolve(
            videoActionTokens.get(video) === actionToken && video.isConnected,
          );
        }
      });
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    });
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
          options.liveStreamMute &&
          video instanceof HTMLVideoElement &&
          video.duration === Number.POSITIVE_INFINITY
        ) {
          await handleMuteAction(video, "mute", actionToken);
          break;
        }
        if (!isManuallyPaused && options.muteDuringAds && isAdPlaying()) {
          await handleMuteAction(video, "mute", actionToken);
          if (
            videoActionTokens.get(video) === actionToken &&
            (await waitForAdToFinish(video, actionToken))
          ) {
            await pauseVideo(video, actionToken, request.immediate === true);
          }
          break;
        }
        if (
          !isManuallyPaused &&
          (!extensionPausedVideos.has(video) || !video.paused)
        ) {
          await pauseVideo(video, actionToken, request.immediate === true);
        }
        break;
      case "resume":
        if (options.muteDuringAds && isAdPlaying()) {
          if (!(await waitForAdToFinish(video, actionToken))) {
            break;
          }
        }
        if (extensionMutedVideos.has(video)) {
          await handleMuteAction(video, "unmute", actionToken);
        }
        if (
          (extensionPausedVideos.has(video) || video.paused) &&
          !isManuallyPaused
        ) {
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
    applySiteSpeed(videoElement);

    if (options.showPipButton) {
      injectPipButton(videoElement);
    }
    if (options.showVideoOverlay) {
      injectVideoOverlay(videoElement);
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
        sendMessage({ statsEvent: "autoplayBlocked" });
        scheduleVideoArbitration();
        return;
      }
      applySiteSpeed(videoElement);
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
    videoElement.addEventListener("ratechange", () => {
      const rule = siteRuleFor(location.hostname.toLowerCase());
      if (Number.isFinite(rule?.speed)) {
        applySiteSpeed(videoElement);
        return;
      }
      const key = `sitePlaybackRate:${location.hostname.toLowerCase()}`;
      env.storage.local
        .set({ [key]: videoElement.playbackRate })
        .catch((error) => {
          console.error(
            "Video Auto Pause could not save this site's speed:",
            error,
          );
        });
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

  let overlaySequence = 0;
  const videoOverlayCleanups = new WeakMap();

  function applySiteSpeed(video) {
    if (
      options.disabled ||
      !VAP_SITE_ENABLED(location.hostname.toLowerCase(), options)
    ) {
      return;
    }
    const hostname = location.hostname.toLowerCase();
    const speed = VAP_OPTIONS_FOR_SITE(hostname, options).playbackSpeed;
    if (Number.isFinite(speed) && speed >= 0.25 && speed <= 4) {
      if (Math.abs(video.playbackRate - speed) > 0.001) {
        video.playbackRate = speed;
      }
      return;
    }
    const key = `sitePlaybackRate:${hostname}`;
    env.storage.local
      .get(key)
      .then((stored) => {
        const speed = stored[key];
        if (
          video.isConnected &&
          Number.isFinite(speed) &&
          speed >= 0.25 &&
          speed <= 4 &&
          Math.abs(video.playbackRate - speed) > 0.001
        ) {
          video.playbackRate = speed;
        }
      })
      .catch((error) => {
        console.error(
          "Video Auto Pause could not restore this site's speed:",
          error,
        );
      });
  }

  function siteIsEnabled(hostname, settings) {
    return VAP_SITE_ENABLED(hostname, settings);
  }

  async function toggleCurrentSite() {
    const hostname = location.hostname.toLowerCase();
    const settings = await env.storage.sync.get(DEFAULT_OPTIONS);
    const siteRules = Array.isArray(settings.siteRules)
      ? [...settings.siteRules]
      : [];
    const enabled = siteIsEnabled(hostname, settings);
    const existingRule = VAP_SITE_RULE_FOR(hostname, settings);
    const updatedRule = existingRule
      ? { ...existingRule, enabled: !enabled }
      : { domain: hostname, enabled: !enabled, overrides: {} };
    const updatedRules = siteRules.filter(
      (rule) =>
        VAP_NORMALIZE_DOMAIN(rule.domain) !==
        VAP_NORMALIZE_DOMAIN(updatedRule.domain),
    );
    updatedRules.push(updatedRule);
    await env.storage.sync.set({
      siteRules: updatedRules,
    });
  }

  function injectVideoOverlay(video) {
    if (video.dataset.vapOverlayId) {
      return;
    }
    let container = video.parentElement;
    if (container?.classList.contains("html5-video-container")) {
      container = container.parentElement;
    }
    if (!container) {
      return;
    }

    const overlayId = `vap-video-overlay-${++overlaySequence}`;
    const overlay = document.createElement("div");
    overlay.className = "vap-video-overlay";
    overlay.dataset.overlayId = overlayId;
    Object.assign(overlay.style, {
      position: "absolute",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      gap: "4px",
      padding: "5px",
      borderRadius: "8px",
      background: "rgba(0, 0, 0, 0.78)",
      color: "white",
      opacity: "0",
      transition: "opacity 150ms ease",
      pointerEvents: "auto",
      font: "12px sans-serif",
      touchAction: "none",
    });
    const buttonStyle = {
      border: "0",
      borderRadius: "5px",
      padding: "6px 8px",
      background: "transparent",
      color: "white",
      cursor: "pointer",
      font: "inherit",
    };
    const addButton = (action, label, displayText = label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.textContent = displayText;
      Object.assign(button.style, buttonStyle);
      overlay.appendChild(button);
      return button;
    };
    const handle = document.createElement("span");
    handle.textContent = env.i18n.getMessage("overlayDragHandle");
    handle.title = handle.textContent;
    handle.style.cursor = "grab";
    handle.style.padding = "4px";
    overlay.appendChild(handle);
    const playButton = addButton(
      "toggle",
      env.i18n.getMessage("commandTogglePlay"),
    );
    const slowerButton = addButton(
      "speed-down",
      env.i18n.getMessage("commandSpeedDown"),
      "-",
    );
    const fasterButton = addButton(
      "speed-up",
      env.i18n.getMessage("commandSpeedUp"),
      "+",
    );
    const speedLabel = document.createElement("span");
    speedLabel.className = "vap-speed-label";
    overlay.appendChild(speedLabel);
    const siteButton = addButton("site-toggle", "");
    const pinButton = addButton("pin-toggle", "");
    let pinned = false;

    const refreshOverlay = () => {
      playButton.textContent = video.paused ? "▶" : "Ⅱ";
      playButton.title = video.paused
        ? env.i18n.getMessage("overlayPlay")
        : env.i18n.getMessage("overlayPause");
      playButton.setAttribute("aria-label", playButton.title);
      speedLabel.textContent = `${video.playbackRate.toFixed(2)}×`;
      const enabled = siteIsEnabled(location.hostname.toLowerCase(), options);
      siteButton.textContent = enabled
        ? env.i18n.getMessage("overlaySiteOn")
        : env.i18n.getMessage("overlaySiteOff");
      siteButton.title = siteButton.textContent;
      siteButton.setAttribute("aria-pressed", String(enabled));
      pinButton.textContent = pinned ? "PIN" : "PIN+";
      pinButton.title = env.i18n.getMessage(
        pinned ? "unpinCurrentTab" : "pinCurrentTab",
      );
      pinButton.setAttribute("aria-label", pinButton.title);
      pinButton.setAttribute("aria-pressed", String(pinned));
    };
    refreshOverlay();

    const refreshPinState = () => {
      env.runtime.sendMessage({ pinAction: "get" }, (response) => {
        if (env.runtime.lastError) {
          console.error(
            "Video Auto Pause overlay could not read the tab pin:",
            env.runtime.lastError.message,
          );
          return;
        }
        pinned = response?.pinned === true;
        refreshOverlay();
      });
    };
    refreshPinState();
    overlayPinRefreshers.add(refreshPinState);

    playButton.addEventListener("click", () => {
      void handleVideoAction(video, { action: "toggle" }).catch((error) => {
        console.error(
          "Video Auto Pause overlay could not toggle playback:",
          error,
        );
      });
    });
    slowerButton.addEventListener("click", () => {
      handleSpeedAction(video, "speed-down");
      refreshOverlay();
    });
    fasterButton.addEventListener("click", () => {
      handleSpeedAction(video, "speed-up");
      refreshOverlay();
    });
    siteButton.addEventListener("click", async () => {
      try {
        await toggleCurrentSite();
        const stored = await env.storage.sync.get(DEFAULT_OPTIONS);
        options = { ...options, ...stored };
        refreshOverlay();
      } catch (error) {
        console.error(
          "Video Auto Pause overlay could not update this site:",
          error,
        );
      }
    });
    pinButton.addEventListener("click", () => {
      env.runtime.sendMessage({ pinAction: "toggle" }, (response) => {
        if (env.runtime.lastError) {
          console.error(
            "Video Auto Pause overlay could not update the tab pin:",
            env.runtime.lastError.message,
          );
          return;
        }
        pinned = response?.pinned === true;
        refreshOverlay();
      });
    });
    video.addEventListener("play", refreshOverlay);
    video.addEventListener("pause", refreshOverlay);
    video.addEventListener("ratechange", refreshOverlay);

    let hideTimeout;
    const show = () => {
      clearTimeout(hideTimeout);
      overlay.style.opacity = "1";
      hideTimeout = setTimeout(() => {
        if (!overlay.matches(":hover")) {
          overlay.style.opacity = "0";
        }
      }, 2000);
    };
    const hideAfterLeave = () => {
      hideTimeout = setTimeout(() => {
        overlay.style.opacity = "0";
      }, 800);
    };
    container.addEventListener("mouseenter", show);
    container.addEventListener("mousemove", show);
    container.addEventListener("mouseleave", hideAfterLeave);
    overlay.addEventListener("mouseenter", show);

    let dragStart;
    handle.addEventListener("pointerdown", (event) => {
      dragStart = {
        x: event.clientX,
        y: event.clientY,
        left: overlay.offsetLeft,
        top: overlay.offsetTop,
      };
      overlay.style.right = "auto";
      overlay.style.bottom = "auto";
      overlay.style.left = `${dragStart.left}px`;
      overlay.style.top = `${dragStart.top}px`;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragStart) {
        return;
      }
      overlay.style.left = `${dragStart.left + event.clientX - dragStart.x}px`;
      overlay.style.top = `${dragStart.top + event.clientY - dragStart.y}px`;
    });
    handle.addEventListener("pointerup", () => {
      dragStart = undefined;
    });
    handle.addEventListener("pointercancel", () => {
      dragStart = undefined;
    });

    if (window.getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    video.dataset.vapOverlayId = overlayId;
    container.appendChild(overlay);
    videoOverlayCleanups.set(video, () => {
      clearTimeout(hideTimeout);
      container.removeEventListener("mouseenter", show);
      container.removeEventListener("mousemove", show);
      container.removeEventListener("mouseleave", hideAfterLeave);
      overlayPinRefreshers.delete(refreshPinState);
      overlay.remove();
      delete video.dataset.vapOverlayId;
    });
  }

  function toggleVideoOverlays() {
    if (options.showVideoOverlay && !options.disabled) {
      for (const video of allVideos()) {
        injectVideoOverlay(video);
      }
    } else {
      for (const video of allVideos()) {
        videoOverlayCleanups.get(video)?.();
        videoOverlayCleanups.delete(video);
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
            videoOverlayCleanups.get(media)?.();
            videoOverlayCleanups.delete(media);
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
