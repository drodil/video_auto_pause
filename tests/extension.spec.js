import { test as base, chromium, expect } from "@playwright/test";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";

const chromeExtensionPath = path.join(__dirname, "../test-dist/chrome");
let port;
let server;

const startServer = async () => {
  const portFinder = net.createServer();
  await new Promise((resolve) => portFinder.listen(0, "127.0.0.1", resolve));
  port = portFinder.address().port;
  await new Promise((resolve) => portFinder.close(resolve));

  const pythonExecutable = process.platform === "win32" ? "python" : "python3";
  server = spawn(pythonExecutable, ["-m", "http.server", String(port)], {
    cwd: path.join(__dirname),
    stdio: "ignore",
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      settle(reject, new Error("Test HTTP server did not start in time"));
    }, 10000);
    server.once("error", (error) => settle(reject, error));
    const checkServer = () => {
      if (settled) return;
      if (server.exitCode !== null) {
        settle(
          reject,
          new Error(`Test HTTP server exited with code ${server.exitCode}`),
        );
        return;
      }
      const connection = net.createConnection({ host: "127.0.0.1", port });
      connection.once("connect", () => {
        connection.end();
        settle(resolve);
      });
      connection.once("error", () => {
        connection.destroy();
        if (!settled) setTimeout(checkServer, 100);
      });
    };
    checkServer();
  });
};

const test = base.extend({
  context: async ({ browserName }, use) => {
    if (!server) await startServer();

    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `${browserName}-user-data-`),
    );

    let context;
    if (browserName === "chromium") {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
          `--disable-extensions-except=${chromeExtensionPath}`,
          `--load-extension=${chromeExtensionPath}`,
          "--no-sandbox",
          "--disable-gpu",
        ],
      });
    } else {
      throw new Error(
        `Browser ${browserName} is not supported for extension testing`,
      );
    }

    let extensionId;
    const captureId = (url) => {
      if (url.startsWith("chrome-extension://")) {
        extensionId = url.split("/")[2];
      }
    };

    if (browserName === "chromium") {
      for (const sw of context.serviceWorkers()) {
        captureId(sw.url());
      }
      context.on("serviceworker", async (sw) => {
        captureId(sw.url());
      });
    }

    context.updateSettings = async (settings) => {
      if (!extensionId) {
        for (let i = 0; i < 10; i++) {
          if (extensionId) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!extensionId) throw new Error("Extension ID not captured yet");
      }

      let worker = context
        .serviceWorkers()
        .find((candidate) => candidate.url().includes(extensionId));
      if (!worker) {
        worker = await context.waitForEvent("serviceworker", {
          predicate: (candidate) => candidate.url().includes(extensionId),
          timeout: 10000,
        });
      }
      await worker.evaluate(
        (newSettings) =>
          new Promise((resolve, reject) => {
            chrome.storage.sync.set(newSettings, () => {
              const error = chrome.runtime.lastError;
              if (error) {
                reject(new Error(error.message));
              } else {
                resolve();
              }
            });
          }),
        settings,
      );
    };

    await use(context);
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (e) {}
  },
  page: async ({ context }, use) => {
    const page = (await context.pages()[0]) || (await context.newPage());
    await use(page);
  },
});

test.afterAll(() => {
  if (server) server.kill();
});

