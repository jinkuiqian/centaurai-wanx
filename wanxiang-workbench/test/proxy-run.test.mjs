import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_PROXY_RUN_CASE_ID,
  PROXY_RUN_CASE_IDS,
  PROXY_RUN_EVAL_REVISION,
  PROXY_RUN_TOOL_NAME,
  PROXY_RUN_WORKFLOW_NAME,
  PROXY_RUN_WORKFLOW_VERSION,
  RunEvidenceStore,
  applyProxyRunEvent,
  createProxyRunProjectionDefinition,
  createProxyRunToolAdapter,
  initialProxyRunProjection,
} from '../src/proxy-run.mjs';

test('DSH projection folds the preset proxy-run workflow facts into current session state', () => {
  const started = {
    type: 'tool-workflow/run-start',
    data: {
      runId: 'run-1',
      name: PROXY_RUN_WORKFLOW_NAME,
      projectId: 'project-1',
      sessionId: 'session-1',
      caseId: DEFAULT_PROXY_RUN_CASE_ID,
      workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
      evalRevision: PROXY_RUN_EVAL_REVISION,
      workBriefRevision: 7,
      startedAt: '2026-09-02T10:00:00.000Z',
    },
  };
  const running = applyProxyRunEvent(initialProxyRunProjection(), started);

  assert.deepEqual(running, {
    status: 'running',
    runCount: 1,
    latest: {
      runId: 'run-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      caseId: DEFAULT_PROXY_RUN_CASE_ID,
      workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
      evalRevision: PROXY_RUN_EVAL_REVISION,
      workBriefRevision: 7,
      retryOf: null,
      status: 'running',
      startedAt: '2026-09-02T10:00:00.000Z',
      completedAt: null,
      conclusion: null,
      evidence: null,
    },
    cases: {
      [DEFAULT_PROXY_RUN_CASE_ID]: {
        runId: 'run-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        caseId: DEFAULT_PROXY_RUN_CASE_ID,
        workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
        evalRevision: PROXY_RUN_EVAL_REVISION,
        workBriefRevision: 7,
        retryOf: null,
        status: 'running',
        startedAt: '2026-09-02T10:00:00.000Z',
        completedAt: null,
        conclusion: null,
        evidence: null,
      },
    },
    runs: {
      'run-1': {
        runId: 'run-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        caseId: DEFAULT_PROXY_RUN_CASE_ID,
        workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
        evalRevision: PROXY_RUN_EVAL_REVISION,
        workBriefRevision: 7,
        retryOf: null,
        status: 'running',
        startedAt: '2026-09-02T10:00:00.000Z',
        completedAt: null,
        conclusion: null,
        evidence: null,
      },
    },
  });

  const passed = applyProxyRunEvent(running, {
    type: 'tool-workflow/run-end',
    data: {
      runId: 'run-1',
      stopReason: 'completed',
      status: 'passed',
      completedAt: '2026-09-02T10:00:01.000Z',
      evidence: { summary: '代理运行通过', assertions: [{ id: 'stable-output', passed: true }] },
    },
  });

  assert.equal(passed.status, 'passed');
  assert.equal(passed.runCount, 1);
  assert.equal(passed.latest.status, 'passed');
  assert.equal(passed.latest.completedAt, '2026-09-02T10:00:01.000Z');
  assert.equal(passed.latest.evidence.summary, '代理运行通过');
  assert.equal(applyProxyRunEvent(passed, { type: 'tool/result', data: {} }), passed);

  const definition = createProxyRunProjectionDefinition();
  assert.equal(definition.key, 'wanxiang.proxy-run');
  assert.equal(definition.stateVersion, 3);
  assert.deepEqual(definition.wire.view(definition.stateSchema.parse(passed)), passed);
});

