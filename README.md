![Video Auto Pause](vap.png)

This is a Chrome & Firefox extension that pauses videos when losing the tab/window focus by
sending events to the player. Resumes the playback once the tab/window is back in focus.

Also listens for computer lock events and when the video goes out of viewport
(for example, when reading comments below the video).

Features some useful keyboard shortcuts to control videos in the window.

## Installing

#### Chrome Web Store
https://chrome.google.com/webstore/detail/pbehcnkdmffkllmlfjpblpjhflnafioo/

#### Firefox Web Store
https://addons.mozilla.org/en-US/firefox/addon/youtube-auto-pause/

**From releases**

There are pre-packaged releases available for both Chrome and Firefox. Download the latest release
from the [releases page](https://github.com/drodil/video_auto_pause/releases) and
install it manually to your browser.

**Manually (Chrome)**

1. Clone the repository
2. Start Chrome
3. Go to `chrome://extensions`
4. Enable developer mode
5. Click on "Load unpacked"
6. Select the `chrome` directory in the repository

**Manually (Firefox)**

1. Clone the repository
2. Start Firefox
3. Go to `about:debugging`
4. Click on "This Firefox"
5. Click on "Load Temporary Add-on"
6. Select the `firefox` directory in the repository

## Contributing

Please feel free to contribute with pull requests or by creating issues. In case
the extension does not work, please also list all other extensions you have
enabled as this might conflict with other extensions.

### Running and developing

To run the extension, either use `npm run start:chrome` or `npm run start:firefox` to start
specific browser. This will open a new browser window with the extension enabled.

If you want to debug the extension further, use `npm run debug:chrome` and `npm run debug:firefox`
respectively. This will open the browser's developer tools that you can use to debug the extension.

### Building

Run `npm install` to fetch necessary dependencies. Then run `npm run build` to build
the extension packages under `web-ext-artifacts`.