test.describe("Video Auto Pause Extension", () => {
  test.beforeEach(async ({ page }) => {
    await page.waitForTimeout(1000);
  });

  test("should pause video when switching tabs", async ({ page, context }) => {
    await page.goto(`http://localhost:${port}/video.html`);

    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );

    await video.evaluate(async (v) => {
      await v.play();
    });

    await expect(video).toHaveJSProperty("paused", false);

    const page2 = await context.newPage();
    await page2.goto(`http://localhost:${port}/video.html`);

    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();

    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should resume browser-blocked autoplay when activating a background tab", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ manualPause: false });
    await page.goto(`http://localhost:${port}/`);

    const worker = context.serviceWorkers()[0];
    const [backgroundPage] = await Promise.all([
      context.waitForEvent("page"),
      worker.evaluate(
        (url) =>
          new Promise((resolve) =>
            chrome.tabs.create({ url, active: false }, resolve),
          ),
        `http://localhost:${port}/video.html`,
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

  test("should block autoplay until the user interacts with the page", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ blockAutoplay: true });
    await page.goto(`http://localhost:${port}/video.html`);

    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );

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

  test("should pause previous tab after service worker restarts", async ({
    page,
    context,
  }) => {
    const devtools = await context.newCDPSession(page);
    let workerVersion;
    devtools.on("ServiceWorker.workerVersionUpdated", (event) => {
      workerVersion =
        event.versions.find((version) =>
          version.scriptURL.endsWith("/vap_bs.js"),
        ) ?? workerVersion;
    });
    await devtools.send("ServiceWorker.enable");

    await page.goto(`http://localhost:${port}/video.html`);

    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate(async (element) => {
      await element.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await expect.poll(() => workerVersion?.runningStatus).toBe("running");
    await devtools.send("ServiceWorker.stopWorker", {
      versionId: workerVersion.versionId,
    });
    await expect.poll(() => workerVersion?.runningStatus).toBe("stopped");

    const nextPage = await context.newPage();
    await nextPage.goto(`http://localhost:${port}/video.html`);
    await expect
      .poll(async () => {
        return workerVersion?.runningStatus === "running";
      })
      .toBe(true);

    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should pause video when scrolling out of view", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ scrollpause: true });

    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toBeAttached();
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );

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
    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", true);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should keep playing while any video remains visible", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      scrollpause: true,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
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

  test("should keep only the most visible video playing", async ({ page }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    const smallerVideo = page.locator("#v");
    await expect(smallerVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );

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

  test("should show PIP button when enabled", async ({ page, context }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    const pipEnabled = await page.evaluate(
      () => document.pictureInPictureEnabled,
    );
    if (!pipEnabled) {
      test.skip(true, "PiP not enabled");
    }

    await context.updateSettings({ showPipButton: true });
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

  test("should clamp negative delay values in the options page", async ({
    context,
  }) => {
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent("serviceworker");
    }
    expect(worker).toBeDefined();
    const extensionId = new URL(worker.url()).host;
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    const pauseDelay = optionsPage.locator("#pauseDelay");
    await expect(pauseDelay).toBeVisible();
    await pauseDelay.fill("-250");
    await pauseDelay.dispatchEvent("change");

    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            new Promise((resolve) =>
              chrome.storage.sync.get("pauseDelay", (result) =>
                resolve(result.pauseDelay),
              ),
            ),
        ),
      )
      .toBe(0);
  });

  test("should honor pause and resume delays", async ({ page, context }) => {
    await context.updateSettings({ pauseDelay: 1200, resumeDelay: 1200 });
    await page.goto(`http://localhost:${port}/video.html`);
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

  test("should pause video when cursor moves to edge (cursorTracking)", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ cursorTracking: true });

    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toBeAttached();
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    await page.mouse.move(0, 0);
    await page.waitForTimeout(1000);

    await expect(video).toHaveJSProperty("paused", true);

    await page.mouse.move(400, 300);
    await page.waitForTimeout(1000);

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should NOT pause video when disabled", async ({ page, context }) => {
    await context.updateSettings({ disabled: true });

    await page.goto(`http://localhost:${port}/video.html`);
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
    await page2.goto(`http://localhost:${port}/video.html`);

    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should not pause video in a disabled tab", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const worker = context.serviceWorkers()[0];
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

  test("should pause video when window loses focus (focuspause)", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ focuspause: true, focusresume: true });

    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.evaluate(() =>
        window.open("about:blank", "_blank", "popup=yes,width=300,height=300"),
      ),
    ]);

    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", true);

    await popup.close();
    await page.bringToFront();

    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should keep fullscreen video playing when focus is lost", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      focuspause: true,
      disableOnFullscreen: true,
    });
    await page.goto(`http://localhost:${port}/video.html`);
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
  }) => {
    await context.updateSettings({ focuspause: true, focusresume: true });
    await page.goto(`http://localhost:${port}/video.html`);
    const firstVideo = page.locator("#v");
    await firstVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", false);

    const [secondWindow] = await Promise.all([
      context.waitForEvent("page"),
      page.evaluate(() =>
        window.open("about:blank", "_blank", "popup=yes,width=300,height=300"),
      ),
    ]);
    await secondWindow.goto(`http://localhost:${port}/video.html`);
    const secondVideo = secondWindow.locator("#v");
    await secondVideo.evaluate((element) => element.play());
    await expect(secondVideo).toHaveJSProperty("paused", false);
    await expect(firstVideo).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(firstVideo).toHaveJSProperty("paused", false);
    await expect(secondVideo).toHaveJSProperty("paused", true);

    await secondWindow.bringToFront();
    await expect(secondVideo).toHaveJSProperty("paused", false);
    await expect(firstVideo).toHaveJSProperty("paused", true);
  });

  test("should react to page blur and focus events", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ focuspause: true, focusresume: true });
    await page.goto(`http://localhost:${port}/video.html`);

    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(video).toHaveJSProperty("paused", true);

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should prioritize active-tab media and resume the previous tab", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      prioritizeActiveTabMedia: true,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    const firstVideo = page.locator("#v");
    await expect(firstVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await firstVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", false);

    const emptyTab = await context.newPage();
    await emptyTab.goto(`http://localhost:${port}/`);
    await expect(firstVideo).toHaveJSProperty("paused", false);

    const secondTab = await context.newPage();
    await secondTab.goto(`http://localhost:${port}/video.html`);
    const secondVideo = secondTab.locator("#v");
    await expect(secondVideo).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await secondVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", true);
    await expect(secondVideo).toHaveJSProperty("paused", false);

    await secondVideo.evaluate((element) => element.pause());
    await expect(firstVideo).toHaveJSProperty("paused", false);

    await secondVideo.evaluate((element) => element.play());
    await expect(firstVideo).toHaveJSProperty("paused", true);
    const worker = context.serviceWorkers()[0];
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
  }) => {
    await context.updateSettings({ prioritizeActiveTabMedia: true });
    await page.goto(`http://localhost:${port}/`);
    await page.evaluate(() => {
      const audio = document.createElement("audio");
      audio.id = "audio-only";
      audio.src = "https://www.w3schools.com/html/mov_bbb.mp4";
      audio.loop = true;
      document.body.appendChild(audio);
    });
    const audio = page.locator("#audio-only");
    await audio.evaluate((element) => element.play());
    await expect(audio).toHaveJSProperty("paused", false);

    const videoTab = await context.newPage();
    await videoTab.goto(`http://localhost:${port}/video.html`);
    const video = videoTab.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);
    await expect(audio).toHaveJSProperty("paused", true);

    await video.evaluate((element) => element.pause());
    await expect(audio).toHaveJSProperty("paused", false);
  });

  test("should NOT resume video if manually paused (manualPause)", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
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
    await page2.goto(`http://localhost:${port}/video.html`);
    await page.waitForTimeout(1000);

    await page.bringToFront();
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should NOT resume video when autoresume is disabled", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ autoresume: false });

    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toBeAttached();

    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect(video).toHaveJSProperty("paused", false);

    const page2 = await context.newPage();
    await page2.goto(`http://localhost:${port}/video.html`);

    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should keep manually paused video stopped when autoresume is disabled", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ autoresume: false });
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    await video.evaluate((element) => element.pause());
    await expect(video).toHaveJSProperty("paused", true);

    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should restore saved behavior after disabling and re-enabling", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await video.evaluate(async (element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const page2 = await context.newPage();
    await page2.goto(`http://localhost:${port}/video.html`);
    await expect(video).toHaveJSProperty("paused", true);

    await context.updateSettings({ disabled: true });
    await context.updateSettings({ disabled: false });
    await page.bringToFront();

    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should only resume videos paused by the extension", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
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
    await page2.goto(`http://localhost:${port}/video.html`);
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect(notStartedVideo).toHaveJSProperty("paused", true);
  });

  test("should mute video instead of pausing when Mute Mode is enabled", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ muteVideo: true });

    await page.goto(`http://localhost:${port}/video.html`);
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
    await page2.goto(`http://localhost:${port}/video.html`);

    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(userMutedVideo).toHaveJSProperty("muted", true);

    await page.bringToFront();
    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("muted", false);
    await expect(userMutedVideo).toHaveJSProperty("muted", true);
  });

  test("should fade audio when pausing and resuming", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      focuspause: true,
      focusresume: true,
      audioFading: true,
      fadeDuration: 600,
    });
    await page.goto(`http://localhost:${port}/video.html`);
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

  test("should control videos in open shadow roots", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ singleVideoPlayback: false });
    await page.goto(`http://localhost:${port}/video.html`);
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
    await page2.goto(`http://localhost:${port}/video.html`);
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("should respect Simultaneous Domain Lists (Priority & Implicit Whitelist)", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ excludedDomains: [], includedDomains: [] });
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await video.evaluate(async (v) => await v.play());

    const page2 = await context.newPage();
    await page2.goto(`http://localhost:${port}/video.html`);
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();

    await context.updateSettings({ includedDomains: ["localhost"] });
    await page.waitForTimeout(1000);

    await page2.bringToFront();
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();

    await video.evaluate(async (v) => await v.play());
    await expect(video).toHaveJSProperty("paused", false);

    await context.updateSettings({
      excludedDomains: ["localhost"],
      includedDomains: ["localhost"],
    });
    await page.waitForTimeout(1000);

    await page2.bringToFront();
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", false);
  });
});
