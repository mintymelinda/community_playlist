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

Tags containing a prerelease suffix, such as `v0.3.0-rc.1`, are published as GitHub prereleases. The archive contains the static overlay (`overlay.html` and `src/`), the Node.js authorization service, Dockerfile, Compose file, public OAuth configuration template, README, and docs. It intentionally excludes tests, CI credentials, and local configuration.

The release job uses the repository-provided `GITHUB_TOKEN`; no additional release token or third-party publishing action is required.

## One-time GitHub setup

No additional repository secrets or variables are needed for publishing releases. Ensure GitHub Actions is enabled and that the workflow's token is allowed to create releases (the workflow requests `contents: write`).

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

The release contains two independently hosted components:

1. **Static OBS overlay:** enable GitHub Pages with GitHub Actions as the source in repository Settings → Pages. The Pages workflow publishes `overlay.html` and `src/` to the project Pages URL. This static host must remain available to OBS.
2. **Authorization service:** extract the release archive on the Docker host. Copy `.env.example` to `.env` and set the Twitch and Spotify public client IDs plus `OVERLAY_BASE_URL` if the default Pages URL is not correct. Register `https://YOUR-AUTH-HOST/oauth/spotify/callback` as the exact Spotify redirect URI. Put the service behind an HTTPS reverse proxy that preserves `X-Forwarded-Host` and `X-Forwarded-Proto`, then run `docker compose up -d --build`.

The authorization service stores refresh credentials in its encrypted persistent Docker volume and provisions an OBS URL after both accounts are authorized. End users do not edit Compose or local browser configuration. The OBS URL contains bearer credentials and must remain private. Once provisioned, the static overlay calls Twitch and Spotify directly; the authorization container can be stopped without interrupting the overlay.

No npm dependencies or build step are required. For a non-container local service run, use `npm run auth:serve` after creating `.env`. See [hosted authorization and OBS setup](authorization-and-obs-setup.md) for the complete operator and user instructions.

## Rollback

To roll back, deploy the previous version's ZIP and restore the matching static overlay and authorization service versions. Preserve the authorization Docker volume and OBS Browser Source local storage; do not clear browser storage as a routine rollback step because rotated provider refresh tokens and pending requests may be present. Inspect `communityPlaylist.status()` and Spotify playback before changing or clearing local state.
