function save_options() {
  var autopause = document.getElementById("autopause").checked;
  var autoresume = document.getElementById("autoresume").checked;
  var scrollpause = document.getElementById("scrollpause").checked;
  var disabled = document.getElementById("disabled").checked;
  var lockpause = document.getElementById("lockpause").checked;
  var lockresume = document.getElementById("lockresume").checked;
  var focuspause = document.getElementById("focuspause").checked;
  var focusresume = document.getElementById("focusresume").checked;
  chrome.storage.sync.set(
    {
      autopause: autopause,
      autoresume: autoresume,
      scrollpause: scrollpause,
      disabled: disabled,
      lockpause: lockpause,
      lockresume: lockresume,
      focuspause: focuspause,
      focusresume: focusresume,
    },
    function () {}
  );
}

function restore_options() {
  chrome.storage.sync.get(
    {
      autopause: true,
      autoresume: true,
      scrollpause: false,
      disabled: false,
      lockpause: true,
      lockresume: true,
      focuspause: true,
      focusresume: true,
    },
    function (items) {
      document.getElementById("autopause").checked = items.autopause;
      document.getElementById("autoresume").checked = items.autoresume;
      document.getElementById("scrollpause").checked = items.scrollpause;
      document.getElementById("lockpause").checked = items.lockpause;
      document.getElementById("lockresume").checked = items.lockresume;
      document.getElementById("focuspause").checked = items.focuspause;
      document.getElementById("focusresume").checked = items.focusresume;
      document.getElementById("disabled").checked = items.disabled;

      document.getElementById("autopause").disabled = items.disabled;
      document.getElementById("autoresume").disabled = items.disabled;
      document.getElementById("scrollpause").disabled = items.disabled;
      document.getElementById("lockpause").disabled = items.disabled;
      document.getElementById("lockresume").disabled = items.disabled;
      document.getElementById("focuspause").disabled = items.disabled;
      document.getElementById("focusresume").disabled = items.disabled;
    }
  );
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
document.getElementById("autopause").addEventListener("change", save_options);
document.getElementById("autoresume").addEventListener("change", save_options);
document.getElementById("lockpause").addEventListener("change", save_options);
document.getElementById("lockresume").addEventListener("change", save_options);
document.getElementById("focuspause").addEventListener("change", save_options);
document.getElementById("focusresume").addEventListener("change", save_options);
document.getElementById("scrollpause").addEventListener("change", save_options);
document.getElementById("disabled").addEventListener("change", save_options);
