const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");

test.describe("Focus, device, and schedule rules", () => {
  test("should pause media that starts while the computer remains locked", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ lockpause: true });
    await page.goto(server.url());

    const worker = await extension.worker();
    await expect
      .poll(() => worker.evaluate(() => globalSettings.lockpause))
      .toBe(true);

    await page.evaluate(() => {
      const video = document.createElement("video");
      video.id = "locked-restart";
      video.src = "/video.webm";
      video.muted = true;
      video.loop = true;
      document.body.append(video);
    });
    const video = page.locator("#locked-restart");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await worker.evaluate(() => handleIdleStateChanged("locked"));
    await video.evaluate((element) => element.play().catch(() => {}));
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should resume extension-paused media after unlock, not manual pauses", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      lockpause: true,
      lockresume: true,
      manualPause: true,
      singleVideoPlayback: false,
    });
    await page.goto(server.url("video.html"));
    const playingVideo = page.locator("#v");
    await playingVideo.evaluate((element) => element.play());
    await expect(playingVideo).toHaveJSProperty("paused", false);

    await page.evaluate(() => {
      const video = document.createElement("video");
      video.id = "manually-paused";
      video.src = document.querySelector("#v").src;
      video.muted = true;
      document.body.append(video);
    });
    const manuallyPausedVideo = page.locator("#manually-paused");
    await expect(manuallyPausedVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await manuallyPausedVideo.evaluate(async (element) => {
      await element.play();
      element.pause();
    });
    await expect(manuallyPausedVideo).toHaveJSProperty("paused", true);

    const worker = await extension.worker();
    await worker.evaluate(() => handleIdleStateChanged("locked"));
    await expect(playingVideo).toHaveJSProperty("paused", true);
    await worker.evaluate(() => handleIdleStateChanged("active"));

    await expect(playingVideo).toHaveJSProperty("paused", false);
    await expect(manuallyPausedVideo).toHaveJSProperty("paused", true);
  });

  test("should pause video when cursor moves to edge (cursorTracking)", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ cursorTracking: true });

    const video = await openVideoPage(page, server.url("video.html"));

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await page.mouse.move(0, 0);

    await expect(video).toHaveJSProperty("paused", true);

    await page.mouse.move(400, 300);

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should pause video when window loses focus (focuspause)", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ focuspause: true, focusresume: true });

    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(video).toHaveJSProperty("paused", true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should keep fullscreen video playing when focus is lost", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      focuspause: true,
      disableOnFullscreen: true,
    });
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "enter-fullscreen";
      button.textContent = "Fullscreen";
      button.addEventListener("click", () =>
        document.querySelector("#v").requestFullscreen(),
      );
      document.body.append(button);
    });
    await page.locator("#enter-fullscreen").click();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.waitForTimeout(500);
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should not resume media in a background window", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ focuspause: true, focusresume: true });
    await page.goto(server.url("video.html"));
    const firstVideo = page.locator("#v");
    await firstVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", false);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(firstVideo).toHaveJSProperty("paused", true);

    const secondTab = await context.newPage();
    await secondTab.goto(server.url("video.html"));
    await secondTab.bringToFront();
    const secondVideo = secondTab.locator("#v");
    await secondVideo.evaluate((element) => element.play());
    await expect(secondVideo).toHaveJSProperty("paused", false);

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(firstVideo).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(firstVideo).toHaveJSProperty("paused", false);
  });

  test("should react to page blur and focus events", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ focuspause: true, focusresume: true });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(video).toHaveJSProperty("paused", true);

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("pauses on idle timeout and during configured quiet hours", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      idlePauseMinutes: 1,
      quietHoursStart: "22:00",
      quietHoursEnd: "06:00",
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate((element) => element.play());
    const worker = await extension.worker();
    await expect
      .poll(() => worker.evaluate(() => globalSettings.idlePauseMinutes))
      .toBe(1);
    await worker.evaluate(() => handleIdleStateChanged("idle"));
    await expect(video).toHaveJSProperty("paused", true);
    await worker.evaluate(() => handleIdleStateChanged("active"));
    await expect(video).toHaveJSProperty("paused", false);

    await worker.evaluate(() =>
      applyQuietHours(new Date(2024, 5, 1, 23, 0), true),
    );
    await expect(video).toHaveJSProperty("paused", true);
    await worker.evaluate(() =>
      applyQuietHours(new Date(2024, 5, 2, 7, 0), true),
    );
    await expect(video).toHaveJSProperty("paused", false);
    await expect
      .poll(() =>
        worker.evaluate(() => ({
          overnight: isWithinQuietHours(
            "22:00",
            "06:00",
            new Date(2024, 5, 1, 23, 0),
          ),
          daytime: isWithinQuietHours(
            "22:00",
            "06:00",
            new Date(2024, 5, 1, 12, 0),
          ),
        })),
      )
      .toEqual({ overnight: true, daytime: false });
  });

  test("keeps a video playing on focus loss while it is hovered", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      focuspause: true,
      peekMode: true,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate((element) => element.play());
    await video.hover();
    const worker = await extension.worker();
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true,
          });
          return Object.values(tabVideoHover[tab.id] ?? {}).some(Boolean);
        }),
      )
      .toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(video).toHaveJSProperty("paused", false);
  });
});
