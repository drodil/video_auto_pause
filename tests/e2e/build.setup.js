const { test: setup } = require("@playwright/test");
const buildExtension = require("./build-extension");

setup("build the Chrome extension", async () => {
  setup.setTimeout(120000);
  await buildExtension();
});
