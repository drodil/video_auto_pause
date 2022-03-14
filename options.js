function save_options() {
  console.log("SAVE OPTIONS");
  var autopause = document.getElementById("autopause").checked;
  var autoresume = document.getElementById("autoresume").checked;
  var scrollpause = document.getElementById("scrollpause").checked;
  console.log(autopause);
  chrome.storage.sync.set(
    { autopause: autopause, autoresume: autoresume, scrollpause: scrollpause },
    function () {
      var status = document.getElementById("status");
      status.textContent = "Saved!";
      setTimeout(function () {
        status.textContent = "";
      }, 1000);
    }
  );
}

function restore_options() {
  chrome.storage.sync.get(
    { autopause: true, autoresume: true, scrollpause: false, toggled: false },
    function (items) {
      document.getElementById("autopause").checked = items.autopause;
      document.getElementById("autoresume").checked = items.autoresume;
      document.getElementById("scrollpause").checked = items.scrollpause;
      if (items.toggled) {
        document.getElementById("autopause").disabled = true;
        document.getElementById("autoresume").disabled = true;
        document.getElementById("scrollpause").disabled = true;
      } else {
        document.getElementById("autopause").disabled = false;
        document.getElementById("autoresume").disabled = false;
        document.getElementById("scrollpause").disabled = false;
      }
    }
  );
}

document.addEventListener("DOMContentLoaded", restore_options);
chrome.storage.onChanged.addListener(function (_changes, _namespace) {
  restore_options();
});
document.getElementById("save").addEventListener("click", save_options);
