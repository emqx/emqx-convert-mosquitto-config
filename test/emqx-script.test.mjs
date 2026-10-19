import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(
  new URL('../scripts/test-emqx.sh', import.meta.url)
);

// Exercise shell orchestration with the real converter, without requiring
// Docker in the unit suite. Real loading/comparison is covered by test:emqx.
function run(
  t,
  { fail = '', stdin = false, invalid = false, restart = false } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'emqx-runner-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const callsPath = join(directory, 'calls.jsonl');
  const input = invalid
    ? 'listener invalid\n'
    : 'listener 1883\nallow_anonymous true\nmax_inflight_messages 17\n';
  writeFileSync(join(directory, 'input with spaces.conf'), input);
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_DOCKER_CALLS, JSON.stringify(args) + '\\n');
const command = args.join(' ');
let stage;
if (args[0] === 'run') stage = 'start';
else if (args[0] === 'restart') stage = 'restart';
else if (command.includes('check_config')) stage = 'check';
else if (command.includes('conf load') && command.includes('dependencies.hocon')) stage = 'dependencies';
else if (command.includes('conf load')) stage = 'load';
else if (command.includes('verify-emqx.escript compare')) stage = 'verify';
if (stage && stage === process.env.TEST_DOCKER_FAIL) process.exit(42);
if (command.includes('verify-emqx.escript dependencies')) console.log('mqtt { max_inflight = 17 }');
if (command.includes('verify-emqx.escript keys')) console.log('mqtt');
if (command.includes('conf show mqtt')) console.log('mqtt { max_inflight = 17 }');
if (stage === 'verify') console.log('Verified generated values.');
`,
    { mode: 0o755 }
  );
  // Explicit module type also works on the minimum supported Node 22 version.
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const result = spawnSync(
    'bash',
    [
      script,
      ...(restart ? ['--restart'] : []),
      ...(stdin === '-' ? ['-'] : stdin ? [] : ['input with spaces.conf']),
    ],
    {
      cwd: directory,
      input: stdin ? input : undefined,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TEST_DOCKER_CALLS: callsPath,
        TEST_DOCKER_FAIL: fail,
      },
    }
  );
  assert.ifError(result.error);
  const artifacts = /Artifacts: (.+)/.exec(result.stdout + result.stderr)?.[1];
  assert.ok(artifacts, result.stdout + result.stderr);
  t.after(() => rmSync(artifacts, { recursive: true, force: true }));
  let calls = [];
  try {
    calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    ...result,
    calls,
    commands: calls.map((args) => args.join(' ')),
    artifacts,
  };
}

for (const stdin of [false, true, '-']) {
  test(`EMQX runner accepts ${stdin === '-' ? 'explicit - stdin' : stdin ? 'stdin' : 'a relative file with spaces from another cwd'}`, (t) => {
    const result = run(t, { stdin });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS:/);
    assert.match(
      readFileSync(join(result.artifacts, 'generated.hocon'), 'utf8'),
      /max_inflight = 17/
    );
    const commands = result.commands;
    const index = (pattern) =>
      commands.findIndex((command) => pattern.test(command));
    assert.ok(index(/check_config/) < index(/conf load .*dependencies.hocon/));
    assert.ok(
      index(/conf load .*dependencies.hocon/) <
        index(/conf load .*generated.hocon/)
    );
    assert.ok(index(/conf load .*generated.hocon/) < index(/conf show mqtt/));
    assert.ok(index(/conf show mqtt/) < index(/verify-emqx.escript compare/));
    assert.ok(commands.at(-1).startsWith('rm -f '));
    const start = result.calls.find((args) => args[0] === 'run');
    assert.ok(!start.includes('--entrypoint'));
    assert.ok(!start.includes('-p'));
    assert.ok(!start.includes('--publish'));
  });
}

test('conversion failure stops before Docker is touched', (t) => {
  const result = run(t, { invalid: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FAILED at conversion/);
  assert.deepEqual(result.calls, []);
});

test('explicit restart mode validates first, restarts, then verifies runtime values', (t) => {
  const result = run(t, { restart: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restart load/);
  assert.ok(!result.commands.some((command) => command.includes('conf load')));
  const index = (pattern) =>
    result.commands.findIndex((command) => pattern.test(command));
  assert.ok(index(/check_config/) < index(/^restart /));
  assert.ok(index(/^restart /) < index(/conf show mqtt/));
  assert.ok(index(/conf show mqtt/) < index(/verify-emqx.escript compare/));
});

test('restart failure stops before runtime verification', (t) => {
  const result = run(t, { restart: true, fail: 'restart' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FAILED at config restart/);
  assert.ok(
    !result.commands.some((command) =>
      /conf show|verify-emqx.escript compare/.test(command)
    )
  );
  assert.ok(result.commands.at(-1).startsWith('rm -f '));
});

for (const [fail, forbidden] of [
  ['start', /check_config|conf load|conf show/],
  ['check', /conf load|conf show|verify-emqx.escript compare/],
  [
    'dependencies',
    /conf load .*generated.hocon|conf show|verify-emqx.escript compare/,
  ],
  ['load', /conf show|verify-emqx.escript compare/],
  ['verify', /never-match/],
]) {
  test(`EMQX runner stops on ${fail} failure and reports failure`, (t) => {
    const result = run(t, { fail });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /PASS:/);
    assert.match(result.stderr, /FAILED at/);
    assert.ok(!result.commands.some((command) => forbidden.test(command)));
    assert.ok(
      !result.commands.some((command) => command.startsWith('restart '))
    );
    assert.ok(result.commands.at(-1).startsWith('rm -f '));
  });
}
