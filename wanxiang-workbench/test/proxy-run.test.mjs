import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PROXY_RUN_CASE_ID,
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
      caseId: PROXY_RUN_CASE_ID,
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
      caseId: PROXY_RUN_CASE_ID,
      workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
      evalRevision: PROXY_RUN_EVAL_REVISION,
      workBriefRevision: 7,
      status: 'running',
      startedAt: '2026-09-02T10:00:00.000Z',
      completedAt: null,
      evidence: null,
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
  assert.equal(definition.stateVersion, 1);
  assert.deepEqual(definition.wire.view(definition.stateSchema.parse(passed)), passed);
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
            assertions: [{ id: 'stable-output', passed: true }],
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
  const tool = createProxyRunToolAdapter({
    projectService: {
      async contextForAgent(actual) {
        assert.equal(actual, agent);
        return { workspaceId: 'project-1', state };
      },
    },
    workflowEngine,
    evidenceStore: { async save(evidence) { saved.push(structuredClone(evidence)); } },
    flushSession: async (actual) => { assert.equal(actual, session); flushes += 1; },
    now: sequenceClock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01.000Z'),
  });

  assert.equal(tool.name, PROXY_RUN_TOOL_NAME);
  const output = await tool.execute({ caseId: PROXY_RUN_CASE_ID }, { agent, signal: new AbortController().signal });

  assert.equal(workflowRequest.parent, agent);
  assert.equal(workflowRequest.meta.name, PROXY_RUN_WORKFLOW_NAME);
  assert.equal(workflowRequest.args.caseId, PROXY_RUN_CASE_ID);
  assert.equal(workflowRequest.maxTotalAgents, undefined);
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
    caseId: PROXY_RUN_CASE_ID,
    workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
    evalRevision: PROXY_RUN_EVAL_REVISION,
    workBriefRevision: 7,
    startedAt: '2026-09-02T10:00:00.000Z',
  });
  assert.equal(events[1].data.runId, 'run-unique-1');
  assert.equal(events[1].data.stopReason, 'completed');
  assert.equal(events[1].data.status, 'passed');
  assert.equal(saved[0].runId, 'run-unique-1');
  assert.equal(saved[0].projectId, 'project-1');
  assert.equal(saved[0].sessionId, 'session-1');
  assert.equal(saved[0].workflowVersion, PROXY_RUN_WORKFLOW_VERSION);
  assert.equal(saved[0].evalRevision, PROXY_RUN_EVAL_REVISION);
  assert.equal(saved[0].workBriefRevision, 7);
  assert.equal(output.status, 'passed');
  assert.equal(output.runId, 'run-unique-1');
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
    caseId: PROXY_RUN_CASE_ID,
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
