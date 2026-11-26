import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PURPOSE = 'community-playlist-e2e-oauth-vault-v1';
const AUTHENTICATED_DATA = Buffer.from(PURPOSE, 'utf8');

function encryptionKey(value) {
  const key = Buffer.from(String(value || '').trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('SPOTIFY_PKCE_HANDOFF_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

function validateCredential(credential, provider) {
  if (!credential || typeof credential !== 'object') {
    throw new Error('OAuth vault is missing the ' + provider + ' credential.');
  }
  if (typeof credential.refreshToken !== 'string' || !credential.refreshToken) {
    throw new Error('OAuth vault is missing the ' + provider + ' refresh token.');
  }
  if (!Array.isArray(credential.scopes) || credential.scopes.some(scope => typeof scope !== 'string')) {
    throw new Error('OAuth vault has invalid ' + provider + ' scopes.');
  }

  const result = {
    refreshToken: credential.refreshToken,
    scopes: [...new Set(credential.scopes)]
  };
  if (provider.toLowerCase() === 'twitch' && credential.userId !== undefined) {
    result.userId = String(credential.userId);
  }
  return result;
}

function validateVault(vault) {
  if (!vault || typeof vault !== 'object' || vault.version !== 1) {
    throw new Error('Encrypted OAuth vault payload is missing or has an unsupported version.');
  }
  const spotify = vault.spotify ? validateCredential(vault.spotify, 'Spotify') : null;
  const twitch = vault.twitch ? validateCredential(vault.twitch, 'Twitch') : null;
  if (!spotify && !twitch) {
    throw new Error('OAuth vault must contain at least one provider refresh token.');
  }
  return {
    version: 1,
    updatedAt: Number.isFinite(vault.updatedAt) ? vault.updatedAt : Date.now(),
    spotify,
    twitch
  };
}

export function encryptOAuthVault(vault, keyValue) {
  const key = encryptionKey(keyValue);
  const payload = validateVault(vault);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AUTHENTICATED_DATA);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);

  return {
    version: 1,
    purpose: PURPOSE,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  };
}

export function decryptOAuthVault(envelope, keyValue) {
  const key = encryptionKey(keyValue);
  if (
    !envelope ||
    envelope.version !== 1 ||
    envelope.purpose !== PURPOSE ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.data
  ) {
    throw new Error('Encrypted OAuth vault artifact is missing or invalid.');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(AUTHENTICATED_DATA);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
    return validateVault(JSON.parse(plaintext));
  } catch (error) {
    if (error.message.includes('OAuth vault') || error.message.includes('SPOTIFY_PKCE_HANDOFF_KEY')) {
      throw error;
    }
    throw new Error('Could not decrypt the OAuth vault artifact. Check SPOTIFY_PKCE_HANDOFF_KEY.');
  }
}
