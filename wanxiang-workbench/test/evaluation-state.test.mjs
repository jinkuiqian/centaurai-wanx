import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EvaluationProjectStore,
  PROXY_RUN_CASE_ID,
} from '../src/evaluation-state.mjs';

test('evaluation project store exposes an editable deterministic Workflow and protected current Eval', async (t) => {
  const fixture = await evaluationFixture(t);

  const current = await fixture.store.load(fixture.project);

  assert.equal(current.workflow.workflowVersion, '1.0.0');
  assert.equal(current.workflow.interface.input, 'wanxiang.proxy-input/v1');
  assert.equal(current.workflow.interface.output, 'wanxiang.proxy-output/v1');
  assert.equal(current.eval.revision, 1);
  assert.equal(current.eval.cases[0].id, PROXY_RUN_CASE_ID);
  assert.match(await readFile(path.join(fixture.workspacePath, '.wanxiang', 'workflow.mjs'), 'utf8'), /process\.stdin/u);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(fixture.workspacePath, '.wanxiang', 'evals.json'), 'utf8')),
    current.evalState,
  );
});

test('editing the visible Eval cannot change the protected current acceptance revision', async (t) => {
  const fixture = await evaluationFixture(t);
  const initial = await fixture.store.load(fixture.project);
  const mirror = path.join(fixture.workspacePath, '.wanxiang', 'evals.json');
  const tampered = structuredClone(initial.evalState);
  tampered.revisions[0].cases[0].expected.itemCount = 0;
  await writeFile(mirror, JSON.stringify(tampered));

  const reloaded = await fixture.store.load(fixture.project);

  assert.equal(reloaded.eval.revision, 1);
  assert.equal(reloaded.eval.cases[0].expected.itemCount, 2);
  assert.equal(JSON.parse(await readFile(mirror, 'utf8')).revisions[0].cases[0].expected.itemCount, 2);
});

test('acceptance changes create a proposed revision that only explicit confirmation can activate', async (t) => {
  const fixture = await evaluationFixture(t);
  const initial = await fixture.store.load(fixture.project);
  const cases = structuredClone(initial.eval.cases);
  cases[0].expected.itemCount = 3;

  const proposed = await fixture.store.propose(fixture.project, { baseRevision: 1, cases });

  assert.equal(proposed.currentRevision, 1);
  assert.equal(proposed.revisions.at(-1).revision, 2);
  assert.equal(proposed.revisions.at(-1).status, 'proposed');
  assert.equal((await fixture.store.load(fixture.project)).eval.cases[0].expected.itemCount, 2);

  const confirmed = await fixture.store.confirm(fixture.project, { revision: 2 });

  assert.equal(confirmed.currentRevision, 2);
  assert.equal((await fixture.store.load(fixture.project)).eval.cases[0].expected.itemCount, 3);
});

test('Workflow manifest rejects alternate entrypoints, traversal and unsupported interfaces', async (t) => {
  const fixture = await evaluationFixture(t);
  await fixture.store.load(fixture.project);
  const manifestPath = path.join(fixture.workspacePath, '.wanxiang', 'workflow.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  for (const patch of [
    { entrypoint: '../outside.mjs' },
    { entrypoint: '/tmp/outside.mjs' },
    { entrypoint: 'alternate.mjs' },
    { interface: { input: 'arbitrary/v1', output: manifest.interface.output } },
  ]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, ...patch }));
    await assert.rejects(
      fixture.store.load(fixture.project),
      (error) => error.code === 'workflow_manifest_invalid',
    );
  }
});

test('evaluation loading rejects Workflow symlinks that escape the workspace', async (t) => {
  const fixture = await evaluationFixture(t);
  await fixture.store.load(fixture.project);
  const sourcePath = path.join(fixture.workspacePath, '.wanxiang', 'workflow.mjs');
  const outsidePath = path.join(path.dirname(fixture.workspacePath), 'outside.mjs');
  await writeFile(outsidePath, "process.stdout.write('{}')");
  await unlink(sourcePath);
  await symlink(outsidePath, sourcePath);

  await assert.rejects(
    fixture.store.load(fixture.project),
    (error) => error.code === 'workflow_entrypoint_invalid',
  );
});

async function evaluationFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-evaluation-'));
  const workspacePath = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EvaluationProjectStore({ dataRoot, createPendingId: () => 'test-id' });
  return {
    workspacePath,
    store,
    project: { workspaceId: 'workspace-1', workspacePath },
  };
}
