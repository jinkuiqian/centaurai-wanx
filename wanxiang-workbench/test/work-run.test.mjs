import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORK_RUN_WORKFLOW_NAME,
  applyWorkRunEvent,
  createWorkRunAdapter,
  createWorkRunProjectionDefinition,
  initialWorkRunProjection,
} from '../src/work-run.mjs';

test('真实工作运行使用独立接口，并记录任务步骤与可复核运行事实', async () => {
  const events = [];
  const saved = [];
  const projectRuns = [];
  const session = { header: {}, append(type, data) { events.push({ type, data: structuredClone(data) }); } };
  const agent = { id: 'session-1', session };
  const workRun = createWorkRunAdapter({
    projectService: {
      async contextForAgent() {
        return {
          workspaceId: 'project-1', workspacePath: '/managed/project',
          state: { brief: { revision: 4 }, work: { sessionId: 'session-1', activeRevision: 4 } },
        };
      },
      async startRealWorkRun(projectId, value) {
        projectRuns.push({ phase: 'start', projectId, value: structuredClone(value) });
      },
      async finishRun(projectId, value) {
        projectRuns.push({ phase: 'finish', projectId, value: structuredClone(value) });
      },
    },
    evaluationStore: {
      async load() {
        return {
          agent: { agentVersion: '1.3.0' },
          workflow: { workflowVersion: '1.3.0', entrypoint: 'workflow.mjs' },
          source: 'workflow source', eval: { revision: 5, cases: [] },
        };
      },
    },
    runner: {
      async run({ input }) {
        return {
          action: `跟进：${input.transcript}`,
          steps: [
            { id: 'extract-request', label: '识别客户回访请求' },
            { id: 'prepare-action', label: '生成后续行动' },
          ],
        };
      },
    },
    evidenceStore: { async save(evidence) { saved.push(structuredClone(evidence)); } },
    flushSession: async () => {},
    createRunId: () => 'run-real-1',
    now: sequenceClock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01.000Z'),
  });

  const result = await workRun.execute({
    caseTitle: '九月客户记录', input: { transcript: '客户希望下周回访' },
  }, { agent, signal: new AbortController().signal });

  assert.equal(result.status, 'passed');
  assert.equal(result.kind, 'real');
  assert.equal(result.output.action, '跟进：客户希望下周回访');
  assert.deepEqual(result.taskSteps.map(({ id, label }) => [id, label]), [
    ['extract-request', '识别客户回访请求'], ['prepare-action', '生成后续行动'],
  ]);
  assert.deepEqual(result.steps.map(({ id, status }) => [id, status]), [
    ['input-recorded', 'completed'], ['agent-loaded', 'completed'],
    ['workflow-executed', 'completed'], ['output-recorded', 'completed'],
  ]);
  assert.match(result.steps[0].facts.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.steps[0].facts.fields, ['transcript']);
  assert.deepEqual(result.steps[1].facts, { agentVersion: '1.3.0', workBriefRevision: 4 });
  assert.match(result.steps[3].facts.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(saved[0].caseId, 'real-case-run-real-1');
  assert.deepEqual(events.map(({ type }) => type), ['tool-workflow/run-start', 'tool-workflow/run-end']);
  assert.equal(events[0].data.name, WORK_RUN_WORKFLOW_NAME);
  assert.deepEqual(projectRuns.map(({ phase }) => phase), ['start', 'finish']);
  const projection = events.reduce(applyWorkRunEvent, initialWorkRunProjection());
  assert.equal(projection.latest.kind, 'real');
  assert.equal(projection.latest.evidence.output.action, '跟进：客户希望下周回访');
  assert.deepEqual(projection.latest.evidence.taskSteps, result.taskSteps);
});

test('影子运行投影只接收影子运行工作流事件', () => {
  const definition = createWorkRunProjectionDefinition();
  const state = definition.apply(definition.init(), {
    type: 'tool-workflow/run-start',
    data: { name: 'wanxiang-preset-proxy-run', runId: 'eval-run-1' },
  });

  assert.equal(definition.key, 'wanxiang.work-run');
  assert.deepEqual(state, initialWorkRunProjection());
});

test('项目终态首次写入失败时不会留下与项目状态冲突的成功证据', async () => {
  const saved = [];
  const finishes = [];
  const events = [];
  let finishAttempts = 0;
  const session = { header: {}, append(type, data) { events.push({ type, data: structuredClone(data) }); } };
  const agent = { id: 'session-1', session };
  const workRun = createWorkRunAdapter({
    projectService: {
      async contextForAgent() {
        return {
          workspaceId: 'project-1', workspacePath: '/managed/project',
          state: { brief: { revision: 4 }, work: { sessionId: 'session-1', activeRevision: 4 } },
        };
      },
      async startRealWorkRun() {},
      async finishRun(projectId, value) {
        finishes.push({ projectId, value: structuredClone(value) });
        finishAttempts += 1;
        if (finishAttempts === 1) throw Object.assign(new Error('项目状态暂时无法写入'), { code: 'state_write_failed' });
      },
    },
    evaluationStore: {
      async load() {
        return {
          agent: { agentVersion: '1.3.0' },
          workflow: { workflowVersion: '1.3.0', entrypoint: 'workflow.mjs' },
          source: 'workflow source', eval: { revision: 5, cases: [] },
        };
      },
    },
    runner: { async run() { return { action: '安排回访' }; } },
    evidenceStore: { async save(evidence) { saved.push(structuredClone(evidence)); } },
    flushSession: async () => {},
    createRunId: () => 'run-real-finish-retry',
    now: sequenceClock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01.000Z'),
  });

  await assert.rejects(workRun.execute({
    caseTitle: '九月客户记录', input: { transcript: '客户希望下周回访' },
  }, { agent, signal: new AbortController().signal }), (error) => {
    assert.equal(error.code, 'state_write_failed');
    assert.equal(error.evidence.status, 'failed');
    return true;
  });

  assert.deepEqual(finishes.map(({ value }) => value.status), ['passed', 'failed']);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'failed');
  assert.deepEqual(events.map(({ type }) => type), ['tool-workflow/run-start', 'tool-workflow/run-end']);
  assert.equal(events[1].data.status, 'failed');
});

