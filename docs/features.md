# Feature guide

Video Auto Pause manages standard HTML video playback across browser tabs and
windows. Audio-only players are left alone by default; turn off
"Allow audio-only playback" to control them too.

## Playback behavior

- Pause videos when their tab or window loses focus, when the computer locks,
  or when the video is no longer in the viewport. Resume playback when the
  relevant context becomes active again.
- When multiple videos are visible on a page, keep the video with the largest
  visible area playing and pause the others.
- Use one-source mode to prioritize media in the active tab and return to the
  previous source when the active media stops.
- Use peek mode to keep a video playing after its window loses focus while the
  pointer remains over the video.
- Optionally open a playing video in a supported Picture-in-Picture window
  when switching tabs.

## Controls and settings

- The welcome page and settings popup include one-click modes for studying,
  background music, binge watching, and battery-saving sessions.
- Optional on-video controls let you toggle playback, adjust speed, or disable
  automatic handling for the current site.
- Pin a tab from the popup or on-video controls to keep its video playing while
  working elsewhere. The pin clears when the tab closes.
- Manage per-site settings in a searchable domain list. Site settings inherit
  global values until customized. The extension can be disabled for an
  individual domain, and playback speed can be configured globally or per site.
  The configured speed is applied when a video loads; you can still change it
  afterwards with the player, shortcuts, or on-video controls.
- Save named settings profiles and switch between them. Profiles sync between
  browsers, while the active profile is chosen separately on each device.
- Hover over or keyboard-focus a setting, mode, or icon button to see a tooltip
  that explains it.
- Export and import settings using a versioned JSON backup.
- Legacy include and exclude settings are migrated automatically to site rules.

## Automation and shortcuts

- Detect active ads using player markers, YouTube's active ad UI,
  `data-ad-playing` signals, and common player-ad overlays. An empty YouTube
  ad-module placeholder alone is not considered an active ad.
- Configure an idle timeout or daily quiet hours in local time to pause
  playback.
- Disable autoplay-next on supported players or set a sleep timer (5 to 60
  minutes) that pauses active videos across tabs.
- Advanced settings can enable in-page shortcuts for seeking, frame stepping,
  A-B looping, playback markers, frame capture, Picture-in-Picture, and
  captions. These shortcuts are off by default and can be left blank
  individually to avoid conflicts with site controls.
