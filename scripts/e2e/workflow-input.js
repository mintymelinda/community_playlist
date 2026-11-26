import { readFile } from 'node:fs/promises';

async function readWorkflowEvent(eventPath, name) {
  if (!eventPath) {
    throw new Error('GitHub Actions event payload is unavailable; cannot read workflow_dispatch input ' + name + '.');
  }

  try {
    return JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    throw new Error('Could not read the GitHub Actions event payload for workflow_dispatch input ' + name + '.');
  }
}

export async function readOptionalWorkflowDispatchInput(name, eventPath = process.env.GITHUB_EVENT_PATH) {
  const event = await readWorkflowEvent(eventPath, name);
  return String(event?.inputs?.[name] ?? '').trim();
}

export async function readWorkflowDispatchInput(name, eventPath = process.env.GITHUB_EVENT_PATH) {
  const value = await readOptionalWorkflowDispatchInput(name, eventPath);
  if (!value) {
    throw new Error('Missing workflow_dispatch input ' + name + '.');
  }
  return value;
}
