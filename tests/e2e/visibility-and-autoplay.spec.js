const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");

test.describe("Visibility and autoplay", () => {
  test("should block autoplay until the user interacts with the page", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ blockAutoplay: true });
    const video = await openVideoPage(page, server.url("video.html"));

    await video.evaluate((element) => {
      element.autoplay = true;
      element.play().catch(() => {});
    });
    await expect(video).toHaveJSProperty("paused", true);

    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "user-play";
      button.textContent = "Play";
      button.addEventListener("click", () => {
        document.querySelector("#v").play();
      });
      document.body.append(button);
    });
    await page.locator("#user-play").click();
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("prevents automatic next playback after a video ends", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      pauseAtEnd: true,
      disableAutoplayNext: true,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await page.evaluate(() => {
      const control = document.createElement("button");
      control.setAttribute("aria-label", "Next episode");
      control.addEventListener("click", () => {
        window.nextEpisodeClicked = true;
      });
      document.body.append(control);
      control.click();
    });
    expect(
      await page.evaluate(() => window.nextEpisodeClicked),
    ).toBeUndefined();

    await page.evaluate(async () => {
      const current = document.querySelector("#v");
      current.dispatchEvent(new Event("ended"));
      const next = document.createElement("video");
      next.id = "automatic-next";
      next.src = current.currentSrc;
      next.muted = true;
      document.body.append(next);
      try {
        await next.play();
      } catch (error) {
        if (!["AbortError", "NotAllowedError"].includes(error.name)) {
          throw error;
        }
      }
    });
    await expect
      .poll(() =>
        page.locator("#automatic-next").evaluate((element) => element.paused),
      )
      .toBe(true);
  });

  test("stops autoplay-next and applies the sleep timer", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      disableAutoplayNext: true,
      singleVideoPlayback: false,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await expect(video).toHaveJSProperty("autoplay", false);
    await page.evaluate(() => {
      const toggle = document.createElement("button");
      toggle.className = "ytp-autonav-toggle-button";
      toggle.setAttribute("aria-checked", "true");
      toggle.addEventListener("click", () => {
        toggle.setAttribute("aria-checked", "false");
      });
      document.body.append(toggle);
    });
    await expect(page.locator(".ytp-autonav-toggle-button")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    const worker = await extension.worker();
    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    const optionsPage = await context.newPage();
    await optionsPage.goto(`${optionsUrl}?popup`);
    await expect(optionsPage.locator("#sleepTimerSection")).not.toHaveAttribute(
      "open",
      "",
    );
    await optionsPage.locator("#sleepTimerSection summary").click();
    await expect(optionsPage.locator("#sleepTimerMinutes option")).toHaveText([
      "5",
      "10",
      "15",
      "30",
      "60",
    ]);
    await optionsPage.locator("#sleepTimerMinutes").selectOption("5");
    await optionsPage.locator("#startSleepTimer").click();
    await expect(optionsPage.locator("#cancelSleepTimer")).toBeVisible();
    await optionsPage.reload();
    await expect(optionsPage.locator("#cancelSleepTimer")).toBeVisible();
    await expect(optionsPage.locator("#sleepTimerSection")).toHaveAttribute(
      "open",
      "",
    );
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const alarm = await chrome.alarms.get("vap-sleep-timer");
          const stored = await chrome.storage.local.get(
            "vapSleepTimerExpiresAt",
          );
          return Boolean(
            alarm &&
            stored.vapSleepTimerExpiresAt > Date.now() &&
            stored.vapSleepTimerExpiresAt - Date.now() <= 5 * 60 * 1000,
          );
        }),
      )
      .toBe(true);
    await worker.evaluate(() => pauseEverythingForSleepTimer());
    await expect(video).toHaveJSProperty("paused", true);
    await expect(optionsPage.locator("#sleepTimerSection")).not.toHaveAttribute(
      "open",
      "",
    );
  });

  test("should pause video when scrolling out of view", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({ scrollpause: true });

    const video = await openVideoPage(page, server.url("video.html"));

    await page.evaluate(() => {
      document.body.style.height = "5000px";
      const spacer = document.createElement("div");
      spacer.style.height = "2000px";
      document.body.appendChild(spacer);
    });

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await page.evaluate(() => window.scrollTo(0, 2000));

    await expect(video).toHaveJSProperty("paused", true);

    await page.evaluate(() => window.scrollTo(0, 0));

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should keep playing while any video remains visible", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      scrollpause: true,
      singleVideoPlayback: false,
    });
    await page.goto(server.url("video.html"));
    const video = page.locator("#v");
    await page.evaluate(() => {
      const visibleVideo = document.createElement("video");
      visibleVideo.id = "visible-video";
      visibleVideo.src = document.querySelector("#v").src;
      visibleVideo.muted = true;
      visibleVideo.style.position = "fixed";
      visibleVideo.style.top = "10px";
      visibleVideo.style.right = "10px";
      visibleVideo.style.width = "100px";
      visibleVideo.style.height = "60px";
      document.body.appendChild(visibleVideo);
      document.body.style.height = "5000px";
      const spacer = document.createElement("div");
      spacer.style.height = "2000px";
      document.body.appendChild(spacer);
    });
    const visibleVideo = page.locator("#visible-video");
    await expect(visibleVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate(async (element) => element.play());
    await visibleVideo.evaluate(async (element) => element.play());

    await page.evaluate(() => window.scrollTo(0, 2000));
    await expect(video).toHaveJSProperty("paused", false);

    await visibleVideo.evaluate((element) => {
      element.style.display = "none";
    });
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should keep only the most visible video playing", async ({
    page,
    server,
  }) => {
    const smallerVideo = await openVideoPage(page, server.url("video.html"));

    await page.evaluate(() => {
      const smaller = document.querySelector("#v");
      Object.assign(smaller.style, {
        position: "fixed",
        top: "20px",
        left: "20px",
        width: "100px",
        height: "80px",
      });
      smaller.muted = true;
      smaller.loop = true;

      const larger = document.createElement("video");
      larger.id = "larger-video";
      larger.src = smaller.src;
      larger.muted = true;
      larger.loop = true;
      Object.assign(larger.style, {
        position: "fixed",
        top: "20px",
        left: "200px",
        width: "240px",
        height: "160px",
      });
      document.body.appendChild(larger);
    });

    const largerVideo = page.locator("#larger-video");
    await expect(largerVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await Promise.all([
      smallerVideo.evaluate((video) => video.play()),
      largerVideo.evaluate((video) => video.play()),
    ]);
    await expect(largerVideo).toHaveJSProperty("paused", false);
    await expect(smallerVideo).toHaveJSProperty("paused", true);

    await page.evaluate(() => {
      const smaller = document.querySelector("#v");
      const larger = document.querySelector("#larger-video");
      Object.assign(smaller.style, { width: "320px", height: "200px" });
      Object.assign(larger.style, { width: "100px", height: "80px" });
      window.dispatchEvent(new Event("resize"));
    });
    await expect(smallerVideo).toHaveJSProperty("paused", false);
    await expect(largerVideo).toHaveJSProperty("paused", true);
  });
});
