# Recording runtime

The Windows application includes the FFmpeg executable distributed by Microsoft
Playwright for browser video recording. It is a separate process, not Electron's
media DLL. Its LGPL 2.1 license text is included alongside the executable at
`resources/playwright/ffmpeg-<revision>/COPYING.LGPLv2.1`.

The runtime is downloaded without modification by the Playwright version pinned
in `package-lock.json`. Its matching revision comes from that version's
`browsers.json`; the build does not use a developer's globally cached binaries.

- Playwright source and notices: https://github.com/microsoft/playwright
- FFmpeg build scripts and source references: https://github.com/microsoft/playwright/tree/v1.62.1/browser_patches/ffmpeg
- FFmpeg project: https://ffmpeg.org/

Playwright and the Windows dependency-inspection helper are distributed by the
Playwright project. Playwright's `LICENSE`, `NOTICE`, and `ThirdPartyNotices.txt`
remain included in the packaged `playwright-core` dependency. Other dependency
notices are retained with their respective packaged modules.
