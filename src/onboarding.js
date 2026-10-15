const env = chrome.runtime ? chrome : browser;

function localizePage() {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const message = env.i18n.getMessage(element.dataset.i18n);
    if (message) {
      element.textContent = message;
    }
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const message = env.i18n.getMessage(element.dataset.i18nTitle);
    if (message) {
      element.title = message;
    }
  });
  document.title = env.i18n.getMessage("onboardingTitle") || "Video Auto Pause";
}

function showHotkeys() {
  env.commands.getAll((commands) => {
    const hotkeyList = document.getElementById("hotkeyList");
    for (const command of commands) {
      if (!command.shortcut || !command.description) {
        continue;
      }
      const row = document.createElement("p");
      row.textContent = `${command.shortcut} - ${command.description}`;
      hotkeyList.appendChild(row);
    }
  });
}

document.getElementById("openSettings").addEventListener("click", () => {
  void env.runtime.openOptionsPage();
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", async () => {
    const status = document.getElementById("presetStatus");
    try {
      await env.storage.sync.set(globalThis.VAP_PRESETS[button.dataset.preset]);
      status.textContent = env.i18n.getMessage("presetApplied");
    } catch (error) {
      status.textContent = env.i18n.getMessage("presetFailed");
      console.error(
        "Video Auto Pause could not apply the selected preset:",
        error,
      );
    }
  });
});

localizePage();
showHotkeys();
