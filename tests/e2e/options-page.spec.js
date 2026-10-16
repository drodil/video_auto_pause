const { test, expect } = require("./fixtures");
const { openSection, computedStyles } = require("./helpers");

test.describe("Options page", () => {
  test("shows local weekly statistics and a milestone rating link", async ({
    extension,
  }) => {
    await extension.evaluate(async () => {
      const date = new Date().toISOString().slice(0, 10);
      await chrome.storage.local.set({
        vapStats: {
          totalPauses: 50,
          [date]: {
            pauses: 50,
            resumes: 12,
            autoplayBlocked: 3,
            preventedSeconds: 7200,
          },
        },
      });
    });
    const optionsPage = await extension.openOptions();
    const summary = optionsPage.locator("#statsSummary");
    await expect(summary).toContainText("50 pauses");
    await expect(summary).toContainText("12 resumes");
    await expect(summary).toContainText("120 min");
    await expect(optionsPage.locator("#rateExtension")).toBeVisible();
  });

  test("sizes the popup and full page layouts", async ({ extension }) => {
    const popupPage = await extension.openOptions({
      popup: true,
      viewport: { width: 1280, height: 800 },
    });
    const popupBounds = await popupPage.locator("#wrapper").boundingBox();
    expect([popupBounds.width, popupBounds.height]).toEqual([800, 600]);

    const optionsPage = await extension.openOptions({
      viewport: { width: 1280, height: 800 },
    });
    const wrapperBounds = await optionsPage.locator("#wrapper").boundingBox();
    expect(wrapperBounds.width).toBe(1080);
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
    const disclosureStyle = ["backgroundColor", "fontSize", "borderTopColor"];
    expect(await computedStyles(presetDisclosure, disclosureStyle)).toEqual(
      await computedStyles(profilesDisclosure, disclosureStyle),
    );
    const [applyBox, deleteBox] = await Promise.all(
      ["#applyProfile", "#deleteProfile"].map((selector) =>
        optionsPage.locator(selector).boundingBox(),
      ),
    );
    expect([applyBox.width, applyBox.height]).toEqual([
      deleteBox.width,
      deleteBox.height,
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

    await openSection(optionsPage, "Advanced Settings");
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeHidden();
    await optionsPage.locator("#contentShortcutsEnabled").check();
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeVisible();
    await optionsPage.locator("#contentShortcutsEnabled").uncheck();
    await expect(optionsPage.locator("#contentShortcutSettings")).toBeHidden();

    await openSection(optionsPage, "Profiles & backup");
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

    await openSection(optionsPage, "Advanced Settings");
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
    await openSection(optionsPage, "Advanced Settings");
    await openSection(optionsPage, "Domain Settings");
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
    await openSection(optionsPage, "Advanced Settings");
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
    await openSection(optionsPage, "Advanced Settings");
    const fadeDuration = optionsPage.locator("#fadeDuration");
    await expect(fadeDuration).toHaveValue("0");
    await fadeDuration.fill("350");
    await fadeDuration.dispatchEvent("change");
    const readFadeDuration = async () =>
      (await extension.getSettings()).fadeDuration;
    await expect.poll(readFadeDuration).toBe(350);

    await optionsPage.reload();
    await openSection(optionsPage, "Advanced Settings");
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
    await openSection(optionsPage, "Advanced Settings");
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
