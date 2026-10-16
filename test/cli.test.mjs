import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (args, options = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });

test('CLI supports help and rejects malformed arguments', () => {
  assert.equal(run(['--help']).status, 0);
  for (const args of [
    [],
    ['--nope'],
    ['x.conf', '-o'],
    ['x.conf', '-o', '--json'],
    ['a.conf', 'b.conf'],
  ])
    assert.equal(run(args).status, 1);
});

test('stdin conversion keeps diagnostics separate from HOCON', () => {
  const result = run(['-'], { input: 'listener 1883\nallow_anonymous true' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('# Converted'));
  assert.match(result.stderr, /Warning \[/);
  assert.ok(!result.stdout.includes('Output written'));
});

test('CLI writes files, supports JSON, strict mode, includes and protects input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mosquitto-converter-test-'));
  try {
    const input = join(dir, 'mosquitto.conf');
    const output = join(dir, 'out.hocon');
    writeFileSync(input, 'allow_anonymous true\ninclude_dir conf.d');
    mkdirSync(join(dir, 'conf.d'));
    writeFileSync(join(dir, 'conf.d', 'B.conf'), 'listener 1884 127.0.0.1');
    writeFileSync(join(dir, 'conf.d', 'A.conf'), 'listener 1883 127.0.0.1');
    writeFileSync(join(dir, 'conf.d', 'ignored.txt'), 'not a config');
    assert.equal(run([input]).status, 1);
    const converted = run([
      input,
      '--include-dir',
      '--base-dir',
      dir,
      '--json',
    ]);
    assert.equal(converted.status, 0, converted.stderr);
    assert.equal(
      JSON.parse(converted.stdout).config.listeners.tcp.mosquitto_1.bind,
      '127.0.0.1:1883'
    );
    const strict = run([
      input,
      '--include-dir',
      '--base-dir',
      dir,
      '--strict',
      '-o',
      output,
    ]);
    assert.equal(strict.status, 2);
    assert.ok(!existsSync(output));
    assert.equal(
      run([input, '--include-dir', '--base-dir', dir, '-o', output]).status,
      0
    );
    assert.match(readFileSync(output, 'utf8'), /listeners/);
    assert.equal(run([input, '-o', input]).status, 1);
    assert.match(readFileSync(input, 'utf8'), /include_dir conf.d/);
    writeFileSync(input, `include_dir ${dir}`);
    assert.match(
      run([input, '--include-dir']).stderr,
      /must not contain the main/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