test('证据发布失败时仍提交项目与会话终态，并保留可恢复的临时证据', async () => {
  const events = [];
  const finishes = [];
  const prepared = [];
  const session = { header: {}, append(type, data) { events.push({ type, data: structuredClone(data) }); } };
  const agent = { id: 'session-1', session };
  const workRun = createWorkRunAdapter({
    projectService: {
      async contextForAgent() {
        return {
          workspaceId: 'project-1', workspacePath: '/managed/project',
          state: { brief: { revision: 4 }, work: { sessionId: 'session-1', activeRevision: 4 } },
        };
      },
      async startRealWorkRun() {},
      async finishRun(projectId, value) { finishes.push({ projectId, value: structuredClone(value) }); },
    },
    evaluationStore: {
      async load() {
        return {
          agent: { agentVersion: '1.3.0' },
          workflow: { workflowVersion: '1.3.0', entrypoint: 'workflow.mjs' },
          source: 'workflow source', eval: { revision: 5, cases: [] },
        };
      },
    },
    runner: { async run() { return { action: '安排回访' }; } },
    evidenceStore: {
      async prepare(evidence) {
        const value = { evidence: structuredClone(evidence), pending: '/pending/run', filename: '/final/run' };
        prepared.push(value);
        return value;
      },
      async publish() { throw Object.assign(new Error('证据目录暂时不可写'), { code: 'evidence_publish_failed' }); },
      async abort() { assert.fail('项目终态已经提交，不应删除待恢复证据'); },
    },
    flushSession: async () => {},
    createRunId: () => 'run-real-publish-failed',
    now: sequenceClock('2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01.000Z'),
  });

  await assert.rejects(workRun.execute({
    caseTitle: '九月客户记录', input: { transcript: '客户希望下周回访' },
  }, { agent, signal: new AbortController().signal }), (error) => {
    assert.equal(error.code, 'evidence_publish_failed');
    assert.equal(error.runTerminalCommitted, true);
    assert.equal(error.evidencePending, true);
    return true;
  });

  assert.equal(prepared.length, 1);
  assert.deepEqual(finishes.map(({ value }) => value.status), ['passed']);
  assert.deepEqual(events.map(({ type }) => type), ['tool-workflow/run-start', 'tool-workflow/run-end']);
  assert.equal(events[1].data.status, 'passed');
});

test('反馈驱动重跑复用原案例与输入并保留 retry 谱系', async () => {
  const starts = [];
  const finishes = [];
  const sourceRun = {
    runId: 'run-before', sessionId: 'session-1', caseId: 'real-case-1', caseTitle: '九月客户记录',
    kind: 'real', agentVersion: '1.0.0', workflowVersion: '1.0.0', evalRevision: 2,
    workBriefRevision: 4, input: { transcript: '客户希望下周回访' }, retryOf: null, status: 'passed',
  };
  const context = {
    workspaceId: 'project-1', workspacePath: '/managed/project',
    state: {
      brief: { revision: 4 }, work: { sessionId: 'session-1', activeRevision: 4 },
      runs: { byId: { 'run-before': sourceRun } },
      feedback: { byId: { 'feedback-1': { id: 'feedback-1', runId: 'run-before' } } },
      improvements: {
        order: ['improvement-1'],
        byId: { 'improvement-1': { id: 'improvement-1', feedbackId: 'feedback-1', kind: 'implementation', status: 'planned' } },
      },
    },
  };
  const session = { header: {}, append() {} };
  const agent = { id: 'session-1', session };
  const workRun = createWorkRunAdapter({
    projectService: {
      async contextForAgent() { return context; },
      async startRealWorkRun(projectId, value) { starts.push({ projectId, value: structuredClone(value) }); },
      async finishRun(projectId, value) { finishes.push({ projectId, value: structuredClone(value) }); },
    },
    evaluationStore: {
      async load() {
        return {
          agent: { agentVersion: '1.0.1', workBriefRevision: 4 },
          workflow: { workflowVersion: '1.0.1', entrypoint: 'workflow.mjs' },
          source: 'workflow source', eval: { revision: 2, cases: [] },
        };
      },
    },
    runner: { async run({ input }) { return { action: `修正：${input.transcript}` }; } },
    evidenceStore: { async save() {} },
    flushSession: async () => {},
    createRunId: () => 'run-after',
    now: sequenceClock('2026-09-02T10:01:00.000Z', '2026-09-02T10:01:01.000Z'),
  });

  const result = await workRun.retryFeedback('feedback-1', {
    agent, signal: new AbortController().signal,
  });

  assert.equal(result.runId, 'run-after');
  assert.equal(result.retryOf, 'run-before');
  assert.equal(result.caseId, 'real-case-1');
  assert.deepEqual(result.input, sourceRun.input);
  assert.equal(result.agentVersion, '1.0.1');
  assert.equal(starts[0].value.retryOf, 'run-before');
  assert.equal(starts[0].value.caseId, 'real-case-1');
  assert.deepEqual(finishes.map(({ value }) => value.status), ['passed']);
});

function sequenceClock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
