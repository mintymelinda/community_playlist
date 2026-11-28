import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

function collectJavaScript(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScript(path));
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(path);
    }
  }
  return files;
}

const files = collectJavaScript('.');
if (!files.length) throw new Error('No JavaScript files were found.');
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.info('Syntax checked ' + files.length + ' JavaScript files.');