test('DSH projection preserves attempts, explicit conclusions and retry lineage without conflicting final states', () => {
  const start = (runId, caseId, retryOf = null) => ({
    type: 'tool-workflow/run-start',
    data: {
      runId, retryOf, name: PROXY_RUN_WORKFLOW_NAME, projectId: 'project-1', sessionId: 'session-1', caseId,
      workflowVersion: PROXY_RUN_WORKFLOW_VERSION, evalRevision: 1, workBriefRevision: 7,
      startedAt: `2026-09-02T10:0${runId.at(-1)}:00.000Z`,
    },
  });
  const end = (runId, status, conclusion, evidence) => ({
    type: 'tool-workflow/run-end',
    data: { runId, status, conclusion, completedAt: '2026-09-02T10:10:00.000Z', evidence },
  });
  let state = initialProxyRunProjection();
  state = applyProxyRunEvent(state, start('run-1', PROXY_RUN_CASE_IDS[0]));
  state = applyProxyRunEvent(state, end('run-1', 'passed', 'passed', { summary: '通过', assertions: [{ id: 'a', passed: true }] }));
  state = applyProxyRunEvent(state, start('run-2', PROXY_RUN_CASE_IDS[1]));
  state = applyProxyRunEvent(state, end('run-2', 'failed', 'timed_out', {
    summary: '超时', assertions: [], error: { code: 'workflow_timeout', message: '超时' },
  }));
  state = applyProxyRunEvent(state, start('run-3', PROXY_RUN_CASE_IDS[1], 'run-2'));
  state = applyProxyRunEvent(state, end('run-3', 'cancelled', 'cancelled', {
    summary: '已取消', assertions: [], error: { code: 'workflow_cancelled', message: '已取消' },
  }));

  assert.equal(state.runCount, 3);
  assert.equal(state.runs['run-1'].status, 'passed');
  assert.equal(state.runs['run-2'].conclusion, 'timed_out');
  assert.equal(state.runs['run-3'].retryOf, 'run-2');
  assert.equal(state.runs['run-3'].status, 'cancelled');
  assert.equal(state.cases[PROXY_RUN_CASE_IDS[0]].status, 'passed');
  assert.equal(state.cases[PROXY_RUN_CASE_IDS[1]].runId, 'run-3');

  const conflicting = applyProxyRunEvent(state, end('run-3', 'passed', 'passed', { summary: '矛盾通过', assertions: [] }));
  assert.equal(conflicting, state);
});

test('DSH projection retains each visible customer follow-up case status and evidence', () => {
  let state = initialProxyRunProjection();
  for (const [index, caseId] of PROXY_RUN_CASE_IDS.entries()) {
    const runId = `run-${index + 1}`;
    state = applyProxyRunEvent(state, {
      type: 'tool-workflow/run-start',
      data: {
        runId,
        name: PROXY_RUN_WORKFLOW_NAME,
        projectId: 'project-1',
        sessionId: 'session-1',
        caseId,
        workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
        evalRevision: PROXY_RUN_EVAL_REVISION,
        workBriefRevision: 7,
        startedAt: '2026-09-02T10:00:00.000Z',
      },
    });
    state = applyProxyRunEvent(state, {
      type: 'tool-workflow/run-end',
      data: {
        runId,
        status: 'passed',
        completedAt: '2026-09-02T10:00:01.000Z',
        evidence: {
          summary: '代理运行通过',
          assertions: [{ id: 'structured-missing-follow-ups', passed: true }],
          output: { missingFollowUps: [] },
        },
      },
    });
  }

  assert.equal(state.runCount, 5);
  assert.deepEqual(Object.keys(state.cases), PROXY_RUN_CASE_IDS);
  for (const caseId of PROXY_RUN_CASE_IDS) {
    assert.equal(state.cases[caseId].status, 'passed');
    assert.deepEqual(state.cases[caseId].evidence.output, { missingFollowUps: [] });
  }
});

