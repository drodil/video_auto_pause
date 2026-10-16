// Shared Playwright fixtures for the extension end-to-end tests.
//
// Every test gets its own Chromium profile and its own copy of the unpacked
// extension (and therefore its own extension ID and storage), so tests do not
// share settings and can run in parallel across workers.
const { test: base, chromium, expect } = require("@playwright/test");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const builtExtensionPath = path.join(__dirname, "../../test-dist/chrome");
const pagesDir = path.join(__dirname, "pages");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".webm": "video/webm",
  ".js": "text/javascript",
};

// Serves tests/e2e/pages with range support so media elements can seek.
async function startStaticServer() {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    const filePath = path.join(
      pagesDir,
      pathname === "/" ? "index.html" : path.normalize(pathname),
    );
    if (!filePath.startsWith(pagesDir) || !fs.existsSync(filePath)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const { size } = fs.statSync(filePath);
    const headers = {
      "Content-Type":
        contentTypes[path.extname(filePath)] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      response.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": size });
    fs.createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: (pagePath = "", host = "localhost") =>
      `http://${host}:${port}/${pagePath}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createExtensionHelpers(context, extensionId) {
  const worker = async () =>
    context
      .serviceWorkers()
      .find((candidate) => candidate.url().includes(extensionId)) ??
    context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().includes(extensionId),
      timeout: 10000,
    });
  const evaluate = async (fn, arg) => (await worker()).evaluate(fn, arg);
  const url = (page) => `chrome-extension://${extensionId}/${page}`;
  return {
    id: extensionId,
    worker,
    evaluate,
    url,
    updateSettings: (settings) =>
      evaluate(async (patch) => {
        await settingsReady;
        await updateActiveProfileSettings(patch);
      }, settings),
    getSettings: () => evaluate(() => getActiveProfileSettings()),
    getTabId: (tabUrl) =>
      evaluate(
        async (target) => (await chrome.tabs.query({ url: target }))[0]?.id,
        tabUrl,
      ),
    async openOptions({ popup = false, viewport } = {}) {
      const page = await context.newPage();
      if (viewport) {
        await page.setViewportSize(viewport);
      }
      await page.goto(url(popup ? "options.html?popup" : "options.html"));
      await expect(page.locator("body")).toHaveAttribute(
        "data-settings-ready",
        "true",
      );
      return page;
    },
  };
}

const test = base.extend({
  // Set to true with test.use() to keep the first-run onboarding tab open.
  keepOnboarding: [false, { option: true }],

  server: [
    async ({}, use) => {
      const server = await startStaticServer();
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],

  context: async ({ keepOnboarding }, use) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vap-e2e-"));
    const extensionPath = path.join(tempDir, "extension");
    fs.cpSync(builtExtensionPath, extensionPath, { recursive: true });
    const context = await chromium.launchPersistentContext(
      path.join(tempDir, "profile"),
      {
        headless: false,
        acceptDownloads: true,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
        ],
      },
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 10000 }));
    await worker.evaluate(() => settingsReady);
    if (!keepOnboarding) {
      await expect
        .poll(
          () =>
            context
              .pages()
              .some((page) => page.url().endsWith("/onboarding.html")),
          { timeout: 10000 },
        )
        .toBe(true);
      for (const page of context.pages()) {
        if (page.url().endsWith("/onboarding.html")) {
          await page.close();
        }
      }
    }
    await use(context);
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  },

  extension: async ({ context }, use) => {
    const [worker] = context.serviceWorkers();
    await use(createExtensionHelpers(context, new URL(worker.url()).host));
  },

  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

// Opens a test page and waits until the content script controls its video.
async function openVideoPage(page, url, selector = "#v") {
  await page.goto(url);
  await page.bringToFront();
  const video = page.locator(selector);
  await expect(video).toHaveAttribute(
    "data-auto-pause-listener-attached",
    "true",
    { timeout: 10000 },
  );
  return video;
}

// Opens and focuses another tab so the previous one becomes inactive.
async function switchToNewTab(context, server) {
  const otherTab = await context.newPage();
  await otherTab.goto(server.url());
  await otherTab.bringToFront();
  return otherTab;
}

async function playVideo(video, { unmute = false } = {}) {
  await video.evaluate(async (element, shouldUnmute) => {
    await element.play();
    if (shouldUnmute) {
      element.muted = false;
    }
  }, unmute);
  await expect(video).toHaveJSProperty("paused", false);
}

module.exports = {
  test,
  expect,
  openVideoPage,
  switchToNewTab,
  playVideo,
};
