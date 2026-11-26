import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOptionalWorkflowDispatchInput, readWorkflowDispatchInput } from '../scripts/e2e/workflow-input.js';

test('reads workflow_dispatch input from the event payload without an environment variable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'community-playlist-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  const callbackUrl = 'http://127.0.0.1:4173/?code=one-time-code&state=matching-state';
  await writeFile(eventPath, JSON.stringify({
    inputs: { spotify_callback_url: callbackUrl }
  }));

  assert.equal(await readWorkflowDispatchInput('spotify_callback_url', eventPath), callbackUrl);
});

test('reads an optional workflow_dispatch input as an empty string when it is absent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'community-playlist-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({ inputs: {} }));
  assert.equal(await readOptionalWorkflowDispatchInput('spotify_callback_url', eventPath), '');
});

test('rejects a missing required workflow_dispatch input without exposing other event data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'community-playlist-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({
    inputs: {},
    secretLikeValue: 'must-not-appear-in-errors'
  }));

  await assert.rejects(
    readWorkflowDispatchInput('spotify_callback_url', eventPath),
    error => {
      assert.match(error.message, /Missing workflow_dispatch input spotify_callback_url/);
      assert.doesNotMatch(error.message, /must-not-appear-in-errors/);
      return true;
    }
  );
});
