var previous_tab = 0;
var autopause = true;
var autoresume = true;
var scrollpause = false;
refresh_settings()

function refresh_settings() {
    chrome.storage.sync.get(['autopause', 'autoresume', 'scrollpause'], function(result) {
        if('autopause' in result) {
            autopause = result.autopause
        }
        if('autoresume' in result) {
            autoresume = result.autoresume
        }
        if('scrollpause' in result) {
            scrollpause = result.scrollpause
        }
    });
}

function stop(tab) {
    chrome.tabs.sendMessage(tab.id, {'action' : 'stop'});
}

function resume(tab) {
    chrome.tabs.sendMessage(tab.id, {'action' : 'resume'});
}

function handle_tabs(tabId) {
    refresh_settings()
    if (autopause && previous_tab != 0) {
        chrome.tabs.get(previous_tab, function(prev) {
            if (!chrome.runtime.lastError) {
                stop(prev);
            }
        });
    }
    previous_tab = tabId;

    chrome.tabs.get(tabId, function(tab) {
        if (autoresume && !chrome.runtime.lastError) {
            resume(tab);
        }
    });
}

chrome.storage.onChanged.addListener(function(changes, namespace) {
    if ('autoresume' in changes) {
        autoresume = changes.autoresume.newValue;
    }
    if ('autopause' in changes) {
        autopause = changes.autopause.newValue;
    }
});

chrome.tabs.onActivated.addListener(function(info) { handle_tabs(info.tabId); });

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if ('status' in changeInfo && changeInfo.status === 'complete' && !tab.active) {
        stop(tab);
    }
});

chrome.windows.onFocusChanged.addListener(function(info) {
    refresh_settings()
    if (previous_tab != 0) {
        chrome.tabs.get(previous_tab, function(tab) {
            if (tab === undefined || chrome.runtime.lastError) {
                return;
            }
            if (!tab.active && autopause) {
                stop(tab);
            }
        });
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (sender.tab === undefined || chrome.runtime.lastError) {
        return true;
    }

    refresh_settings()
    if ('minimized' in request) {
        if (request.minimized && autopause) {
            chrome.tabs.get(sender.tab.id, function(tab) {
                if (!chrome.runtime.lastError) {
                    stop(sender.tab);
                }
            });
        } else if (!request.minimized && autoresume) {
            chrome.tabs.get(sender.tab.id, function(tab) {
                if (!chrome.runtime.lastError) {
                    resume(sender.tab);
                }
            });
        }
    }
    if('visible' in request && scrollpause) {
        if(!request.visible) {
            chrome.tabs.get(sender.tab.id, function(tab) {
                if (!chrome.runtime.lastError) {
                    stop(sender.tab);
                }
            });
        } else {
            chrome.tabs.get(sender.tab.id, function(tab) {
                if (!chrome.runtime.lastError) {
                    resume(sender.tab);
                }

            });
        }
    }

    return true;
});


chrome.runtime.onInstalled.addListener(installScript);

function installScript(details){
    let params = {
        currentWindow: true
    };
    chrome.tabs.query(params, function gotTabs(tabs){
        let contentjsFile = chrome.runtime.getManifest().content_scripts[0].js[0];
        let matches = chrome.runtime.getManifest().content_scripts[0].matches
        for (let index = 0; index < tabs.length; index++) {
            let execute = false;
            matches.forEach(function(match) {
                let reg = match.replace(/[.+?^${}()|/[\]\\]/g, '\\$&').replace('*', '.*');
                if(new RegExp(reg).test(tabs[index].url) === true) {
                    execute = true;
                    return
                }
            });
            if(execute) {
                chrome.tabs.executeScript(tabs[index].id, {
                    file: contentjsFile
                });
            }
        }
    });
}
