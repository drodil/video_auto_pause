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
  for (const layout of [
    { name: "full page" },
    { name: "popup", popup: true },
    { name: "narrow page", viewport: { width: 320, height: 720 } },
  ]) {
    test(`lists profiles with individual removal controls in the ${layout.name}`, async ({
      extension,
    }) => {
      await extension.updateSettings({ playbackSpeed: 1.5 });
      const optionsPage = await extension.openOptions(layout);
      await openSection(optionsPage, "Profiles & backup");
      const list = optionsPage.locator("#profileList");
      await expect(list.locator("li")).toHaveCount(0);
      await expect(list).toBeHidden();
      await expect(list.getByRole("button")).toHaveCount(0);
      await expect(optionsPage.locator("#activeProfileControl")).toBeHidden();
      await expect(
        optionsPage.locator(
          "#profilesContent select, #applyProfile, #profileSelect",
        ),
      ).toHaveCount(0);

      const workName = "W".repeat(40);
      await optionsPage.locator("#profileName").fill(workName);
      await optionsPage.locator("#saveProfile").click();
      await expect(optionsPage.locator("#profileStatus")).toContainText(
        "saved",
      );
      const workId = await optionsPage
        .locator("#activeProfileSelect")
        .inputValue();
      await extension.updateSettings({ playbackSpeed: 1.25 });
      await optionsPage.locator("#profileName").fill("Personal");
      await optionsPage.locator("#saveProfile").click();
      await expect(list.locator("li > span")).toHaveText([
        workName,
        "Personal",
      ]);
      const personalId = await optionsPage
        .locator("#activeProfileSelect")
        .inputValue();
      expect(personalId).not.toBe(workId);
      await extension.updateSettings({ playbackSpeed: 2 });
      await expect(list.locator('[aria-current="true"] > span')).toHaveText(
        "Personal",
      );
      await expect(list.getByRole("button")).toHaveCount(2);
      await expect(
        optionsPage.locator("#activeProfileSelect option[value=default]"),
      ).toHaveText("Default");
      await expect(list.locator('[data-profile-id="default"]')).toHaveCount(0);
      const listBox = await list.boundingBox();
      const exportBox = await optionsPage
        .locator("#exportSettings")
        .boundingBox();
      expect(exportBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
      const removeBox = await list.getByRole("button").first().boundingBox();
      expect(removeBox.height).toBe(28);
      expect(removeBox.width).toBeLessThanOrEqual(70);
      expect(
        await list.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);

      await optionsPage.locator("#activeProfileSelect").selectOption(workId);
      await expect
        .poll(() => extension.getSettings())
        .toMatchObject({ playbackSpeed: 1.25 });
      await expect(list.locator('[aria-current="true"] > span')).toHaveText(
        workName,
      );
      await optionsPage
        .locator("#activeProfileSelect")
        .selectOption(personalId);
      await expect
        .poll(() => extension.getSettings())
        .toMatchObject({ playbackSpeed: 2 });
      const removeWork = list.getByRole("button", {
        name: `Remove: ${workName}`,
        exact: true,
      });
      await removeWork.focus();
      await optionsPage.keyboard.press("Space");
      await expect(list.locator("li > span")).toHaveText(["Personal"]);
      await expect(optionsPage.locator("#profileStatus")).toContainText(
        "deleted",
      );
      await expect(optionsPage.locator("#activeProfileSelect")).toHaveValue(
        personalId,
      );
      await expect(optionsPage.locator("#profileName")).toBeFocused();
      await expect
        .poll(() => extension.getSettings())
        .toMatchObject({ playbackSpeed: 2 });

      await optionsPage.reload();
      await openSection(optionsPage, "Profiles & backup");
      await expect(list.locator("li > span")).toHaveText(["Personal"]);
      await expect(optionsPage.locator("#activeProfileSelect")).toHaveValue(
        personalId,
      );
      await list
        .getByRole("button", { name: "Remove: Personal", exact: true })
        .click();
      await expect(list.locator("li")).toHaveCount(0);
      await expect(list).toBeHidden();
      await expect(optionsPage.locator("#activeProfileControl")).toBeHidden();
      await expect(list.getByRole("button")).toHaveCount(0);
      await expect
        .poll(() => extension.getSettings())
        .toMatchObject({ playbackSpeed: 1.5 });
    });
  }

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

    await optionsPage
      .getByRole("button", { name: "Remove: Work", exact: true })
      .click();
    await expect(optionsPage.locator("#profileStatus")).toContainText(
      "deleted",
    );
    await expect(optionsPage.locator("#activeProfileSelect")).toBeHidden();
    await expect(optionsPage.locator("#profileList li")).toHaveCount(0);
    await expect(optionsPage.locator("[data-remove-profile]")).toHaveCount(0);
    await expect(extension.getSettings()).resolves.toMatchObject({
      playbackSpeed: 1.5,
    });
  });
});
