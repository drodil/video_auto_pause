# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.15.0](https://github.com/drodil/video_auto_pause/compare/v1.14.1...v1.15.0) (2026-10-29)


### Features

* ad handling ([7fb1e4b](https://github.com/drodil/video_auto_pause/commit/7fb1e4b90c7eb178809d290ddfc4600b380786d0))
* **ads:** detect active ad markers across players ([b2f7259](https://github.com/drodil/video_auto_pause/commit/b2f7259da4846a65ce189ea48cf1a8c2ca29c0da))
* **audio:** add opt-in audio-only handling ([8dd8c89](https://github.com/drodil/video_auto_pause/commit/8dd8c896201c345fdd260ae03cf38ff2b1f63a6d))
* **autoplay:** add next-video control and sleep timer ([f1a47ed](https://github.com/drodil/video_auto_pause/commit/f1a47ed4e869a6bd331038ca5c047f9b5d295a30))
* **autoplay:** stop automatic playback at video end ([e920518](https://github.com/drodil/video_auto_pause/commit/e9205181c27b70f5a65153aa12fdf6b556a8f6db))
* **compat:** add player support guidance and site reports ([7fe590c](https://github.com/drodil/video_auto_pause/commit/7fe590c71b02198a98dc290ecd02d6cf4e650977))
* **context:** add idle and quiet-hour pause rules ([16f5568](https://github.com/drodil/video_auto_pause/commit/16f5568b124409e87db0117bbee0d30dd6a5b3e3))
* **context:** add low-battery pause rule ([fde0963](https://github.com/drodil/video_auto_pause/commit/fde096384b5c30c2b490aa69231ae8966e2bc3b1))
* **context:** pause on audio output disconnect ([c45ac5f](https://github.com/drodil/video_auto_pause/commit/c45ac5f427e4be7472121938678033dcdad2fdc4))
* **diagnostics:** add local settings report export ([ce0397f](https://github.com/drodil/video_auto_pause/commit/ce0397ff42ebfc94e61fab2604d9470e11bb9c01))
* expand profile-bound settings and controls ([6018099](https://github.com/drodil/video_auto_pause/commit/6018099b0998c65c3797f2a2b5eb918ad3f2cab5))
* **focus:** add pointer-aware peek mode ([bc759c4](https://github.com/drodil/video_auto_pause/commit/bc759c4a2bc873ca84778c6ec1f9bebd9aad816f))
* **media:** handle live streams and player ads ([7d718b9](https://github.com/drodil/video_auto_pause/commit/7d718b9c105d9250dafcc544129b46baed17cec8))
* **mobile:** improve touch settings layout ([66318f9](https://github.com/drodil/video_auto_pause/commit/66318f92d23eff15475cc27fa1dbb0be00fc2883))
* **onboarding:** add first-run welcome page ([c001435](https://github.com/drodil/video_auto_pause/commit/c0014358212fc25ccddfe086551567b7e8d343e1))
* **options:** improve domain and audio fade controls ([13edb63](https://github.com/drodil/video_auto_pause/commit/13edb63c8104ed51c38c4913177e73386ea87d19))
* **overlay:** add draggable on-video controls ([4c2f79b](https://github.com/drodil/video_auto_pause/commit/4c2f79bb6cf1525545d4872f673f032346a01f87))
* **pin:** keep selected tabs playing in background ([11e840d](https://github.com/drodil/video_auto_pause/commit/11e840df4669251fd2011ea9caeef794edd65b5d))
* **pip:** pop out video on tab switch ([62657c0](https://github.com/drodil/video_auto_pause/commit/62657c08864fba968e7f7ae5886ed9c6f27ba471))
* **presets:** add one-click playback modes ([0b5347d](https://github.com/drodil/video_auto_pause/commit/0b5347d125e02d4039b78d85f3f85303224c017f))
* **presets:** explain modes with localized tooltips ([270e903](https://github.com/drodil/video_auto_pause/commit/270e903198cc8092ec24894e383dc5d62b017681))
* **profiles:** apply saved settings by domain ([87e6f53](https://github.com/drodil/video_auto_pause/commit/87e6f53c523ba740427c6d40b7a9aef390e5dcb6))
* **resume:** rewind videos after automatic pauses ([8b21b80](https://github.com/drodil/video_auto_pause/commit/8b21b8084466af9f907700b59db0320b79e15eda))
* **safety:** disable tabs after content errors ([ab6e184](https://github.com/drodil/video_auto_pause/commit/ab6e18406763447eaa8e398cc97ee9e6798775e1))
* **settings:** add inheritable per-site rules ([aab9560](https://github.com/drodil/video_auto_pause/commit/aab95600ba048525490c624eb3fd82ffd44330e9))
* **shortcuts:** add remappable in-page video controls ([2b588ef](https://github.com/drodil/video_auto_pause/commit/2b588ef21d85a189e38625f5981179bbccabc1f5))
* **stats:** add private weekly playback dashboard ([f68e9e0](https://github.com/drodil/video_auto_pause/commit/f68e9e046118876ab0ab74badfbe3c6cc32c0592))
* **stats:** remove weekly summary copy action ([9de692a](https://github.com/drodil/video_auto_pause/commit/9de692a63e588a5969077a6267b574567e1117b0))
* ui improvements ([1afcdd2](https://github.com/drodil/video_auto_pause/commit/1afcdd2a4417a25dd51137e8674ca5c1d15d6ed8))


### Bug Fixes

* pause media started while device is locked ([a572a76](https://github.com/drodil/video_auto_pause/commit/a572a764cdc2ab6b16b9fc6d290ceb64f9ff49dc))


### Maintenance

* refactoring ([aa451a7](https://github.com/drodil/video_auto_pause/commit/aa451a7f9d31a096d5be9506f6844f034bda618d))

### [1.14.1](https://github.com/drodil/video_auto_pause/compare/v1.14.0...v1.14.1) (2026-10-16)

### Bug Fixes

- resume autoplay when activating background tabs ([f72541a](https://github.com/drodil/video_auto_pause/commit/f72541af759054c37830b441943aa1333d872f47))

## [1.14.0](https://github.com/drodil/video_auto_pause/compare/v1.13.0...v1.14.0) (2026-10-15)

### Features

- prioritize active media and expand browser coverage ([3fb5c29](https://github.com/drodil/video_auto_pause/commit/3fb5c29955d98f64aeeecfde129843b701223311)), closes [#4](https://github.com/drodil/video_auto_pause/issues/4) [#5](https://github.com/drodil/video_auto_pause/issues/5) [#8](https://github.com/drodil/video_auto_pause/issues/8) [#15](https://github.com/drodil/video_auto_pause/issues/15) [#16](https://github.com/drodil/video_auto_pause/issues/16) [#19](https://github.com/drodil/video_auto_pause/issues/19) [#20](https://github.com/drodil/video_auto_pause/issues/20)

### Bug Fixes

- update Firefox add-on link ([984cc7b](https://github.com/drodil/video_auto_pause/commit/984cc7b1cb68cd5dc5358903672d75ab1d9c415a))

## [1.13.0](https://github.com/drodil/video_auto_pause/compare/v1.12.0...v1.13.0) (2026-01-27)

### Features

- mute instead pause + bug fixes ([8e8dc53](https://github.com/drodil/video_auto_pause/commit/8e8dc5398a539484f80b217f765268feea88f153))

### Bug Fixes

- **ci:** use xvfb-run for playwright tests ([995e6c8](https://github.com/drodil/video_auto_pause/commit/995e6c88447aa4efa939786b127b17e43a086938))
- icon handling + perf improvements ([f28ceef](https://github.com/drodil/video_auto_pause/commit/f28ceefb1af34a1c87bb6fec253fcb82a0801321))
- update upload-artifact ([f7d77a7](https://github.com/drodil/video_auto_pause/commit/f7d77a7cb71b465d993cf01ac16b3cb1c6693fbb))

## [1.12.0](https://github.com/drodil/video_auto_pause/compare/v1.11.4...v1.12.0) (2026-01-27)

### Features

- add localization ([94a1851](https://github.com/drodil/video_auto_pause/commit/94a18514e3f096928c84ddbbea7a81320828207b))
- delays + domain exclusions ([f1e3764](https://github.com/drodil/video_auto_pause/commit/f1e37647b397ebf02a32fc66beabbc9f19bccc1c))
- more languages + hotkey translation fix ([e7d15b0](https://github.com/drodil/video_auto_pause/commit/e7d15b04395f3eb535d1ad5917e4ec256ed4b902))
- pip and audio fading ([c915fe5](https://github.com/drodil/video_auto_pause/commit/c915fe5c29103009421ac18d213371764ced5531))
- restyle options panel ([be3651d](https://github.com/drodil/video_auto_pause/commit/be3651d441603395a0e8ca90d4f89555500092f8))

### [1.11.4](https://github.com/drodil/video_auto_pause/compare/v1.11.3...v1.11.4) (2026-01-26)

### Bug Fixes

- new window tab creation ([624dd9d](https://github.com/drodil/video_auto_pause/commit/624dd9da9a1bfe7f0db3ab6305b5c6f075024bfa))

### [1.11.3](https://github.com/drodil/video_auto_pause/compare/v1.11.2...v1.11.3) (2026-01-21)

### Bug Fixes

- cursor listeners ([3675887](https://github.com/drodil/video_auto_pause/commit/3675887b0c491644445386167ee9f73e4ec2d984))

### Maintenance

- error handling + formatting ([7d33f8d](https://github.com/drodil/video_auto_pause/commit/7d33f8d146c083c322458de40dfe1b2c8114a69c))
- fix prettier deps ([eb8763b](https://github.com/drodil/video_auto_pause/commit/eb8763bf25b77450b3b02d5c4e2f8fe42cc62985))

### [1.11.2](https://github.com/drodil/video_auto_pause/compare/v1.11.1...v1.11.2) (2025-06-05)

### Bug Fixes

- check for active tab explicitly before resuming ([90db7da](https://github.com/drodil/video_auto_pause/commit/90db7da9242b22428e98c1efdb4e6aee3e332762)), closes [#16](https://github.com/drodil/video_auto_pause/issues/16)
- improve disabled icon handling ([2fb2887](https://github.com/drodil/video_auto_pause/commit/2fb28877f1d6ac4fc033b0d3450748d1078f2f16))

### [1.11.1](https://github.com/drodil/video_auto_pause/compare/v1.11.0...v1.11.1) (2025-01-13)

### Bug Fixes

- enabled icon & viewport check ([75d2bbf](https://github.com/drodil/video_auto_pause/commit/75d2bbfa407a2b7e750c6e77f690efe84b434320))

## [1.11.0](https://github.com/drodil/video_auto_pause/compare/v1.10.2...v1.11.0) (2025-01-09)

### Features

- enable extension on all sites ([0bf9017](https://github.com/drodil/video_auto_pause/commit/0bf9017a38c20d4c85fc69664856804ceb44863d))

### Documentation

- remove supported services from readme ([1ee26bf](https://github.com/drodil/video_auto_pause/commit/1ee26bfae0cac61cef90b44ab0d4610c97bec8f4))

### [1.10.2](https://github.com/drodil/video_auto_pause/compare/v1.10.1...v1.10.2) (2024-10-11)

### Bug Fixes

- rename to video auto pause due to trademark ([5403e08](https://github.com/drodil/video_auto_pause/commit/5403e08ef16766683fc1a85bc7ce9591b0f24a5e))

### Maintenance

- change graphics ([95ff64d](https://github.com/drodil/video_auto_pause/commit/95ff64d0895a9676613e0264dcd1a4590dc28844))

### [1.10.1](https://github.com/drodil/video_auto_pause/compare/v1.10.0...v1.10.1) (2024-10-07)

### Bug Fixes

- lint command ([13bffc1](https://github.com/drodil/video_auto_pause/commit/13bffc142b7edb6057d0c3aef3c901c30f00ecde))

## [1.10.0](https://github.com/drodil/video_auto_pause/compare/v1.9.2...v1.10.0) (2024-10-07)

### Features

- allow enabling/disabling for single tab ([4c5ec50](https://github.com/drodil/video_auto_pause/commit/4c5ec506caf9ef8766e6def3db69ccf69e5881c4))

### Maintenance

- merge firefox and chrome sources ([79219a0](https://github.com/drodil/video_auto_pause/commit/79219a0a6a12a91faed385e6948ab080ebb6ef9b))

### [1.9.2](https://github.com/drodil/video_auto_pause/compare/v1.9.1...v1.9.2) (2024-10-04)

### Bug Fixes

- check for active tab for disabled icon ([22a2f3a](https://github.com/drodil/video_auto_pause/commit/22a2f3a1585db9199b99b035965821b571a088fb))

### [1.9.1](https://github.com/drodil/video_auto_pause/compare/v1.9.0...v1.9.1) (2024-10-04)

### Bug Fixes

- disabled icon in new tab and navigation ([d68cc16](https://github.com/drodil/video_auto_pause/commit/d68cc1600855e4566270085a50f6a6762effb6d5))

## [1.9.0](https://github.com/drodil/video_auto_pause/compare/v1.8.0...v1.9.0) (2024-10-03)

### Features

- ff support for gray icon ([c768126](https://github.com/drodil/video_auto_pause/commit/c768126311a7f16a3cc402d0d3a315805c9957b2))
- turn icon to gray when extension not active ([7f1c00c](https://github.com/drodil/video_auto_pause/commit/7f1c00c003b68140e41610c19385cae52611c3be)), closes [#13](https://github.com/drodil/video_auto_pause/issues/13)

## [1.8.0](https://github.com/drodil/video_auto_pause/compare/v1.7.7...v1.8.0) (2024-09-18)

### Features

- add support to decide if fullscreen ignores all commands ([6d74141](https://github.com/drodil/video_auto_pause/commit/6d74141c307a27f6000fc24b36c09127a3f949ac))

### [1.7.7](https://github.com/drodil/video_auto_pause/compare/v1.7.6...v1.7.7) (2024-09-18)

### Bug Fixes

- ignore all messages when in fullscreen mode ([f5bd8a3](https://github.com/drodil/video_auto_pause/commit/f5bd8a3d04c9a4600158739ba81d03084a589aa0))

### [1.7.6](https://github.com/drodil/video_auto_pause/compare/v1.7.5...v1.7.6) (2024-08-06)

### Bug Fixes

- standard-version scripts ([919d071](https://github.com/drodil/video_auto_pause/commit/919d07151ddf642dc93611310add10c32cf812f2))

### Documentation

- add mention about pre-packaged releases ([e6ca879](https://github.com/drodil/video_auto_pause/commit/e6ca879ea8f5f2492ec536222a7dccd7cc2e5a10))

### Maintenance

- change to use standard-version ([4e362a0](https://github.com/drodil/video_auto_pause/commit/4e362a0f0f7295008f210084104b3b5aa3b2009f))
