![Youtube Auto Pause](yt_auto_pause.png)

This is a Chrome extension that pauses Youtube videos when losing the tab/window focus by
sending events to the player. Resumes the playback once the Youtube tab/window is back in focus.

Also listens for computer lock events and when the video goes out of viewport
(for example when reading comments below the video).

Features some useful keyboard shortcuts to control videos in the window.

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

## Supported services

* Youtube (obviously)
* Youtube Kids
* Vimeo
* Netflix
* ... More to come, please contribute! (also see TODO)

## Contributing

Please feel free to contribute with pull requests or by creating issues. In case
the extension does not work, please also list all other extensions you have
enabled as this might conflict with other extensions.

## TODO

* Allow selecting video services
