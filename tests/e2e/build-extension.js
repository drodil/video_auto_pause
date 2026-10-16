const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

// Builds the Chrome package once and unpacks it for the e2e tests.
module.exports = async function globalSetup() {
  const rootDir = path.join(__dirname, "../..");
  const chromeZip = path.join(rootDir, "web-ext-artifacts", "chrome.zip");
  const chromeDist = path.join(rootDir, "test-dist", "chrome");

  execSync("npm run build:chrome", { stdio: "inherit", cwd: rootDir });
  fs.rmSync(chromeDist, { recursive: true, force: true });
  fs.mkdirSync(chromeDist, { recursive: true });
  new AdmZip(chromeZip).extractAllTo(chromeDist, true);
};
