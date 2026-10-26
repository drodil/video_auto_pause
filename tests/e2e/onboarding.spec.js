const { test, expect } = require("./fixtures");

const presetDescriptions = {
  study:
    "Pauses and resumes when you switch tabs or windows, then rewinds 5 seconds.",
  music:
    "Keeps playback going when you switch tabs or windows or lock your device.",
  binge:
    "Pauses and resumes on tab changes and device lock; ignores focus changes and disables itself in fullscreen.",
  saver:
    "Pauses on tab changes, focus loss, device lock, or when video scrolls out of view; blocks autoplay and does not auto-resume.",
};

// Checks that each preset explains itself through a real tooltip that is also
// exposed as the button's accessible description.
async function expectPresetTooltips(page) {
  for (const [preset, text] of Object.entries(presetDescriptions)) {
    const button = page.locator(`[data-preset=${preset}]`);
    await expect(button).not.toHaveAttribute("title", /.*/);
    await expect(button).toHaveAccessibleDescription(text);
    await button.hover();
    await expect(page.getByRole("tooltip")).toHaveText(text);
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toBeHidden();
  }
}

test.describe("Onboarding", () => {
  test.describe("first install", () => {
    test.use({ keepOnboarding: true });

    test("opens a localized onboarding page", async ({ context }) => {
      await expect
        .poll(() =>
          context
            .pages()
            .some((page) => page.url().endsWith("/onboarding.html")),
        )
        .toBe(true);
      const onboarding = context
        .pages()
        .find((page) => page.url().endsWith("/onboarding.html"));
      await expect(
        onboarding.getByRole("heading", {
          name: "Welcome to Video Auto Pause",
        }),
      ).toBeVisible();
      await expect(onboarding.locator("#hotkeys")).toBeVisible();
      await expect(
        onboarding.getByRole("region", { name: "What the extension does" }),
      ).toBeVisible();
      await expect(onboarding.locator("html")).toHaveAttribute("lang", /.+/);
    });
  });

  test("applies a preset from onboarding and the settings page", async ({
    context,
    extension,
  }) => {
    const onboarding = await context.newPage();
    await onboarding.goto(extension.url("onboarding.html"));
    await expect(onboarding.locator("[data-preset=study]")).toBeVisible();
    await expectPresetTooltips(onboarding);
    await onboarding.locator("[data-preset=study]").click();
    await expect(onboarding.locator("#presetStatus")).toContainText("applied");
    await expect
      .poll(() => extension.getSettings())
      .toMatchObject({
        autopause: true,
        focuspause: true,
        focusresume: true,
        rewindSeconds: 5,
      });

    const optionsPage = await extension.openOptions();
    await expect(optionsPage.locator("[data-preset]").first()).toBeHidden();
    await optionsPage.locator(".preset-options summary").click();
    await expect(optionsPage.locator("[data-preset=study]")).toBeVisible();
    await expectPresetTooltips(optionsPage);
    await optionsPage.locator("[data-preset=saver]").click();
    await expect(optionsPage.locator("#presetStatus")).toContainText("applied");
    await expect
      .poll(() => extension.getSettings())
      .toMatchObject({
        autopause: true,
        autoresume: false,
        scrollpause: true,
        blockAutoplay: true,
      });
  });

  test("keeps onboarding usable on a narrow viewport", async ({
    context,
    extension,
  }) => {
    const onboarding = await context.newPage();
    await onboarding.setViewportSize({ width: 320, height: 568 });
    await onboarding.goto(extension.url("onboarding.html"));
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
});
