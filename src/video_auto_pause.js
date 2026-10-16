if (window.autoPauseInjected !== true) {
  const env = chrome.runtime ? chrome : browser;
  window.autoPauseInjected = true;
  const manuallyPausedVideos = new WeakMap();
  const detectedVideos = new Set();
  const detectedAudio = new Set();
  const extensionPausedVideos = new WeakSet();
  const extensionInitiatedPlays = new WeakSet();
  const pauseOnNextPlay = new WeakMap();
  const automaticallyPausedVideos = new WeakSet();
  const autoNextPausedVideos = new WeakSet();
  const extensionMutedVideos = new WeakMap();
  const automaticPauseStartedAt = new WeakMap();
  const automaticPausePositions = new WeakMap();
  const scheduledActions = new WeakMap();
  const observedRoots = new WeakSet();
  const observedMedia = new WeakSet();
  const shadowHosts = new Set();
  const visibleVideos = new Set();
  const hoveredVideos = new Set();
  const overlayPinRefreshers = new Set();
  const videoLoops = new WeakMap();
  const videosWithLoopListeners = new WeakSet();
  const videosWithListeners = new WeakSet();
  let videoObserver;
  let lastVisibility = null;
  let userInteracted = false;
  let lastUserInteractionAt = 0;
  let lastVideoEndedAt = 0;
  let safeModeTriggered = false;
  let settings = { ...DEFAULT_SETTINGS };
  let autoPipVideo = null;
  let autoDocumentPipWindow = null;
  let batteryStatus = null;
  let batteryListenersRegistered = false;
  let audioOutputDeviceIds = null;
  let audioDeviceListenerRegistered = false;
  const batteryPausedVideos = new WeakSet();

  function recordUserInteraction(event) {
    if (!event.isTrusted) {
      return;
    }
    userInteracted = true;
    lastUserInteractionAt = Date.now();
  }

  document.addEventListener("pointerdown", recordUserInteraction, true);
  document.addEventListener("keydown", recordUserInteraction, true);

  function debugLog(message) {
    if (settings.debugMode) {
      console.log(`Video auto pause: ${message}`);
    }
  }

  // Automatic behaviors that stay off on sites where the extension is inactive.
  // The overlay and PiP button remain so the site can be re-enabled in place.
  const inactiveSiteOverrides = Object.freeze({
    autopause: false,
    autoresume: false,
    muteVideo: false,
    scrollpause: false,
    lockpause: false,
    lockresume: false,
    focuspause: false,
    focusresume: false,
    blockAutoplay: false,
    disableAutoplayNext: false,
    liveStreamMute: false,
    muteDuringAds: false,
    prioritizeActiveTabMedia: false,
    singleVideoPlayback: false,
  });
  const disabledExtensionOverrides = Object.freeze({
    ...inactiveSiteOverrides,
    cursorTracking: false,
    debugMode: false,
    showPipButton: false,
    showVideoOverlay: false,
  });

  async function refreshSettings() {
    const profileSettings = await getActiveProfileSettings();
    const hostname = location.hostname.toLowerCase();
    const siteSettings = getSiteSettings(hostname, profileSettings);
    if (profileSettings.disabled) {
      settings = { ...siteSettings, ...disabledExtensionOverrides };
    } else if (!isSiteEnabled(hostname, profileSettings)) {
      settings = { ...siteSettings, ...inactiveSiteOverrides };
    } else {
      settings = siteSettings;
    }
    toggleCursorTracking(settings.cursorTracking);
    togglePipButtons();
    toggleVideoOverlays();
    applyAutoplaySettings();
    void updateBatteryAwareness().catch((error) => {
      console.error("Video Auto Pause could not monitor battery state:", error);
    });
    void updateAudioOutputAwareness().catch((error) => {
      console.error(
        "Video Auto Pause could not monitor audio output devices:",
        error,
      );
    });
  }

  async function applyBatteryPolicy() {
    if (!batteryStatus) {
      return;
    }
    const shouldPause =
      settings.pauseOnLowBattery &&
      !batteryStatus.charging &&
      batteryStatus.level <= 0.2 &&
      document.hidden;
    for (const video of allVideos()) {
      if (shouldPause && !video.paused) {
        batteryPausedVideos.add(video);
        await handleVideoAction(video, { action: "stop", immediate: true });
      } else if (!shouldPause && batteryPausedVideos.has(video)) {
        batteryPausedVideos.delete(video);
        if (settings.autoresume) {
          await handleVideoAction(video, { action: "resume" });
        }
      }
    }
  }

  async function updateBatteryAwareness() {
    if (
      settings.pauseOnLowBattery &&
      typeof navigator.getBattery === "function"
    ) {
      batteryStatus ??= await navigator.getBattery();
      if (!batteryListenersRegistered) {
        batteryStatus.addEventListener("levelchange", () => {
          void applyBatteryPolicy().catch((error) => {
            console.error(
              "Video Auto Pause could not apply battery policy:",
              error,
            );
          });
        });
        batteryStatus.addEventListener("chargingchange", () => {
          void applyBatteryPolicy().catch((error) => {
            console.error(
              "Video Auto Pause could not apply battery policy:",
              error,
            );
          });
        });
        batteryListenersRegistered = true;
      }
    } else if (
      settings.pauseOnLowBattery &&
      typeof navigator.getBattery !== "function"
    ) {
      debugLog("Battery Status API is unavailable in this browser");
    }
    await applyBatteryPolicy();
  }

  async function updateAudioOutputAwareness() {
    const mediaDevices = navigator.mediaDevices;
    if (
      !settings.pauseOnAudioOutputDisconnect ||
      !mediaDevices?.enumerateDevices
    ) {
      audioOutputDeviceIds = null;
      return;
    }
    if (
      !audioDeviceListenerRegistered &&
      typeof mediaDevices.addEventListener === "function"
    ) {
      mediaDevices.addEventListener("devicechange", () => {
        void updateAudioOutputAwareness().catch((error) => {
          console.error(
            "Video Auto Pause could not check audio output devices:",
            error,
          );
        });
      });
      audioDeviceListenerRegistered = true;
    }
    const devices = await mediaDevices.enumerateDevices();
    const currentOutputs = new Set(
      devices
        .filter((device) => device.kind === "audiooutput")
        .map((device) => device.deviceId)
        .filter(Boolean),
    );
    const disconnected =
      audioOutputDeviceIds !== null &&
      [...audioOutputDeviceIds].some(
        (deviceId) => !currentOutputs.has(deviceId),
      );
    audioOutputDeviceIds = currentOutputs;
    if (disconnected) {
      for (const video of allVideos()) {
        if (!video.paused) {
          await handleVideoAction(video, { action: "stop", immediate: true });
        }
      }
    }
  }

  async function openVideoInPictureInPicture(video) {
    if (
      document.pictureInPictureElement === video ||
      autoDocumentPipWindow?.document.contains(video)
    ) {
      return;
    }
    const documentPip = window.documentPictureInPicture;
    if (documentPip?.requestWindow && !documentPip.window) {
      const parent = video.parentNode;
      const nextSibling = video.nextSibling;
      const originalStyle = video.getAttribute("style");
      let pipWindow;
      try {
        pipWindow = await documentPip.requestWindow({
          width: video.videoWidth || 640,
          height: video.videoHeight || 360,
        });
        pipWindow.document.body.style.margin = "0";
        pipWindow.document.body.style.background = "black";
        pipWindow.document.body.append(video);
        Object.assign(video.style, {
          width: "100%",
          height: "100%",
          maxWidth: "100vw",
          maxHeight: "100vh",
        });
        autoDocumentPipWindow = pipWindow;
        autoPipVideo = video;
        pipWindow.addEventListener(
          "pagehide",
          () => {
            const restoreParent = parent?.isConnected ? parent : document.body;
            if (restoreParent) {
              restoreParent.insertBefore(
                video,
                nextSibling?.parentNode === restoreParent ? nextSibling : null,
              );
            }
            if (originalStyle === null) {
              video.removeAttribute("style");
            } else {
              video.setAttribute("style", originalStyle);
            }
            autoDocumentPipWindow = null;
            autoPipVideo = null;
          },
          { once: true },
        );
        return;
      } catch (error) {
        console.error(
          "Video Auto Pause could not open Document Picture-in-Picture:",
          error,
        );
        if (pipWindow) {
          if (pipWindow.document.contains(video)) {
            const restoreParent = parent?.isConnected ? parent : document.body;
            restoreParent?.insertBefore(
              video,
              nextSibling?.parentNode === restoreParent ? nextSibling : null,
            );
            if (originalStyle === null) {
              video.removeAttribute("style");
            } else {
              video.setAttribute("style", originalStyle);
            }
          }
          pipWindow.close();
        }
      }
    }
    try {
      await video.requestPictureInPicture();
      autoPipVideo = video;
    } catch (error) {
      console.error(
        "Video Auto Pause could not open Picture-in-Picture:",
        error,
      );
    }
  }

  async function handleVisibilityChange() {
    await settingsReady;
    await applyBatteryPolicy();
    if (document.hidden && settings.autoPipOnTabSwitch) {
      const video = allVideos().find(
        (candidate) => !candidate.paused && !candidate.ended,
      );
      if (video) {
        await openVideoInPictureInPicture(video);
      }
    } else if (!document.hidden && autoPipVideo) {
      const video = autoPipVideo;
      if (autoDocumentPipWindow) {
        autoDocumentPipWindow.close();
      } else if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        autoPipVideo = null;
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    void handleVisibilityChange().catch((error) => {
      console.error(
        "Video Auto Pause could not handle the Picture-in-Picture tab switch:",
        error,
      );
    });
  });
  document.addEventListener(
    "play",
    (event) => {
      const video = event.target;
      if (
        settings.pauseAtEnd &&
        video instanceof HTMLVideoElement &&
        lastVideoEndedAt > 0 &&
        Date.now() - lastVideoEndedAt < 15000 &&
        Date.now() - lastUserInteractionAt > 1500
      ) {
        autoNextPausedVideos.add(video);
        video.pause();
        event.stopImmediatePropagation();
        automaticallyPausedVideos.add(video);
        sendMessage({ statsEvent: "autoplayBlocked" });
        showToast(env.i18n.getMessage("pauseAtEndNotice"));
        return;
      }
      if (document.hidden && event.target?.tagName === "VIDEO") {
        void applyBatteryPolicy().catch((error) => {
          console.error(
            "Video Auto Pause could not apply battery policy:",
            error,
          );
        });
      }
    },
    true,
  );
  document.addEventListener(
    "ended",
    (event) => {
      if (settings.pauseAtEnd && event.target instanceof HTMLVideoElement) {
        lastVideoEndedAt = Date.now();
      }
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!settings.disableAutoplayNext || event.isTrusted) {
        return;
      }
      const control = event.target?.closest?.(
        "button, a, [role='button'], [tabindex]",
      );
      if (!control) {
        return;
      }
      const description = [
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("data-testid"),
        control.textContent,
        control.className,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (
        /(?:^|\b)(?:next video|next episode|play next|up next|next)(?:\b|$)/.test(
          description,
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  let settingsReady = refreshSettings();
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
    if (!isSettingsStorageChange(changes, namespace)) {
      return;
    }
    settingsReady = refreshSettings();
    settingsReady
      .then(() => {
        if (settings.disabled) {
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
        reportMediaState();
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

  function enterSafeMode(errorMessage, source) {
    if (safeModeTriggered) {
      return;
    }
    safeModeTriggered = true;
    const disabledOptions = Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS)
        .filter(([, value]) => typeof value === "boolean")
        .map(([key]) => [key, false]),
    );
    settings = { ...settings, ...disabledOptions, disabled: true };
    toggleCursorTracking(false);
    togglePipButtons();
    toggleVideoOverlays();
    sendMessage({
      contentScriptError: {
        message: String(errorMessage).slice(0, 240),
        source: String(source).split(/[?#]/, 1)[0].slice(-160),
      },
    });
  }

  window.addEventListener("error", (event) => {
    const extensionUrl = env.runtime.getURL("");
    if (event.filename?.startsWith(extensionUrl)) {
      enterSafeMode(event.message || event.error?.message, event.filename);
    }
  });

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

  function collectMedia(root = document) {
    const media = new Set(root.querySelectorAll?.("video, audio") ?? []);
    for (const element of root.querySelectorAll?.("*") ?? []) {
      if (element.shadowRoot) {
        for (const nested of collectMedia(element.shadowRoot)) {
          media.add(nested);
        }
      }
    }
    return [...media];
  }

  function collectVideos(root = document) {
    return collectMedia(root).filter((media) => media.localName === "video");
  }

  // Shadow-root media is tracked by observeRoot(), so hot paths only need a
  // cheap light-DOM query instead of a deep scan of every element.
  function allVideos() {
    return [
      ...new Set([...document.querySelectorAll("video"), ...detectedVideos]),
    ].filter((video) => video.isConnected);
  }

  function getShortcutVideo() {
    const videos = allVideos();
    return (
      videos.find((video) => !video.paused && !video.ended) ??
      [...visibleVideos].find((video) => video.isConnected) ??
      videos[0]
    );
  }

  function showShortcutStatus(message) {
    let status = document.getElementById("vap-shortcut-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "vap-shortcut-status";
      Object.assign(status.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483647",
        padding: "8px 12px",
        borderRadius: "6px",
        background: "rgba(0, 0, 0, 0.8)",
        color: "white",
        font: "13px sans-serif",
        pointerEvents: "none",
      });
      document.documentElement.appendChild(status);
    }
    status.textContent = message;
    clearTimeout(status._vapTimeout);
    status._vapTimeout = setTimeout(() => status.remove(), 1800);
  }

  function formatMediaTime(seconds) {
    const wholeSeconds = Math.floor(Math.max(0, seconds));
    return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
  }

  function getShortcutAction(event) {
    const keys = settings.contentShortcutKeys;
    if (!keys || typeof keys !== "object") {
      return null;
    }
    return (
      Object.entries(keys).find(
        ([, key]) =>
          typeof key === "string" &&
          key.trim() &&
          key.trim().toLowerCase() === event.key.toLowerCase(),
      )?.[0] ?? null
    );
  }

  function addVideoBookmark(video) {
    void (async () => {
      const { vapVideoBookmarks = [] } =
        await env.storage.local.get("vapVideoBookmarks");
      const bookmarks = Array.isArray(vapVideoBookmarks)
        ? vapVideoBookmarks
        : [];
      bookmarks.push({
        title: document.title,
        url: location.href,
        time: video.currentTime,
        createdAt: Date.now(),
      });
      await env.storage.local.set({
        vapVideoBookmarks: bookmarks.slice(-100),
      });
      showShortcutStatus(
        env.i18n.getMessage("shortcutBookmarkSaved", [
          formatMediaTime(video.currentTime),
        ]),
      );
    })().catch((error) => {
      console.error(
        "Video Auto Pause could not save a playback marker:",
        error,
      );
      showShortcutStatus(env.i18n.getMessage("shortcutActionFailed"));
    });
  }

  function saveVideoFrame(video) {
    if (!video.videoWidth || !video.videoHeight) {
      showShortcutStatus(env.i18n.getMessage("shortcutFrameUnavailable"));
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          showShortcutStatus(env.i18n.getMessage("shortcutActionFailed"));
          return;
        }
        const imageUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = imageUrl;
        link.download = `video-frame-${formatMediaTime(video.currentTime).replace(":", "-")}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(imageUrl), 1000);
        showShortcutStatus(env.i18n.getMessage("shortcutFrameSaved"));
      }, "image/png");
    } catch (error) {
      console.error("Video Auto Pause could not capture a video frame:", error);
      showShortcutStatus(env.i18n.getMessage("shortcutFrameUnavailable"));
    }
  }

  function toggleVideoLoop(video) {
    const loop = videoLoops.get(video);
    if (!loop) {
      videoLoops.set(video, { start: video.currentTime, end: null });
      if (!videosWithLoopListeners.has(video)) {
        video.addEventListener("timeupdate", () => {
          const activeLoop = videoLoops.get(video);
          if (
            activeLoop &&
            activeLoop.end !== null &&
            video.currentTime >= activeLoop.end
          ) {
            video.currentTime = activeLoop.start;
          }
        });
        videosWithLoopListeners.add(video);
      }
      showShortcutStatus(
        env.i18n.getMessage("shortcutLoopStart", [
          formatMediaTime(video.currentTime),
        ]),
      );
    } else if (loop.end === null && video.currentTime > loop.start) {
      loop.end = video.currentTime;
      showShortcutStatus(
        env.i18n.getMessage("shortcutLoopEnd", [
          formatMediaTime(loop.start),
          formatMediaTime(loop.end),
        ]),
      );
    } else {
      videoLoops.delete(video);
      showShortcutStatus(env.i18n.getMessage("shortcutLoopCleared"));
    }
  }

  async function runContentShortcut(action, video) {
    switch (action) {
      case "seekBackward":
      case "seekForward": {
        const delta = action === "seekBackward" ? -10 : 10;
        const duration = Number.isFinite(video.duration)
          ? video.duration
          : Number.POSITIVE_INFINITY;
        video.currentTime = Math.max(
          0,
          Math.min(duration, video.currentTime + delta),
        );
        break;
      }
      case "frameBackward":
      case "frameForward": {
        video.pause();
        const duration = Number.isFinite(video.duration)
          ? video.duration
          : Number.POSITIVE_INFINITY;
        video.currentTime = Math.max(
          0,
          Math.min(
            duration,
            video.currentTime + (action === "frameBackward" ? -1 / 30 : 1 / 30),
          ),
        );
        break;
      }
      case "toggleLoop":
        toggleVideoLoop(video);
        break;
      case "bookmark":
        addVideoBookmark(video);
        break;
      case "screenshot":
        saveVideoFrame(video);
        break;
      case "togglePip":
        if (
          !document.pictureInPictureEnabled ||
          video.disablePictureInPicture
        ) {
          showShortcutStatus(env.i18n.getMessage("shortcutActionUnsupported"));
        } else if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
        break;
      case "toggleCaptions": {
        const tracks = [...video.textTracks].filter((track) =>
          ["captions", "subtitles"].includes(track.kind),
        );
        if (tracks.length === 0) {
          showShortcutStatus(env.i18n.getMessage("shortcutActionUnsupported"));
          break;
        }
        const enable = tracks.every((track) => track.mode !== "showing");
        for (const track of tracks) {
          track.mode = enable ? "showing" : "disabled";
        }
        break;
      }
      default:
        return;
    }
  }

  function handleContentShortcut(event) {
    if (
      !settings.contentShortcutsEnabled ||
      settings.disabled ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      event.target?.closest?.(
        "input, textarea, select, [contenteditable='true'], [role='textbox'], .vap-video-overlay",
      ) ||
      !isSiteEnabled(location.hostname.toLowerCase(), settings)
    ) {
      return;
    }
    const action = getShortcutAction(event);
    const video = action && getShortcutVideo();
    if (!video) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void runContentShortcut(action, video).catch((error) => {
      console.error(`Video Auto Pause shortcut failed (${action}):`, error);
      showShortcutStatus(env.i18n.getMessage("shortcutActionFailed"));
    });
  }

  document.addEventListener("keydown", handleContentShortcut, true);

  function allMedia() {
    return [
      ...new Set([
        ...allVideos(),
        ...document.querySelectorAll("audio"),
        ...detectedAudio,
      ]),
    ].filter(
      (media) =>
        media.isConnected &&
        (media.tagName !== "AUDIO" ||
          !settings.allowAudio ||
          settings.prioritizeActiveTabMedia),
    );
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
    if (duration <= 0) {
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
    if (
      document.pictureInPictureElement === video ||
      (settings.autoPipOnTabSwitch &&
        autoDocumentPipWindow?.document.contains(video))
    ) {
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
    } else if (settings.fadeDuration > 0 && !document.hidden) {
      const volume = video.volume;
      originalVolumes.set(video, volume);
      await fadeAudio(video, 0, settings.fadeDuration);
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
    if (
      video.ended ||
      autoNextPausedVideos.has(video) ||
      (!extensionPausedVideos.has(video) && !video.paused)
    ) {
      return;
    }

    const targetVolume = originalVolumes.get(video);
    activeFades.get(video)?.cancel();
    if (
      settings.fadeDuration > 0 &&
      targetVolume !== undefined &&
      video.paused
    ) {
      setVideoVolume(video, 0);
    }
    const pausePosition = automaticPausePositions.get(video);
    if (
      pausePosition &&
      settings.rewindSeconds > 0 &&
      Number.isFinite(video.duration) &&
      video.duration > 0
    ) {
      const awaySeconds = Math.max(
        0,
        (Date.now() - pausePosition.pausedAt) / 1000,
      );
      const rewindSeconds = Math.min(
        settings.rewindSeconds * 2,
        settings.rewindSeconds * (1 + awaySeconds / 60),
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
      if (settings.fadeDuration > 0 && targetVolume !== undefined) {
        await fadeAudio(video, targetVolume, settings.fadeDuration);
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
    ".vjs-ima3-ad-mode",
    ".jw-flag-ads",
    ".shaka-ad-container",
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
    if (action === "toggleMute") {
      activeFades.get(video)?.cancel();
      video.muted = !video.muted;
      extensionMutedVideos.delete(video);
    } else if (action === "mute" && !extensionMutedVideos.has(video)) {
      extensionMutedVideos.set(video, {
        muted: video.muted,
        volume: video.volume,
      });
      if (settings.fadeDuration > 0 && !document.hidden && !video.muted) {
        await fadeAudio(video, 0, settings.fadeDuration);
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
        if (settings.fadeDuration > 0 && !document.hidden) {
          setVideoVolume(video, 0);
        }
        video.muted = original.muted;
        if (settings.fadeDuration > 0 && !document.hidden) {
          await fadeAudio(video, original.volume, settings.fadeDuration);
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
      showToast(env.i18n.getMessage("speedToast", [String(newRate)]));
    }
  };

  const handleVideoAction = async (video, request) => {
    const actionToken = {};
    videoActionTokens.set(video, actionToken);
    const isManuallyPaused =
      settings.manualPause && manuallyPausedVideos.get(video);

    switch (request.action) {
      case "stop":
        if (
          !isManuallyPaused &&
          video.paused &&
          request.pausePendingPlay === true
        ) {
          pauseOnNextPlay.set(video, Date.now() + 2000);
          break;
        }
        if (
          !isManuallyPaused &&
          settings.liveStreamMute &&
          video instanceof HTMLVideoElement &&
          video.duration === Number.POSITIVE_INFINITY
        ) {
          await handleMuteAction(video, "mute", actionToken);
          break;
        }
        if (
          !isManuallyPaused &&
          video instanceof HTMLVideoElement &&
          settings.muteDuringAds &&
          isAdPlaying()
        ) {
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
        if (
          video instanceof HTMLVideoElement &&
          settings.muteDuringAds &&
          isAdPlaying()
        ) {
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
      case "toggleMute":
        await handleMuteAction(video, request.action, actionToken);
        break;
      case "toggle":
        if (video.paused) {
          autoNextPausedVideos.delete(video);
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
          if (settings.manualPause) {
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
          settings.disableOnFullscreen
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
        !settings.singleVideoPlayback ||
        settings.disabled ||
        document.hidden ||
        (document.fullscreenElement && settings.disableOnFullscreen)
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

  function reportVideoHover(video, hovered) {
    if (hovered) {
      hoveredVideos.add(video);
    } else {
      hoveredVideos.delete(video);
    }
    sendMessage({ videoHovered: hoveredVideos.size > 0 });
  }

  function attachVideoListeners(videoElement, intersectionObserver) {
    detectedVideos.add(videoElement);
    attachMediaStateListeners(videoElement);

    // Track elements in memory: data attributes are copied by cloneNode(), so
    // they cannot tell whether this particular element has listeners.
    if (videosWithListeners.has(videoElement)) {
      return;
    }
    videosWithListeners.add(videoElement);
    videoElement.dataset.autoPauseListenerAttached = "true";
    videoElement.addEventListener("pointerenter", () => {
      reportVideoHover(videoElement, true);
    });
    videoElement.addEventListener("pointerleave", () => {
      reportVideoHover(videoElement, false);
    });
    videoElement.addEventListener("volumechange", () => {
      const original = extensionMutedVideos.get(videoElement);
      if (original && !videoElement.muted) {
        original.muted = false;
        videoElement.muted = true;
      }
    });
    applySiteSpeed(videoElement);
    if (settings.disableAutoplayNext) {
      videoElement.autoplay = false;
      videoElement.removeAttribute("autoplay");
    }

    if (settings.showPipButton) {
      injectPipButton(videoElement);
    }

    if (settings.showVideoOverlay) {
      injectVideoOverlay(videoElement);
    }

    intersectionObserver.observe(videoElement);
    videoResizeObserver?.observe(videoElement);

    videoElement.addEventListener("pause", () => {
      debugLog(
        `Pause event: automaticallyPaused=${automaticallyPausedVideos.has(videoElement)}, manualPause=${settings.manualPause}`,
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
        if (settings.manualPause) {
          debugLog(`Manually paused video`);
          manuallyPausedVideos.set(videoElement, true);
        }
      }
      scheduleVideoArbitration();
    });

    videoElement.addEventListener("play", (_e) => {
      const pauseDeadline = pauseOnNextPlay.get(videoElement);
      if (pauseDeadline !== undefined) {
        if (
          pauseDeadline >= Date.now() &&
          !extensionInitiatedPlays.has(videoElement)
        ) {
          automaticallyPausedVideos.add(videoElement);
          videoElement.pause();
          scheduleVideoArbitration();
          return;
        }
        pauseOnNextPlay.delete(videoElement);
      }
      debugLog(`Video resumed`);
      autoNextPausedVideos.delete(videoElement);
      if (
        settings.blockAutoplay &&
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
    // Apply the configured speed whenever a new source loads, but let the
    // user change it afterwards with the player, shortcuts, or overlay.
    videoElement.addEventListener("loadedmetadata", () => {
      applySiteSpeed(videoElement);
    });
  }

  function applyAutoplaySettings() {
    if (!settings.disableAutoplayNext) {
      return;
    }
    for (const video of allVideos()) {
      video.autoplay = false;
      video.removeAttribute("autoplay");
    }
    const autoplayToggle = document.querySelector(
      ".ytp-autonav-toggle-button[aria-checked='true'], #autonav-toggle-button[aria-checked='true']",
    );
    autoplayToggle?.click();
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
    btn.type = "button";
    btn.title = env.i18n.getMessage("pipTitle");
    btn.setAttribute("aria-label", btn.title);
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
    if (settings.showPipButton) {
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
    const speed = settings.playbackSpeed;
    if (
      settings.disabled ||
      !isSiteEnabled(location.hostname.toLowerCase(), settings) ||
      !Number.isFinite(speed) ||
      speed < 0.25 ||
      speed > 4
    ) {
      return;
    }
    if (Math.abs(video.playbackRate - speed) > 0.001) {
      video.playbackRate = speed;
    }
  }

  async function toggleCurrentSite() {
    const hostname = location.hostname.toLowerCase();
    const profileSettings = await getActiveProfileSettings();
    const existingRule = findSiteRule(hostname, profileSettings);
    await updateActiveProfileSettings({
      siteRules: upsertSiteRule(profileSettings.siteRules, {
        overrides: {},
        ...existingRule,
        domain: existingRule?.domain ?? hostname,
        enabled: !isSiteEnabled(hostname, profileSettings),
      }),
    });
  }

  function injectVideoOverlay(video) {
    if (videoOverlayCleanups.has(video)) {
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
    handle.className = "vap-overlay-handle";
    handle.textContent = env.i18n.getMessage("overlayDragHandle");
    handle.title = env.i18n.getMessage("overlayDragHandleHint");
    handle.tabIndex = 0;
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", handle.textContent);
    handle.setAttribute("aria-description", handle.title);
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
    speedLabel.title = env.i18n.getMessage("overlaySpeed");
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
      const enabled = isSiteEnabled(location.hostname.toLowerCase(), settings);
      siteButton.textContent = enabled
        ? env.i18n.getMessage("overlaySiteOn")
        : env.i18n.getMessage("overlaySiteOff");
      siteButton.title = env.i18n.getMessage("siteRuleEnabled");
      siteButton.setAttribute("aria-label", siteButton.title);
      siteButton.setAttribute("aria-pressed", String(enabled));
      pinButton.textContent = pinned ? "PIN" : "PIN+";
      pinButton.title = env.i18n.getMessage(
        pinned ? "unpinCurrentTab" : "pinCurrentTab",
      );
      pinButton.setAttribute(
        "aria-label",
        env.i18n.getMessage("pinCurrentTab"),
      );
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
        settingsReady = refreshSettings();
        await settingsReady;
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
        if (!overlay.matches(":hover, :focus-within")) {
          overlay.style.opacity = "0";
        }
      }, 2000);
    };
    const hideAfterLeave = () => {
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        if (!overlay.matches(":focus-within")) {
          overlay.style.opacity = "0";
        }
      }, 800);
    };
    container.addEventListener("mouseenter", show);
    container.addEventListener("mousemove", show);
    container.addEventListener("mouseleave", hideAfterLeave);
    overlay.addEventListener("mouseenter", show);
    overlay.addEventListener("focusin", show);
    overlay.addEventListener("focusout", hideAfterLeave);

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
    const keyboardMoves = {
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0],
      ArrowUp: [0, -10],
      ArrowDown: [0, 10],
    };
    handle.addEventListener("keydown", (event) => {
      const move = keyboardMoves[event.key];
      if (!move) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const { offsetLeft, offsetTop } = overlay;
      overlay.style.right = "auto";
      overlay.style.bottom = "auto";
      overlay.style.left = `${offsetLeft + move[0]}px`;
      overlay.style.top = `${offsetTop + move[1]}px`;
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
    if (settings.showVideoOverlay && !settings.disabled) {
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
      !settings.scrollpause ||
      !settings.autopause ||
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

  const intersectionObserver = new IntersectionObserver(
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
        attachVideoListeners(media, intersectionObserver);
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

  // Elements that may call attachShadow() (per the DOM standard). Only these
  // are polled for shadow roots attached after insertion.
  const shadowHostTags = new Set([
    "article",
    "aside",
    "blockquote",
    "body",
    "div",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "main",
    "nav",
    "p",
    "section",
    "span",
  ]);

  function canHostShadowRoot(element) {
    return (
      element.localName.includes("-") || shadowHostTags.has(element.localName)
    );
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
      } else if (canHostShadowRoot(element)) {
        shadowHosts.add(element);
      }
    }
  }

  function forgetShadowHosts(root) {
    if (shadowHosts.size === 0) {
      return;
    }
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
    for (const media of collectMedia()) {
      if (media.localName === "video") {
        attachVideoListeners(media, intersectionObserver);
      } else {
        attachAudioListeners(media);
      }
    }
    const videosFound = hasVideos();
    sendMessage({ hasVideos: videosFound });
    if (!videosFound && retries > 0) {
      setTimeout(() => observeExistingVideos(retries - 1), 1000);
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
            if (hoveredVideos.delete(media)) {
              sendMessage({ videoHovered: hoveredVideos.size > 0 });
            }
            videoOverlayCleanups.get(media)?.();
            videoOverlayCleanups.delete(media);
            detectedVideos.delete(media);
            visibleVideos.delete(media);
            intersectionObserver.unobserve(media);
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
            attachVideoListeners(media, intersectionObserver);
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

    if (settings.disableAutoplayNext) {
      applyAutoplaySettings();
    }
    if (changed) {
      sendMessage({ hasVideos: hasVideos() });
      reportMediaState();
      scheduleVideoArbitration();
    }
  });

  observeRoot(document);
  discoverShadowHosts(document);
  void settingsReady
    .then(() => {
      for (const video of allVideos()) {
        applySiteSpeed(video);
      }
      reportMediaState();
      scheduleVideoArbitration();
    })
    .catch((error) => {
      console.error(
        "Video Auto Pause could not initialize playback settings:",
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
