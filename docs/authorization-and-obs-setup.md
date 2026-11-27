# Hosted authorization and OBS setup

## User setup

1. Open the signup page over HTTPS.
2. Authorize the Twitch broadcaster account. Setup loads that broadcaster's Custom Power-ups from Twitch.
3. Select the enabled, in-stock Custom Power-up that requires viewer text input and should be used for song requests. The selection is saved by Twitch Power-up ID, not by its display name. Use Refresh list if you change Power-ups in Twitch while setup is open.
4. Authorize the Spotify account. After both providers are connected and a Power-up is selected, choose Finish setup.
5. On the completion page, use COPY to retrieve the OBS Browser Source URL and paste it into OBS.

The broadcaster does not provide a playlist URL. At runtime, the controller discovers the playlist already playing on the active Spotify Connect device and returns to that playlist after viewer requests. Start the playlist you want to use before accepting requests.

**Do not share the OBS URL publicly.** It contains both providers' refresh credentials in its URL fragment. Anyone who obtains it can act on the connected accounts within the granted scopes. Treat it like a password.

## Runtime separation

The Node.js/Docker service handles signup, OAuth callbacks, and encrypted server-side authorization storage only. The generated Browser Source points to a separately hosted static overlay. The URL fragment is not sent in HTTP requests. The overlay must read the fragment, remove it from the address bar, store tokens in browser local storage, and refresh credentials directly with Twitch and Spotify. The Docker service can be stopped after setup without interrupting an already provisioned overlay.

## One-time operator setup

Register a Twitch public OAuth application and a Spotify application. Configure their public client IDs in the service's .env file using .env.example as a template. These IDs are public values, not client secrets. No provider client secret is used. Register the exact Spotify redirect URI https://YOUR-AUTH-HOST/oauth/spotify/callback in the Spotify app. Put the service behind an HTTPS reverse proxy that forwards X-Forwarded-Host and X-Forwarded-Proto.

Enable GitHub Pages with GitHub Actions as the source in repository Settings → Pages. The pages.yml workflow publishes only overlay.html and src/ to the independent static host. OVERLAY_BASE_URL must point to that static overlay.html URL. The OAuth client IDs and overlay URL are service-level public configuration, not per-user secrets. Users do not edit Compose or provide secrets.

Copy .env.example to .env and enter the two public client IDs. Run docker compose up -d --build. The service creates a persistent Docker volume containing vault.key and authorizations.enc on first start. Back up the entire community-playlist-auth-data volume; losing the key makes the vault unreadable.

## Security notes

- Server-side refresh credentials are encrypted with AES-256-GCM at rest.
- The generated OBS URL is a bearer credential. Clipboard history, OBS settings exports, screenshots, browser sync, or accidental sharing can expose it.
- The overlay must refresh directly with provider APIs and store rotated tokens locally. Clearing Browser Source storage after token rotation can require reauthorization.
- Revoke provider access in Twitch and Spotify if the URL is exposed. Account management and automated URL rotation are not included in this initial flow.
