// Copy this file to config.local.js and edit the values.
// config.local.js is intentionally ignored by Git.
export default {
  twitchClientId: "YOUR_TWITCH_PUBLIC_CLIENT_ID",
  spotifyClientId: "YOUR_SPOTIFY_CLIENT_ID",
  // Must exactly match the Spotify app redirect URI, including path and trailing slash.
  spotifyRedirectUri: "https://example.com/community-playlist/",
  // Optional: blank automatically follows the playlist already playing on Spotify.
  playlistUri: "",
  // Optional: leave empty only when exactly one enabled text-input Custom Power-up exists.
  powerUpId: "",
  // Optional: pin to one Connect device ID. Blank uses the currently active device.
  spotifyDeviceId: "",
  pollIntervalMs: 2000,
  maxPendingRequests: 100
};
