import test from 'node:test';
import assert from 'node:assert/strict';
import { findLatestOAuthVaultArtifact, OAUTH_VAULT_ARTIFACT_NAME } from '../scripts/e2e/find-oauth-vault-artifact.js';

function fakeFetch(body, status = 200) {
  return async (url, options) => {
    assert.equal(url.searchParams.get('name'), OAUTH_VAULT_ARTIFACT_NAME);
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  };
}

test('selects the newest non-expired vault from a previous workflow run', async () => {
  const result = await findLatestOAuthVaultArtifact({
    repository: 'owner/repo',
    token: 'test-token',
    fetchImpl: fakeFetch({
      artifacts: [
        { id: 1, name: OAUTH_VAULT_ARTIFACT_NAME, expired: true, created_at: '2026-01-03T00:00:00Z', workflow_run: { id: 100 } },
        { id: 2, name: OAUTH_VAULT_ARTIFACT_NAME, expired: false, created_at: '2026-01-02T00:00:00Z', workflow_run: { id: 200 } },
        { id: 3, name: OAUTH_VAULT_ARTIFACT_NAME, expired: false, created_at: '2026-01-04T00:00:00Z', workflow_run: { id: 300 } },
        { id: 4, name: OAUTH_VAULT_ARTIFACT_NAME, expired: false, created_at: '2026-01-01T00:00:00Z', workflow_run: { id: 50 } }
      ]
    })
  });
  assert.deepEqual(result, { runId: '300', artifactId: 3 });
});

test('returns null when no unexpired saved vault exists', async () => {
  const result = await findLatestOAuthVaultArtifact({
    repository: 'owner/repo',
    token: 'test-token',
    fetchImpl: fakeFetch({ artifacts: [] })
  });
  assert.equal(result, null);
});

test('fails clearly when Actions artifact permissions are unavailable', async () => {
  await assert.rejects(
    findLatestOAuthVaultArtifact({
      repository: 'owner/repo',
      token: 'test-token',
      currentRunId: '300',
      fetchImpl: fakeFetch({}, 403)
    }),
    /actions: read permission/
  );
});
