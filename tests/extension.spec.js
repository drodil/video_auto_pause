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
  context: async ({ browserName }, use, testInfo) => {
    if (!server) await startServer();

    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `${browserName}-user-data-`),
    );
    const extensionTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `${browserName}-extension-`),
    );
    const testExtensionPath = path.join(extensionTempDir, "unpacked");
    // Give each test its own extension ID to isolate Chrome Sync write quotas.
    fs.cpSync(chromeExtensionPath, testExtensionPath, { recursive: true });

    let context;
    if (browserName === "chromium") {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        acceptDownloads: true,
        args: [
          `--disable-extensions-except=${testExtensionPath}`,
          `--load-extension=${testExtensionPath}`,
          "--headless=new",
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
    let suppressInitialOnboarding =
      testInfo.title !== "opens a localized onboarding page on first install";
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
    const maybeCloseInitialOnboarding = (page) => {
      if (
        suppressInitialOnboarding &&
        page.url().includes("/onboarding.html")
      ) {
        suppressInitialOnboarding = false;
        void page.waitForLoadState("load").then(
          () => {
            if (!page.isClosed()) {
              return page.close();
            }
          },
          (error) => {
            if (!page.isClosed()) {
              console.error(
                "Could not wait for the initial onboarding page:",
                error,
              );
            }
          },
        );
      }
    };
    for (const openPage of context.pages()) {
      openPage.on("load", () => maybeCloseInitialOnboarding(openPage));
      maybeCloseInitialOnboarding(openPage);
    }
    context.on("page", (openPage) => {
      openPage.on("load", () => maybeCloseInitialOnboarding(openPage));
      maybeCloseInitialOnboarding(openPage);
    });

    const initialWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 10000 }));
    await initialWorker.evaluate(async () => settingsReady);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const openPage of context.pages()) {
      maybeCloseInitialOnboarding(openPage);
    }
    suppressInitialOnboarding = false;

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
      await worker.evaluate(async (newSettings) => {
        await settingsReady;
        await VAP_UPDATE_ACTIVE_PROFILE_SETTINGS(
          chrome.storage.sync,
          chrome.storage.local,
          VAP_DEFAULT_OPTIONS,
          newSettings,
        );
      }, settings);
    };
    context.getSettings = async () => {
      const worker =
        context
          .serviceWorkers()
          .find((candidate) => candidate.url().includes(extensionId)) ??
        initialWorker;
      return worker.evaluate(() =>
        VAP_GET_ACTIVE_PROFILE_SETTINGS(
          chrome.storage.sync,
          chrome.storage.local,
          VAP_DEFAULT_OPTIONS,
        ),
      );
    };

    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extensionTempDir, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
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

  test("opens a localized onboarding page on first install", async ({
    context,
  }) => {
    await expect
      .poll(() =>
        context
          .pages()
          .some((candidate) => candidate.url().endsWith("/onboarding.html")),
      )
      .toBe(true);

    const onboarding = context
      .pages()
      .find((candidate) => candidate.url().endsWith("/onboarding.html"));
    await expect(
      onboarding.getByRole("heading", { name: "Welcome to Video Auto Pause" }),
    ).toBeVisible();
    await expect(onboarding.locator("#hotkeys")).toBeVisible();
  });

  test("shows local weekly statistics and a milestone rating link", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => {
      const date = new Date().toISOString().slice(0, 10);
      return new Promise((resolve) =>
        chrome.storage.local.set(
          {
            vapStats: {
              totalPauses: 50,
              [date]: {
                pauses: 50,
                resumes: 12,
                autoplayBlocked: 3,
                preventedSeconds: 7200,
              },
            },
          },
          resolve,
        ),
      );
    });
    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    const optionsPage = await context.newPage();
    await optionsPage.goto(optionsUrl);

    await expect(optionsPage.locator("#statsSummary")).toContainText(
      "50 pauses",
    );
    await expect(optionsPage.locator("#statsSummary")).toContainText(
      "12 resumes",
    );
    await expect(optionsPage.locator("#rateExtension")).toBeVisible();
    await expect(optionsPage.locator("#shareStats")).toHaveCount(0);
  });

  test("keeps a pinned tab playing and shows its badge until unpinned", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      showVideoOverlay: true,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate((element) => element.play());
    const pinButton = page.locator(
      ".vap-video-overlay [data-action='pin-toggle']",
    );
    await expect(pinButton).toHaveAttribute("aria-pressed", "false");
    await pinButton.click();
    await expect(pinButton).toHaveAttribute("aria-pressed", "true");

    const worker = context.serviceWorkers()[0];
    const tabId = await worker.evaluate(
      (url) =>
        new Promise((resolve) =>
          chrome.tabs.query({ url }, (tabs) => resolve(tabs[0]?.id)),
        ),
      `http://localhost:${port}/video.html`,
    );
    await expect
      .poll(() =>
        worker.evaluate(
          (id) => chrome.action.getBadgeText({ tabId: id }),
          tabId,
        ),
      )
      .toBe("PIN");

    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await page.bringToFront();
    await pinButton.click();
    await expect(pinButton).toHaveAttribute("aria-pressed", "false");
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("saves and edits an override rule for any site", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const worker = context.serviceWorkers()[0];
    const optionsPage = await context.newPage();
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Domain Settings" })
      .click();
    await optionsPage.locator("#siteRuleFilter").fill("localhost");
    await optionsPage.locator("#addSiteRule").click();
    await expect(optionsPage.locator("#siteSettingsTitle")).toContainText(
      "localhost",
    );
    await optionsPage
      .locator("#siteSettingsFields details")
      .nth(1)
      .locator("summary")
      .click();
    await optionsPage.locator('[data-site-override="muteVideo"]').check();
    await optionsPage.locator('[data-site-value="muteVideo"]').check();
    await optionsPage.locator('[data-site-override="pauseDelay"]').check();
    await optionsPage.locator('[data-site-value="pauseDelay"]').fill("250");
    await optionsPage.locator('[data-site-override="resumeDelay"]').check();
    await optionsPage.locator('[data-site-value="resumeDelay"]').fill("500");
    await optionsPage.locator('[data-site-override="playbackSpeed"]').check();
    await optionsPage.locator('[data-site-value="playbackSpeed"]').fill("1.75");
    await optionsPage.locator('[data-site-override="fadeDuration"]').check();
    await optionsPage.locator('[data-site-value="fadeDuration"]').fill("450");
    await optionsPage.locator('[data-site-override="allowAudio"]').check();
    await optionsPage.locator('[data-site-value="allowAudio"]').uncheck();
    await optionsPage.locator('[data-site-override="quietHoursStart"]').check();
    await optionsPage
      .locator('[data-site-value="quietHoursStart"]')
      .fill("21:30");
    await optionsPage.locator('[data-site-override="quietHoursEnd"]').check();
    await optionsPage
      .locator('[data-site-value="quietHoursEnd"]')
      .fill("06:00");
    await optionsPage
      .locator('[data-site-override="contentShortcutKeys"]')
      .check();
    await optionsPage
      .locator('[data-site-shortcut-value="seekBackward"]')
      .fill("k");
    await optionsPage.locator("#saveSiteSettings").click();
    await expect(optionsPage.locator("#siteSettingsStatus")).toContainText(
      "saved",
    );
    await expect(optionsPage.locator("#siteRuleList")).toContainText(
      "localhost",
    );
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({
        siteRules: [
          {
            domain: "localhost",
            enabled: true,
            overrides: {
              muteVideo: true,
              pauseDelay: 250,
              resumeDelay: 500,
              playbackSpeed: 1.75,
              fadeDuration: 450,
              allowAudio: false,
              quietHoursStart: "21:30",
              quietHoursEnd: "06:00",
              contentShortcutKeys: expect.objectContaining({
                seekBackward: "k",
              }),
            },
          },
        ],
      });
    await optionsPage.locator("#backToGlobal").click();
    await optionsPage.locator('[data-open-site-rule="localhost"]').click();
    await expect(
      optionsPage.locator('[data-site-value="muteVideo"]'),
    ).toBeChecked();
    await expect(
      optionsPage.locator('[data-site-value="fadeDuration"]'),
    ).toHaveValue("450");
    await expect(
      optionsPage.locator('[data-site-shortcut-value="seekBackward"]'),
    ).toHaveValue("k");
    await optionsPage.locator("#backToGlobal").click();
    await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await optionsPage.locator("#siteRuleFilter").fill("missing.example");
    await expect(optionsPage.locator("#siteRuleList li")).toHaveCount(0);
    await optionsPage.locator("#siteRuleFilter").clear();
    await expect(optionsPage.locator("#siteRuleList li")).toHaveCount(1);
    await optionsPage.locator('[data-remove-site-rule="localhost"]').click();
    await expect(optionsPage.locator("#siteRuleList li")).toHaveCount(0);
  });

  test("applies per-site mute behavior, delay, and remembered playback speed", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      muteVideo: false,
      singleVideoPlayback: false,
      siteRules: [
        {
          domain: "*.localhost",
          enabled: true,
          overrides: {
            muteVideo: true,
            pauseDelay: 0,
            resumeDelay: 0,
            playbackSpeed: 1.5,
          },
        },
      ],
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await expect
      .poll(() => video.evaluate((element) => element.playbackRate))
      .toBe(1.5);
    await video.evaluate(async (element) => {
      await element.play();
      element.muted = false;
    });
    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);
    await page.bringToFront();
    await expect(video).toHaveJSProperty("muted", false);
  });

  test("configures and applies global playback speed", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    const worker = context.serviceWorkers()[0];
    const optionsPage = await context.newPage();
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();
    await optionsPage.locator("#playbackSpeed").fill("1.25");
    await optionsPage.locator("#playbackSpeed").press("Tab");
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({ playbackSpeed: 1.25 });
    await expect
      .poll(() => page.locator("#v").evaluate((video) => video.playbackRate))
      .toBe(1.25);
  });

  test("uses remapped in-page video shortcuts and ignores editable controls", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
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
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
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
  }) => {
    await context.updateSettings({ contentShortcutsEnabled: true });
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
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
    const worker = context.serviceWorkers()[0];
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

  test("a per-site autopause override inherits the rest of the defaults", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: false,
      onlyConfiguredSites: true,
      siteRules: [
        {
          domain: "localhost",
          enabled: true,
          overrides: { autopause: false },
        },
      ],
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await video.evaluate(async (element) => element.play());
    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("applies a preset from onboarding and the settings popup", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const onboarding = await context.newPage();
    await onboarding.goto(
      await worker.evaluate(() => chrome.runtime.getURL("onboarding.html")),
    );
    await expect(onboarding.locator("[data-preset=study]")).toBeVisible();
    const descriptions = [
      {
        preset: "study",
        id: "presetStudyDescription",
        text: "Pauses and resumes when you switch tabs or windows, then rewinds 5 seconds.",
      },
      {
        preset: "music",
        id: "presetMusicDescription",
        text: "Mutes videos, fades audio, and keeps playback going when you change focus or lock your device.",
      },
      {
        preset: "binge",
        id: "presetBingeDescription",
        text: "Pauses and resumes on tab changes and device lock; ignores focus changes and disables itself in fullscreen.",
      },
      {
        preset: "saver",
        id: "presetSaverDescription",
        text: "Pauses on tab changes, focus loss, device lock, or when video scrolls out of view; blocks autoplay and does not auto-resume.",
      },
    ];
    for (const description of descriptions) {
      const button = onboarding.locator(`[data-preset=${description.preset}]`);
      await expect(button).toHaveAttribute("title", description.text);
      await expect(button).toHaveAttribute("aria-describedby", description.id);
      await expect(onboarding.locator(`#${description.id}`)).toHaveText(
        description.text,
      );
    }
    await onboarding.locator("[data-preset=study]").click();
    await expect(onboarding.locator("#presetStatus")).toContainText("applied");
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({
        autopause: true,
        focuspause: true,
        focusresume: true,
        rewindSeconds: 5,
      });

    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    const optionsPage = await context.newPage();
    await optionsPage.goto(optionsUrl);
    for (const description of descriptions) {
      const button = optionsPage.locator(`[data-preset=${description.preset}]`);
      await expect(button).toHaveAttribute("title", description.text);
      await expect(button).toHaveAttribute("aria-describedby", description.id);
      await expect(optionsPage.locator(`#${description.id}`)).toHaveText(
        description.text,
      );
    }
    await expect(optionsPage.locator("[data-preset]").first()).toBeHidden();
    await optionsPage.locator(".preset-options summary").click();
    await expect(optionsPage.locator("[data-preset=study]")).toBeVisible();
    await optionsPage.locator("[data-preset=saver]").click();
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({
        autopause: true,
        autoresume: false,
        scrollpause: true,
        blockAutoplay: true,
      });
  });

  test("keeps optional controls compact and exposes profile switching as needed", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 1280, height: 800 });
    await popupPage.goto(`${optionsUrl}?popup`);
    const popupBounds = await popupPage.locator("#wrapper").boundingBox();
    expect(popupBounds.width).toBe(800);
    expect(popupBounds.height).toBe(600);

    const optionsPage = await context.newPage();
    await optionsPage.goto(optionsUrl);
    await optionsPage.setViewportSize({ width: 1280, height: 800 });
    const wrapperBounds = await optionsPage.locator("#wrapper").boundingBox();
    expect(wrapperBounds.width).toBe(1080);
    expect(wrapperBounds.height).toBeGreaterThanOrEqual(800);
    await optionsPage.setViewportSize({ width: 430, height: 700 });
    const narrowWrapperBounds = await optionsPage
      .locator("#wrapper")
      .boundingBox();
    expect(narrowWrapperBounds.width).toBe(430);
    expect(narrowWrapperBounds.height).toBeGreaterThanOrEqual(700);
    await optionsPage.setViewportSize({ width: 1280, height: 800 });
    await expect(optionsPage.locator("#activeProfileControl")).toBeHidden();
    const pinButton = optionsPage.getByRole("button", {
      name: "Keep playing in this tab",
    });
    await expect(pinButton).toBeVisible();
    await expect(pinButton.locator("svg")).toHaveCount(1);
    const pinBox = await pinButton.boundingBox();
    expect(pinBox.width).toBeLessThanOrEqual(44);
    await expect(optionsPage.locator("[data-preset]").first()).toBeHidden();
    const presetDisclosure = optionsPage.locator(".preset-options summary");
    const profilesDisclosure = optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Profiles & backup" });
    const [presetDisclosureStyle, profilesDisclosureStyle] = await Promise.all([
      presetDisclosure.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.fontSize, style.borderTopColor];
      }),
      profilesDisclosure.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.fontSize, style.borderTopColor];
      }),
    ]);
    expect(presetDisclosureStyle).toEqual(profilesDisclosureStyle);
    const [applyProfileBox, deleteProfileBox] = await Promise.all(
      ["#applyProfile", "#deleteProfile"].map((selector) =>
        optionsPage.locator(selector).boundingBox(),
      ),
    );
    expect([applyProfileBox.width, applyProfileBox.height]).toEqual([
      deleteProfileBox.width,
      deleteProfileBox.height,
    ]);
    const [supportLinkStyle, diagnosticsButtonStyle] = await Promise.all([
      optionsPage.locator(".support-link[href]").first().evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.padding, style.minHeight];
      }),
      optionsPage.locator("#copyDiagnostics").evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.padding, style.minHeight];
      }),
    ]);
    expect(diagnosticsButtonStyle).toEqual(supportLinkStyle);
    await presetDisclosure.click();
    const presetColors = await optionsPage
      .locator(".preset-grid [data-preset]")
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).backgroundColor),
      );
    expect(new Set(presetColors).size).toBe(4);
    await presetDisclosure.click();
    await expect(optionsPage.locator("#settingsContent")).toHaveClass(
      /expanded/,
    );
    await expect(
      optionsPage
        .locator(".collapsible_button")
        .filter({ hasText: "Profiles & backup" }),
    ).toHaveAttribute("aria-expanded", "false");

    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeHidden();
    await optionsPage.locator("#contentShortcutsEnabled").check();
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeVisible();
    await optionsPage.locator("#contentShortcutsEnabled").uncheck();
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeHidden();

    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Profiles & backup" })
      .click();
    const actionColors = await Promise.all(
      ["#saveProfile", "#applyProfile", "#deleteProfile"].map((selector) =>
        optionsPage
          .locator(selector)
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ),
    );
    expect(new Set(actionColors).size).toBe(3);
    await optionsPage.locator("#profileName").fill("Work");
    await optionsPage.locator("#saveProfile").click();
    await expect(optionsPage.locator("#profileStatus")).toContainText("saved");
    await expect(optionsPage.locator("#activeProfileControl")).toBeVisible();
    await expect(optionsPage.locator("#activeProfileSelect")).not.toHaveValue(
      "default",
    );
  });

  test("keeps onboarding usable on a narrow viewport", async ({ context }) => {
    const worker = context.serviceWorkers()[0];
    const onboarding = await context.newPage();
    await onboarding.setViewportSize({ width: 320, height: 568 });
    await onboarding.goto(
      await worker.evaluate(() => chrome.runtime.getURL("onboarding.html")),
    );
    await expect(
      onboarding.getByRole("heading", { name: "Welcome to Video Auto Pause" }),
    ).toBeVisible();
    await expect(onboarding.locator("[data-preset]")).toHaveCount(4);
    await expect(onboarding.locator("[data-preset]").first()).toBeVisible();
    expect(
      await onboarding.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
  });

  test("includes all added settings messages in every locale", () => {
    const localeDirectory = path.join(__dirname, "../src/_locales");
    const keys = [
      "presetStudyDescription",
      "presetMusicDescription",
      "presetBingeDescription",
      "presetSaverDescription",
      "prioritizeActiveTabMedia",
      "idlePauseMinutes",
      "quietHours",
      "quietHoursStart",
      "quietHoursEnd",
      "peekMode",
      "disableAutoplayNext",
      "sleepTimerStart",
      "sleepTimerDuration",
      "sleepTimerCancel",
      "sleepTimerSet",
      "sleepTimerFailed",
      "reportSite",
      "reportSiteDescription",
      "profilesAndBackup",
      "exportSettings",
      "importSettings",
      "settingsExported",
      "settingsExportFailed",
      "settingsImported",
      "settingsImportFailed",
      "profileName",
      "profileNamePlaceholder",
      "saveProfile",
      "applyProfile",
      "deleteProfile",
      "profileSelectPlaceholder",
      "profileSaved",
      "profileApplied",
      "profileDeleted",
      "profileFailed",
      "contentShortcutsEnabled",
      "contentShortcutsDescription",
      "seekBackwardShortcut",
      "seekForwardShortcut",
      "frameBackwardShortcut",
      "frameForwardShortcut",
      "toggleLoopShortcut",
      "bookmarkShortcut",
      "screenshotShortcut",
      "togglePipShortcut",
      "toggleCaptionsShortcut",
      "contentShortcutsConflict",
      "contentShortcutsSaved",
      "shortcutBookmarkSaved",
      "shortcutFrameSaved",
      "shortcutFrameUnavailable",
      "shortcutLoopStart",
      "shortcutLoopEnd",
      "shortcutLoopCleared",
      "shortcutActionUnsupported",
      "shortcutActionFailed",
      "autoPipOnTabSwitch",
      "allowAudio",
      "profileDefault",
      "settingsSaveFailed",
      "pauseOnLowBattery",
      "pauseOnLowBatteryDescription",
      "pauseOnAudioOutputDisconnect",
      "pauseOnAudioOutputDisconnectDescription",
      "diagnosticsExport",
      "diagnosticsDescription",
      "diagnosticsCopied",
      "diagnosticsFailed",
      "pauseAtEnd",
      "pauseAtEndNotice",
    ];
    for (const locale of fs.readdirSync(localeDirectory)) {
      const messages = JSON.parse(
        fs.readFileSync(
          path.join(localeDirectory, locale, "messages.json"),
          "utf8",
        ),
      );
      for (const key of keys) {
        expect(
          messages[key]?.message,
          `${locale} is missing ${key}`,
        ).toBeTruthy();
      }
    }
  });

  test("exports and validates versioned settings JSON", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: false,
      rewindSeconds: 4,
      siteRules: [
        {
          domain: "example.com",
          enabled: true,
          overrides: { playbackSpeed: 1.5 },
        },
      ],
    });
    const worker = context.serviceWorkers()[0];
    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    const optionsPage = await context.newPage();
    await optionsPage.goto(optionsUrl);
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Profiles & backup" })
      .click();

    const downloadPromise = optionsPage.waitForEvent("download");
    await optionsPage.locator("#exportSettings").click();
    const download = await downloadPromise;
    const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    expect(exported.schemaVersion).toBe(1);
    expect(exported.settings).toMatchObject({
      autopause: false,
      rewindSeconds: 4,
      siteRules: [
        {
          domain: "example.com",
          overrides: { playbackSpeed: 1.5 },
        },
      ],
    });
    expect(exported.profiles).toHaveLength(1);
    expect(exported.profiles[0]).toMatchObject({
      id: "default",
      name: "Default",
    });
    expect(exported.activeProfileId).toBe("default");

    const importedPayload = {
      schemaVersion: 1,
      settings: {
        autopause: true,
        rewindSeconds: 12,
        quietHoursStart: "21:30",
        siteRules: [
          {
            domain: "media.example",
            enabled: false,
            overrides: { playbackSpeed: 2 },
          },
        ],
      },
    };
    await optionsPage.locator("#importSettingsFile").setInputFiles({
      name: "settings.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(importedPayload)),
    });
    await expect(optionsPage.locator("#settingsImportStatus")).toContainText(
      "imported",
    );
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({
        autopause: true,
        rewindSeconds: 12,
        quietHoursStart: "21:30",
        siteRules: [
          {
            domain: "media.example",
            enabled: false,
            overrides: { playbackSpeed: 2 },
          },
        ],
      });

    await optionsPage.locator("#importSettingsFile").setInputFiles({
      name: "unsupported.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ schemaVersion: 999, settings: { autopause: false } }),
      ),
    });
    await expect(optionsPage.locator("#settingsImportStatus")).toContainText(
      "Could not import",
    );
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({ autopause: true });
  });

  test("keeps global and site settings bound to the active profile", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      playbackSpeed: 1.5,
      siteRules: [
        {
          domain: "localhost",
          enabled: true,
          overrides: { playbackSpeed: 2 },
        },
      ],
    });
    const worker = context.serviceWorkers()[0];
    await page.goto(`http://video.localhost:${port}/video.html`);
    await expect
      .poll(() => page.locator("#v").evaluate((video) => video.playbackRate))
      .toBe(2);
    const optionsPage = await context.newPage();
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Profiles & backup" })
      .click();
    await optionsPage.locator("#profileName").fill("Work");
    await optionsPage.locator("#saveProfile").click();
    await expect(optionsPage.locator("#profileStatus")).toContainText("saved");
    const workProfileId = await optionsPage
      .locator("#activeProfileSelect")
      .inputValue();
    expect(workProfileId).not.toBe("default");
    expect(
      await worker.evaluate(
        async () =>
          (await chrome.storage.local.get("vapActiveProfileId"))
            .vapActiveProfileId,
      ),
    ).toBe(workProfileId);
    expect(
      await worker.evaluate(async () =>
        Object.prototype.hasOwnProperty.call(
          await chrome.storage.sync.get("vapActiveProfileId"),
          "vapActiveProfileId",
        ),
      ),
    ).toBe(false);

    await context.updateSettings({
      playbackSpeed: 1.25,
      siteRules: [
        {
          domain: "video.localhost",
          enabled: true,
          overrides: { playbackSpeed: 1.75 },
        },
      ],
    });
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({
        playbackSpeed: 1.25,
        siteRules: [
          {
            domain: "video.localhost",
            overrides: { playbackSpeed: 1.75 },
          },
        ],
      });

    await optionsPage.locator("#activeProfileSelect").selectOption("default");
    await expect(optionsPage.locator("#profileStatus")).toContainText(
      "applied",
    );
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({
        playbackSpeed: 1.5,
        siteRules: [
          {
            domain: "localhost",
            overrides: { playbackSpeed: 2 },
          },
        ],
      });
    await optionsPage
      .locator("#activeProfileSelect")
      .selectOption(workProfileId);
    await expect(optionsPage.locator("#profileStatus")).toContainText(
      "applied",
    );
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({
        playbackSpeed: 1.25,
        siteRules: [
          {
            domain: "video.localhost",
            overrides: { playbackSpeed: 1.75 },
          },
        ],
      });
    await page.reload();
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await expect
      .poll(() => page.locator("#v").evaluate((video) => video.playbackRate))
      .toBe(1.75);

    const workProfile = await worker.evaluate(async (id) => {
      const key = VAP_PROFILE_STORAGE_KEY(id);
      return (await chrome.storage.sync.get(key))[key];
    }, workProfileId);
    expect(workProfile.settings.siteRules[0].overrides.playbackSpeed).toBe(
      1.75,
    );
    expect(
      await worker.evaluate(async () =>
        Object.keys(await chrome.storage.local.get(null)).some((key) =>
          key.startsWith("sitePlaybackRate:"),
        ),
      ),
    ).toBe(false);

    const downloadPromise = optionsPage.waitForEvent("download");
    await optionsPage.locator("#exportSettings").click();
    const backup = await downloadPromise;
    const backupPayload = JSON.parse(
      fs.readFileSync(await backup.path(), "utf8"),
    );
    expect(backupPayload.profiles).toHaveLength(2);
    expect(backupPayload.activeProfileId).toBe(workProfileId);
    await optionsPage.locator("#importSettingsFile").setInputFiles({
      name: "profiles-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backupPayload)),
    });
    await expect(optionsPage.locator("#settingsImportStatus")).toContainText(
      "imported",
    );
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({ playbackSpeed: 1.25 });

    await optionsPage.locator("#deleteProfile").click();
    await expect(optionsPage.locator("#profileStatus")).toContainText(
      "deleted",
    );
    await expect(optionsPage.locator("#activeProfileSelect")).toBeHidden();
    await expect(optionsPage.locator("#profileSelect option")).toHaveCount(2);
    await expect(optionsPage.locator("#deleteProfile")).toBeDisabled();
    await expect(context.getSettings()).resolves.toMatchObject({
      playbackSpeed: 1.5,
    });
  });

  test("rewinds automatically resumed finite videos by the configured amount", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      rewindSeconds: 4,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
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
    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
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
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      rewindSeconds: 4,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    const startTime = await video.evaluate((element) => {
      element.currentTime = 5;
      Object.defineProperty(element, "duration", {
        configurable: true,
        get: () => Number.POSITIVE_INFINITY,
      });
      return element.currentTime;
    });
    await video.evaluate((element) => element.play());
    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeGreaterThan(startTime - 0.5);
  });

  test("mutes live streams instead of pausing them when switching tabs", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      liveStreamMute: true,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate(async (element) => {
      await element.play();
      element.muted = false;
    });
    const worker = context.serviceWorkers()[0];
    const tabId = await worker.evaluate(
      (url) =>
        new Promise((resolve) =>
          chrome.tabs.query({ url }, (tabs) => resolve(tabs[0]?.id)),
        ),
      `http://localhost:${port}/video.html`,
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

    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);

    await page.bringToFront();
    await expect(video).toHaveJSProperty("muted", false);
  });

  test("mutes videos during ads, then pauses them once the ad ends", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      muteDuringAds: true,
      liveStreamMute: false,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate(async (element) => {
      await element.play();
      element.muted = false;
      const ad = document.createElement("div");
      ad.className = "ad-showing";
      ad.id = "test-ad";
      document.body.append(ad);
    });

    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
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
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      muteDuringAds: true,
      liveStreamMute: false,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);

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

  test("shows draggable video controls for playback, speed, and site rules", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      showVideoOverlay: true,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
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
    const dragHandle = overlay.locator('[title="Move"]');
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
    const worker = context.serviceWorkers()[0];
    await expect
      .poll(
        async () =>
          (await context.getSettings()).siteRules.find(
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
  }) => {
    await context.updateSettings({
      showVideoOverlay: true,
      singleVideoPlayback: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://localhost:${port}/video.html`);
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

  test("keeps settings usable in a narrow touch viewport and sets document language", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const optionsPage = await context.newPage();
    await optionsPage.setViewportSize({ width: 320, height: 720 });
    const cdp = await context.newCDPSession(optionsPage);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
      configuration: "mobile",
    });
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    const wrapperBounds = await optionsPage.locator("#wrapper").boundingBox();
    expect(wrapperBounds.width).toBeLessThanOrEqual(320);
    await expect(optionsPage.locator("html")).toHaveAttribute(
      "lang",
      await optionsPage.evaluate(() => chrome.i18n.getUILanguage()),
    );
    await expect(optionsPage.locator("html")).toHaveAttribute(
      "dir",
      await optionsPage.evaluate(() => chrome.i18n.getMessage("@@bidi_dir")),
    );
    const checkboxLabel = optionsPage.locator("label:has(#autopause)");
    await expect(checkboxLabel).toHaveCSS("min-height", "44px");
    await cdp.detach();
  });

  test("records automatic pauses and playback time prevented locally", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      focuspause: true,
      focusresume: true,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
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

    const worker = context.serviceWorkers()[0];
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const { vapStats = {} } = await chrome.storage.local.get("vapStats");
          return Object.values(vapStats).find((day) => day.pauses)?.pauses ?? 0;
        }),
      )
      .toBe(1);

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(video).toHaveJSProperty("paused", false);
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const { vapStats = {} } = await chrome.storage.local.get("vapStats");
          return (
            Object.values(vapStats).find((day) => day.resumes)?.resumes ?? 0
          );
        }),
      )
      .toBe(1);
  });

  test("should pause video when switching tabs", async ({ page, context }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();

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

  test("should leave video playing on tab switches when autopause is disabled", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ autopause: false });
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const nextPage = await context.newPage();
    await nextPage.goto(`http://localhost:${port}/video.html`);
    await expect(video).toHaveJSProperty("paused", false);

    await page.bringToFront();
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

  test("should control SPA videos inserted and replaced after page load", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();
    await page.evaluate(() => {
      const video = document.createElement("video");
      video.id = "spa-video";
      video.src = "https://www.w3schools.com/html/mov_bbb.mp4";
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

    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
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
  }) => {
    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();
    await page.evaluate((frameUrl) => {
      const frame = document.createElement("iframe");
      frame.src = frameUrl;
      document.body.append(frame);
    }, `http://127.0.0.1:${port}/video.html`);

    const video = page.frameLocator("iframe").locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const otherTab = await context.newPage();
    await otherTab.goto(`http://localhost:${port}/`);
    await otherTab.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
  });

  test("should pause media that starts while the computer remains locked", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ lockpause: true });
    await page.goto(`http://localhost:${port}/`);

    const worker = context.serviceWorkers()[0];
    await expect
      .poll(() => worker.evaluate(() => options.lockpause))
      .toBe(true);

    await page.evaluate(() => {
      const video = document.createElement("video");
      video.id = "locked-restart";
      video.src = "https://www.w3schools.com/html/mov_bbb.mp4";
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
  }) => {
    await context.updateSettings({
      lockpause: true,
      lockresume: true,
      manualPause: true,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
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

    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => handleIdleStateChanged("locked"));
    await expect(playingVideo).toHaveJSProperty("paused", true);
    await worker.evaluate(() => handleIdleStateChanged("active"));

    await expect(playingVideo).toHaveJSProperty("paused", false);
    await expect(manuallyPausedVideo).toHaveJSProperty("paused", true);
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

  test("stores the automatic Picture-in-Picture tab-switch setting", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const optionsPage = await context.newPage();
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();
    await optionsPage.locator("#autoPipOnTabSwitch").check();
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({ autoPipOnTabSwitch: true });
  });

  test("allows audio globally and lets site rules override the choice", async ({
    page,
    context,
  }) => {
    await context.updateSettings({ allowAudio: true });
    await page.goto(`http://localhost:${port}/video.html`);
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    const worker = context.serviceWorkers()[0];
    const createAudioAndPlay = async () =>
      page.evaluate(async () => {
        const audio = document.createElement("audio");
        audio.id = "audio-only";
        audio.src = "https://www.w3schools.com/html/horse.mp3";
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

    await context.updateSettings({ allowAudio: false });
    await page.reload();
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await createAudioAndPlay();
    await sendStop();
    await expect(page.locator("#audio-only")).toHaveJSProperty("paused", true);

    await context.updateSettings({
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

  test("stores the optional low-battery pause preference", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const optionsPage = await context.newPage();
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();
    await optionsPage.locator("#pauseOnLowBattery").check();
    await expect
      .poll(() => context.getSettings(), { timeout: 10000 })
      .toMatchObject({ pauseOnLowBattery: true });
  });

  test("stores the optional audio-output disconnect preference", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const optionsPage = await context.newPage();
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();
    await optionsPage.locator("#pauseOnAudioOutputDisconnect").check();
    await expect
      .poll(() => context.getSettings())
      .toMatchObject({ pauseOnAudioOutputDisconnect: true });
  });

  test("copies local diagnostics without submitting them", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const optionsPage = await context.newPage();
    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    await optionsPage.goto(optionsUrl);
    await optionsPage.evaluate(() => {
      window.__clipboardText = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__clipboardText = text;
          },
        },
      });
    });
    await optionsPage.locator("#copyDiagnostics").click();
    await expect(optionsPage.locator("#diagnosticsStatus")).toContainText(
      "copied",
    );
    const diagnosticText = await optionsPage.evaluate(
      () => window.__clipboardText,
    );
    const diagnostics = JSON.parse(diagnosticText);
    expect(diagnostics).toHaveProperty("extensionVersion");
    expect(diagnostics).toHaveProperty("browser");
    expect(diagnostics).toHaveProperty("settings");
  });

  test("disables the affected tab after a content-script error", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    const worker = context.serviceWorkers()[0];
    const result = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await handlePageMessage(
        {
          contentScriptError: {
            message: "Test extension error",
            source: "chrome-extension://test/video_auto_pause.js",
          },
        },
        { tab, frameId: 0 },
      );
      return {
        tabId: tab.id,
        disabledTabs: (await chrome.storage.session.get("disabledTabs"))
          .disabledTabs,
        safeModeTabs: (await chrome.storage.session.get("safeModeTabs"))
          .safeModeTabs,
        badge: await chrome.action.getBadgeText({ tabId: tab.id }),
        error: (await chrome.storage.local.get("vapLastContentScriptError"))
          .vapLastContentScriptError,
      };
    }, page.url());
    expect(result.disabledTabs).toContain(result.tabId);
    expect(result.safeModeTabs).toContain(result.tabId);
    expect(result.badge).toBe("ERR");
    expect(result.error.message).toBe("Test extension error");
    const optionsPage = await context.newPage();
    await optionsPage.goto(
      await worker.evaluate(() => chrome.runtime.getURL("options.html")),
    );
    await optionsPage.evaluate(() => {
      window.__clipboardText = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => (window.__clipboardText = text) },
      });
    });
    await optionsPage.locator("#copyDiagnostics").click();
    await expect(optionsPage.locator("#diagnosticsStatus")).toContainText(
      "copied",
    );
    const diagnostics = JSON.parse(
      await optionsPage.evaluate(() => window.__clipboardText),
    );
    expect(diagnostics.lastContentScriptError.message).toBe(
      "Test extension error",
    );
  });

  test("prevents automatic next playback after a video ends", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      pauseAtEnd: true,
      disableAutoplayNext: true,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
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
      .poll(async () => (await context.getSettings()).pauseDelay)
      .toBe(0);
  });

  test("should save and restore settings through the options page", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const extensionId = new URL(worker.url()).host;
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);

    const autopause = optionsPage.locator("#autopause");
    await expect(autopause).toBeChecked();
    await autopause.uncheck();

    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();
    const pauseDelay = optionsPage.locator("#pauseDelay");
    await pauseDelay.fill("350");
    await pauseDelay.dispatchEvent("change");

    await expect
      .poll(() => context.getSettings())
      .toMatchObject({ autopause: false, pauseDelay: 350 });

    await optionsPage.reload();
    await expect(autopause).not.toBeChecked();
    await expect(pauseDelay).toHaveValue("350");
  });

  test("migrates include and exclude lists into site rules", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const migrated = await worker.evaluate(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set({
        vapSiteRulesVersion: 0,
        audioFading: true,
        fadeDuration: 350,
        handleAudio: true,
        audioAllowList: "music.example",
        siteRules: [
          {
            domain: "media.example.com",
            speed: 1.5,
            behavior: "mute",
            pauseDelay: 400,
          },
        ],
        includedDomains: ["allowed.example.com"],
        excludedDomains: ["blocked.example.com"],
      });
      const settings = await VAP_GET_ACTIVE_PROFILE_SETTINGS(
        chrome.storage.sync,
        chrome.storage.local,
        VAP_DEFAULT_OPTIONS,
      );
      const stored = await chrome.storage.sync.get(null);
      return { settings, stored };
    });
    expect(migrated.settings.onlyConfiguredSites).toBe(true);
    expect(migrated.settings).toMatchObject({
      fadeDuration: 350,
      allowAudio: false,
    });
    expect(migrated.settings.siteRules).toEqual(
      expect.arrayContaining([
        {
          domain: "media.example.com",
          overrides: {
            muteVideo: true,
            pauseDelay: 400,
            playbackSpeed: 1.5,
          },
        },
        {
          domain: "allowed.example.com",
          enabled: true,
          overrides: {},
        },
        {
          domain: "blocked.example.com",
          enabled: false,
          overrides: {},
        },
        {
          domain: "music.example",
          enabled: true,
          overrides: { allowAudio: true },
        },
      ]),
    );
    expect(migrated.stored).not.toHaveProperty("includedDomains");
    expect(migrated.stored).not.toHaveProperty("excludedDomains");
    expect(migrated.stored).not.toHaveProperty("siteRules");
    expect(migrated.stored.vapProfileIds).toContain("default");
  });

  test("keeps the active profile local while syncing available profiles", async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0];
    const result = await worker.evaluate(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set({
        vapProfiles: [
          {
            id: "default",
            name: "Default",
            settings: { ...VAP_DEFAULT_OPTIONS, playbackSpeed: 1 },
          },
          {
            id: "work",
            name: "Work",
            settings: { ...VAP_DEFAULT_OPTIONS, playbackSpeed: 1.5 },
          },
        ],
        vapActiveProfileId: "work",
      });
      const settings = await VAP_GET_ACTIVE_PROFILE_SETTINGS(
        chrome.storage.sync,
        chrome.storage.local,
        VAP_DEFAULT_OPTIONS,
      );
      const storedSync = await chrome.storage.sync.get(null);
      const activeProfile =
        await chrome.storage.local.get("vapActiveProfileId");
      await chrome.storage.local.clear();
      const secondMachine = await VAP_ENSURE_PROFILES(
        chrome.storage.sync,
        chrome.storage.local,
        VAP_DEFAULT_OPTIONS,
      );
      return {
        firstMachineSpeed: settings.playbackSpeed,
        firstMachineActiveId: activeProfile.vapActiveProfileId,
        syncHasActiveId: Object.prototype.hasOwnProperty.call(
          storedSync,
          "vapActiveProfileId",
        ),
        secondMachineProfileIds: secondMachine.profiles.map(
          (profile) => profile.id,
        ),
        secondMachineActiveId: secondMachine.activeProfileId,
      };
    });
    expect(result).toMatchObject({
      firstMachineSpeed: 1.5,
      firstMachineActiveId: "work",
      syncHasActiveId: false,
      secondMachineProfileIds: ["default", "work"],
      secondMachineActiveId: "default",
    });
  });

  test("uses zero to disable audio fading", async ({ context }) => {
    const worker = context.serviceWorkers()[0];
    const extensionId = new URL(worker.url()).host;
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();

    const fadeDuration = optionsPage.locator("#fadeDuration");
    await expect(fadeDuration).toHaveValue("0");
    await fadeDuration.fill("350");
    await fadeDuration.dispatchEvent("change");
    const readFadeDuration = () =>
      worker.evaluate(async () => {
        const activeProfileId =
          (await chrome.storage.local.get("vapActiveProfileId"))
            .vapActiveProfileId ?? "default";
        const key = `vapProfile:${activeProfileId}`;
        return (await chrome.storage.sync.get(key))[key]?.settings
          ?.fadeDuration;
      });
    await expect
      .poll(readFadeDuration, { timeout: 10000 })
      .toBe(350);

    await optionsPage.reload();
    await optionsPage
      .locator(".collapsible_button")
      .filter({ hasText: "Advanced Settings" })
      .click();
    await expect(fadeDuration).toHaveValue("350");
    await fadeDuration.fill("0");
    await fadeDuration.dispatchEvent("change");
    await expect
      .poll(readFadeDuration, { timeout: 10000 })
      .toBe(0);
  });

  test("should apply playback commands to the active tab", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/video.html`);
    const video = page.locator("#v");
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);

    const worker = context.serviceWorkers()[0];
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
    await expect.poll(() => worker.evaluate(() => options.disabled)).toBe(true);
    await worker.evaluate(() => handleCommand("toggle-extension"));
    await expect
      .poll(() => worker.evaluate(() => options.disabled))
      .toBe(false);
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

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(video).toHaveJSProperty("paused", true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
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

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(firstVideo).toHaveJSProperty("paused", true);

    const secondTab = await context.newPage();
    await secondTab.goto(`http://localhost:${port}/video.html`);
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

  test("pauses on idle timeout and during configured quiet hours", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      idlePauseMinutes: 1,
      quietHoursStart: "22:00",
      quietHoursEnd: "06:00",
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate((element) => element.play());
    const worker = context.serviceWorkers()[0];
    await expect
      .poll(() => worker.evaluate(() => options.idlePauseMinutes))
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
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      focuspause: true,
      peekMode: true,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    await video.evaluate((element) => element.play());
    await video.hover();
    const worker = context.serviceWorkers()[0];
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

  test("stops autoplay-next and applies the sleep timer", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      disableAutoplayNext: true,
      singleVideoPlayback: false,
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await expect(video).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
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

    const worker = context.serviceWorkers()[0];
    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    const optionsPage = await context.newPage();
    await optionsPage.goto(`${optionsUrl}?popup`);
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
  });

  test("prepares a site report with privacy-safe browser details", async ({
    page,
    context,
  }) => {
    await page.goto(
      `http://localhost:${port}/video.html?session-secret=do-not-share#private`,
    );
    const worker = context.serviceWorkers()[0];
    const optionsUrl = await worker.evaluate(() =>
      chrome.runtime.getURL("options.html"),
    );
    const optionsPage = await context.newPage();
    await optionsPage.goto(optionsUrl);
    await expect
      .poll(() => optionsPage.locator("#reportSite").getAttribute("href"))
      .toContain("body=");
    const issueUrl = new URL(
      await optionsPage.locator("#reportSite").getAttribute("href"),
    );
    expect(issueUrl.origin).toBe("https://github.com");
    expect(issueUrl.pathname).toBe("/drodil/video_auto_pause/issues/new");
    expect(issueUrl.searchParams.get("title")).toBe(
      "Site compatibility report",
    );
    const body = issueUrl.searchParams.get("body");
    expect(body).toContain(`Site: http://localhost:${port}`);
    expect(body).toContain("Browser: ");
    expect(body).not.toContain("session-secret");
    expect(body).not.toContain("private");
  });

  test("should prioritize audio-only media across tabs", async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();
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
    await context.updateSettings({ prioritizeActiveTabMedia: true });

    const videoTab = await context.newPage();
    await videoTab.goto(`http://localhost:${port}/video.html`);
    await videoTab.bringToFront();
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

  test("per-site enabled state replaces include and exclude lists", async ({
    page,
    context,
  }) => {
    await context.updateSettings({
      autopause: true,
      autoresume: true,
      onlyConfiguredSites: false,
      siteRules: [],
    });
    await page.goto(`http://localhost:${port}/video.html`);
    await page.bringToFront();
    const video = page.locator("#v");
    await video.evaluate(async (v) => await v.play());

    const page2 = await context.newPage();
    await page2.goto(`http://localhost:${port}/video.html`);
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();

    await context.updateSettings({
      onlyConfiguredSites: true,
      siteRules: [{ domain: "localhost", enabled: true, overrides: {} }],
    });
    await page.waitForTimeout(1000);

    await page2.bringToFront();
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();

    await video.evaluate(async (v) => await v.play());
    await expect(video).toHaveJSProperty("paused", false);

    await context.updateSettings({
      onlyConfiguredSites: false,
      siteRules: [{ domain: "localhost", enabled: false, overrides: {} }],
    });
    await page.waitForTimeout(1000);

    await page2.bringToFront();
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", false);
  });
});
