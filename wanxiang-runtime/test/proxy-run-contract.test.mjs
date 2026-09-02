import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread';
import {
  DEFAULT_PROXY_RUN_CASE_ID,
  PROXY_RUN_EVAL_REVISION,
  PROXY_RUN_WORKFLOW_NAME,
  PROXY_RUN_WORKFLOW_VERSION,
  RunEvidenceStore,
  createProxyRunProjectionDefinition,
  createProxyRunToolAdapter,
  createPresetProxyRunWorkflowRequest,
} from '../../wanxiang-workbench/src/proxy-run.mjs';
import { EvaluationProjectStore } from '../../wanxiang-workbench/src/evaluation-state.mjs';
import { WanxiangStateService } from '../../wanxiang-workbench/src/project-state.mjs';
import { RestrictedWorkflowRunner } from '../../wanxiang-workbench/src/restricted-runner.mjs';

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
    caseId: DEFAULT_PROXY_RUN_CASE_ID,
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

test('one runId cross-locates protected project state, immutable evidence and real DSH session facts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-run-lineage-contract-'));
  const workspacePath = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  await mkdir(workspacePath, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = { id: 'project-lineage', path: workspacePath, title: '谱系项目', sessionIds: [] };
  const registry = {
    get(id) { return id === workspace.id ? workspace : undefined; },
    list() { return [workspace]; },
    async resolveByPath(value) { return value === workspacePath ? workspace : undefined; },
  };
  const projectState = new WanxiangStateService({
    workspaceRegistry: registry, projectsRoot: root, dataRoot, id: () => 'pending-id',
  });
  await projectState.getProject(workspace.id);

  const ctx = new Context();
  await ctx.plugin(NoopSubagents);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn', disposeGraceMs: 1_000 });
  t.after(() => ctx.fiber.dispose());
  ctx.sessionProjections.register(createProxyRunProjectionDefinition());
  const session = ctx.sessions.create('session-lineage', { meta: { cwd: workspacePath } });
  const agent = { id: session.id, session };
  const activeState = { brief: { revision: 7 }, work: { sessionId: session.id, activeRevision: 7 } };
  const evaluationStore = new EvaluationProjectStore({ dataRoot });
  const tool = createProxyRunToolAdapter({
    projectService: {
      async contextForAgent() {
        return { workspaceId: workspace.id, workspacePath, state: activeState };
      },
      startEvaluationRun: (...args) => projectState.startEvaluationRun(...args),
      finishEvaluationRun: (...args) => projectState.finishEvaluationRun(...args),
    },
    evaluationStore,
    runner: new RestrictedWorkflowRunner(),
    workflowEngine: ctx.workflowEngine,
    evidenceStore: new RunEvidenceStore({ dataRoot }),
    flushSession: async () => {},
    createRunId: () => 'run-cross-located',
    now: () => '2026-09-02T10:00:00.000Z',
  });

  const result = await tool.execute(
    { caseId: DEFAULT_PROXY_RUN_CASE_ID },
    { agent, signal: new AbortController().signal },
  );
  const project = await projectState.getProject(workspace.id);
  const projection = ctx.sessionProjections.snapshot(session).values['wanxiang.proxy-run'];

  assert.equal(result.runId, 'run-cross-located');
  assert.equal(project.runs.byId[result.runId].status, 'passed');
  assert.equal(project.runs.byId[result.runId].sessionId, session.id);
  assert.equal(projection.runs[result.runId].projectId, workspace.id);
  assert.equal(projection.runs[result.runId].sessionId, session.id);
});

