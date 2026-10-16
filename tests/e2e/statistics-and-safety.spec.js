const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");

test.describe("Statistics and safe mode", () => {
  test("records automatic pauses and playback time prevented locally", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      focuspause: true,
      focusresume: true,
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await video.evaluate((element) => element.play());
    await expect(video).toHaveJSProperty("paused", false);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(video).toHaveJSProperty("paused", true);

    const worker = await extension.worker();
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

  test("disables the affected tab after a content-script error", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await page.goto(server.url("video.html"));
    await expect(page.locator("#v")).toHaveAttribute(
      "data-auto-pause-listener-attached",
      "true",
      { timeout: 10000 },
    );
    const worker = await extension.worker();
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
    const optionsPage = await extension.openOptions();
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

  test("re-registers the content script when its files change", async ({
    extension,
  }) => {
    const registeredFiles = await extension.evaluate(async () => {
      await chrome.scripting.unregisterContentScripts({
        ids: [CONTENT_SCRIPT.id],
      });
      await chrome.scripting.registerContentScripts([
        { ...CONTENT_SCRIPT, js: ["video_auto_pause.js"] },
      ]);
      await registerContentScriptIfNeeded();
      const [script] = await chrome.scripting.getRegisteredContentScripts({
        ids: [CONTENT_SCRIPT.id],
      });
      return script.js;
    });
    expect(registeredFiles).toEqual(["settings.js", "video_auto_pause.js"]);
  });

  test("migrates settings stored by release 1.14 when the background starts", async ({
    extension,
  }) => {
    const result = await extension.evaluate(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set({
        autopause: false,
        audioFading: true,
        fadeDuration: 300,
        excludedDomains: ["blocked.example"],
      });
      await initialize();
      return {
        stored: await chrome.storage.sync.get(null),
        settings: globalSettings,
      };
    });
    expect(Object.keys(result.stored).sort()).toEqual([
      "vapProfile:default",
      "vapProfileIds",
    ]);
    expect(result.settings).toMatchObject({
      autopause: false,
      fadeDuration: 300,
      siteRules: [{ domain: "blocked.example", enabled: false }],
    });
  });
});
