# Hosted authorization and OBS setup

## User setup

1. Open the signup page over HTTPS and enter the Spotify playlist URL or URI.
2. Authorize the Twitch broadcaster account and Spotify account.
3. After both providers show connected, choose Finish setup.
4. On the completion page, use COPY to retrieve the OBS Browser Source URL and paste it into OBS.

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
