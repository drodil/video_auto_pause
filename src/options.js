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

  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const message = env.i18n.getMessage(element.dataset.i18nTitle);
    if (message) {
      element.title = message;
      element.setAttribute("aria-label", message);
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

async function addCurrentDomainToList(option) {
  const tab = await getCurrentWebTab();
  const input = document.getElementById(option);
  if (!tab || !input) {
    return;
  }

  const domain = new URL(tab.url).hostname;
  if (!domain) {
    return;
  }

  const domains = readOption(option, input);
  if (domains.includes(domain)) {
    return;
  }

  input.value = [...domains, domain].join("\n");
  await save_option(option);
}

function updateAudioFadingVisibility() {
  const settings = document.getElementById("audioFadingSettings");
  const enabled = document.getElementById("audioFading")?.checked;
  if (settings) {
    settings.hidden = !enabled;
  }
}

function getWeeklyStats(stats) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - 6);
  const summary = {
    pauses: 0,
    resumes: 0,
    autoplayBlocked: 0,
    preventedSeconds: 0,
    lifetimePauses: stats.totalPauses ?? 0,
  };
  for (const [day, values] of Object.entries(stats)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      continue;
    }
    if (Date.parse(`${day}T00:00:00Z`) >= cutoff.getTime()) {
      summary.pauses += values.pauses ?? 0;
      summary.resumes += values.resumes ?? 0;
      summary.autoplayBlocked += values.autoplayBlocked ?? 0;
      summary.preventedSeconds += values.preventedSeconds ?? 0;
    }
  }
  return summary;
}

async function restoreStats() {
  const { vapStats = {} } = await env.storage.local.get("vapStats");
  const stats = getWeeklyStats(vapStats);
  const values = [
    stats.pauses.toString(),
    stats.resumes.toString(),
    stats.autoplayBlocked.toString(),
    Math.floor(stats.preventedSeconds / 60).toString(),
  ];
  const summary = env.i18n.getMessage("statsSummary", values);
  document.getElementById("statsSummary").textContent =
    summary ||
    `${values[0]} pauses · ${values[1]} resumes · ${values[2]} autoplay blocks · ${values[3]} min saved`;
  document.getElementById("rateExtension").hidden = stats.lifetimePauses < 50;
}

async function copyWeeklyStats() {
  const status = document.getElementById("statsStatus");
  try {
    await navigator.clipboard.writeText(
      document.getElementById("statsSummary").textContent,
    );
    status.textContent = env.i18n.getMessage("statsCopied");
  } catch (error) {
    status.textContent = env.i18n.getMessage("statsCopyFailed");
    console.error("Video Auto Pause could not copy the weekly summary:", error);
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

  updateAudioFadingVisibility();

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
    if (namespace === "local" && "vapStats" in changes) {
      void restoreStats();
    }
  }
});

document.getElementById("shareStats")?.addEventListener("click", () => {
  void copyWeeklyStats();
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", async () => {
    const preset = globalThis.VAP_PRESETS[button.dataset.preset];
    const status = document.getElementById("presetStatus");
    try {
      await env.storage.sync.set(preset);
      status.textContent = env.i18n.getMessage("presetApplied");
    } catch (error) {
      status.textContent = env.i18n.getMessage("presetFailed");
      console.error("Video Auto Pause could not apply the selected preset:", error);
    }
  });
});

if (env.runtime.getManifest().browser_specific_settings?.gecko) {
  document.getElementById("rateExtension").href =
    "https://addons.mozilla.org/firefox/addon/video-auto-pause/";
}

void restoreStats();

// Listen to changes of options
for (const option in options) {
  const el = document.getElementById(option);
  if (el) {
    el.addEventListener("change", async () => {
      if (option === "audioFading") {
        updateAudioFadingVisibility();
      }
      await save_option(option);
    });
  }
}

document.querySelectorAll("[data-add-domain]").forEach((button) => {
  button.addEventListener("click", () => {
    void addCurrentDomainToList(button.dataset.addDomain);
  });
});

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
