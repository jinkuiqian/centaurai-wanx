import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RestrictedWorkflowRunner } from '../src/restricted-runner.mjs';

test('restricted runner executes the fixed deterministic JSON interface with a filtered environment', async (t) => {
  const fixture = await runnerFixture(t, `
let body = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
process.stdout.write(JSON.stringify({ title: input.title }));
`);

  const output = await fixture.runner.run(fixture.request({ title: '客户跟进清单' }));

  assert.deepEqual(output, { title: '客户跟进清单' });
});

test('restricted runner returns structured failures for timeout, nonzero exit, malformed and oversized output', async (t) => {
  const cases = [
    ['while (true) {}', 'workflow_timeout', 100],
    ['process.exit(7);', 'workflow_nonzero_exit', 1_000],
    ["process.stdout.write('not json');", 'workflow_output_malformed', 1_000],
    ["process.stdout.write('x'.repeat(4096));", 'workflow_output_too_large', 1_000],
  ];
  for (const [source, code, timeoutMs] of cases) {
    const fixture = await runnerFixture(t, source, { timeoutMs, maxOutputBytes: 1024 });
    await assert.rejects(fixture.runner.run(fixture.request({})), (error) => error.code === code);
  }
});

test('restricted runner stops the child process and reports user cancellation explicitly', async (t) => {
  const fixture = await runnerFixture(t, 'while (true) {}', { timeoutMs: 2_000 });
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = fixture.runner.run({ ...fixture.request({}), signal: controller.signal });
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(running, (error) => error.code === 'workflow_cancelled');
  assert.ok(Date.now() - startedAt < 1_000);
});

test('restricted runner rejects network, credential, filesystem and process escape attempts before execution', async (t) => {
  for (const source of [
    "await fetch('https://example.com');",
    "await import('node:fs');",
    "require('node:fs');",
    'process.env.HOME;',
    "Bun.file('/etc/passwd');",
  ]) {
    const fixture = await runnerFixture(t, source);
    await assert.rejects(fixture.runner.run(fixture.request({})), (error) => error.code === 'workflow_capability_denied');
  }
});

async function runnerFixture(t, source, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-runner-'));
  const artifactRoot = path.join(root, '.wanxiang');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = new RestrictedWorkflowRunner(options);
  return {
    runner,
    request: (input) => ({
      workspacePath: root,
      entrypoint: 'workflow.mjs',
      source,
      input,
    }),
  };
}
