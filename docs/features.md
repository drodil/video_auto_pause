# Feature guide

Video Auto Pause manages standard HTML video playback across browser tabs and
windows. Audio-only players are left alone by default; turn off
"Allow audio-only playback" to control them too.

## Playback behavior

- Pause videos when their tab or window loses focus, when the computer locks,
  or when the video is no longer in the viewport. Resume playback when the
  relevant context becomes active again.
- When multiple videos are visible on a page, keep the video with the largest
  visible area playing and pause the others. This is enabled by default.
- "Prioritize media in the active tab" controls playback across tabs, not videos
  on the same page. It returns to the previous source when the active media
  stops. This separate feature is off by default.
- Use peek mode to keep a video playing after its window loses focus while the
  pointer remains over the video.
- Optionally open a playing video in a supported Picture-in-Picture window
  when switching tabs.

## Controls and settings

- The welcome page and settings popup include one-click modes for studying,
  background music, binge watching, and battery-saving sessions.
  Each mode resets playback and automation settings before applying its policy,
  so delays, quiet hours, autoplay restrictions, and other advanced settings from
  an earlier mode cannot interfere. Site settings, profile identity, extension
  enablement, shortcut bindings, and personal control/display preferences remain
  unchanged. Site overrides still take precedence, and an active sleep timer
  is not cancelled.
  - Study pauses/resumes on tab, window focus, and device-lock changes, and
    rewinds five seconds on resume.
  - Background music keeps playback going across tab, focus, and device-lock
    changes without muting it. A 200ms fade applies to controlled playback.
  - Binge pauses/resumes on tab and device-lock changes, ignores window focus,
    and leaves fullscreen playback alone.
  - Battery saver pauses on tab, focus, lock, and visibility changes without
    resuming automatically. It also controls audio-only players, blocks initial
    autoplay and autoplay-next, and pauses rather than muting live streams or ads.
    Low battery and audio-output disconnection also pause playback. Fullscreen
    does not bypass its pause rules.
- Optional on-video controls let you toggle playback, adjust speed, or disable
  automatic handling for the current site.
- Pin a tab from the popup or on-video controls to keep its video playing while
  working elsewhere. The pin clears when the tab closes.
- General settings opens by default with the main pause/resume controls. Separate
  top-level sections put modes, site settings, and profile management before
  detailed playback, focus, controls, and automation settings. Playback adjustments
  follow playback and audio; hotkeys follow video controls and shortcuts; the sleep
  timer follows automation. Statistics and troubleshooting come last.
  The site editor uses the same settings groups and order.
- Manage per-site settings in a domain list. Site settings inherit
  global values until customized. Add the current site or enter a domain name
  without visiting it. Boolean settings cycle through default (`[-]`), enabled
  (`[x]`), and disabled (`[ ]`) with a click or the Space key. Numeric settings
  and shortcut keys have a separate customization toggle.
  Saving or deleting site settings returns directly to the main settings view,
  without a confirmation dialog. Invalid settings stay open with an error.
  The extension can be disabled for an
  individual domain, and playback speed can be configured globally or per site.
  The configured speed is applied when a video loads; you can still change it
  afterwards with the player, shortcuts, or on-video controls.
- Save named settings profiles and switch between them. Profiles sync between
  browsers, while the active profile is chosen separately on each device.
  Switch profiles using the selector at the top, shown when multiple profiles
  exist. Profiles & backup lists custom profiles with compact Remove buttons;
  Default remains available in the top selector but is not listed for removal.
  Removing the active profile switches back to Default. Export/import actions
  appear below profile management.
- Hover over or keyboard-focus a setting, mode, or icon button to see a tooltip
  that explains it.
- Export and import settings using a versioned JSON backup.
- Open the Statistics section to see pauses, resumes, blocked autoplay, and
  prevented playback minutes. Use the 7-, 30-, or 90-day buttons to change the
  reporting period. Daily totals are stored
  locally for 90 days. This section is collapsed by default.
- Legacy include and exclude settings are migrated automatically to site rules.

## Automation and shortcuts

- Detect active ads using player markers, YouTube's active ad UI,
  `data-ad-playing` signals, and common player-ad overlays. An empty YouTube
  ad-module placeholder alone is not considered an active ad.
- Configure an idle timeout or daily quiet hours in local time to pause
  playback.
- Disable autoplay-next on supported players or set a sleep timer (5 to 60
  minutes) that pauses active videos across tabs.
  The sleep timer section opens automatically while a timer is active and is
  collapsed otherwise. Its heading shows a live remaining-time countdown.
- Video controls & shortcuts can enable in-page shortcuts for seeking, frame stepping,
  A-B looping, playback markers, frame capture, Picture-in-Picture, and
  captions. These shortcuts are off by default and can be left blank
  individually to avoid conflicts with site controls.