test('customer follow-up proxy slice runs all five protected cases with stable structured judgments', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-follow-up-contract-'));
  const workspacePath = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(NoopSubagents);
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn', disposeGraceMs: 1_000 });
  t.after(() => ctx.fiber.dispose());
  const evaluationStore = new EvaluationProjectStore({ dataRoot });
  const evaluation = await evaluationStore.load({ workspaceId: 'project-1', workspacePath });
  const agent = {
    id: 'session-contract',
    session: { header: { cwd: workspacePath }, append() {} },
  };
  const state = { brief: { revision: 4 }, work: { sessionId: agent.id, activeRevision: 4 } };
  let nextRunId = 0;
  const tool = createProxyRunToolAdapter({
    projectService: {
      async contextForAgent() { return { workspaceId: 'project-1', workspacePath, state }; },
      async startEvaluationRun() {},
      async finishEvaluationRun() {},
    },
    evaluationStore,
    runner: new RestrictedWorkflowRunner(),
    workflowEngine: ctx.workflowEngine,
    evidenceStore: { async save() {} },
    flushSession: async () => {},
    createRunId: () => `follow-up-run-${++nextRunId}`,
    now: () => '2026-09-02T10:00:00.000Z',
  });

  const firstBatch = await tool.execute({}, { agent, signal: new AbortController().signal });
  assert.equal(firstBatch.status, 'passed');
  assert.equal(firstBatch.results.length, 5);
  const firstPass = [];
  for (const [index, evalCase] of evaluation.eval.cases.entries()) {
    const result = firstBatch.results[index];
    assert.equal(result.caseId, evalCase.id);
    assert.equal(result.status, 'passed', evalCase.title);
    assert.deepEqual(result.output.missingFollowUps, evalCase.expected.missingFollowUps);
    for (const fragment of Object.values(evalCase.expected.markdown).flat()) {
      assert.match(result.output.reportMarkdown, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }
    firstPass.push(result.output.missingFollowUps);
  }

  const secondBatch = await tool.execute({}, { agent, signal: new AbortController().signal });
  const secondPass = secondBatch.results.map((result) => result.output.missingFollowUps);
  assert.deepEqual(secondPass, firstPass);
});

test('the evaluation tool reruns an Agent-modified Workflow against the same protected Eval', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-tool-contract-'));
  const workspacePath = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(NoopSubagents);
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn', disposeGraceMs: 1_000 });
  t.after(() => ctx.fiber.dispose());
  const evaluationStore = new EvaluationProjectStore({ dataRoot });
  await evaluationStore.load({ workspaceId: 'project-1', workspacePath });
  const manifestPath = path.join(workspacePath, '.wanxiang', 'workflow.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, workflowVersion: '1.1.0' }, null, 2)}\n`);
  const workflowPath = path.join(workspacePath, '.wanxiang', 'workflow.mjs');
  const source = await readFile(workflowPath, 'utf8');
  await writeFile(workflowPath, source.replace(
    'const output = { reportMarkdown:',
    "lines.unshift('由 Agent 修改的 Workflow');\nconst output = { reportMarkdown:",
  ));
  const events = [];
  const agent = {
    id: 'session-contract',
    session: { header: { cwd: workspacePath }, append(type, data) { events.push({ type, data }); } },
  };
  const state = { brief: { revision: 4 }, work: { sessionId: agent.id, activeRevision: 4 } };
  const evidence = [];
  const tool = createProxyRunToolAdapter({
    projectService: {
      async contextForAgent() { return { workspaceId: 'project-1', workspacePath, state }; },
      async startEvaluationRun() {},
      async finishEvaluationRun() {},
    },
    evaluationStore,
    runner: new RestrictedWorkflowRunner(),
    workflowEngine: ctx.workflowEngine,
    evidenceStore: { async save(value) { evidence.push(value); } },
    flushSession: async () => {},
    createRunId: () => 'modified-run',
  });

  const result = await tool.execute({ caseId: DEFAULT_PROXY_RUN_CASE_ID }, { agent, signal: new AbortController().signal });

  assert.equal(result.status, 'passed');
  assert.equal(result.workflowVersion, '1.1.0');
  assert.equal(result.evalRevision, 1);
  assert.match(result.output.reportMarkdown, /^由 Agent 修改的 Workflow/u);
  assert.deepEqual(events.map((event) => event.type), ['tool-workflow/run-start', 'tool-workflow/run-end']);
  assert.equal(evidence[0].runId, 'modified-run');
});
