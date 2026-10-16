const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");
const { openSection } = require("./helpers");

test.describe("Site rules", () => {
  test("saves and edits an override rule for any site", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await page.goto(server.url("video.html"));
    await page.bringToFront();
    const worker = await extension.worker();
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Domain Settings");
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
      .poll(() => extension.getSettings())
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
    server,
    extension,
  }) => {
    await extension.updateSettings({
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
    const video = await openVideoPage(page, server.url("video.html"));
    await expect
      .poll(() => video.evaluate((element) => element.playbackRate))
      .toBe(1.5);
    await video.evaluate(async (element) => {
      await element.play();
      element.muted = false;
    });
    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", false);
    await expect(video).toHaveJSProperty("muted", true);
    await page.bringToFront();
    await expect(video).toHaveJSProperty("muted", false);
  });

  test("a per-site autopause override inherits the rest of the defaults", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
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
    await page.goto(server.url("video.html"));
    await page.bringToFront();
    const video = page.locator("#v");
    await video.evaluate(async (element) => element.play());
    const otherTab = await switchToNewTab(context, server);
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("per-site enabled state replaces include and exclude lists", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      autopause: true,
      autoresume: true,
      onlyConfiguredSites: false,
      siteRules: [],
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await playVideo(video);

    const page2 = await context.newPage();
    await page2.goto(server.url("video.html"));
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();

    await extension.updateSettings({
      onlyConfiguredSites: true,
      siteRules: [{ domain: "localhost", enabled: true, overrides: {} }],
    });
    await page.waitForTimeout(1000);

    await page2.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();

    await video.evaluate(async (v) => await v.play());
    await expect(video).toHaveJSProperty("paused", false);

    await extension.updateSettings({
      onlyConfiguredSites: false,
      siteRules: [{ domain: "localhost", enabled: false, overrides: {} }],
    });
    await page.waitForTimeout(1000);

    await page2.bringToFront();
    await page.waitForTimeout(2000);
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("labels every per-site setting for assistive technology", async ({
    page,
    server,
    extension,
  }) => {
    await page.goto(server.url());
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Domain Settings");
    await optionsPage.locator("#addSiteRule").click();
    await expect(optionsPage.locator("#siteSettingsTitle")).toHaveText(
      "Settings for localhost",
    );
    await expect(optionsPage.locator("#backToGlobal")).toBeFocused();
    expect(
      await optionsPage
        .locator("#globalSettingsView")
        .evaluate((view) => view.inert),
    ).toBe(true);

    const rows = optionsPage.locator(".site-setting-row");
    const names = await rows.locator("strong").allTextContents();
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((name) => !name.trim())).toEqual([]);
    expect(names).toContain("In-page shortcut keys");
    expect(names).toContain("Quiet hours (local time): Start");
    await expect(
      optionsPage.getByRole("checkbox", {
        name: "Customize for this site: Pause video when switching tabs",
      }),
    ).toBeVisible();
    await optionsPage
      .locator("#siteSettingsFields details")
      .evaluateAll((groups) => groups.forEach((group) => (group.open = true)));
    for (const override of await optionsPage
      .locator("[data-site-override]")
      .all()) {
      await expect(override).toHaveAccessibleName(
        /^Customize for this site: .+/,
      );
    }

    await optionsPage.locator("#backToGlobal").click();
    expect(
      await optionsPage
        .locator("#siteSettingsView")
        .evaluate((view) => view.inert),
    ).toBe(true);
  });

  test("pauses a configured site when switching to an unconfigured one", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
      onlyConfiguredSites: true,
      siteRules: [{ domain: "localhost", enabled: true, overrides: {} }],
    });
    const video = await openVideoPage(page, server.url("video.html"));
    await playVideo(video);

    const otherSite = await context.newPage();
    await otherSite.goto(server.url("", "127.0.0.1"));
    await otherSite.bringToFront();
    await expect(video).toHaveJSProperty("paused", true);
    await page.bringToFront();
    await expect(video).toHaveJSProperty("paused", false);
  });
});
