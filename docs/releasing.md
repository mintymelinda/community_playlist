# Releases and deployment

## What the release workflow does

The release workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml). It runs when a version tag matching `v*` is pushed.

For each release it:

1. Runs `npm run verify` (JavaScript syntax checks and the complete automated test suite).
2. Requires the tag version to exactly match `package.json` (for example, tag `v0.2.0` requires package version `0.2.0`).
3. Packages the static application and its setup/technical documentation. There is no compile or bundling step and no production dependency installation.
4. Creates a GitHub Release with generated release notes and two assets:
   - `community-playlist-vX.Y.Z.zip`
   - `community-playlist-vX.Y.Z.zip.sha256`

Tags containing a prerelease suffix, such as `v0.3.0-rc.1`, are published as GitHub prereleases. The archive contains `index.html`, `config.example.js`, `src/`, `README.md`, and `docs/`. It intentionally excludes tests, CI credentials, local configuration, and the live E2E harness.

The release job uses the repository-provided `GITHUB_TOKEN`; no additional release token or third-party publishing action is required.

## One-time GitHub setup

No additional repository secrets or variables are needed for publishing releases. Ensure GitHub Actions is enabled and that the workflow's token is allowed to create releases (the workflow requests `contents: write`).

The live Twitch/Spotify E2E workflow has separate provider configuration. Its variables and the `SPOTIFY_PKCE_HANDOFF_KEY` secret are not needed by the release workflow. See [Live E2E through GitHub Actions](../README.md#live-e2e-through-github-actions) for those settings.

## Cut a release

1. Make and merge the release-ready changes into `main`. CI must be green.
2. Update the `version` field in `package.json` and commit that change to `main`. Use semantic versioning:
   - patch: backwards-compatible fixes;
   - minor: backwards-compatible functionality;
   - major: incompatible configuration or runtime changes.
3. Pull the final `main` commit locally and create a tag whose version exactly matches `package.json`:

   ```sh
   git checkout main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Open **Actions → Release** and follow the run. The workflow verifies, packages, and publishes the release automatically.
5. Confirm the GitHub Release contains both assets. Download the ZIP and checksum, then verify the archive before deploying:

   ```sh
   sha256sum --check community-playlist-vX.Y.Z.zip.sha256
   ```

Do not move a published version tag to different source. If a release run fails before publishing, fix the source and use a new version/tag after updating `package.json`. If the release was already created, publish a new patch version rather than silently replacing its assets.

## Deploy a release

Community Playlist is a static browser application. The release ZIP is already the deployable application; it does not need `npm install`, a build command, Node.js on the web server, or a backend process.

1. Extract the ZIP into a directory served by a static HTTPS web server. Preserve the `src/` directory structure.
2. Copy `config.example.js` to `config.local.js` in the same directory as `index.html`.
3. Edit `config.local.js` with the Twitch public client ID, Spotify OAuth client ID, exact Spotify redirect URI, playlist URI, and optional broadcaster/Power-up/device IDs.
4. Add the exact deployed `index.html` URL (including path and trailing slash) to the Spotify app's redirect URI allowlist. The value in `config.local.js` must match it exactly.
5. Ensure the static host serves JavaScript modules and `config.local.js` from the same origin. Do not expose a client secret or OAuth token in the configuration file.
6. Open the deployed page in the browser that will remain active, open its developer console, and run `communityPlaylist.start()`. Complete Spotify PKCE and Twitch Device Code authorization when prompted.
7. Start the configured playlist on the intended Spotify Connect device. Repeat must be off; shuffle may remain enabled when the upcoming queue identifies an unambiguous playlist continuation.

The application has no visible UI. Keep the browser tab active; closing or suspending it stops EventSub intake and playback polling. See the main [README setup and runtime instructions](../README.md#setup) before putting a release into use.

## Rollback

To roll back, deploy the previous version's ZIP and restore its matching `config.local.js` values. The browser's local queue and deduplication data are origin-scoped and may persist across deployments; do not clear browser storage as a routine rollback step because pending requests may be present. Inspect `communityPlaylist.status()` and Spotify playback before changing or clearing local state.