test('proxy-run tool adapter executes one deterministic synthetic case outside the Host and records durable DSH facts', async () => {
  const events = [];
  const session = {
    header: { cwd: '/managed/project' },
    append(type, data) {
      events.push({ type, data: structuredClone(data) });
    },
  };
  const agent = { id: 'session-1', session };
  const state = {
    brief: { revision: 7 },
    work: { sessionId: 'session-1', activeRevision: 7 },
  };
  let workflowRequest;
  let disposed = 0;
  const workflowEngine = {
    start(request) {
      workflowRequest = request;
      return {
        id: 'run-unique-1',
        meta: request.meta,
        result: Promise.resolve({
          value: {
            status: 'passed',
            summary: '代理运行通过',
            assertions: [{ id: 'structured-missing-follow-ups', passed: true }],
            output: { reportMarkdown: '# 客户跟进代理周报', missingFollowUps: [] },
          },
          stopReason: 'completed',
          agentsStarted: 0,
        }),
        cancel() {},
        async dispose() { disposed += 1; },
      };
    },
  };
  const saved = [];
  const projectRuns = [];
  let flushes = 0;
  const runRequests = [];
  const tool = createProxyRunToolAdapter({
    projectService: {
      async contextForAgent(actual) {
        assert.equal(actual, agent);
        return { workspaceId: 'project-1', workspacePath: '/managed/project', state };
      },
      async startEvaluationRun(projectId, value) { projectRuns.push({ phase: 'start', projectId, value }); },
      async finishEvaluationRun(projectId, value) { projectRuns.push({ phase: 'finish', projectId, value }); },
    },
    evaluationStore: {
      async load(project) {
        assert.deepEqual(project, { workspaceId: 'project-1', workspacePath: '/managed/project' });
        return {
          workflow: { workflowVersion: '2.0.0', entrypoint: 'workflow.mjs' },
          source: 'workflow source',
          eval: {
            revision: 3,
            cases: [{
              id: DEFAULT_PROXY_RUN_CASE_ID,
              input: { asOf: '2026-09-01', customersCsv: 'customer_id,name', communicationsJson: '[]' },
              expected: {
                missingFollowUps: [],
                markdown: { requiredSections: ['# 客户跟进代理周报'], customerReferences: [], evidenceReferences: [] },
              },
            }],
          },
        };
      },
    },
    runner: {
      async run(request) {
        runRequests.push(request);
        return { reportMarkdown: '# 客户跟进代理周报', missingFollowUps: [] };
      },
    },
    workflowEngine,
    evidenceStore: { async save(evidence) { saved.push(structuredClone(evidence)); } },
    flushSession: async (actual) => { assert.equal(actual, session); flushes += 1; },
    createRunId: () => 'run-unique-1',
    now: sequenceClock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01.000Z'),
  });

  assert.equal(tool.name, PROXY_RUN_TOOL_NAME);
  const output = await tool.execute({ caseId: DEFAULT_PROXY_RUN_CASE_ID }, { agent, signal: new AbortController().signal });

  assert.equal(workflowRequest.parent, agent);
  assert.equal(workflowRequest.meta.name, PROXY_RUN_WORKFLOW_NAME);
  assert.equal(workflowRequest.args.caseId, DEFAULT_PROXY_RUN_CASE_ID);
  assert.equal(workflowRequest.maxTotalAgents, 1);
  assert.match(workflowRequest.script, /return \{/u);
  assert.doesNotMatch(workflowRequest.script, /readFile|import\(|require\(/u);
  assert.equal(disposed, 1);
  assert.equal(flushes, 2);
  assert.deepEqual(events.map(({ type }) => type), ['tool-workflow/run-start', 'tool-workflow/run-end']);
  assert.deepEqual(events[0].data, {
    runId: 'run-unique-1',
    name: PROXY_RUN_WORKFLOW_NAME,
    projectId: 'project-1',
    sessionId: 'session-1',
    caseId: DEFAULT_PROXY_RUN_CASE_ID,
    workflowVersion: '2.0.0',
    evalRevision: 3,
    workBriefRevision: 7,
    retryOf: null,
    startedAt: '2026-09-02T10:00:00.000Z',
  });
  assert.equal(events[1].data.runId, 'run-unique-1');
  assert.equal(events[1].data.stopReason, 'completed');
  assert.equal(events[1].data.status, 'passed');
  assert.equal(saved[0].runId, 'run-unique-1');
  assert.equal(saved[0].projectId, 'project-1');
  assert.equal(saved[0].sessionId, 'session-1');
  assert.equal(saved[0].workflowVersion, '2.0.0');
  assert.equal(saved[0].evalRevision, 3);
  assert.equal(saved[0].workBriefRevision, 7);
  assert.deepEqual(projectRuns.map((item) => [item.phase, item.projectId, item.value.runId]), [
    ['start', 'project-1', 'run-unique-1'],
    ['finish', 'project-1', 'run-unique-1'],
  ]);
  assert.equal(output.status, 'passed');
  assert.equal(output.runId, 'run-unique-1');
  assert.deepEqual(output.output, { reportMarkdown: '# 客户跟进代理周报', missingFollowUps: [] });
  assert.equal(runRequests[0].entrypoint, 'workflow.mjs');
  assert.deepEqual(runRequests[0].input, {
    asOf: '2026-09-01', customersCsv: 'customer_id,name', communicationsJson: '[]',
  });
});

test('runner failures become structured evidence and a terminal fact in the same DSH session', async () => {
  const currentCaseId = 'normal-case-v2';
  const events = [];
  const saved = [];
  const session = { header: {}, append(type, data) { events.push({ type, data }); } };
  const agent = { id: 'session-1', session };
  const tool = createProxyRunToolAdapter({
    projectService: {
      async contextForAgent() {
        return {
          workspaceId: 'project-1',
          workspacePath: '/managed/project',
          state: { brief: { revision: 7 }, work: { sessionId: 'session-1', activeRevision: 7 } },
        };
      },
      async startEvaluationRun() {},
      async finishEvaluationRun() {},
    },
    evaluationStore: {
      async load() {
        return {
          workflow: { workflowVersion: '2.0.0', entrypoint: 'workflow.mjs' },
          source: 'while (true) {}',
          eval: { revision: 3, cases: [{ id: currentCaseId, input: {}, expected: {} }] },
        };
      },
    },
    runner: {
      async run() { throw Object.assign(new Error('Workflow 超时。'), { code: 'workflow_timeout' }); },
    },
    workflowEngine: { start() { assert.fail('failed execution must not reach assertions'); } },
    evidenceStore: { async save(value) { saved.push(value); } },
    flushSession: async () => {},
    createRunId: () => 'run-failed-1',
    now: sequenceClock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01.000Z'),
  });

  await assert.rejects(
    tool.execute({ caseId: currentCaseId }, { agent, signal: new AbortController().signal }),
    (error) => error.code === 'workflow_timeout',
  );

  assert.deepEqual(events.map((event) => event.type), ['tool-workflow/run-start', 'tool-workflow/run-end']);
  assert.equal(events[1].data.status, 'failed');
  assert.equal(events[1].data.conclusion, 'timed_out');
  assert.equal(events[1].data.evidence.error.code, 'workflow_timeout');
  assert.equal(saved[0].status, 'failed');
  assert.equal(saved[0].error.code, 'workflow_timeout');
});

test('cancelled retries keep a new runId, link the prior attempt and finalize project and DSH facts consistently', async () => {
  const caseId = 'cancel-case-v1';
  const events = [];
  const projectStarts = [];
  const projectEnds = [];
  const session = { header: {}, append(type, data) { events.push({ type, data: structuredClone(data) }); } };
  const agent = { id: 'session-1', session };
  const projectService = {
    async contextForAgent() {
      return {
        workspaceId: 'project-1', workspacePath: '/managed/project',
        state: { brief: { revision: 7 }, work: { sessionId: 'session-1', activeRevision: 7 } },
      };
    },
    async startEvaluationRun(projectId, value) { projectStarts.push({ projectId, value: structuredClone(value) }); },
    async finishEvaluationRun(projectId, value) { projectEnds.push({ projectId, value: structuredClone(value) }); },
  };
  const tool = createProxyRunToolAdapter({
    projectService,
    evaluationStore: {
      async load() {
        return {
          workflow: { workflowVersion: '2.0.0', entrypoint: 'workflow.mjs' }, source: 'source',
          eval: { revision: 3, cases: [{ id: caseId, input: {}, expected: {} }] },
        };
      },
    },
    runner: {
      async run() { throw Object.assign(new Error('用户已取消代理运行。'), { code: 'workflow_cancelled' }); },
    },
    workflowEngine: { start() { assert.fail('cancelled execution must not reach assertions'); } },
    evidenceStore: { async save() {} },
    flushSession: async () => {},
    createRunId: () => 'run-retry-2',
    now: sequenceClock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01.000Z'),
  });

  await assert.rejects(
    tool.execute({ caseId, retryOf: 'run-failed-1' }, { agent, signal: new AbortController().signal }),
    (error) => error.code === 'workflow_cancelled',
  );

  assert.equal(projectStarts[0].projectId, 'project-1');
  assert.equal(projectStarts[0].value.runId, 'run-retry-2');
  assert.equal(projectStarts[0].value.retryOf, 'run-failed-1');
  assert.deepEqual(projectEnds[0].value, {
    runId: 'run-retry-2',
    status: 'cancelled',
    conclusion: 'cancelled',
    completedAt: '2026-09-02T10:00:01.000Z',
    evidence: {
      summary: '用户已取消代理运行。',
      assertions: [],
      error: { code: 'workflow_cancelled', message: '用户已取消代理运行。' },
    },
  });
  assert.equal(events[0].data.retryOf, 'run-failed-1');
  assert.equal(events[1].data.status, 'cancelled');
  assert.equal(events[1].data.conclusion, 'cancelled');
});

test('proxy-run evidence is persisted outside project code under stable run identity', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-proxy-run-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new RunEvidenceStore({ dataRoot, createPendingId: () => 'temp-id' });
  const evidence = {
    runId: 'run/unsafe',
    projectId: 'project/unsafe',
    sessionId: 'session-1',
    workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
    evalRevision: PROXY_RUN_EVAL_REVISION,
    workBriefRevision: 7,
    caseId: DEFAULT_PROXY_RUN_CASE_ID,
    status: 'passed',
    startedAt: '2026-09-02T10:00:00.000Z',
    completedAt: '2026-09-02T10:00:01.000Z',
    summary: '代理运行通过',
    assertions: [],
  };

  const filename = await store.save(evidence);

  assert.ok(filename.startsWith(path.join(dataRoot, 'proxy-run-evidence')));
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), evidence);
  assert.doesNotMatch(path.relative(dataRoot, filename), /run\/unsafe|project\/unsafe/u);

  await assert.rejects(store.save({ ...evidence, status: 'failed', summary: '冲突结论' }), {
    code: 'evaluation_run_id_conflict',
  });
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), evidence);
});

function sequenceClock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
