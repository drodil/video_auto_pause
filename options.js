function save_options() {
    var autopause = document.getElementById('autopause').checked;
    var autoresume = document.getElementById('autoresume').checked;
    chrome.storage.sync.set({autopause : autopause, autoresume : autoresume}, function() {
        var status = document.getElementById('status');
        status.textContent = 'Saved!';
        setTimeout(function() { status.textContent = ''; }, 1000);
    });
}

function restore_options() {
    chrome.storage.sync.get({autopause : true, autoresume : true}, function(items) {
        document.getElementById('autopause').checked = items.autopause;
        document.getElementById('autoresume').checked = items.autoresume;
    });
}

document.addEventListener('DOMContentLoaded', restore_options);
document.getElementById('save').addEventListener('click', save_options);
