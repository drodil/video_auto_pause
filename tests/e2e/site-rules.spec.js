const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");
const { openSection, computedStyles } = require("./helpers");

test.describe("Site rules", () => {
  for (const layout of [
    { name: "full page" },
    { name: "popup", popup: true },
    { name: "narrow page", viewport: { width: 320, height: 720 } },
  ]) {
    test(`returns directly after saving or deleting site settings in the ${layout.name}`, async ({
      extension,
    }) => {
      const optionsPage = await extension.openOptions(layout);
      const dialogs = [];
      optionsPage.on("dialog", async (dialog) => {
        dialogs.push(dialog.type());
        await dialog.dismiss();
      });
      await openSection(optionsPage, "Site settings");
      const domain = `${"long-site-name-".repeat(3)}example.com`;
      await optionsPage.locator("#newSiteDomain").fill(domain);
      await optionsPage.locator("#newSiteDomain").press("Enter");
      await optionsPage.locator("#siteSettingsDomain").fill("not a domain");
      await optionsPage.locator("#saveSiteSettings").click();
      await expect(optionsPage.locator("#siteSettingsStatus")).toContainText(
        "Could not save",
      );
      await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
        "aria-hidden",
        "false",
      );
      expect((await extension.getSettings()).siteRules).toEqual([]);
      await optionsPage.locator("#siteSettingsDomain").fill(domain);
      await optionsPage.locator('[data-site-value="autopause"]').click();
      await optionsPage.locator('[data-site-value="autopause"]').click();
      await optionsPage.locator("#saveSiteSettings").click();
      await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      const link = optionsPage.locator(`[data-open-site-rule="${domain}"]`);
      await expect(link).toBeFocused();
      await expect(optionsPage.locator("#globalSettingsView")).toHaveCSS(
        "transform",
        "none",
      );
      await expect(optionsPage.locator("#siteRuleStatus")).toContainText(
        "saved",
      );
      await expect
        .poll(() => extension.getSettings())
        .toMatchObject({
          siteRules: [{ domain, overrides: { autopause: false } }],
        });
      const remove = optionsPage.locator(`[data-remove-site-rule="${domain}"]`);
      const box = await remove.boundingBox();
      expect(box.height).toBe(28);
      expect(box.width).toBeLessThanOrEqual(70);
      expect(
        await optionsPage
          .locator("#siteRuleList")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await link.click();
      await optionsPage.locator("#deleteSiteSettings").click();
      await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      await expect(optionsPage.locator("#newSiteDomain")).toBeFocused();
      await expect
        .poll(async () => (await extension.getSettings()).siteRules)
        .toEqual([]);
      await expect(optionsPage.locator("#siteRuleList li")).toHaveCount(0);
      expect(dialogs).toEqual([]);
    });
  }

  test("keeps site settings open and reports failed save and delete storage writes", async ({
    extension,
  }) => {
    await extension.updateSettings({
      siteRules: [{ domain: "example.com", enabled: true, overrides: {} }],
    });
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Site settings");
    await optionsPage.locator('[data-open-site-rule="example.com"]').click();
    await optionsPage.locator('[data-site-value="autopause"]').click();
    await optionsPage.evaluate(() => {
      chrome.storage.sync.set = async () => {
        throw new Error("Storage unavailable");
      };
    });
    await optionsPage.locator("#saveSiteSettings").click();
    await expect(optionsPage.locator("#siteSettingsStatus")).toContainText(
      "Could not save",
    );
    await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    expect((await extension.getSettings()).siteRules).toEqual([
      { domain: "example.com", enabled: true, overrides: {} },
    ]);
    await optionsPage.locator("#siteSettingsStatus").evaluate((element) => {
      element.textContent = "";
    });
    await optionsPage.locator("#deleteSiteSettings").click();
    await expect(optionsPage.locator("#siteSettingsStatus")).toContainText(
      "Could not save",
    );
    await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    expect((await extension.getSettings()).siteRules).toHaveLength(1);
  });

  test("adds a site without visiting it and cycles boolean overrides with mouse and keyboard", async ({
    extension,
  }) => {
    const optionsPage = await extension.openOptions();
    const groupTitles = [
      "General settings",
      "Focus & visibility",
      "Playback & audio",
      "Playback adjustments",
      "Video controls & shortcuts",
      "Automation",
      "Troubleshooting",
    ];
    const globalGroups = optionsPage.locator("[data-settings-group]");
    await expect(globalGroups.locator(".collapsible-button")).toHaveText(
      groupTitles,
    );
    await expect(
      globalGroups.first().locator(".collapsible-button"),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      globalGroups.locator('.collapsible-button[aria-expanded="false"]'),
    ).toHaveCount(6);
    await expect(
      optionsPage.getByText("Advanced Settings", { exact: true }),
    ).toHaveCount(0);
    await expect(globalGroups.first().locator("#manualPause")).toBeVisible();
    await openSection(optionsPage, "Site settings");
    const domain = optionsPage.locator("#newSiteDomain");
    await domain.fill("not a domain");
    await optionsPage
      .getByRole("button", { name: "Add new site", exact: true })
      .click();
    await expect(optionsPage.locator("#siteRuleStatus")).not.toBeEmpty();
    await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await domain.fill("https://Example.com/path");
    await domain.press("Enter");
    const siteGroups = optionsPage.locator("#siteSettingsFields details");
    await expect(siteGroups.locator("summary")).toHaveText(groupTitles);
    await expect(
      optionsPage.locator("#siteSettingsFields details[open]"),
    ).toHaveCount(1);
    await expect(siteGroups.first()).toHaveJSProperty("open", true);
    const siteSettingKeys = await optionsPage
      .locator("[data-site-value], [data-site-override=contentShortcutKeys]")
      .evaluateAll((inputs) =>
        inputs
          .map((input) => input.dataset.siteValue ?? input.dataset.siteOverride)
          .sort(),
      );
    expect(siteSettingKeys).toEqual(
      await extension.evaluate(() => [...SITE_OVERRIDE_SETTINGS].sort()),
    );
    for (const [group, setting] of [
      ["generalSettings", "manualPause"],
      ["focusSettings", "peekMode"],
      ["playbackSettings", "muteVideo"],
      ["videoControlsSettings", "contentShortcutsEnabled"],
      ["automationSettings", "quietHoursStart"],
      ["playbackAdjustments", "fadeDuration"],
      ["troubleshootingSettings", "debugMode"],
    ]) {
      await expect(
        optionsPage.locator(`[data-settings-group="${group}"] #${setting}`),
      ).toHaveCount(1);
      await expect(
        optionsPage.locator(
          `[data-site-settings-group="${group}"] [data-site-value="${setting}"]`,
        ),
      ).toHaveCount(1);
    }
    await expect(
      optionsPage.getByRole("button", {
        name: "Save site settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(optionsPage.locator("#siteSettingsDomain")).toHaveValue(
      "example.com",
    );
    const checkbox = optionsPage.locator('[data-site-value="autopause"]');
    await expect(checkbox).toHaveJSProperty("indeterminate", true);
    await expect(checkbox).toHaveAttribute("aria-checked", "mixed");
    await expect(checkbox).toHaveAccessibleDescription(
      /Use default settings: Enabled/,
    );
    await checkbox.locator("..").click();
    await expect(checkbox).toHaveAttribute("aria-checked", "true");
    await optionsPage.locator("#saveSiteSettings").click();
    await expect
      .poll(() => extension.getSettings())
      .toMatchObject({
        siteRules: [{ domain: "example.com", overrides: { autopause: true } }],
      });
    await expect(optionsPage.locator("#siteSettingsView")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(
      optionsPage.locator('[data-open-site-rule="example.com"]'),
    ).toBeFocused();
    await optionsPage.locator('[data-open-site-rule="example.com"]').click();
    await checkbox.focus();
    await optionsPage.keyboard.press("Space");
    await expect(checkbox).toHaveAttribute("aria-checked", "false");
    await optionsPage.locator("#saveSiteSettings").click();
    await expect
      .poll(() => extension.getSettings())
      .toMatchObject({
        siteRules: [{ domain: "example.com", overrides: { autopause: false } }],
      });
    await optionsPage.reload();
    await openSection(optionsPage, "Site settings");
    await optionsPage.locator('[data-open-site-rule="example.com"]').click();
    await expect(checkbox).toHaveAttribute("aria-checked", "false");
    await checkbox.focus();
    await optionsPage.keyboard.press("Space");
    await expect(checkbox).toHaveJSProperty("indeterminate", true);
    await optionsPage.locator("#saveSiteSettings").click();
    await expect
      .poll(async () => (await extension.getSettings()).siteRules)
      .toEqual([{ domain: "example.com", enabled: true, overrides: {} }]);
    await extension.updateSettings({ autopause: false });
    await optionsPage.locator('[data-open-site-rule="example.com"]').click();
    await expect(checkbox).toHaveAttribute("aria-checked", "mixed");
    await expect(checkbox).toHaveAccessibleDescription(
      /Use default settings: Disabled/,
    );
    await optionsPage.locator("#siteSettingsDomain").fill("other.example");
    await optionsPage.locator("#saveSiteSettings").click();
    await expect
      .poll(async () => (await extension.getSettings()).siteRules)
      .toEqual([{ domain: "other.example", enabled: true, overrides: {} }]);
    await expect(
      optionsPage.locator('[data-open-site-rule="other.example"]'),
    ).toBeFocused();
  });

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
    const disclosureStyles = [
      "padding",
      "margin",
      "backgroundColor",
      "color",
      "fontSize",
      "fontWeight",
      "border",
      "borderRadius",
      "minHeight",
    ];
    const defaultDisclosureStyle = await computedStyles(
      optionsPage.locator('[aria-controls="settingsContent"]'),
      disclosureStyles,
    );
    const defaultContentStyle = await computedStyles(
      optionsPage.locator("#settingsContent"),
      ["padding"],
    );
    const defaultCheckboxSpacing = await optionsPage
      .locator("#autoresume")
      .evaluate(
        (input) =>
          input.getBoundingClientRect().y -
          document.getElementById("autopause").getBoundingClientRect().y,
      );
    await openSection(optionsPage, "Site settings");
    await optionsPage.locator("#addSiteRule").click();
    await expect(optionsPage.locator("#siteSettingsTitle")).toContainText(
      "localhost",
    );
    for (const summary of await optionsPage
      .locator("#siteSettingsFields summary")
      .all()) {
      expect(await computedStyles(summary, disclosureStyles)).toEqual(
        defaultDisclosureStyle,
      );
    }
    expect(
      await computedStyles(
        optionsPage.locator("#siteSettingsFields .disclosure-content").first(),
        ["padding"],
      ),
    ).toEqual(defaultContentStyle);
    expect(
      await optionsPage
        .locator('[data-site-value="autoresume"]')
        .evaluate(
          (input) =>
            input.getBoundingClientRect().y -
            document
              .querySelector('[data-site-value="autopause"]')
              .getBoundingClientRect().y,
        ),
    ).toBe(defaultCheckboxSpacing);
    for (const title of [
      "Playback & audio",
      "Playback adjustments",
      "Automation",
      "Video controls & shortcuts",
    ]) {
      await optionsPage
        .locator("#siteSettingsFields")
        .getByText(title, { exact: true })
        .click();
    }
    await optionsPage.locator('[data-site-value="muteVideo"]').click();
    await optionsPage.locator('[data-site-override="pauseDelay"]').check();
    await optionsPage.locator('[data-site-value="pauseDelay"]').fill("250");
    await optionsPage.locator('[data-site-override="resumeDelay"]').check();
    await optionsPage.locator('[data-site-value="resumeDelay"]').fill("500");
    await optionsPage.locator('[data-site-override="playbackSpeed"]').check();
    await optionsPage.locator('[data-site-value="playbackSpeed"]').fill("1.75");
    await optionsPage.locator('[data-site-override="fadeDuration"]').check();
    await optionsPage.locator('[data-site-value="fadeDuration"]').fill("450");
    await optionsPage.locator('[data-site-value="allowAudio"]').click();
    await optionsPage.locator('[data-site-value="allowAudio"]').click();
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
    await expect(optionsPage.locator("#siteRuleStatus")).toContainText("saved");
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
    await expect(optionsPage.locator('input[type="search"]')).toHaveCount(0);
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
    await openSection(optionsPage, "Site settings");
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
    const names = await rows.locator("strong, .label-text").allTextContents();
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((name) => !name.trim())).toEqual([]);
    expect(names).toContain("In-page shortcut keys");
    expect(names).toContain("Quiet hours (local time): Start");
    await expect(
      optionsPage.getByRole("checkbox", {
        name: "Pause video when switching tabs",
      }),
    ).toBeVisible();
    const inherited = optionsPage.locator('[data-site-value="autopause"]');
    await expect(inherited).toHaveAttribute("aria-checked", "mixed");
    await expect(inherited).toHaveAccessibleDescription(/Use default settings/);
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
