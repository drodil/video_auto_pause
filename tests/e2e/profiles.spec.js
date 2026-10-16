const {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
} = require("./fixtures");
const fs = require("fs");
const { openSection } = require("./helpers");

test.describe("Profiles and backups", () => {
  test("exports and validates versioned settings JSON", async ({
    page,
    context,
    extension,
  }) => {
    await extension.updateSettings({
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
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Profiles & backup");

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
      .poll(() => extension.getSettings())
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
      .poll(() => extension.getSettings())
      .toMatchObject({ autopause: true });
  });

  test("keeps global and site settings bound to the active profile", async ({
    page,
    context,
    server,
    extension,
  }) => {
    await extension.updateSettings({
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
    const worker = await extension.worker();
    await page.goto(server.url("video.html", "video.localhost"));
    await expect
      .poll(() => page.locator("#v").evaluate((video) => video.playbackRate))
      .toBe(2);
    const optionsPage = await extension.openOptions();
    await openSection(optionsPage, "Profiles & backup");
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

    await extension.updateSettings({
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
      .poll(() => extension.getSettings())
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
      .poll(() => extension.getSettings())
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
      .poll(() => extension.getSettings())
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
      const key = getProfileStorageKey(id);
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
      .poll(() => extension.getSettings())
      .toMatchObject({ playbackSpeed: 1.25 });

    await optionsPage.locator("#deleteProfile").click();
    await expect(optionsPage.locator("#profileStatus")).toContainText(
      "deleted",
    );
    await expect(optionsPage.locator("#activeProfileSelect")).toBeHidden();
    await expect(optionsPage.locator("#profileSelect option")).toHaveCount(2);
    await expect(optionsPage.locator("#deleteProfile")).toBeDisabled();
    await expect(extension.getSettings()).resolves.toMatchObject({
      playbackSpeed: 1.5,
    });
  });
});
