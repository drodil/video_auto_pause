# Installation

## Browser stores

- [Chrome Web Store](https://chrome.google.com/webstore/detail/pbehcnkdmffkllmlfjpblpjhflnafioo/)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/video-auto-pause/)

## Release packages

Download the latest pre-packaged Chrome or Firefox release from the
[releases page](https://github.com/drodil/video_auto_pause/releases) and
install it manually in your browser.

## Load an unpacked extension

### Chrome

1. Clone the repository.
2. Run `npm install`, then `npm run prepare:chrome`.
3. Open `chrome://extensions` and enable developer mode.
4. Select **Load unpacked** and choose the repository's `src` directory.
5. Enable **Allow access to file URLs** if you want the extension to control
   videos opened from your computer.

### Firefox

1. Clone the repository.
2. Run `npm install`, then `npm run prepare:firefox`.
3. Open `about:debugging`, select **This Firefox**, and choose **Load
   Temporary Add-on**.
4. Select `src/manifest.json`.

For local development with an automatically launched browser, see
[CONTRIBUTION.md](../CONTRIBUTION.md).
