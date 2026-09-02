import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread';
import {
  PROXY_RUN_CASE_ID,
  PROXY_RUN_EVAL_REVISION,
  PROXY_RUN_WORKFLOW_NAME,
  PROXY_RUN_WORKFLOW_VERSION,
  createProxyRunProjectionDefinition,
  createPresetProxyRunWorkflowRequest,
} from '../../wanxiang-workbench/src/proxy-run.mjs';

class NoopSubagents extends Service {
  constructor(ctx) {
    super(ctx, 'subagents');
  }

  getProvider(name) {
    return name === 'spawn' ? {} : undefined;
  }
}

test('preset proxy run executes on the real DSH worker-thread seam with unique run ids', async (t) => {
  const ctx = new Context();
  await ctx.plugin(NoopSubagents);
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn', disposeGraceMs: 1_000 });
  t.after(() => ctx.fiber.dispose());
  const parent = { id: 'session-contract', session: { header: { id: 'session-contract' } } };

  const runOnce = async () => {
    const run = ctx.workflowEngine.start(createPresetProxyRunWorkflowRequest(parent));
    const result = await run.result;
    await run.dispose();
    return { run, result };
  };
  const { run: first, result: firstResult } = await runOnce();
  const { run: second, result: secondResult } = await runOnce();

  assert.equal(first.meta.name, PROXY_RUN_WORKFLOW_NAME);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.stopReason, 'completed');
  assert.equal(firstResult.agentsStarted, 0);
  assert.equal(firstResult.value.status, 'passed');
  assert.equal(firstResult.value.summary, '代理运行通过');
  assert.ok(firstResult.value.assertions.every((item) => item.passed));
});

test('real DSH session projection registry folds durable run facts into one current value', async (t) => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  t.after(() => ctx.fiber.dispose());
  ctx.sessionProjections.register(createProxyRunProjectionDefinition());
  const session = ctx.sessions.create('session-projection-contract', { meta: { cwd: '/managed/project' } });
  const runId = 'run-projection-contract';

  session.append('tool-workflow/run-start', {
    runId,
    name: PROXY_RUN_WORKFLOW_NAME,
    projectId: 'project-contract',
    sessionId: session.id,
    caseId: PROXY_RUN_CASE_ID,
    workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
    evalRevision: PROXY_RUN_EVAL_REVISION,
    workBriefRevision: 3,
    startedAt: '2026-09-02T10:00:00.000Z',
  });
  assert.equal(ctx.sessionProjections.snapshot(session).values['wanxiang.proxy-run'].status, 'running');

  session.append('tool-workflow/run-end', {
    runId,
    stopReason: 'completed',
    status: 'passed',
    completedAt: '2026-09-02T10:00:01.000Z',
    evidence: { summary: '代理运行通过', assertions: [{ id: 'stable-output', passed: true }] },
  });
  const snapshot = ctx.sessionProjections.snapshot(session);

  assert.equal(snapshot.asOfSeq, 1);
  assert.equal(snapshot.values['wanxiang.proxy-run'].status, 'passed');
  assert.equal(snapshot.values['wanxiang.proxy-run'].latest.runId, runId);
  assert.equal(snapshot.values['wanxiang.proxy-run'].latest.projectId, 'project-contract');
  assert.equal(snapshot.values['wanxiang.proxy-run'].latest.sessionId, session.id);
});
