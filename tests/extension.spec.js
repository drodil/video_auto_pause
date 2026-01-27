import { test as base, chromium, expect } from "@playwright/test";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const chromeExtensionPath = path.join(__dirname, "../test-dist/chrome");
const port = 8123;
let server;

const startServer = () => {
  return new Promise((resolve) => {
    server = spawn("python", ["-m", "http.server", String(port)], {
      cwd: path.join(__dirname),
      stdio: "ignore",
    });
    setTimeout(resolve, 1000);
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

      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      await page.evaluate((newSettings) => {
        return new Promise((resolve) => {
          chrome.storage.sync.set(newSettings, resolve);
        });
      }, settings);

      await page.close();
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
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", false);

    const page2 = await context.newPage();
    await page2.goto(`http://localhost:${port}/video.html`);

    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);

    await page.bringToFront();
    await page.waitForTimeout(2000);

    await expect(video).toHaveJSProperty("muted", false);
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
