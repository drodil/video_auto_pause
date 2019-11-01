# Youtube Auto Pause

This is a Chrome extension that pauses Youtube videos when losing the tab focus by
sending 'k' even to the player. Resumes the playback once the Youtube tab is
back in focus.

## Installing

**From chrome web store**

https://chrome.google.com/webstore/detail/pbehcnkdmffkllmlfjpblpjhflnafioo/

**Manually**

1. Clone the repository
2. Start chrome
3. Go to chrome://extensions
4. Enable developer mode
5. Click on "Load unpacked"
6. Select the cloned folder

## Contributing

Please feel free to contribute with pull requests or by creating issues. In case
the extension does not work, please also list all other extensions you have
enabled as this might conflict with other extensions.

## TODO

* Support for other video services
* Fix the "Extension context invalidated" error on first start
    * Relates to the chrome.runtime.sendMessage being called before the
      extension background script is loaded
