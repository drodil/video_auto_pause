const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");
const { openSection } = require("./helpers");

async function openModePage(extension, context, surface) {
  if (surface === "settings") {
    const page = await extension.openOptions({ popup: true });
    await page.locator(".preset-options summary").click();
    return page;
  }
  const page = await context.newPage();
  await page.goto(extension.url("onboarding.html"));
  await expect(page.locator("[data-preset=study]")).toBeVisible();
  return page;
}

async function applyMode(page, mode) {
  await page.locator("#presetStatus").evaluate((element) => {
    element.textContent = "";
  });
  await page.locator(`[data-preset=${mode}]`).click();
  await expect(page.locator("#presetStatus")).toHaveText("Mode applied");
}

for (const surface of ["onboarding", "settings"]) {
  for (const mode of ["study", "music", "binge", "saver"]) {
    test(`${surface}: ${mode} replaces all behavior settings and preserves personal configuration`, async ({
      extension,
      context,
    }) => {
      const profileId = await extension.evaluate(() =>
        createProfile("Custom modes"),
      );
      const page = await openModePage(extension, context, surface);
      const { expected, conflicting } = await page.evaluate((name) => {
        const expected = SETTING_PRESETS[name];
        return {
          expected,
          conflicting: Object.fromEntries(
            Object.entries(expected).map(([key, value]) => [
              key,
              typeof value === "boolean"
                ? !value
                : typeof value === "number"
                  ? key === "playbackSpeed"
                    ? 2
                    : 3
                  : "12:00",
            ]),
          ),
        };
      }, mode);
      await extension.updateSettings({
        ...conflicting,
        onlyConfiguredSites: true,
        siteRules: [
          {
            domain: "example.com",
            enabled: true,
            overrides: { autopause: false, rewindSeconds: 13 },
          },
        ],
        debugMode: true,
        showPipButton: true,
        showVideoOverlay: true,
        contentShortcutsEnabled: true,
        contentShortcutKeys: { toggleLoop: "k", screenshot: "" },
      });
      const before = await extension.getSettings();
      await applyMode(page, mode);
      await expect
        .poll(() => extension.getSettings())
        .toEqual({ ...before, ...expected });
      expect(
        await extension.evaluate(
          async () => (await loadProfiles()).activeProfileId,
        ),
      ).toBe(profileId);

      const next = mode === "saver" ? "music" : "saver";
      const nextExpected = await page.evaluate(
        (name) => SETTING_PRESETS[name],
        next,
      );
      await applyMode(page, next);
      await expect
        .poll(() => extension.getSettings())
        .toEqual({ ...before, ...nextExpected });
      await applyMode(page, mode);
      await page.reload();
      await expect
        .poll(() => extension.getSettings())
        .toEqual({ ...before, ...expected });
    });
  }
}

test("background music stays playing and audible across tab changes and device lock after saver", async ({
  extension,
  context,
  page,
  server,
}) => {
  const settings = await openModePage(extension, context, "settings");
  await applyMode(settings, "saver");
  await applyMode(settings, "music");
  await settings.close();
  const video = await openVideoPage(page, server.url("video.html"));
  await video.evaluate((element) => {
    element.loop = true;
  });
  await playVideo(video, { unmute: true });
  const before = await video.evaluate((element) => element.currentTime);
  await switchToNewTab(context, server);
  await extension.evaluate(() => handleIdleStateChanged("locked"));
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(before + 1);
  await expect(video).toHaveJSProperty("paused", false);
  await expect(video).toHaveJSProperty("muted", false);
  await extension.evaluate(() => handleIdleStateChanged("active"));
  await page.bringToFront();
  await expect(video).toHaveJSProperty("paused", false);
  await expect(video).toHaveJSProperty("muted", false);
});

test("saver pauses audio-only playback and does not resume it after returning", async ({
  extension,
  context,
  page,
  server,
}) => {
  const settings = await openModePage(extension, context, "settings");
  await applyMode(settings, "music");
  await applyMode(settings, "saver");
  await settings.close();
  await openVideoPage(page, server.url("video.html"));
  await page.evaluate(() => {
    const audio = document.createElement("audio");
    audio.id = "music";
    audio.src = "/audio.webm";
    audio.loop = true;
    document.body.append(audio);
  });
  const audio = page.locator("#music");
  await page.locator("body").click();
  await playVideo(audio);
  await switchToNewTab(context, server);
  await expect(audio).toHaveJSProperty("paused", true);
  await page.bringToFront();
  await extension.evaluate(() => handleIdleStateChanged("active"));
  await expect(audio).toHaveJSProperty("paused", true);
});

test("saver does not resume paused videos when same-page visibility changes", async ({
  extension,
  context,
  page,
  server,
}) => {
  const settings = await openModePage(extension, context, "settings");
  await applyMode(settings, "saver");
  await settings.close();
  const video = await openVideoPage(page, server.url("video.html"));
  await page.locator("body").click();
  await video.evaluate((element) => {
    element.loop = true;
    const second = element.cloneNode();
    second.id = "second-video";
    document.body.append(second);
  });
  await playVideo(video);
  const second = page.locator("#second-video");
  await second.evaluate((element) => element.play());
  await expect(video).toHaveJSProperty("paused", false);
  await expect(second).toHaveJSProperty("paused", true);
  await switchToNewTab(context, server);
  await expect(video).toHaveJSProperty("paused", true);
  await page.bringToFront();
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.dispatchEvent(new Event("resize"));
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await expect(video).toHaveJSProperty("paused", true);
});

test("labels and tooltips distinguish same-page limiting from cross-tab priority", async ({
  extension,
}) => {
  const page = await extension.openOptions();
  const label = "Prioritize media in the active tab";
  const description =
    "Controls playback across tabs, not videos on the same page. Media in the active tab pauses media in other tabs; the previous tab resumes when it stops.";
  await openSection(page, "Focus & visibility");
  await expect(
    page.getByRole("checkbox", {
      name: "Play only the most visible video",
      exact: true,
    }),
  ).toBeChecked();
  await openSection(page, "Playback & audio");
  const checkbox = page.getByRole("checkbox", { name: label, exact: true });
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toHaveAccessibleDescription(description);
  await checkbox.hover();
  await expect(page.getByRole("tooltip")).toHaveText(description);

  await openSection(page, "Site settings");
  await page.locator("#newSiteDomain").fill("example.com");
  await page.locator("#newSiteDomain").press("Enter");
  await page
    .locator('[data-site-settings-group="playbackSettings"] summary')
    .click();
  const siteCheckbox = page.getByRole("checkbox", { name: label, exact: true });
  await expect(siteCheckbox).toHaveJSProperty("indeterminate", true);
  await expect(siteCheckbox).toHaveAccessibleDescription(
    new RegExp("Controls playback across tabs, not videos on the same page"),
  );
  await siteCheckbox.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(siteCheckbox).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText(
    `${description} Use default settings: Disabled`,
  );
  await page.keyboard.press("Space");
  await expect(siteCheckbox).toBeChecked();
  await expect(siteCheckbox).toHaveAccessibleDescription(
    `${description} Enabled`,
  );
  await page.keyboard.press("Space");
  await expect(siteCheckbox).not.toBeChecked();
  await expect(siteCheckbox).toHaveAccessibleDescription(
    `${description} Disabled`,
  );
});
