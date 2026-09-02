import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EvaluationProjectStore,
  DEFAULT_PROXY_RUN_CASE_ID,
  PROXY_RUN_CASE_IDS,
} from '../src/evaluation-state.mjs';

test('evaluation project store exposes five transparent customer follow-up fixtures with a fixed clock', async (t) => {
  const fixture = await evaluationFixture(t);

  const current = await fixture.store.load(fixture.project);

  assert.equal(current.workflow.workflowVersion, '2.0.0');
  assert.equal(current.workflow.interface.input, 'wanxiang.proxy-input/v1');
  assert.equal(current.workflow.interface.output, 'wanxiang.proxy-output/v1');
  assert.equal(current.eval.revision, 1);
  assert.equal(current.eval.cases[0].id, DEFAULT_PROXY_RUN_CASE_ID);
  assert.deepEqual(current.eval.cases.map(({ id }) => id), PROXY_RUN_CASE_IDS);
  assert.equal(current.eval.cases.filter(({ kind }) => kind === 'boundary').length, 2);
  assert.deepEqual(current.eval.cases.map(({ title }) => title), [
    '正常客户',
    '超过 14 天未跟进',
    '无沟通记录',
    '高意向但无下一步',
    '缺少负责人',
  ]);
  for (const evalCase of current.eval.cases) {
    assert.equal(evalCase.input.asOf, '2026-09-01');
    assert.match(evalCase.input.customersCsv, /^customer_id,name,intent,next_step,owner/mu);
    assert.ok(Array.isArray(JSON.parse(evalCase.input.communicationsJson)));
    assert.ok(Array.isArray(evalCase.expected.missingFollowUps));
    assert.deepEqual(Object.keys(evalCase.expected.markdown), [
      'requiredSections',
      'customerReferences',
      'evidenceReferences',
    ]);
  }
  assert.deepEqual(current.eval.cases.slice(1).map(({ expected }) => expected.missingFollowUps[0].reasonCodes), [
    ['OVERDUE_FOLLOW_UP'],
    ['NO_COMMUNICATION'],
    ['HIGH_INTENT_NO_NEXT_STEP'],
    ['MISSING_OWNER'],
  ]);
  assert.match(await readFile(path.join(fixture.workspacePath, '.wanxiang', 'workflow.mjs'), 'utf8'), /process\.stdin/u);
  assert.match(await readFile(path.join(fixture.workspacePath, '.wanxiang', 'workflow.mjs'), 'utf8'), /missingFollowUps/u);
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
  tampered.revisions[0].cases[1].expected.missingFollowUps = [];
  await writeFile(mirror, JSON.stringify(tampered));

  const reloaded = await fixture.store.load(fixture.project);

  assert.equal(reloaded.eval.revision, 1);
  assert.equal(reloaded.eval.cases[1].expected.missingFollowUps.length, 1);
  assert.equal(JSON.parse(await readFile(mirror, 'utf8')).revisions[0].cases[1].expected.missingFollowUps.length, 1);
});

test('loading upgrades the untouched legacy single-case fixture without replacing user Workflow edits', async (t) => {
  const fixture = await evaluationFixture(t);
  await fixture.store.load(fixture.project);
  const artifactRoot = path.join(fixture.workspacePath, '.wanxiang');
  const canonical = path.join(
    fixture.dataRoot,
    'evaluations',
    `${createHash('sha256').update(fixture.project.workspaceId).digest('hex')}.json`,
  );
  const legacyWorkflow = `let body = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
const output = {
  title: input.title,
  itemCount: input.items.length,
  labels: input.items.map((item) => item.label).sort(),
};
process.stdout.write(JSON.stringify(output));
`;
  await writeFile(path.join(artifactRoot, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 1,
    workflowVersion: '1.0.0',
    entrypoint: 'workflow.mjs',
    interface: { input: 'wanxiang.proxy-input/v1', output: 'wanxiang.proxy-output/v1' },
  }, null, 2)}\n`);
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), legacyWorkflow);
  await writeFile(canonical, `${JSON.stringify({
    schemaVersion: 1,
    currentRevision: 1,
    revisions: [{
      revision: 1,
      status: 'confirmed',
      cases: [{
        id: 'preset-proxy-run-v1',
        kind: 'normal',
        input: { title: '客户跟进清单', items: [{ label: '待回复' }, { label: '已安排' }] },
        expected: { title: '客户跟进清单', itemCount: 2, labels: ['已安排', '待回复'] },
      }],
    }],
  }, null, 2)}\n`);

  const upgraded = await fixture.store.load(fixture.project);

  assert.equal(upgraded.workflow.workflowVersion, '2.0.0');
  assert.deepEqual(upgraded.eval.cases.map(({ id }) => id), PROXY_RUN_CASE_IDS);
  assert.match(upgraded.source, /missingFollowUps/u);

  await writeFile(path.join(artifactRoot, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 1,
    workflowVersion: '1.0.0',
    entrypoint: 'workflow.mjs',
    interface: { input: 'wanxiang.proxy-input/v1', output: 'wanxiang.proxy-output/v1' },
  }, null, 2)}\n`);
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), `${legacyWorkflow}// 用户修改\n`);
  const preserved = await fixture.store.load(fixture.project);
  assert.equal(preserved.workflow.workflowVersion, '1.0.0');
  assert.match(preserved.source, /用户修改/u);
});

test('acceptance changes create a proposed revision that only explicit confirmation can activate', async (t) => {
  const fixture = await evaluationFixture(t);
  const initial = await fixture.store.load(fixture.project);
  const cases = structuredClone(initial.eval.cases);
  cases[0].expected.markdown.customerReferences.push('新增客户');

  const proposed = await fixture.store.propose(fixture.project, { baseRevision: 1, cases });

  assert.equal(proposed.currentRevision, 1);
  assert.equal(proposed.revisions.at(-1).revision, 2);
  assert.equal(proposed.revisions.at(-1).status, 'proposed');
  assert.equal((await fixture.store.load(fixture.project)).eval.cases[0].expected.markdown.customerReferences.length, 1);

  const confirmed = await fixture.store.confirm(fixture.project, { revision: 2 });

  assert.equal(confirmed.currentRevision, 2);
  assert.equal((await fixture.store.load(fixture.project)).eval.cases[0].expected.markdown.customerReferences.length, 2);
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
    dataRoot,
    store,
    project: { workspaceId: 'workspace-1', workspacePath },
  };
}
