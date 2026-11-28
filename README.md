# Community Playlist

Community Playlist lets viewers request songs through Twitch Custom Power-ups and have those tracks played on the broadcaster's Spotify account before the playlist continues.

## How to use it

1. Visit **[spotify.bigstorageparty.synology.me](https://spotify.bigstorageparty.synology.me)**.
2. Connect the Twitch account for the channel that will receive song requests.
3. Choose the channel's enabled, in-stock Custom Power-up that accepts viewer text. Viewers will enter a song request when redeeming it.
4. Connect the Spotify account that will provide the music, then finish setup.
5. Copy the OBS Browser Source URL shown on the completion page and add it to OBS as a **Browser Source**. Keep that source active while taking requests.

Start the Spotify playlist you want to use on an available Spotify Connect device before accepting requests. When a viewer redeems the selected Power-up with a song request, Community Playlist looks up the requested track and plays it. Requests are handled in the order received. When the request queue is empty, playback returns to the playlist.

The OBS Browser Source is intentionally invisible; it runs the controller in the background. The Spotify account handles audio playback.

## What you need

- A Twitch channel eligible to use Custom Power-ups (Twitch currently makes these available to Partners and Affiliates).
- An enabled, in-stock Custom Power-up that accepts viewer text.
- A Spotify Premium account with access to the playlist you want to play.
- OBS, with the generated URL added as a Browser Source.
- A Spotify Connect device available to play music.

## Moderation

Moderators and Broadcasters(the streamer) can use the following command
- `!skip` to skip any request or natural playlist item

## Keep your OBS URL private

The generated OBS URL contains authorization credentials for the connected Twitch and Spotify accounts. Treat it like a password. Do not post it publicly, share it with viewers, or include it in screenshots or support requests.

If the URL is exposed or you need to start over, use **Revoke access & start over** on the setup completion page. Follow the Spotify account-access link shown during revocation to disconnect the app from Spotify as well, then complete setup again.

## Legal

This service is provided as-is, without warranties or guarantees. The operator assumes no responsibility or liability for how this service is used. You are solely responsible for your use of the service, your accounts, your broadcasts, and compliance with all applicable laws and the terms and policies of Twitch and Spotify.

**Important Spotify restriction:** Spotify's Platform / Developer Terms specifically restrict using the Spotify Platform or API to create a streaming service. They also impose restrictions on broadcasting Spotify content and synchronizing sound recordings with visual media. This project does not grant permission or an exception to those restrictions. Before using it, review Spotify's current [Developer Terms](https://developer.spotify.com/terms) and [Developer Policy](https://developer.spotify.com/policy), and determine whether your intended use is permitted. Do not use the service in a way that violates Spotify's terms. You are responsible for obtaining any permissions or approvals required from Spotify.

Use of this service is at your own risk. Nothing in this README is legal advice or a representation that Spotify has approved this service.

## Thanks

Special thanks to **[@Vinny_Vega](https://github.com/Vinny_Vega)** for E2E/integration testing.
