// Browser
const env = chrome.runtime ? chrome : browser;
const tabStorage = env.storage.session ?? env.storage.local;
const DEFAULT_OPTIONS = globalThis.VAP_DEFAULT_OPTIONS;

function localizeUI() {
  if (!env?.i18n) {
    return;
  }
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const messageName = element.dataset.i18n;
    const message = env.i18n.getMessage(messageName);
    if (message) {
      element.textContent = message;
    }
  });

  document.title = env.i18n.getMessage("extName") ?? "Video Auto Pause";
}

const options = DEFAULT_OPTIONS;

async function getCurrentWebTab() {
  const tabs = await env.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs.find((tab) => {
    try {
      return ["http:", "https:", "file:"].includes(new URL(tab.url).protocol);
    } catch {
      return false;
    }
  });
}

function readOption(option, element) {
  if (option === "excludedDomains" || option === "includedDomains") {
    return element.value
      .split("\n")
      .map((domain) => domain.trim())
      .filter((domain) => domain.length > 0);
  }
  if (["pauseDelay", "resumeDelay", "fadeDuration"].includes(option)) {
    const value = Number(element.value);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  return element.checked;
}

async function save_option(option) {
  if (option === "disabledTabs") {
    const tab = await getCurrentWebTab();
    if (!tab) {
      return;
    }
    const disabled = (await tabStorage.get("disabledTabs")).disabledTabs ?? [];
    const updated = document.getElementById("disabledTabs").checked
      ? [...new Set([...disabled, tab.id])]
      : disabled.filter((id) => id !== tab.id);
    await tabStorage.set({ disabledTabs: updated });
  } else {
    const element = document.getElementById(option);
    if (element) {
      await env.storage.sync.set({ [option]: readOption(option, element) });
    }
  }
}

async function restore_options(changedKeys = Object.keys(options)) {
  const items = await env.storage.sync.get(options);
  for (const opt of changedKeys) {
    if (!(opt in options)) {
      continue;
    }
    const element = document.getElementById(opt);
    if (!element) {
      continue;
    }
    if (opt === "excludedDomains" || opt === "includedDomains") {
      element.value = items[opt].join("\n");
    } else if (["pauseDelay", "resumeDelay", "fadeDuration"].includes(opt)) {
      element.value = Math.max(0, Number(items[opt]) || 0);
    } else {
      element.checked = Boolean(items[opt]);
    }
  }

  if (changedKeys.includes("disabled")) {
    for (const option of Object.keys(options)) {
      const element = document.getElementById(option);
      if (element) {
        element.disabled = items.disabled && option !== "disabled";
      }
    }
  }

  const disabledTabsInput = document.getElementById("disabledTabs");
  if (disabledTabsInput) {
    const tab = await getCurrentWebTab();
    disabledTabsInput.disabled = !tab;
    if (tab) {
      const disabled =
        (await tabStorage.get("disabledTabs")).disabledTabs ?? [];
      disabledTabsInput.checked = disabled.includes(tab.id);
    } else {
      disabledTabsInput.checked = false;
    }
  }
}

// Show shortcuts in the options window
env.commands.getAll(function (commands) {
  const hotkeysDiv = document.getElementById("hotkeys");
  for (let i = 0; i < commands.length; i++) {
    if (
      commands[i].shortcut.length === 0 ||
      commands[i].description.length === 0
    ) {
      continue;
    }
    const tag = document.createElement("p");
    const text = document.createTextNode(
      commands[i].shortcut + " - " + commands[i].description,
    );
    tag.appendChild(text);
    hotkeysDiv.appendChild(tag);
  }
});

// Show version in the options window
const version = document.getElementById("version");
version.textContent = "v" + env.runtime.getManifest().version;

// Localize UI elements
localizeUI();

// Restore options on load and when they change in the store
document.addEventListener("DOMContentLoaded", () => {
  void restore_options();
});

env.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync") {
    void restore_options(Object.keys(changes));
  } else if (namespace === "session" || namespace === "local") {
    void restore_options([]);
  }
});

// Listen to changes of options
for (const option in options) {
  const el = document.getElementById(option);
  if (el) {
    el.addEventListener("change", async () => {
      await save_option(option);
    });
  }
}

document
  .getElementById("disabledTabs")
  ?.addEventListener("change", async () => {
    await save_option("disabledTabs");
  });

const coll = document.getElementsByClassName("collapsible_button");
let i;

for (i = 0; i < coll.length; i++) {
  coll[i].addEventListener("click", function () {
    this.classList.toggle("active");
    const content = this.nextElementSibling;
    if (content.style.maxHeight) {
      content.style.maxHeight = null;
    } else {
      content.style.maxHeight = content.scrollHeight + "px";
    }
  });
}
