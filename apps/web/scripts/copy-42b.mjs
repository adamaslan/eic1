// Copies the original 42b audio files from the repo root into the web app's public
// assets before build/dev, and verifies every file against the catalogue
// (name + byte length + sha256). Fails the build loudly on any mismatch.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = new URL('..', import.meta.url).pathname;      // apps/web/
const repoRoot = join(webRoot, '..', '..');
const destDir = join(webRoot, 'public', '42b');
const catalogue = JSON.parse(readFileSync(join(webRoot, 'app', 'data', 'music-library.json'), 'utf8'));

mkdirSync(destDir, { recursive: true });

const failures = [];
for (const track of catalogue) {
  const src = join(repoRoot, track.file);
  let buf;
  try {
    buf = readFileSync(src);
  } catch {
    failures.push(`${track.file}: missing at repo root`);
    continue;
  }
  if (buf.length !== track.bytes) {
    failures.push(`${track.file}: size ${buf.length} != catalogue ${track.bytes}`);
    continue;
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== track.sha256) {
    failures.push(`${track.file}: sha256 mismatch`);
    continue;
  }
  copyFileSync(src, join(destDir, track.file));
}

const copied = readdirSync(destDir).filter((f) => /\.(mp3|m4a)$/i.test(f));
if (copied.length !== catalogue.length) {
  failures.push(`expected ${catalogue.length} audio files in public/42b, found ${copied.length}`);
}

if (failures.length) {
  console.error('copy-42b failed:\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log(`copy-42b: verified and staged ${copied.length} original audio files into public/42b`);
