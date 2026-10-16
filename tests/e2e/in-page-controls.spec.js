const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");

test.describe("In-page controls", () => {
  test("uses remapped in-page video shortcuts and ignores editable controls", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      contentShortcutsEnabled: true,
      contentShortcutKeys: {
        seekBackward: "k",
        seekForward: "",
        frameBackward: "",
        frameForward: "",
        toggleLoop: "",
        bookmark: "",
        screenshot: "",
        togglePip: "",
        toggleCaptions: "",
      },
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate((element) => {
      element.pause();
      element.currentTime = 5;
    });
    await page.keyboard.press("k");
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBe(0);

    await video.evaluate((element) => (element.currentTime = 5));
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "shortcut-test-input";
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press("k");
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBe(5);
  });

  test("supports A-B loops, local playback markers, and caption shortcuts", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ contentShortcutsEnabled: true });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate((element) => {
      element.pause();
      element.currentTime = 1;
    });
    await page.keyboard.press("b");
    await video.evaluate((element) => (element.currentTime = 3));
    await page.keyboard.press("b");
    await video.evaluate((element) => {
      element.currentTime = 4;
      element.dispatchEvent(new Event("timeupdate"));
    });
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBe(1);

    await page.keyboard.press("m");
    const worker = await extension.worker();
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          chrome.storage.local.get("vapVideoBookmarks"),
        ),
      )
      .toMatchObject({
        vapVideoBookmarks: [
          expect.objectContaining({
            title: "Test",
            time: 1,
          }),
        ],
      });

    await video.evaluate((element) => {
      element.addTextTrack("captions", "English", "en");
    });
    await page.keyboard.press("c");
    await expect
      .poll(() => video.evaluate((element) => element.textTracks[0].mode))
      .toBe("showing");
  });

  test("shows draggable video controls for playback, speed, and site rules", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      showVideoOverlay: true,
      singleVideoPlayback: false,
    });
    await page.goto(server.url("video.html"));
    await page.bringToFront();
    const video = page.locator("#v");
    const overlay = page.locator(".vap-video-overlay");
    await expect(overlay).toBeAttached({ timeout: 10000 });
    await video.hover();
    await expect(overlay).toHaveCSS("opacity", "1");

    await overlay.locator('[data-action="toggle"]').click();
    await expect(video).toHaveJSProperty("paused", true);
    await overlay.locator('[data-action="toggle"]').click();
    await expect(video).toHaveJSProperty("paused", false);
    await overlay.locator('[data-action="speed-up"]').click();
    await expect(video).toHaveJSProperty("playbackRate", 1.25);

    const before = await overlay.boundingBox();
    const dragHandle = overlay.locator(".vap-overlay-handle");
    await dragHandle.hover();
    await page.mouse.down();
    await page.mouse.move(before.x + 70, before.y + 35);
    await page.mouse.up();
    const after = await overlay.boundingBox();
    expect(
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
    ).toBeGreaterThan(10);

    const siteToggle = overlay.locator('[data-action="site-toggle"]');
    await siteToggle.click();
    await expect(siteToggle).toHaveAttribute("aria-pressed", "false");
    const worker = await extension.worker();
    await expect
      .poll(
        async () =>
          (await extension.getSettings()).siteRules.find(
            (rule) => rule.domain === "localhost",
          )?.enabled,
      )
      .toBe(false);
    await siteToggle.click();
    await expect(siteToggle).toHaveAttribute("aria-pressed", "true");
  });

  test("supports touch interaction with the video overlay", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      showVideoOverlay: true,
      singleVideoPlayback: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.url("video.html"));
    await page.bringToFront();
    const video = page.locator("#v");
    const overlay = page.locator(".vap-video-overlay");
    await expect(overlay).toBeAttached({ timeout: 10000 });
    await overlay.evaluate((element) => (element.style.opacity = "1"));
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);
    const toggle = overlay.locator('[data-action="toggle"]');
    const bounds = await toggle.boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
      configuration: "mobile",
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          id: 1,
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          radiusX: 1,
          radiusY: 1,
          force: 1,
        },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(video).toHaveJSProperty("paused", true);
    await cdp.detach();
  });

  test("should show PIP button when enabled", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    const pipEnabled = await page.evaluate(
      () => document.pictureInPictureEnabled,
    );
    if (!pipEnabled) {
      test.skip(true, "PiP not enabled");
    }

    await extension.updateSettings({ showPipButton: true });
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );

    await video.hover();

    const btn = page.locator(".vap-pip-btn");
    await expect(btn).toBeAttached({ timeout: 5000 });

    await btn.evaluate((b) => (b.style.display = "block"));
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test("should apply playback commands to the active tab", async ({
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
    await worker.evaluate(() => handleCommand("toggle-play"));
    await expect(video).toHaveJSProperty("paused", true);

    await worker.evaluate(() => handleCommand("toggle-play"));
    await expect(video).toHaveJSProperty("paused", false);

    await worker.evaluate(() => handleCommand("toggle_mute"));
    await expect(video).toHaveJSProperty("muted", false);

    await worker.evaluate(() => handleCommand("speed-up"));
    await expect(video).toHaveJSProperty("playbackRate", 1.25);
    await worker.evaluate(() => handleCommand("speed-down"));
    await expect(video).toHaveJSProperty("playbackRate", 1);
    await worker.evaluate(() => handleCommand("speed-down"));
    await expect(video).toHaveJSProperty("playbackRate", 0.75);
    await worker.evaluate(() => handleCommand("speed-reset"));
    await expect(video).toHaveJSProperty("playbackRate", 1);

    await worker.evaluate(() => handleCommand("toggle-tab"));
    await expect.poll(() => worker.evaluate(() => disabledTabs.length)).toBe(1);
    await worker.evaluate(() => handleCommand("toggle-tab"));
    await expect.poll(() => worker.evaluate(() => disabledTabs.length)).toBe(0);

    await worker.evaluate(() => handleCommand("toggle-extension"));
    await expect
      .poll(() => worker.evaluate(() => globalSettings.disabled))
      .toBe(true);
    await worker.evaluate(() => handleCommand("toggle-extension"));
    await expect
      .poll(() => worker.evaluate(() => globalSettings.disabled))
      .toBe(false);
  });

  test("makes the video overlay usable with a keyboard and screen reader", async ({
    page,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      showVideoOverlay: true,
      showPipButton: true,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    const overlay = page.locator(".vap-video-overlay");
    await expect(overlay).toBeAttached({ timeout: 10000 });
    await expect(overlay).toHaveCSS("opacity", "0");

    const handle = overlay.getByRole("button", { name: "Move" });
    await handle.focus();
    await expect(overlay).toHaveCSS("opacity", "1");
    await expect(handle).toHaveAttribute("title", /arrow keys/);
    const before = await overlay.boundingBox();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    const after = await overlay.boundingBox();
    expect(Math.round(before.x - after.x)).toBe(10);
    expect(Math.round(before.y - after.y)).toBe(10);

    const pin = overlay.getByRole("button", {
      name: "Keep playing in this tab",
    });
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(pin).toHaveAccessibleName("Keep playing in this tab");
    await expect(pin).toHaveAttribute("title", "Remove keep-playing pin");
    await expect(
      overlay.getByRole("button", {
        name: "Enable the extension on this site",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(overlay.locator(".vap-speed-label")).toHaveAttribute(
      "title",
      "Current playback speed",
    );
    const pipButton = page.locator(".vap-pip-btn");
    if (await pipButton.count()) {
      await expect(pipButton).toHaveAccessibleName("Toggle Picture-in-Picture");
    }
    await expect(video).toBeAttached();
  });

  test("keeps speed changes made after the configured speed is applied", async ({
    page,
    server,
    extension,
  }) => {
    await extension.updateSettings({ playbackSpeed: 1.5 });
    const video = await openVideoPage(page, server.url("video.html"));
    await expect(video).toHaveJSProperty("playbackRate", 1.5);
    await video.evaluate((element) => (element.playbackRate = 2));
    await extension.evaluate(() => handleCommand("speed-up"));
    await expect(video).toHaveJSProperty("playbackRate", 2.25);
    await playVideo(video);
    await expect(video).toHaveJSProperty("playbackRate", 2.25);

    await video.evaluate((element) => {
      element.src = element.src.replace(/\?.*$/, "") + "?next";
    });
    await expect(video).toHaveJSProperty("playbackRate", 1.5);
  });
});
