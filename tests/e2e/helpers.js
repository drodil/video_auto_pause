const { expect } = require("./fixtures");

// Expands a collapsible section of the options page by its visible title.
async function openSection(optionsPage, title) {
  const button = optionsPage
    .locator(".collapsible-button")
    .filter({ hasText: title });
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-expanded", "true");
  // Wait for the expand transition so controls are at their final position.
  await expect(
    optionsPage.locator(`#${await button.getAttribute("aria-controls")}`),
  ).toHaveCSS("max-height", "5000px");
}

async function computedStyles(locator, properties) {
  return locator.evaluate(
    (element, names) => names.map((name) => getComputedStyle(element)[name]),
    properties,
  );
}

module.exports = { openSection, computedStyles };
