const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");

test.describe("Muting, ads, fading, and audio", () => {
  test("mutes live streams instead of pausing them when switching tabs", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      liveStreamMute: true,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate(async (element) => {
      await element.play();
      element.muted = false;
    });
    const worker = await extension.worker();
    const tabId = await worker.evaluate(
      (url) =>
        new Promise((resolve) =>
          chrome.tabs.query({ url }, (tabs) => resolve(tabs[0]?.id)),
        ),
      server.url("video.html"),
    );
    await worker.evaluate(
      (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          world: "ISOLATED",
          func: () => {
            Object.defineProperty(document.querySelector("#v"), "duration", {
              configurable: true,
              get: () => Number.POSITIVE_INFINITY,
            });
          },
        }),
      tabId,
    );

    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("muted", false);
  });

  test("mutes videos during ads, then pauses them once the ad ends", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      muteDuringAds: true,
      liveStreamMute: false,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate(async (element) => {
      await element.play();
      element.muted = false;
      const ad = document.createElement("div");
      ad.className = "ad-showing";
      ad.id = "test-ad";
      document.body.append(ad);
    });

    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);

    await page.locator("#test-ad").evaluate((ad) => ad.remove());
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", false);
  });

  test("recognizes generic, third-party, and YouTube player ad markers", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      muteDuringAds: true,
      liveStreamMute: false,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    const otherTab = await context.newPage();
    await otherTab.goto(server.url());

    for (const marker of ["generic", "youtube", "shaka", "ima"]) {
      await page.bringToFront();
      await video.evaluate(async (element, markerType) => {
        await element.play();
        element.muted = false;
        const ad = document.createElement("div");
        ad.id = "test-ad-marker";
        if (markerType === "generic") {
          ad.dataset.adPlaying = "true";
        } else if (markerType === "youtube") {
          ad.className = "video-ads ytp-ad-module";
          const activeOverlay = document.createElement("div");
          activeOverlay.className = "ytp-ad-player-overlay";
          activeOverlay.style.cssText =
            "position:fixed;width:10px;height:10px;top:0;left:0";
          ad.append(activeOverlay);
        } else {
          ad.className =
            markerType === "shaka" ? "shaka-ad-container" : "vjs-ima3-ad-mode";
        }
        document.body.append(ad);
      }, marker);

      await otherTab.bringToFront();
      await expect(video).toHaveJSProperty("paused", false);
      await expect(video).toHaveJSProperty("muted", true);
      await page.locator("#test-ad-marker").evaluate((ad) => ad.remove());
      await expect(video).toHaveJSProperty("paused", true);
      await page.bringToFront();
      await expect(video).toHaveJSProperty("paused", false);
      await expect(video).toHaveJSProperty("muted", false);
    }
  });

  test("should mute video instead of pausing when Mute Mode is enabled", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ muteVideo: true });

    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await video.evaluate(async (v) => {
      v.muted = false;
      await v.play();
    });
    await page.evaluate(() => {
      const userMutedVideo = document.createElement("video");
      userMutedVideo.id = "user-muted";
      userMutedVideo.src = document.querySelector("#v").src;
      userMutedVideo.muted = true;
      userMutedVideo.controls = true;
      document.body.appendChild(userMutedVideo);
    });
    const userMutedVideo = page.locator("#user-muted");
    await expect(userMutedVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await userMutedVideo.evaluate(async (element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", false);

    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));

    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(userMutedVideo).toHaveJSProperty("muted", true);

    await page.bringToFront();

    await expect(video).toHaveJSProperty("muted", false);
    await expect(userMutedVideo).toHaveJSProperty("muted", true);
  });

  test("should fade audio when pausing and resuming", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      focuspause: true,
      focusresume: true,
      fadeDuration: 600,
    });
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await video.evaluate(async (element) => {
      element.muted = false;
      element.volume = 0.8;
      await element.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
      .poll(() => video.evaluate((element) => element.volume))
      .toBeLessThan(0.8);
    await expect(video).toHaveJSProperty("paused", true);
    await expect(video).toHaveJSProperty("volume", 0.8);

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(video).toHaveJSProperty("paused", false);
    await expect
      .poll(() => video.evaluate((element) => element.volume))
      .toBe(0.8);
  });

  test("allows audio globally and lets site rules override the choice", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ allowAudio: true });
    await page.goto(server.url("video.html"));
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    const worker = await extension.worker();
    const createAudioAndPlay = async () =>
      page.evaluate(async () => {
        const audio = document.createElement("audio");
        audio.id = "audio-only";
        audio.src = "/audio.webm";
        audio.muted = true;
        document.body.append(audio);
        await new Promise((resolve, reject) => {
          audio.addEventListener("canplay", resolve, { once: true });
          audio.addEventListener("error", reject, { once: true });
        });
        await audio.play();
      });
    const sendStop = async () =>
      worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.sendMessage(tab.id, {
          action: "stop",
          immediate: true,
        });
      }, page.url());

    await createAudioAndPlay();
    await sendStop();
    await expect(page.locator("#audio-only")).toHaveJSProperty("paused", false);

    await extension.updateSettings({ allowAudio: false });
    await page.reload();
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await createAudioAndPlay();
    await sendStop();
    await expect(page.locator("#audio-only")).toHaveJSProperty("paused", true);

    await extension.updateSettings({
      allowAudio: false,
      siteRules: [
        {
          domain: "localhost",
          enabled: true,
          overrides: { allowAudio: true },
        },
      ],
    });
    await page.reload();
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await createAudioAndPlay();
    await sendStop();
    await expect(page.locator("#audio-only")).toHaveJSProperty("paused", false);
  });

  test("should prioritize active-tab media and resume the previous tab", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      prioritizeActiveTabMedia: true,
    });
    const firstVideo = await openVideoPage(page, server.url("video.html"));
    await firstVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", false);

    const emptyTab = await context.newPage();
    await emptyTab.goto(server.url());
    await expect(firstVideo).toHaveJSProperty("paused", false);

    const secondTab = await context.newPage();
    const secondVideo = await openVideoPage(
      secondTab,
      server.url("video.html"),
    );
    await secondVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", true);
    await expect(secondVideo).toHaveJSProperty("paused", false);

    await secondVideo.evaluate((element) => element.pause());
    await expect(firstVideo).toHaveJSProperty("paused", false);

    await secondVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", true);
    const worker = await extension.worker();
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            isMediaPlaying(priorityTabId) &&
            priorityHistory.some((tabId) => hasMedia(tabId)),
        ),
      )
      .toBe(true);
    await secondTab.close();
    await expect(firstVideo).toHaveJSProperty("paused", false);
  });

  test("should prioritize audio-only media across tabs", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await page.goto(server.url());
    await page.bringToFront();
    await page.evaluate(() => {
      const audio = document.createElement("audio");
      audio.id = "audio-only";
      audio.src = "/video.webm";
      audio.loop = true;
      document.body.appendChild(audio);
    });
    const audio = page.locator("#audio-only");
    await audio.evaluate((element) => element.play());
    await expect(audio).toHaveJSProperty("paused", false);
    await extension.updateSettings({ prioritizeActiveTabMedia: true });

    const videoTab = await context.newPage();
    await videoTab.goto(server.url("video.html"));
    await videoTab.bringToFront();
    const video = videoTab.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);
    await expect(audio).toHaveJSProperty("paused", true);

    await video.evaluate((element) => element.pause());
    await expect(audio).toHaveJSProperty("paused", false);
  });
});
