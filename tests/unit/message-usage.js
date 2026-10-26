// Collects the i18n message keys referenced by the extension source.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const srcDir = path.join(__dirname, "../../src");

function loadSettingsGlobals() {
  const context = vm.createContext({ crypto: globalThis.crypto });
  vm.runInContext(
    fs.readFileSync(path.join(srcDir, "settings.js"), "utf8"),
    context,
  );
  return context;
}

function collectUsedMessageKeys() {
  const used = new Set();
  const files = fs
    .readdirSync(srcDir)
    .filter((file) => /\.(js|html)$/.test(file))
    .map((file) => fs.readFileSync(path.join(srcDir, file), "utf8"));
  for (const manifest of ["chrome.json", "firefox.json"]) {
    files.push(
      fs.readFileSync(
        path.join(__dirname, "../../manifests", manifest),
        "utf8",
      ),
    );
  }
  const patterns = [
    /getMessage\(\s*"([\w@]+)"/g,
    /message\(\s*"(\w+)"/g,
    /setStatus\(\s*"\w+",\s*"(\w+)"/g,
    /data-i18n(?:-[a-z-]+)?="(\w+)"/g,
    /__MSG_(\w+)__/g,
    /(?:getMessage|message)\(\s*[\w.\s=!]*\?\s*"(\w+)"\s*:\s*"(\w+)"/g,
    /bindAction\(\s*"\w+",\s*"\w+",\s*(?:"(\w+)"|null),\s*"(\w+)"/g,
  ];
  for (const source of files) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        for (const key of match.slice(1)) {
          if (key) used.add(key);
        }
      }
    }
  }
  const settings = loadSettingsGlobals();
  // Setting names double as labels in the per-site settings editor.
  for (const setting of settings.SITE_OVERRIDE_SETTINGS) {
    used.add(setting);
  }
  for (const action of Object.keys(
    settings.DEFAULT_SETTINGS.contentShortcutKeys,
  )) {
    used.add(`${action}Shortcut`);
  }
  for (const key of ["quietHours"]) {
    used.add(key);
  }
  return used;
}

module.exports = { collectUsedMessageKeys, loadSettingsGlobals, srcDir };
