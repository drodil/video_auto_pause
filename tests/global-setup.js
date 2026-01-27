import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

async function globalSetup() {
  console.log("Global Setup: Building and preparing extensions...");

  const rootDir = path.join(__dirname, "..");
  const artifactsDir = path.join(rootDir, "web-ext-artifacts");
  const testDistDir = path.join(rootDir, "test-dist");

  if (!fs.existsSync(artifactsDir))
    fs.mkdirSync(artifactsDir, { recursive: true });

  console.log("Building Chrome extension...");
  try {
    execSync("npm run build:chrome", { stdio: "inherit", cwd: rootDir });
  } catch (e) {
    console.error("Failed to build chrome extension inside globalSetup");
    throw e;
  }

  console.log("Unzipping Chrome build...");
  const chromeZip = path.join(artifactsDir, "chrome.zip");
  const chromeDist = path.join(testDistDir, "chrome");

  if (fs.existsSync(chromeDist))
    fs.rmSync(chromeDist, { recursive: true, force: true });
  fs.mkdirSync(chromeDist, { recursive: true });

  const zip = new AdmZip(chromeZip);
  zip.extractAllTo(chromeDist, true);

  console.log("Global Setup Complete.");
}

export default globalSetup;
