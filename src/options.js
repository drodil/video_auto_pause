// Browser
const env = chrome.runtime ? chrome : browser;

const options = {
  autopause: true,
  autoresume: true,
  scrollpause: false,
  lockpause: true,
  lockresume: true,
  focuspause: false,
  focusresume: false,
  disabled: false,
  cursorTracking: false,
  manualPause: true,
  debugMode: false,
  disableOnFullscreen: false,
};

const hosts = env.runtime.getManifest().host_permissions;
for (const host of hosts) {
  options[host] = true;
}

// Saves options to chrome storage
async function save_options() {
  const storage = {};

  for (const option in options) {
    storage[option] = document.getElementById(option).checked;
  }
  await env.storage.sync.set(storage);

  const disabledForActive = document.getElementById("disabledTabs").checked;
  const tabs = await env.tabs.query({ active: true, currentWindow: true });
  const disabled =
    (await env.storage.local.get("disabledTabs")).disabledTabs ?? [];
  if (disabledForActive) {
    await env.storage.local.set({
      disabledTabs: [...new Set([...disabled, tabs[0].id])],
    });
  } else {
    await env.storage.local.set({
      disabledTabs: disabled.filter((tab) => tab !== tabs[0].id),
    });
  }
}

// Restores options from chrome storage
async function restore_options() {
  const items = await env.storage.sync.get(options);
  for (const opt in items) {
    document.getElementById(opt).checked = items[opt];
  }

  for (const option in options) {
    document.getElementById(option).disabled = items.disabled;
    if (items.disabled) {
      document.getElementById("disabled").disabled = false;
    }
  }

  const disabled =
    (await env.storage.local.get("disabledTabs")).disabledTabs ?? [];
  const tabs = await env.tabs.query({ active: true, currentWindow: true });
  if (disabled.includes(tabs[0].id)) {
    document.getElementById("disabledTabs").checked = true;
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
      commands[i].shortcut + " - " + commands[i].description
    );
    tag.appendChild(text);
    hotkeysDiv.appendChild(tag);
  }
});

function formatHostName(hostname) {
  return hostname.replace("https://", "").split("/")[0].replaceAll("*.", "");
}

const hostsDiv = document.getElementById("hosts");
for (host of hosts) {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = host;
  label.appendChild(checkbox);
  const span = document.createElement("span");
  span.className = "label-text";
  span.textContent = formatHostName(host);
  label.appendChild(span);
  hostsDiv.appendChild(label);
  checkbox.addEventListener("change", save_options);
}

// Show version in the options window
const version = document.getElementById("version");
version.textContent = "v" + env.runtime.getManifest().version;

// Restore options on load and when they change in the store
document.addEventListener("DOMContentLoaded", restore_options);
env.storage.onChanged.addListener(async (_changes, _namespace) => {
  await restore_options();
});

// Listen to changes of options
for (const option in options) {
  document
    .getElementById(option)
    .addEventListener("change", async () => await save_options());
}
document
  .getElementById("disabledTabs")
  .addEventListener("change", async () => await save_options());

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
