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
      status: 'running',
      startedAt: '2026-09-02T10:00:00.000Z',
      completedAt: null,
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
        status: 'running',
        startedAt: '2026-09-02T10:00:00.000Z',
        completedAt: null,
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
  assert.equal(definition.stateVersion, 2);
  assert.deepEqual(definition.wire.view(definition.stateSchema.parse(passed)), passed);
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
  let flushes = 0;
  const runRequests = [];
  const tool = createProxyRunToolAdapter({
    projectService: {
      async contextForAgent(actual) {
        assert.equal(actual, agent);
        return { workspaceId: 'project-1', workspacePath: '/managed/project', state };
      },
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
  assert.equal(events[1].data.evidence.error.code, 'workflow_timeout');
  assert.equal(saved[0].status, 'failed');
  assert.equal(saved[0].error.code, 'workflow_timeout');
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
});

function sequenceClock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
