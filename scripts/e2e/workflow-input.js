import { readFile } from 'node:fs/promises';

export async function readWorkflowDispatchInput(name, eventPath = process.env.GITHUB_EVENT_PATH) {
  if (!eventPath) {
    throw new Error('GitHub Actions event payload is unavailable; cannot read workflow_dispatch input ' + name + '.');
  }

  let event;
  try {
    event = JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    throw new Error('Could not read the GitHub Actions event payload for workflow_dispatch input ' + name + '.');
  }

  const value = String(event?.inputs?.[name] ?? '').trim();
  if (!value) {
    throw new Error('Missing workflow_dispatch input ' + name + '.');
  }
  return value;
}
