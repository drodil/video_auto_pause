const { test, expect } = require("./fixtures");
const {
  openSection,
  openSettingsGroups,
  computedStyles,
} = require("./helpers");

test.describe("Options page", () => {
  test("orders related sections together and leaves troubleshooting last", async ({
    extension,
  }) => {
    const page = await extension.openOptions();
    await expect(
      page.locator(
        "#globalSettingsView > .section > .collapsible-button, #globalSettingsView > .section > details > summary",
      ),
    ).toHaveText(
      [
        "General settings",
        "Choose a mode",
        "Site settings",
        "Profiles & backup",
        "Focus & visibility",
        "Playback & audio",
        "Playback adjustments",
        "Video controls & shortcuts",
        "Hotkeys",
        "Automation",
        "Sleep timer",
        "Statistics",
        "Troubleshooting",
      ],
      { useInnerText: true },
    );
    await expect(
      page.locator('[aria-controls="settingsContent"]'),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.locator('[aria-controls="troubleshootingSettingsContent"]'),
    ).toHaveAttribute("aria-expanded", "false");
    for (const [group, ids] of [
      [
        "generalSettings",
        [
          "autopause",
          "autoresume",
          "focuspause",
          "focusresume",
          "manualPause",
          "disableOnFullscreen",
          "disabledTabs",
          "disabled",
        ],
      ],
      [
        "focusSettings",
        [
          "scrollpause",
          "singleVideoPlayback",
          "lockpause",
          "lockresume",
          "peekMode",
          "cursorTracking",
        ],
      ],
      [
        "playbackSettings",
        [
          "blockAutoplay",
          "disableAutoplayNext",
          "prioritizeActiveTabMedia",
          "muteVideo",
          "allowAudio",
          "pauseAtEnd",
          "liveStreamMute",
          "muteDuringAds",
        ],
      ],
      [
        "videoControlsSettings",
        [
          "showVideoOverlay",
          "showPipButton",
          "autoPipOnTabSwitch",
          "contentShortcutsEnabled",
        ],
      ],
      [
        "automationSettings",
        [
          "idlePauseMinutes",
          "quietHoursStart",
          "quietHoursEnd",
          "pauseOnLowBattery",
          "pauseOnAudioOutputDisconnect",
        ],
      ],
      [
        "playbackAdjustments",
        [
          "playbackSpeed",
          "rewindSeconds",
          "pauseDelay",
          "resumeDelay",
          "fadeDuration",
        ],
      ],
    ]) {
      expect(
        await page
          .locator(`[data-settings-group="${group}"] input[id]`)
          .evaluateAll((inputs) =>
            inputs
              .filter((input) => !input.closest("#contentShortcutSettings"))
              .map((input) => input.id),
          ),
      ).toEqual(ids);
    }
  });

  test("insets dropdown arrows in both directions and preserves native keyboard selection and high contrast", async ({
    extension,
  }) => {
    await extension.updateSettings({ playbackSpeed: 1 });
    const workId = await extension.evaluate(() => createProfile("Work"));
    await extension.updateSettings({ playbackSpeed: 1.5 });
    const page = await extension.openOptions();
    await page.locator("#sleepTimerSection summary").click();
    const select = page.getByRole("combobox", {
      name: "Choose a profile",
      exact: true,
    });
    for (const direction of ["ltr", "rtl"]) {
      await page.locator("html").evaluate((element, dir) => {
        element.dir = dir;
      }, direction);
      for (const control of await page.getByRole("combobox").all()) {
        await expect(control).toHaveCSS("appearance", "none");
        await expect(control).toHaveCSS("padding-inline-start", "9px");
        await expect(control).toHaveCSS("padding-inline-end", "36px");
        await expect(control).toHaveCSS("background-size", "12px 12px");
        await expect(control).toHaveCSS(
          "background-position-x",
          direction === "rtl" ? "12px" : "calc(100% - 12px)",
        );
      }
      await select.selectOption("default");
      await expect
        .poll(() => extension.getSettings())
        .toMatchObject({ playbackSpeed: 1 });
      await select.focus();
      await page.keyboard.press("w");
      await page.keyboard.press("Enter");
      await expect(select).toHaveValue(workId);
      await expect
        .poll(() => extension.getSettings())
        .toMatchObject({ playbackSpeed: 1.5 });
    }
    await select
      .locator("option")
      .first()
      .evaluate((option) => {
        option.dataset.retained = "true";
      });
    await extension.updateSettings({ debugMode: true });
    await expect(page.locator("#debugMode")).toBeChecked();
    await expect(select.locator("option").first()).toHaveAttribute(
      "data-retained",
      "true",
    );
    await page.emulateMedia({ forcedColors: "active" });
    await expect(select).toHaveCSS("appearance", "auto");
    await expect(select).toHaveCSS("background-image", "none");
    await page.reload();
    await expect(select).toHaveValue(workId);
  });

  for (const layout of [
    { name: "full page", viewport: { width: 1280, height: 800 } },
    { name: "narrow page", viewport: { width: 320, height: 720 } },
    { name: "popup", popup: true, viewport: { width: 800, height: 700 } },
  ]) {
    test(`uses consistent form controls and labels throughout the ${layout.name}`, async ({
      extension,
    }) => {
      const page = await extension.openOptions(layout);
      await openSection(page, "Profiles & backup");
      await page.locator("#profileName").fill("UI checks");
      await page.locator("#saveProfile").click();
      await expect(page.locator("#profileStatus")).toContainText("saved");
      await expect(page.locator("#activeProfileControl")).toBeVisible();
      await openSettingsGroups(page);
      await page.locator("#contentShortcutsEnabled").check();
      await openSection(page, "Site settings");
      await page.locator("#sleepTimerSection summary").click();
      await page.locator("#statisticsSection summary").click();
      await page.locator(".header").click();

      const inputStyle = [
        "paddingTop",
        "paddingBottom",
        "paddingInlineStart",
        "border",
        "borderRadius",
        "backgroundColor",
        "color",
        "fontSize",
        "fontFamily",
        "fontWeight",
        "minHeight",
      ];
      const expectedInputStyle = await computedStyles(
        page.locator("#playbackSpeed"),
        inputStyle,
      );
      const labelStyle = [
        "padding",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "color",
      ];
      const expectedLabelStyle = await computedStyles(
        page.locator('label[for="playbackSpeed"]'),
        labelStyle,
      );
      for (const control of await page
        .locator(
          '#globalSettingsView input:not([type="checkbox"]):not([type="file"]), #globalSettingsView select',
        )
        .all()) {
        await expect(control).toBeVisible();
        expect(
          await computedStyles(control, inputStyle),
          await control.getAttribute("id"),
        ).toEqual(expectedInputStyle);
        await expect(control).toHaveCSS(
          "padding-inline-end",
          (await control.evaluate((element) => element.tagName)) === "SELECT"
            ? "36px"
            : "9px",
        );
        expect(
          (await control.boundingBox()).height,
          await control.getAttribute("id"),
        ).toBe(38);
      }
      for (const label of await page
        .locator("#globalSettingsView label[for]")
        .all()) {
        expect(
          await computedStyles(label, labelStyle),
          await label.getAttribute("for"),
        ).toEqual(expectedLabelStyle);
      }
      for (const id of [
        "fadeDuration",
        "rewindSeconds",
        "playbackSpeed",
        "idlePauseMinutes",
        "pauseDelay",
        "resumeDelay",
        "quietHoursStart",
        "quietHoursEnd",
        "profileName",
        "activeProfileSelect",
        "newSiteDomain",
      ]) {
        const input = page.locator(`#${id}`);
        const availableWidth = await input.evaluate((element) => {
          const parent = element.parentElement;
          const style = getComputedStyle(parent);
          return (
            parent.getBoundingClientRect().width -
            Number.parseFloat(style.borderLeftWidth) -
            Number.parseFloat(style.borderRightWidth) -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight)
          );
        });
        expect((await input.boundingBox()).width, id).toBeCloseTo(
          availableWidth,
          1,
        );
      }
      expect(
        await computedStyles(page.locator("#fadeDuration").locator(".."), [
          "marginTop",
        ]),
      ).toEqual(
        await computedStyles(page.locator("#playbackSpeed").locator(".."), [
          "marginTop",
        ]),
      );
      const button = page.locator('[aria-controls="profilesContent"]');
      const summary = page.locator("#sleepTimerSection summary");
      await button.hover();
      await expect(button).toHaveCSS("background-color", "rgb(238, 242, 255)");
      await summary.hover();
      await expect(summary).toHaveCSS("background-color", "rgb(238, 242, 255)");
      await page.locator("#newSiteDomain").fill("example.com");
      await page.locator("#newSiteDomain").press("Enter");
      for (const details of await page
        .locator("#siteSettingsFields details")
        .all()) {
        if (!(await details.evaluate((element) => element.open))) {
          await details.locator("summary").click();
        }
      }
      await page.locator("#siteSettingsTitle").click();
      for (const control of await page
        .locator('#siteSettingsView input:not([type="checkbox"])')
        .all()) {
        await expect(control).toBeVisible();
        expect(
          await computedStyles(control, inputStyle),
          await control.getAttribute("data-site-value"),
        ).toEqual(expectedInputStyle);
        expect((await control.boundingBox()).height).toBe(38);
      }
      for (const label of await page
        .locator(
          "#siteSettingsView label[for], .site-setting-row > strong, .site-shortcut-fields label",
        )
        .all()) {
        expect(await computedStyles(label, labelStyle)).toEqual(
          expectedLabelStyle,
        );
      }
    });
  }

  test("updates the sleep timer countdown without reopening a manually collapsed section", async ({
    context,
    extension,
  }) => {
    const time = new Date("2030-01-01T12:00:00Z");
    await extension.evaluate(
      (expiry) =>
        chrome.storage.local.set({
          vapSleepTimerExpiresAt: expiry,
        }),
      time.getTime() + 65000,
    );
    const page = await context.newPage();
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
    await page.goto(extension.url("options.html"));
    const section = page.locator("#sleepTimerSection");
    const remaining = page.locator("#sleepTimerRemaining");
    await expect(section).toHaveJSProperty("open", true);
    await expect(remaining).toHaveText("1:05");
    await section.locator("summary").click();
    await page.clock.fastForward(5000);
    await expect(remaining).toHaveText("1:00");
    await expect(section).toHaveJSProperty("open", false);
    await page.clock.fastForward(61000);
    await expect(remaining).toBeHidden();
    await section.locator("summary").click();
    await expect(page.locator("#startSleepTimer")).toBeVisible();
    await expect(page.locator("#sleepTimerStatus")).toBeEmpty();
  });

  test("keeps grouped checkbox spacing uniform and focus rings inside clipped content", async ({
    extension,
  }) => {
    const page = await extension.openOptions({
      viewport: { width: 430, height: 700 },
    });
    await openSettingsGroups(page);
    for (const ids of [
      ["blockAutoplay", "disableAutoplayNext", "prioritizeActiveTabMedia"],
      ["pauseOnLowBattery", "pauseOnAudioOutputDisconnect"],
    ]) {
      const boxes = await Promise.all(
        ids.map((id) => page.locator(`#${id}`).boundingBox()),
      );
      const gaps = boxes
        .slice(1)
        .map((box, index) => Math.round(box.y - boxes[index].y));
      expect(new Set(gaps).size).toBe(1);
      expect(gaps[0]).toBeGreaterThanOrEqual(28);
    }
    for (const id of [
      "idlePauseMinutes",
      "quietHoursStart",
      "quietHoursEnd",
      "pauseDelay",
      "resumeDelay",
      "rewindSeconds",
      "playbackSpeed",
      "fadeDuration",
    ]) {
      const input = page.locator(`#${id}`);
      await input.focus();
      const offset = await input.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).outlineOffset),
      );
      expect(offset).toBeLessThanOrEqual(-2);
      const [box, content] = await Promise.all([
        input.boundingBox(),
        page
          .locator(".collapsible-content")
          .filter({ has: input })
          .boundingBox(),
      ]);
      expect(box.x).toBeGreaterThanOrEqual(content.x);
      expect(box.x + box.width).toBeLessThanOrEqual(content.x + content.width);
    }
  });

  test("shows zero statistics for a new installation in all time periods", async ({
    extension,
  }) => {
    const page = await extension.openOptions();
    await page.locator("#statisticsSection summary").click();
    for (const period of ["7", "30", "90"]) {
      await page.locator(`[data-stats-days="${period}"]`).click();
      await expect(page.locator("#statsPeriod [aria-pressed=true]")).toHaveText(
        `Last ${period} days`,
      );
      await expect(page.locator(".stat-card dd")).toHaveText([
        "0",
        "0",
        "0",
        "0",
      ]);
    }
    await expect(page.locator("#rateExtension")).toBeHidden();
  });

  test("switches statistics periods with pointer and keyboard, excludes out-of-range days, and updates live", async ({
    extension,
  }) => {
    await extension.evaluate(async () => {
      const date = new Date().toISOString().slice(0, 10);
      const day = (age) => {
        const value = new Date();
        value.setUTCDate(value.getUTCDate() - age);
        return value.toISOString().slice(0, 10);
      };
      await chrome.storage.local.set({
        vapStats: {
          totalPauses: 50,
          [date]: {
            pauses: 50,
            resumes: 12,
            autoplayBlocked: 3,
            preventedSeconds: 7200,
          },
          [day(6)]: { pauses: 2, resumes: 1, preventedSeconds: 60 },
          [day(7)]: {
            pauses: 3,
            resumes: 2,
            autoplayBlocked: 1,
            preventedSeconds: 120,
          },
          [day(29)]: { pauses: 4, autoplayBlocked: 2, preventedSeconds: 180 },
          [day(30)]: {
            pauses: 5,
            resumes: 3,
            autoplayBlocked: 4,
            preventedSeconds: 240,
          },
          [day(89)]: {
            pauses: 6,
            resumes: 4,
            autoplayBlocked: 5,
            preventedSeconds: 300,
          },
          [day(90)]: { pauses: 10000 },
          [day(-1)]: { pauses: 10000 },
        },
      });
    });
    const optionsPage = await extension.openOptions();
    const summary = optionsPage.locator("#statsSummary");
    await expect(summary).toBeHidden();
    const disclosure = optionsPage.getByText("Statistics", { exact: true });
    await disclosure.focus();
    await optionsPage.keyboard.press("Enter");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("52 pauses");
    await expect(summary).toContainText("13 resumes");
    await expect(summary).toContainText("121 min");
    await expect(optionsPage.locator("#statsPauses")).toHaveText("52");
    await expect(optionsPage.locator("#statsPreventedMinutes")).toHaveText(
      "121",
    );
    const periods = optionsPage.getByRole("group", { name: "Time period" });
    await periods
      .getByRole("button", { name: "Last 30 days", exact: true })
      .click();
    await expect(periods.getByRole("button", { pressed: true })).toHaveText(
      "Last 30 days",
    );
    await expect(optionsPage.locator("#statsPauses")).toHaveText("59");
    await expect(optionsPage.locator("#statsResumes")).toHaveText("15");
    await expect(optionsPage.locator("#statsAutoplayBlocks")).toHaveText("6");
    await expect(optionsPage.locator("#statsPreventedMinutes")).toHaveText(
      "126",
    );
    const ninetyDays = periods.getByRole("button", {
      name: "Last 90 days",
      exact: true,
    });
    await ninetyDays.focus();
    await optionsPage.keyboard.press("Enter");
    await expect(periods.getByRole("button", { pressed: true })).toHaveText(
      "Last 90 days",
    );
    await expect(optionsPage.locator(".stat-card dd")).toHaveText([
      "70",
      "22",
      "15",
      "135",
    ]);
    await extension.evaluate(async () => {
      const { vapStats } = await chrome.storage.local.get("vapStats");
      vapStats[new Date().toISOString().slice(0, 10)].pauses += 1;
      await chrome.storage.local.set({ vapStats });
    });
    await expect(optionsPage.locator("#statsPauses")).toHaveText("71");
    await expect(periods.getByRole("button", { pressed: true })).toHaveText(
      "Last 90 days",
    );
    await periods
      .getByRole("button", { name: "Last 7 days", exact: true })
      .focus();
    await optionsPage.keyboard.press("Space");
    await expect(optionsPage.locator(".stat-card dd")).toHaveText([
      "53",
      "13",
      "3",
      "121",
    ]);
    await expect(periods.getByRole("button", { pressed: true })).toHaveText(
      "Last 7 days",
    );
    const popup = await extension.openOptions({ popup: true });
    await popup.locator("#statisticsSection summary").click();
    for (const [days, pauses] of [
      [30, "60"],
      [90, "71"],
      [7, "53"],
    ]) {
      await popup
        .getByRole("button", { name: `Last ${days} days`, exact: true })
        .click();
      await expect(popup.locator("#statsPauses")).toHaveText(pauses);
      await expect(popup.getByRole("button", { pressed: true })).toHaveText(
        `Last ${days} days`,
      );
    }
    await expect(optionsPage.locator("#rateExtension")).toBeVisible();
    await disclosure.click();
    await expect(summary).toBeHidden();
  });

  test("opens the sleep timer only when active and collapses after cancellation", async ({
    extension,
  }) => {
    await extension.evaluate(() =>
      chrome.storage.local.set({
        vapSleepTimerExpiresAt: Date.now() - 60000,
      }),
    );
    const optionsPage = await extension.openOptions();
    const section = optionsPage.locator("#sleepTimerSection");
    await expect(section).toHaveJSProperty("open", false);
    await section.locator("summary").focus();
    await optionsPage.keyboard.press("Enter");
    await expect(section).toHaveJSProperty("open", true);
    await optionsPage.locator("#startSleepTimer").click();
    await expect(optionsPage.locator("#cancelSleepTimer")).toBeVisible();
    await optionsPage.locator("#cancelSleepTimer").click();
    await expect(section).toHaveJSProperty("open", false);
    await optionsPage.reload();
    await expect(section).toHaveJSProperty("open", false);
    await section.locator("summary").click();
    await expect(optionsPage.locator("#startSleepTimer")).toBeVisible();
    await expect(optionsPage.locator("#sleepTimerStatus")).toBeEmpty();
  });

  test("sizes the popup and full page layouts", async ({ extension }) => {
    const popupPage = await extension.openOptions({
      popup: true,
      viewport: { width: 1280, height: 800 },
    });
    const popupBounds = await popupPage.locator("#wrapper").boundingBox();
    expect([popupBounds.width, popupBounds.height]).toEqual([600, 600]);

    const optionsPage = await extension.openOptions({
      viewport: { width: 1280, height: 800 },
    });
    const wrapperBounds = await optionsPage.locator("#wrapper").boundingBox();
    expect(wrapperBounds.width).toBe(600);
    expect(wrapperBounds.height).toBeGreaterThanOrEqual(800);
    await optionsPage.setViewportSize({ width: 430, height: 700 });
    const narrowBounds = await optionsPage.locator("#wrapper").boundingBox();
    expect(narrowBounds.width).toBe(430);
    expect(narrowBounds.height).toBeGreaterThanOrEqual(700);
  });

  test("keeps optional controls compact and visually consistent", async ({
    extension,
  }) => {
    const optionsPage = await extension.openOptions({
      viewport: { width: 1280, height: 800 },
    });
    await expect(optionsPage.locator("#activeProfileControl")).toBeHidden();
    const pinButton = optionsPage.getByRole("button", {
      name: "Keep playing in this tab",
    });
    await expect(pinButton).toBeVisible();
    await expect(pinButton.locator("svg")).toHaveCount(1);
    expect((await pinButton.boundingBox()).width).toBeLessThanOrEqual(44);

    await expect(optionsPage.locator("[data-preset]").first()).toBeHidden();
    const presetDisclosure = optionsPage.locator(".preset-options summary");
    const profilesDisclosure = optionsPage
      .locator(".collapsible-button")
      .filter({ hasText: "Profiles & backup" });
    const disclosureStyle = [
      "backgroundColor",
      "color",
      "fontSize",
      "fontWeight",
      "border",
      "borderRadius",
      "padding",
      "margin",
      "minHeight",
    ];
    expect(await computedStyles(presetDisclosure, disclosureStyle)).toEqual(
      await computedStyles(profilesDisclosure, disclosureStyle),
    );
    for (const selector of [
      "#sleepTimerSection summary",
      "#statisticsSection summary",
    ]) {
      expect(
        await computedStyles(optionsPage.locator(selector), disclosureStyle),
      ).toEqual(await computedStyles(profilesDisclosure, disclosureStyle));
    }
    const sectionStyles = ["padding", "margin"];
    expect(
      await computedStyles(
        optionsPage.locator("#sleepTimerSection").locator(".."),
        sectionStyles,
      ),
    ).toEqual(
      await computedStyles(profilesDisclosure.locator(".."), sectionStyles),
    );
    const [exportBox, importBox] = await Promise.all(
      ["#exportSettings", "#importSettings"].map((selector) =>
        optionsPage.locator(selector).boundingBox(),
      ),
    );
    expect([exportBox.width, exportBox.height]).toEqual([
      importBox.width,
      importBox.height,
    ]);
    const supportStyle = ["fontSize", "padding", "minHeight"];
    expect(
      await computedStyles(
        optionsPage.locator("#copyDiagnostics"),
        supportStyle,
      ),
    ).toEqual(
      await computedStyles(
        optionsPage.locator(".support-link[href]").first(),
        supportStyle,
      ),
    );

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
    await expect(profilesDisclosure).toHaveAttribute("aria-expanded", "false");

    await openSection(optionsPage, "Video controls & shortcuts");
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeHidden();
    await optionsPage.locator("#contentShortcutsEnabled").check();
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeVisible();
    await optionsPage.locator("#contentShortcutsEnabled").uncheck();
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeHidden();

    await openSection(optionsPage, "Profiles & backup");
    await optionsPage.locator("#profileName").fill("Work");
    await optionsPage.locator("#saveProfile").click();
    await expect(optionsPage.locator("#profileStatus")).toContainText("saved");
    const actionColors = await Promise.all(
      ["#saveProfile", "#exportSettings", "[data-remove-profile]"].map(
        (selector) =>
          optionsPage
            .locator(selector)
            .evaluate((element) => getComputedStyle(element).backgroundColor),
      ),
    );
    expect(new Set(actionColors).size).toBe(3);
    await expect(optionsPage.locator("#activeProfileControl")).toBeVisible();
    await expect(optionsPage.locator("#activeProfileSelect")).not.toHaveValue(
      "default",
    );
  });

  test("keeps settings usable in a narrow touch viewport and sets document language", async ({
    context,
    extension,
  }) => {
    const optionsPage = await context.newPage();
    await optionsPage.setViewportSize({ width: 320, height: 720 });
    const cdp = await context.newCDPSession(optionsPage);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
      configuration: "mobile",
    });
    await optionsPage.goto(extension.url("options.html"));
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
    await expect(optionsPage.locator("label:has(#autopause)")).toHaveCSS(
      "min-height",
      "44px",
    );
    await openSection(optionsPage, "Playback adjustments");
    await openSection(optionsPage, "Profiles & backup");
    for (const id of [
      "fadeDuration",
      "playbackSpeed",
      "profileName",
      "saveProfile",
      "exportSettings",
    ]) {
      await expect(optionsPage.locator(`#${id}`)).toHaveCSS(
        "min-height",
        "44px",
      );
    }
    await optionsPage.locator("#profileName").fill("Touch profile");
    await optionsPage.locator("#saveProfile").click();
    await expect(optionsPage.locator("[data-remove-profile]")).toHaveCSS(
      "min-height",
      "44px",
    );
    await openSection(optionsPage, "Site settings");
    await optionsPage.locator("#newSiteDomain").fill("touch.example");
    await optionsPage.locator("#newSiteDomain").press("Enter");
    await optionsPage.locator("#saveSiteSettings").click();
    await expect(
      optionsPage.locator('[data-remove-site-rule="touch.example"]'),
    ).toHaveCSS("min-height", "44px");
    await cdp.detach();
  });

  test("shows accessible tooltips on hover and keyboard focus", async ({
    page,
    server,
    extension,
  }) => {
    await page.goto(server.url());
    const optionsPage = await extension.openOptions();
    const tooltip = optionsPage.getByRole("tooltip");
    const pinButton = optionsPage.locator("#pinCurrentTab");
    await expect(pinButton).not.toHaveAttribute("title", /.*/);

    await pinButton.hover();
    await expect(tooltip).toHaveText("Keep playing in this tab");
    await optionsPage.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();

    await openSection(optionsPage, "Focus & visibility");
    const peekMode = optionsPage.locator("#peekMode");
    const peekDescription =
      "When focus pausing is on, a video keeps playing while the pointer is over it.";
    await expect(peekMode).toHaveAccessibleDescription(peekDescription);
    await peekMode.focus();
    await optionsPage.keyboard.press("Shift+Tab");
    await optionsPage.keyboard.press("Tab");
    await expect(peekMode).toBeFocused();
    await expect(tooltip).toHaveText(peekDescription);
    const [tooltipBox, viewport] = [
      await tooltip.boundingBox(),
      optionsPage.viewportSize(),
    ];
    expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(viewport.width);
    await optionsPage.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();

    await expect(
      optionsPage.locator("#copyDiagnostics"),
    ).toHaveAccessibleDescription(/Nothing is sent automatically/);
    await expect(
      optionsPage.locator("#reportSite"),
    ).toHaveAccessibleDescription(/nothing is sent/);
    for (const id of ["pauseOnLowBattery", "pauseOnAudioOutputDisconnect"]) {
      await expect(optionsPage.locator(`#${id}`)).toHaveAccessibleDescription(
        /.+/,
      );
    }
  });

  test("persists every setting control and restores it after reload", async ({
    extension,
  }) => {
    const optionsPage = await extension.openOptions();
    await openSettingsGroups(optionsPage);
    await openSection(optionsPage, "Site settings");
    const checkboxIds = await optionsPage
      .locator("#globalSettingsView input[type=checkbox][id]")
      .evaluateAll((inputs) =>
        inputs
          .map((input) => input.id)
          .filter((id) => !["disabled", "disabledTabs"].includes(id)),
      );
    const defaults = await extension.evaluate(() => DEFAULT_SETTINGS);
    const expected = {};
    for (const id of checkboxIds) {
      expect(typeof defaults[id], `${id} should be a boolean setting`).toBe(
        "boolean",
      );
      const checkbox = optionsPage.locator(`#${id}`);
      await checkbox.setChecked(!defaults[id]);
      expected[id] = !defaults[id];
    }
    const numericValues = {
      idlePauseMinutes: "15",
      pauseDelay: "100",
      resumeDelay: "200",
      rewindSeconds: "3",
      playbackSpeed: "1.5",
      fadeDuration: "250",
    };
    for (const [id, value] of Object.entries(numericValues)) {
      await optionsPage.locator(`#${id}`).fill(value);
      await optionsPage.locator(`#${id}`).dispatchEvent("change");
      expected[id] = Number(value);
    }
    await optionsPage.locator("#quietHoursStart").fill("22:00");
    await optionsPage.locator("#quietHoursEnd").fill("07:30");
    expected.quietHoursStart = "22:00";
    expected.quietHoursEnd = "07:30";
    await expect.poll(() => extension.getSettings()).toMatchObject(expected);

    await optionsPage.reload();
    await expect(optionsPage.locator("body")).toHaveAttribute(
      "data-settings-ready",
      "true",
    );
    for (const [id, value] of Object.entries(expected)) {
      const control = optionsPage.locator(`#${id}`);
      if (typeof value === "boolean") {
        await expect(control, id).toBeChecked({ checked: value });
      } else {
        await expect(control, id).toHaveValue(String(value));
      }
    }
  });

  test("clamps numeric values to their supported ranges", async ({
    extension,
  }) => {
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Playback adjustments");
    await openSection(optionsPage, "Automation");
    for (const [id, value] of [
      ["pauseDelay", "-250"],
      ["rewindSeconds", "500"],
      ["playbackSpeed", "1.6"],
      ["idlePauseMinutes", "999"],
    ]) {
      await optionsPage.locator(`#${id}`).fill(value);
      await optionsPage.locator(`#${id}`).dispatchEvent("change");
    }
    await expect
      .poll(() => extension.getSettings())
      .toMatchObject({
        pauseDelay: 0,
        rewindSeconds: 60,
        playbackSpeed: 1.5,
        idlePauseMinutes: 240,
      });
  });

  test("disables other controls while the extension is disabled", async ({
    extension,
  }) => {
    const optionsPage = await extension.openOptions();
    await optionsPage.locator("#disabled").check();
    await expect(optionsPage.locator("#autopause")).toBeDisabled();
    await expect
      .poll(() => extension.getSettings())
      .toMatchObject({
        disabled: true,
      });
    await optionsPage.locator("#disabled").uncheck();
    await expect(optionsPage.locator("#autopause")).toBeEnabled();
  });

  test("copies local diagnostics without submitting them", async ({
    extension,
  }) => {
    const optionsPage = await extension.openOptions();
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
    const diagnostics = JSON.parse(
      await optionsPage.evaluate(() => window.__clipboardText),
    );
    expect(diagnostics).toHaveProperty("extensionVersion");
    expect(diagnostics).toHaveProperty("browser");
    expect(diagnostics).toHaveProperty("settings");
  });

  test("prepares a site report with privacy-safe browser details", async ({
    page,
    server,
    extension,
  }) => {
    await page.goto(
      server.url("video.html?session-secret=do-not-share#private"),
    );
    const optionsPage = await extension.openOptions();
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
    expect(body).toContain(`Site: http://localhost:${server.port}`);
    expect(body).toContain("Browser: ");
    expect(body).not.toContain("session-secret");
    expect(body).not.toContain("private");
  });

  test("uses zero to disable audio fading", async ({ extension }) => {
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Playback adjustments");
    const fadeDuration = optionsPage.locator("#fadeDuration");
    await expect(fadeDuration).toHaveValue("0");
    await fadeDuration.fill("350");
    await fadeDuration.dispatchEvent("change");
    const readFadeDuration = async () =>
      (await extension.getSettings()).fadeDuration;
    await expect.poll(readFadeDuration).toBe(350);

    await optionsPage.reload();
    await openSection(optionsPage, "Playback adjustments");
    await expect(fadeDuration).toHaveValue("350");
    await fadeDuration.fill("0");
    await fadeDuration.dispatchEvent("change");
    await expect.poll(readFadeDuration).toBe(0);
  });

  test("configures and applies global playback speed", async ({
    page,
    server,
    extension,
  }) => {
    await page.goto(server.url("video.html"));
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Playback adjustments");
    await optionsPage.locator("#playbackSpeed").fill("1.25");
    await optionsPage.locator("#playbackSpeed").press("Tab");
    await expect
      .poll(() => extension.getSettings())
      .toMatchObject({ playbackSpeed: 1.25 });
    await expect
      .poll(() => page.locator("#v").evaluate((video) => video.playbackRate))
      .toBe(1.25);
  });
});
