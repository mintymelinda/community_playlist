import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OAUTH_VAULT_ARTIFACT_NAME = 'community-playlist-oauth-vault';

export async function findLatestOAuthVaultArtifact({
  repository,
  token,
  currentRunId,
  fetchImpl = fetch
}) {
  if (!repository || !token) {
    throw new Error('GitHub repository and Actions token are required to find the OAuth vault artifact.');
  }
  const url = new URL('https://api.github.com/repos/' + repository + '/actions/artifacts');
  url.searchParams.set('name', OAUTH_VAULT_ARTIFACT_NAME);
  url.searchParams.set('per_page', '100');
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) {
    throw new Error('Could not list GitHub Actions artifacts (HTTP ' + response.status + '). Check the workflow actions: read permission.');
  }

  const body = await response.json();
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
  const latest = artifacts
    .filter(artifact =>
      artifact.name === OAUTH_VAULT_ARTIFACT_NAME &&
      artifact.expired !== true &&
      artifact.workflow_run?.id &&
      String(artifact.workflow_run.id) !== String(currentRunId)
    )
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];

  return latest ? {
    runId: String(latest.workflow_run.id),
    artifactId: Number(latest.id)
  } : null;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const currentRunId = process.env.GITHUB_RUN_ID;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is unavailable.');

  const artifact = await findLatestOAuthVaultArtifact({ repository, token, currentRunId });
  const output = artifact
    ? 'found=true\nrun_id=' + artifact.runId + '\n'
    : 'found=false\nrun_id=\n';
  await appendFile(outputPath, output);
  console.info(artifact
    ? '[community-playlist:ci] Found a saved encrypted OAuth vault from workflow run ' + artifact.runId + '.'
    : '[community-playlist:ci] No saved OAuth vault found; one-time provider authorization is required.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error('[community-playlist:ci] Could not locate OAuth vault: ' + error.message);
    process.exitCode = 1;
  });
}
