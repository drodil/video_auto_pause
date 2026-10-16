const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  collectUsedMessageKeys,
  loadSettingsGlobals,
  srcDir,
} = require("./message-usage");

const localesDir = path.join(srcDir, "_locales");
const locales = fs.readdirSync(localesDir).sort();
const readMessages = (locale) =>
  JSON.parse(
    fs.readFileSync(path.join(localesDir, locale, "messages.json"), "utf8"),
  );
const englishMessages = readMessages("en");
const placeholders = (text) => [...text.matchAll(/\$\d/g)].map(String).sort();

test.describe("locales", () => {
  test("every message used by the extension exists", () => {
    const missing = [...collectUsedMessageKeys()].filter(
      (key) => !key.startsWith("@@") && !englishMessages[key],
    );
    expect(missing).toEqual([]);
  });

  test("no unused messages are shipped", () => {
    const used = collectUsedMessageKeys();
    expect(
      Object.keys(englishMessages).filter((key) => !used.has(key)),
    ).toEqual([]);
  });

  for (const locale of locales) {
    test(`${locale} matches the English messages`, () => {
      const messages = readMessages(locale);
      expect(Object.keys(messages).sort()).toEqual(
        Object.keys(englishMessages).sort(),
      );
      for (const [key, { message }] of Object.entries(messages)) {
        expect(message.trim(), `${locale}.${key} is empty`).not.toBe("");
        expect(placeholders(message), `${locale}.${key} placeholders`).toEqual(
          placeholders(englishMessages[key].message),
        );
      }
    });
  }
});

test.describe("markup and manifests", () => {
  const optionsHtml = fs.readFileSync(
    path.join(srcDir, "options.html"),
    "utf8",
  );
  const manifests = Object.fromEntries(
    ["chrome", "firefox"].map((name) => [
      name,
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "../../manifests", `${name}.json`),
          "utf8",
        ),
      ),
    ]),
  );

  test("every global setting has a control on the options page", () => {
    const { DEFAULT_SETTINGS } = loadSettingsGlobals();
    const missing = Object.keys(DEFAULT_SETTINGS).filter(
      (setting) =>
        !["siteRules", "contentShortcutKeys"].includes(setting) &&
        !optionsHtml.includes(`id="${setting}"`),
    );
    expect(missing).toEqual([]);
  });

  test("pages do not rely on title attributes for help text", () => {
    for (const page of ["options.html", "onboarding.html"]) {
      const html = fs.readFileSync(path.join(srcDir, page), "utf8");
      expect(html, page).not.toMatch(/\stitle="/);
      expect(html, page).not.toMatch(/data-i18n-title=/);
    }
  });

  test("Chrome and Firefox manifests stay in sync", () => {
    const { chrome, firefox } = manifests;
    expect(firefox.version).toBe(chrome.version);
    expect(firefox.commands).toEqual(chrome.commands);
    expect(firefox.permissions).toEqual(chrome.permissions);
    expect(firefox.background.scripts).toEqual([
      "settings.js",
      chrome.background.service_worker,
    ]);
    const packageVersion = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ).version;
    expect(chrome.version).toBe(packageVersion);
  });

  test("referenced scripts and styles exist", () => {
    for (const page of ["options.html", "onboarding.html"]) {
      const html = fs.readFileSync(path.join(srcDir, page), "utf8");
      for (const [, file] of html.matchAll(/(?:src|href)="([\w./-]+)"/g)) {
        expect(fs.existsSync(path.join(srcDir, file)), `${page}: ${file}`).toBe(
          true,
        );
      }
    }
    const background = fs.readFileSync(path.join(srcDir, "vap_bs.js"), "utf8");
    const [, files] = /js: (\[[^\]]+\])/.exec(background);
    for (const file of JSON.parse(files)) {
      expect(fs.existsSync(path.join(srcDir, file)), file).toBe(true);
    }
  });
});
