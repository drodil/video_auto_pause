const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");

test.describe("Tab switching", () => {
  test("should pause video when switching tabs", async ({
    page,
    context,
    server,
  }) => {
    const video = await openVideoPage(page, server.url("video.html"));

    await video.evaluate(async (v) => {
      await v.play();
    });

    await expect(video).toHaveJSProperty("paused", false);

    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));

    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should leave video playing on tab switches when autopause is disabled", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ autopause: false });
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const nextPage = await context.newPage();
    await nextPage.goto(server.url("video.html"));
    await expect(video).toHaveJSProperty("paused", false);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should resume browser-blocked autoplay when activating a background tab", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ manualPause: false });
    await page.goto(server.url());

    const worker = await extension.worker();
    const [backgroundPage] = await Promise.all([
      context.waitForEvent("page"),
      worker.evaluate(
        (url) =>
          new Promise((resolve) =>
            chrome.tabs.create({ url, active: false }, resolve),
          ),
        server.url("video.html"),
      ),
    ]);
    await backgroundPage.waitForLoadState();
    const video = backgroundPage.locator("#v");
    await expect(video).toBeAttached();
    await video.evaluate((element) => {
      element.autoplay = false;
      element.removeAttribute("autoplay");
      element.pause();
    });
    await expect(video).toHaveJSProperty("paused", true);

    await backgroundPage.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should control SPA videos inserted and replaced after page load", async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url());
    await page.bringToFront();
    await page.evaluate(() => {
      const video = document.createElement("video");
      video.id = "spa-video";
      video.src = "/video.webm";
      video.muted = true;
      video.loop = true;
      document.body.append(video);
    });

    const video = page.locator("#spa-video");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);

    await page.evaluate(() => {
      const currentVideo = document.querySelector("#spa-video");
      const replacement = currentVideo.cloneNode();
      replacement.id = "spa-video-replacement";
      currentVideo.replaceWith(replacement);
    });
    const replacement = page.locator("#spa-video-replacement");
    await expect(replacement).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await replacement.evaluate((element) => element.play());
    await otherTab.bringToFront();
    await expect(replacement).toHaveJSProperty("paused", true);
  });

  test("should control video playback inside a cross-origin iframe", async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url());
    await page.bringToFront();
    await page.evaluate(
      (frameUrl) => {
        const frame = document.createElement("iframe");
        frame.src = frameUrl;
        document.body.append(frame);
      },
      server.url("video.html", "127.0.0.1"),
    );

    const video = page.frameLocator("iframe").locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should pause previous tab after service worker restarts", async ({
    page,
    context,
    server,
  }) => {
    const devtools = await context.newCDPSession(page);
    let workerVersion;
    let workerStopped = false;
    devtools.on("ServiceWorker.workerVersionUpdated", (event) => {
      workerVersion =
        event.versions.find((version) =>
          version.scriptURL.endsWith("/vap_bs.js"),
        ) ?? workerVersion;
      workerStopped ||= workerVersion?.runningStatus === "stopped";
    });
    await devtools.send("ServiceWorker.enable");

    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate(async (element) => {
      await element.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await expect.poll(() => workerVersion?.runningStatus).toBe("running");
    await devtools.send("ServiceWorker.stopWorker", {
      versionId: workerVersion.versionId,
    });
    // A content-script message may restart the worker right away, so check
    // that it stopped at some point rather than polling the current state.
    await expect.poll(() => workerStopped).toBe(true);

    const nextPage = await context.newPage();
    await nextPage.goto(server.url("video.html"));
    await expect
      .poll(async () => {
        return workerVersion?.runningStatus === "running";
      })
      .toBe(true);

    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should control videos in open shadow roots", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ singleVideoPlayback: false });
    await page.goto(server.url("video.html"));
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "shadow-player";
      document.body.appendChild(host);
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const host = document.querySelector("#shadow-player");
      const shadow = host.attachShadow({ mode: "open" });
      const video = document.createElement("video");
      video.id = "shadow-video";
      video.src = document.querySelector("#v").src;
      video.muted = true;
      video.controls = true;
      shadow.appendChild(video);
    });

    const video = page.locator("#shadow-video");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate(async (element) => element.play());
    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should NOT pause video when disabled", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ disabled: true });

    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await video.evaluate(async (v) => {
      await v.play();
    });
    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));

    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should not pause video in a disabled tab", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const worker = await extension.worker();
    const tabId = await worker.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) =>
            resolve(tabs[0].id),
          ),
        ),
    );
    await worker.evaluate(
      (id) =>
        new Promise((resolve) =>
          chrome.storage.session.set({ disabledTabs: [id] }, resolve),
        ),
      tabId,
    );

    await context.newPage();
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should NOT resume video if manually paused (manualPause)", async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await video.evaluate(async (v) => {
      v.pause();
    });
    await expect(video).toHaveJSProperty("paused", true);

    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));

    await page.bringToFront();
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should NOT resume video when autoresume is disabled", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ autoresume: false });

    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));

    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should keep manually paused video stopped when autoresume is disabled", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ autoresume: false });
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    await video.evaluate((element) => element.pause());
    await expect(video).toHaveJSProperty("paused", true);

    const otherTab = await context.newPage();
    await otherTab.goto(server.url());
    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should restore saved behavior after disabling and re-enabling", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await video.evaluate(async (element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));
    await expect(video).toHaveJSProperty("paused", true);

    await extension.updateSettings({ disabled: true });
    await extension.updateSettings({ disabled: false });
    await page.bringToFront();

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should only resume videos paused by the extension", async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await page.evaluate(() => {
      const secondVideo = document.createElement("video");
      secondVideo.id = "not-started";
      secondVideo.src = document.querySelector("#v").src;
      secondVideo.controls = true;
      document.body.appendChild(secondVideo);
    });
    const notStartedVideo = page.locator("#not-started");
    await expect(notStartedVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );

    await video.evaluate(async (element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);
    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect(notStartedVideo).toHaveJSProperty("paused", true);
  });

  test("keeps a pinned tab playing and shows its badge until unpinned", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      showVideoOverlay: true,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate((element) => element.play());
    const pinButton = page.locator(
      ".vap-video-overlay [data-action='pin-toggle']",
    );
    await expect(pinButton).toHaveAttribute("aria-pressed", "false");
    await pinButton.click();
    await expect(pinButton).toHaveAttribute("aria-pressed", "true");

    const worker = await extension.worker();
    const tabId = await worker.evaluate(
      (url) =>
        new Promise((resolve) =>
          chrome.tabs.query({ url }, (tabs) => resolve(tabs[0]?.id)),
        ),
      server.url("video.html"),
    );
    await expect
      .poll(() =>
        worker.evaluate(
          (id) => chrome.action.getBadgeText({ tabId: id }),
          tabId,
        ),
      )
      .toBe("PIN");

    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", false);
    await page.bringToFront();
    await pinButton.click();
    await expect(pinButton).toHaveAttribute("aria-pressed", "false");
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should honor pause and resume delays", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ pauseDelay: 1200, resumeDelay: 1200 });
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    await context.newPage();
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("rewinds automatically resumed finite videos by the configured amount", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      rewindSeconds: 4,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await expect
      .poll(() =>
        video.evaluate((element) => Number.isFinite(element.duration)),
      )
      .toBe(true);

    const startTime = await video.evaluate((element) => {
      const target = Math.min(
        element.duration - 1,
        Math.max(5, element.duration / 2),
      );
      element.currentTime = target;
      return target;
    });
    await video.evaluate((element) => element.play());
    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeLessThan(startTime - 3);
  });

  test("does not rewind live streams when they resume", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      rewindSeconds: 4,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    const startTime = await video.evaluate((element) => {
      element.currentTime = 5;
      Object.defineProperty(element, "duration", {
        configurable: true,
        get: () => Number.POSITIVE_INFINITY,
      });
      return element.currentTime;
    });
    await video.evaluate((element) => element.play());
    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeGreaterThan(startTime - 0.5);
  });

  test("attaches listeners to cloned videos that copy extension attributes", async ({
    page,
    context,
    server,
  }) => {
    const original = await openVideoPage(page, server.url("video.html"));
    await page.evaluate(() => {
      const clone = document.querySelector("#v").cloneNode();
      clone.id = "clone";
      document.body.append(clone);
    });
    const clone = page.locator("#clone");
    await expect(clone).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
    );
    await original.evaluate((element) => element.remove());
    await playVideo(clone);

    // A manual pause is only remembered when the clone has its own listeners.
    await clone.evaluate((element) => element.pause());
    const otherTab = await switchToNewTab(context, server);
    await page.bringToFront();
    await page.waitForTimeout(1000);
    await expect(clone).toHaveJSProperty("paused", true);

    await playVideo(clone);
    await otherTab.bringToFront();
    await expect(clone).toHaveJSProperty("paused", true);
    await page.bringToFront();
    await expect(clone).toHaveJSProperty("paused", false);
  });
});
