import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('music staging removes obsolete audio but preserves unrelated files', () => {
  const root = mkdtempSync(join(tmpdir(), 'copy-42b-'));
  try {
    const web = join(root, 'apps/web');
    const dest = join(web, 'public/42b');
    mkdirSync(join(web, 'scripts'), { recursive: true });
    mkdirSync(join(web, 'app/data'), { recursive: true });
    mkdirSync(dest, { recursive: true });
    copyFileSync(new URL('./copy-42b.mjs', import.meta.url), join(web, 'scripts/copy-42b.mjs'));
    const bytes = Buffer.from('current original');
    writeFileSync(join(root, 'current.m4a'), bytes);
    writeFileSync(join(web, 'app/data/music-library.json'), JSON.stringify([
      { file: 'current.m4a', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]));
    for (const file of ['Nahnahnahmah - Shalma.mp3', 'obsolete.m4a', 'notes.txt']) writeFileSync(join(dest, file), 'preserve only notes');
    const run = () => spawnSync(process.execPath, [join(web, 'scripts/copy-42b.mjs')], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(existsSync(join(dest, 'Nahnahnahmah - Shalma.mp3')), false);
    assert.equal(existsSync(join(dest, 'obsolete.m4a')), false);
    assert.equal(readFileSync(join(dest, 'notes.txt'), 'utf8'), 'preserve only notes');
    assert.deepEqual(readFileSync(join(dest, 'current.m4a')), bytes);
    assert.equal(run().status, 0, 'staging is repeatable');
    // Never prune on validation failure: leave the staging directory untouched.
    writeFileSync(join(dest, 'obsolete.mp3'), 'keep on failure');
    writeFileSync(join(root, 'current.m4a'), 'corrupted');
    assert.notEqual(run().status, 0);
    assert.equal(existsSync(join(dest, 'obsolete.mp3')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
