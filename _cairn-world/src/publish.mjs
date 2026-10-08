// Copy the built site into the folder GitHub Pages serves.
//
//   npm run publish-pages [-- --to <dir>]      (default: ../world, i.e. <repo>/world/)
//
// With branch-based Pages and the Jekyll rules site at the repo root, anything in a plain folder
// is served as static files, so dist/ lands at <site>/world/. Run `npm run build` first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toIdx = process.argv.indexOf('--to');
const TARGET = path.resolve(toIdx > 0 ? process.argv[toIdx + 1] : path.join(ROOT, '..', 'world'));
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(path.join(DIST, 'explorer', 'app.js'))) {
  console.error('dist/ is missing or incomplete; run `npm run build` first.');
  process.exit(1);
}
// Never wipe something that is not a previous publish of ours.
if (fs.existsSync(TARGET) && !fs.existsSync(path.join(TARGET, 'explorer', 'app.js'))) {
  console.error(`${TARGET} exists and does not look like a previous publish; refusing to overwrite it.`);
  process.exit(1);
}
fs.rmSync(TARGET, { recursive: true, force: true });
fs.cpSync(DIST, TARGET, { recursive: true });
console.log(`published dist/ -> ${path.relative(process.cwd(), TARGET) || '.'}`);
