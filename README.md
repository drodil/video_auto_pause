![Video Auto Pause](vap.png)

This is a Chrome & Firefox extension that pauses videos when losing the tab/window focus by
sending events to the player. Resumes the playback once the tab/window is back in focus.
It controls HTML video elements; audio-only playback is not affected.

Also listens for computer lock events and when the video goes out of viewport
(for example, when reading comments below the video).
When multiple videos are visible on a page, it keeps the one with the largest
visible area playing and pauses other videos.

Features some useful keyboard shortcuts to control videos in the window.

On first install, a short welcome page explains the main behaviors, shows available
keyboard shortcuts, and links to the settings.

The welcome page and settings popup also include one-click modes for studying,
background music, binge watching, and battery-saving sessions.

An optional on-video control lets you toggle playback, adjust speed, and disable
automatic handling for the current site without opening the popup.

Use the tab pin in the popup or on-video controls to keep one tab playing while
you work elsewhere; the pin clears automatically when its tab is closed.

Per-site settings are managed from a searchable domain list. Select a domain to
open its settings panel; each option inherits the global value until you
customize it for that site. You can disable the extension for one domain, set a
global playback speed (or override it per site), and preserve legacy include /
exclude behavior through automatic migration to site rules.

Ad handling watches active player markers across sites, including YouTube's
active ad UI, generic `data-ad-playing` signals, and common player-ad overlays.
An empty YouTube ad-module placeholder alone is not treated as an active ad.

Advanced context rules can pause playback after a configurable idle timeout or
during daily quiet hours in local time. The one-source mode prioritizes media in
the active tab and returns to the previous source when the current one stops.
You can also disable autoplay-next on supported players and set a 30-minute
sleep timer to pause active videos across tabs.
Peek mode can keep a video playing when its window loses focus while the
pointer remains over that video.

Settings can be exported to or imported from a versioned JSON backup. You can
also save named settings profiles and optionally associate each with one or more
domains; the most specific matching profile is applied automatically, while
domains without a matching profile continue using the global settings.

Advanced settings can enable configurable in-page video shortcuts for seeking,
frame stepping, A-B looping, playback markers, frame capture, Picture-in-Picture,
and captions. Shortcuts are disabled by default and can be left blank
individually to avoid conflicts with a site's own controls.
An optional tab-switch setting opens the playing video in a supported
Picture-in-Picture window instead of pausing it.

## Player compatibility

The extension controls standard HTML video elements across sites. YouTube also
has player-specific active-ad detection and autoplay-next controls. Streaming
services such as Netflix, Twitch, Prime Video, Disney+, Vimeo, Coursera, Udemy,
Bilibili, X, TikTok, and Reddit are best-effort: DRM, cross-origin frames, or
custom players can limit browser access to their controls.

Use **Report a site** in the settings to open a GitHub issue draft containing
the current site origin and browser. The draft is not submitted automatically,
and query strings and fragments are intentionally excluded.

## Installing

#### Chrome Web Store

https://chrome.google.com/webstore/detail/pbehcnkdmffkllmlfjpblpjhflnafioo/

#### Firefox Web Store

https://addons.mozilla.org/en-US/firefox/addon/video-auto-pause/

#### From releases

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
7. Enable **Allow access to file URLs** for the extension to control videos opened from your computer

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
