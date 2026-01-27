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
    debugMode: false,
    disableOnFullscreen: true,
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
        options.scrollpause = false;
        options.lockpause = false;
        options.lockresume = false;
        options.focuspause = false;
        options.focusresume = false;
        options.cursorTracking = false;
        options.debugMode = false;
        options.disableOnFullscreen = true;
        options.audioFading = false;
        options.fadeDuration = 200;
        options.showPipButton = false;
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

    if ("showPipButton" in changes) {
      togglePipButtons();
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

      const activeFades = new WeakMap();
      const originalVolumes = new WeakMap();

      const fadeAudio = (video, targetVolume, duration) => {
        if (!options.audioFading) return Promise.resolve();

        debugLog(
          `Fading audio for ${video} to ${targetVolume} over ${duration}ms`,
        );
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

      for (const element of videoElements) {
        try {
          const video = element;
          const isManuallyPaused = manuallyPausedVideos.get(video);

          if (request.action === "stop" && !isManuallyPaused) {
            if (document.pictureInPictureElement === video) {
                 debugLog(`Ignoring stop command for ${video} because it is in PiP`);
                 continue;
            }

            automaticallyPaused = true;
            if (options.audioFading && !video.paused) {
              if (!originalVolumes.has(video)) {
                originalVolumes.set(video, video.volume);
              }

              fadeAudio(video, 0, options.fadeDuration).then(() => {
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
              });
            } else {
              video.pause();
            }
          } else if (
            request.action === "resume" &&
            (video.paused || activeFades.has(video)) &&
            !isManuallyPaused
          ) {
            debugLog(
              `Attempting to resume video: paused=${video.paused}, manuallyPaused=${isManuallyPaused}`,
            );
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
                fadeAudio(video, targetVolume, options.fadeDuration);
              } else {
                await video.play();
              }
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

    if (options.showPipButton) {
      injectPipButton(videoElement);
    }

    intersection_observer.observe(videoElement);

    videoElement.addEventListener("pause", async (_e) => {
      debugLog(
        `Pause event: automaticallyPaused=${automaticallyPaused}, manualPause=${options.manualPause}`,
      );
      
      // Ignore pause events during PiP exit
      if (videoElement.dataset.returningFromPiP === "true") {
          debugLog("Ignoring pause event during PiP exit and enforcing playback");
          // If the browser paused it, force it to play again (seamless return)
          if (!document.hidden) {
              videoElement.play().catch(e => debugLog(`Failed to auto-resume from PiP: ${e}`));
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
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/></svg>';

    Object.assign(btn.style, {
      position: "absolute",
      top: "10px",
      right: "10px",
      zIndex: "99999",
      background: "rgba(0, 0, 0, 0.6)",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer",
      padding: "4px",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
    });

    const showBtn = () => {
      btn.style.display = "flex";
    };
    const hideBtn = () => {
      setTimeout(() => {
        if (!btn.matches(":hover") && !video.matches(":hover"))
          btn.style.display = "none";
      }, 1000);
    };

    video.addEventListener("mouseenter", showBtn);
    video.addEventListener("mouseleave", hideBtn);
    btn.addEventListener("mouseenter", showBtn);
    btn.addEventListener("mouseleave", hideBtn);

    video.addEventListener("enterpictureinpicture", () => {
        debugLog("Entered Picture-in-Picture");
    });

    video.addEventListener("leavepictureinpicture", () => {
        debugLog("Left Picture-in-Picture");
        // Mark that we are returning from PiP to prevent "manual pause" detection
        video.dataset.returningFromPiP = "true";
        setTimeout(() => {
             delete video.dataset.returningFromPiP;
        }, 1000);
        
        // Ensure we don't treat the transition as a manual pause if it continues playing
        if (!video.paused) {
             manuallyPausedVideos.delete(video);
        }
    });

    btn.addEventListener("click", async (e) => {
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

    const parent = video.parentElement || video.parentNode;
    if (parent) {
      if (window.getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
      parent.appendChild(btn);
    }
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
