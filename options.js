const options = {
  autopause: true,
  autoresume: true,
  scrollpause: false,
  lockpause: true,
  lockresume: true,
  focuspause: false,
  focusresume: false,
  disabled: false,
};

function save_options() {
  var storage = {};
  for (var option in options) {
    storage[option] = document.getElementById(option).checked;
  }
  chrome.storage.sync.set(storage, function () {});
}

function restore_options() {
  chrome.storage.sync.get(options, function (items) {
    for (var option in items) {
      document.getElementById(option).checked = items[option];
    }

    for (var option in options) {
      document.getElementById(option).disabled = items.disabled;
      if (items.disabled) {
        document.getElementById("disabled").disabled = false;
      }
    }
  });
}

chrome.commands.getAll(function (commands) {
  var hotkeysDiv = document.getElementById("hotkeys");
  for (let i = 0; i < commands.length; i++) {
    var tag = document.createElement("p");
    var text = document.createTextNode(
      commands[i].shortcut + " - " + commands[i].description
    );
    tag.appendChild(text);
    hotkeysDiv.appendChild(tag);
  }
});

var version = document.getElementById("version");
version.innerHTML = "v" + chrome.runtime.getManifest().version;

document.addEventListener("DOMContentLoaded", restore_options);
chrome.storage.onChanged.addListener(function (_changes, _namespace) {
  restore_options();
});

for (var option in options) {
  document.getElementById(option).addEventListener("change", save_options);
}
