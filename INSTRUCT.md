# Releasing Wonder World

This project ships as a desktop app for **Windows** and **macOS**. The app is
the existing web game wrapped in [Electron](https://www.electronjs.org/): the
Electron launcher (`electron/main.js`) starts the bundled Express + WebSocket
server and opens the game in a native window.

Installers are built automatically by GitHub Actions and attached to a GitHub
Release. You never build them by hand.

---

## TL;DR — cut a release

```bash
# 1. Set the version (must be valid semver — see note below)
#    Edit "version" in package.json, e.g. "1.0.0"

# 2. Commit it
git add package.json package-lock.json
git commit -m "Release v1.0.0"
git push

# 3. Tag it with a "v" prefix that MATCHES the version, and push the tag
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

Pushing the tag triggers the **Release** workflow. It builds the Windows and
macOS installers in parallel and uploads them to a **draft** GitHub Release
named after the tag.

```
4. Go to GitHub → Releases → the draft "v1.0.0"
5. Review the auto-generated notes (and tick "This is a pre-release" for betas)
6. Click "Publish release"
```

That's it. Users can now download the installers from the release page.

---

## ⚠️ The one rule you must follow

**The git tag must equal `v` + the `version` in `package.json`.**

| package.json `version` | tag you push |
| --- | --- |
| `1.0.0`         | `v1.0.0`         |
| `1.2.3`         | `v1.2.3`         |
| `1.0.0-beta.1`  | `v1.0.0-beta.1`  |

electron-builder looks for the release whose tag is `v<version>` and uploads
the installers there. If the tag and the version don't match, the build
succeeds but the installers are never attached to your release.

The version must be **valid [semver](https://semver.org/)**. `1.0.0` and
`1.0.0-beta.1` are valid; `beta.1.0.0` is **not** and will fail the build.
(The project currently ships as `1.0.0-beta.1`.)

---

## What gets produced

| Platform | File | Notes |
| --- | --- | --- |
| Windows | `WonderWorld-<version>-x64.exe` | NSIS installer, 64-bit. Runs on Windows 10 & 11. |
| macOS   | `WonderWorld-<version>-universal.dmg` | Universal — runs on both Apple Silicon and Intel Macs (macOS 11+). |

The Windows installer is a normal wizard: the user picks an install location and
gets Start-menu and desktop shortcuts. The macOS `.dmg` is the standard
drag-to-Applications image.

---

## One-time setup

**None required.** The workflow authenticates to GitHub using the built-in
`GITHUB_TOKEN`, which every repository already has. There are no secrets to
configure for a basic release.

Code signing is intentionally left off (see below), so the very first release
works with zero configuration.

---

## Testing before you release

You don't have to tag to check things work:

```bash
npm install          # once, to install dependencies

npm start            # run the full desktop app locally (server + window)
npm run server       # run just the game server (http://localhost:3000)

npm run pack         # build an UNPACKED app into dist/ (fast, no installer)
npm run dist:win     # build the Windows installer locally (Windows only)
npm run dist:mac     # build the macOS installer locally (macOS only)
```

You can also trigger the workflow **without** releasing: on GitHub go to
**Actions → Release → Run workflow**. This builds both installers and uploads
them as *workflow artifacts* (download them from the run's summary page) without
creating or touching any GitHub Release.

---

## About the "unverified app" warnings

The installers are **not code-signed** (that requires paid certificates), so the
operating system will warn users on first launch:

- **Windows** — SmartScreen shows *"Windows protected your PC."* The user clicks
  **More info → Run anyway**.
- **macOS** — Gatekeeper says the app *"cannot be opened because the developer
  cannot be verified."* The user **right-clicks the app → Open**, then confirms
  (or allows it under *System Settings → Privacy & Security*).

This is normal for unsigned apps and does not indicate a problem.

### Enabling code signing later (optional)

When you obtain certificates, signing removes those warnings:

- **Windows:** add repository secrets `CSC_LINK` (base64 of your `.pfx`) and
  `CSC_KEY_PASSWORD`, and pass them as env vars in the build step.
- **macOS:** add `CSC_LINK` / `CSC_KEY_PASSWORD` for your Developer ID
  certificate, remove `identity: null` from `electron-builder.yml`, and set up
  notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
  Remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` from the workflow.

See the [electron-builder code signing docs](https://www.electron.build/code-signing).

---

## How it all fits together (reference)

| File | Purpose |
| --- | --- |
| `.github/workflows/release.yml` | The GitHub Action. Triggers on `v*.*.*` tags. Creates the draft release, then builds Windows + macOS installers on parallel runners and publishes them. Uses **Node.js 24** and **Electron 43**. |
| `electron/main.js` | Electron launcher. Boots the embedded server, opens the game window, routes world saves to the per-user data folder. |
| `electron-builder.yml` | Build configuration — targets, installer options, app icon, and GitHub publishing settings. |
| `build/icon.png` | The 1024×1024 app icon (electron-builder converts it to `.ico`/`.icns` automatically). Replace this file to change the icon. |
| `package.json` | `version` drives the release; `main` points at the launcher; runtime deps live here. |

### Where player data is stored

In the packaged app the game files are read-only, so world saves, settings, and
screenshots are written to the OS per-user app-data folder:

- **Windows:** `%APPDATA%\Wonder World\user\worlds`
- **macOS:** `~/Library/Application Support/Wonder World/user/worlds`

(Running `npm run server` in dev still saves into the repo's `user/` folder.)

---

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| Build succeeds but the release has no installers | Tag didn't match `v<version>`. Delete the tag/release, fix `package.json`, re-tag. |
| Workflow fails immediately on `electron-builder` with a version error | `version` in `package.json` isn't valid semver. |
| `npm ci` fails in CI | `package-lock.json` is out of sync. Run `npm install` locally and commit the updated lock file. |
| macOS build fails trying to sign | Ensure `CSC_IDENTITY_AUTO_DISCOVERY: "false"` is still set in the workflow (it is, by default) if you have no certificate. |
| Want a custom app icon | Replace `build/icon.png` with a square PNG ≥ 1024×1024. |
