import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';

const filename = 'content/tracker.js';
const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8');
const start = /  init\(\)\.catch\([^\r\n]+;\r?\n(?=\}\)\(\);\s*$)/;

// Return the bindings the test needs without starting the browser lifecycle.
export function loadTracker(context, names) {
  if (!start.test(source)) throw new Error(`Could not find the startup call in ${filename}`);
  const instrumented = source.replace(start, `  return { ${names.join(', ')} };\n`);
  return runInContext(instrumented, context, { filename });
}
