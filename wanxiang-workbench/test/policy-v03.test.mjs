import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  apply,
  createActivationApiHandler,
  createAutomaticEvaluationHooks,
  createDiscoveryAuthorizationGuard,
  createEvaluationApiHandler,
  createRealWorkRunApiHandler,
  createRunFeedbackChangeDecisionApiHandler,
  createRunFeedbackChangeTool,
  createRunFeedbackApiHandler,
  createProjectResponse,
  createPublicWebFetchTool,
  createWorkAgentGenerationTool,
  createWorkBriefTool,
  discoveryToolAllowed,
  evaluationPolicy,
  inject,
  renderPromptWorkDescription,
  terminalRunMatchesEvidence,
} from '../src/policy.mjs';
import { createInitialState, deriveProjectState, serviceError, updateProjectState } from '../src/project-state.mjs';

test('workbench composition registers separate proxy and real-run DSH projection seams', () => {
  const registeredTools = new Map();
  const projections = new Map();
  const ctx = {
    effect(effect) { return effect(); },
    on() { return () => {}; },
    agents: {},
    permissionPresets: {},
    workflowEngine: { start() { assert.fail('registration must not start a run'); } },
    sessions: {
      list: () => [],
      async flush() {},
    },
    sessionProjections: {
      register(definition) { projections.set(definition.key, definition); return () => {}; },
    },
    systemPrompt: {},
    tools: {
      get(name) { return name === 'web_fetch' ? {} : registeredTools.get(name); },
      register(tool) { registeredTools.set(tool.name, tool); return () => {}; },
      guard() { return () => {}; },
    },
    web: {},
    webServer: {
      tapIndex() { return () => {}; },
      register() { return () => {}; },
    },
    workspaceRegistry: {
      list: () => [],
    },
  };

  apply(ctx);

  assert.ok(inject.includes('workflowEngine'));
  assert.ok(inject.includes('sessionProjections'));
  assert.equal(registeredTools.get('wanxiang_run_evaluation')?.name, 'wanxiang_run_evaluation');
  assert.equal(registeredTools.get('wanxiang_generate_work_agent')?.name, 'wanxiang_generate_work_agent');
  assert.equal(projections.get('wanxiang.proxy-run')?.stateVersion, 3);
  assert.equal(projections.get('wanxiang.work-run')?.stateVersion, 1);
});

test('pending evidence recovery only accepts evidence matching the authoritative terminal run', () => {
  const evidence = {
    runId: 'run-real-1', projectId: 'workspace-1', sessionId: 'session-root', caseId: 'real-case-1',
    caseTitle: '九月客户记录', kind: 'real', agentVersion: '1.0.0', workflowVersion: '1.0.0',
    evalRevision: 2, workBriefRevision: 3, retryOf: null, status: 'passed',
    startedAt: '2026-09-02T10:00:00.000Z', completedAt: '2026-09-02T10:00:01.000Z',
    input: { transcript: '客户希望下周回访' }, summary: '工作 Agent 已完成影子运行。',
    output: { action: '安排回访' }, steps: [], taskSteps: [],
  };
  const run = {
    ...evidence,
    runtimeInstanceId: 'runtime-1',
    conclusion: 'passed',
    evidence: {
      input: evidence.input, summary: evidence.summary, kind: 'real', caseTitle: evidence.caseTitle,
      steps: [], taskSteps: [], output: evidence.output,
    },
  };

  assert.equal(terminalRunMatchesEvidence({ runs: { byId: { 'run-real-1': run } } }, evidence), true);
  assert.equal(terminalRunMatchesEvidence(
    { runs: { byId: { 'run-real-1': run } } }, { ...evidence, status: 'failed' },
  ), false);
  assert.equal(terminalRunMatchesEvidence({
    runs: { byId: { 'run-real-1': { ...run, status: 'running' } } },
  }, evidence), false);
});

test('work Agent generation tool derives the confirmed contract from the active root session', async () => {
  const agent = { id: 'session-root', session: { header: { cwd: '/managed/meeting-notes' } } };
  const state = createInitialState('会议纪要整理');
  state.brief.revision = 4;
  state.brief.confirmedRevision = 4;
  state.brief.confirmedAnswers = {
    ...state.brief.answers,
    goal: '把访谈记录整理成可执行的会议纪要',
    inputs: '一段访谈逐字稿',
    examples: '一条带负责人的访谈待办',
    rules: '按截止日期排序',
    output: '包含决定和待办事项的 JSON',
    boundaries: '不发送消息',
    success: '每项待办都包含负责人和截止日期',
  };
  state.work = { sessionId: 'session-root', activeRevision: 4, activation: { status: 'active' } };
  state.improvements = {
    order: ['contract-improvement-1'],
    byId: {
      'contract-improvement-1': {
        id: 'contract-improvement-1', feedbackId: 'feedback-contract-1',
        kind: 'contract', status: 'accepted',
      },
    },
  };
  let received;
  const evaluationCalls = [];
  const completedChanges = [];
  const tool = createWorkAgentGenerationTool({
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', workspacePath: '/managed/meeting-notes', state };
    },
    async completeRunFeedbackChange(workspaceId, input) {
      completedChanges.push({ workspaceId, input });
    },
    async failRunFeedbackChange() {
      assert.fail('successful contract rerun must not fail the improvement');
    },
  }, {
    async generate(project, request) {
      received = { project, request };
      return {
        agent: { agentVersion: '1.0.0', workBriefRevision: 4, workflowVersion: '1.0.0', evalRevision: 2 },
        eval: { cases: [{ id: request.smokeCase.id }] },
      };
    },
  }, {
    async execute(args, execution) {
      evaluationCalls.push({ args, execution });
      return { status: 'passed', runId: 'run-smoke-1' };
    },
  }, null, {
    async retryFeedback(feedbackId, execution) {
      assert.equal(feedbackId, 'feedback-contract-1');
      assert.equal(execution.agent, agent);
      return { runId: 'run-contract-after', status: 'passed' };
    },
  });
  const definition = {
    workflowSource: "process.stdout.write(JSON.stringify({ notes: [] }));\n",
    inputSchema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] },
    outputSchema: { type: 'object', properties: { notes: { type: 'array' } }, required: ['notes'] },
    smokeCase: {
      id: 'meeting-notes-smoke-v1',
      title: '最小访谈记录',
      input: { transcript: '确定下周发布' },
      expected: { notes: [] },
    },
  };

  const result = await tool.execute(definition, { agent });

  assert.deepEqual(received.project, { workspaceId: 'workspace-1', workspacePath: '/managed/meeting-notes' });
  assert.equal(received.request.projectName, '会议纪要整理');
  assert.equal(received.request.workBriefRevision, 4);
  assert.deepEqual(received.request.brief, {
    goal: '把访谈记录整理成可执行的会议纪要',
    inputs: '一段访谈逐字稿',
    examples: '一条带负责人的访谈待办',
    rules: '按截止日期排序',
    output: '包含决定和待办事项的 JSON',
    boundaries: '不发送消息',
    success: '每项待办都包含负责人和截止日期',
  });
  assert.equal(received.request.workflowSource, definition.workflowSource);
  assert.equal(evaluationCalls.length, 1);
  assert.deepEqual(evaluationCalls[0].args, { caseId: 'meeting-notes-smoke-v1' });
  assert.equal(evaluationCalls[0].execution.agent, agent);
  assert.deepEqual(completedChanges, [{
    workspaceId: 'workspace-1',
    input: {
      improvementId: 'contract-improvement-1',
      afterAgentVersion: '1.0.0',
      rerunId: 'run-contract-after',
      evalRevision: 2,
    },
  }]);
  assert.deepEqual(result, {
    ok: true,
    agentVersion: '1.0.0',
    workBriefRevision: 4,
    workflowVersion: '1.0.0',
    evalRevision: 2,
    smokeCaseId: 'meeting-notes-smoke-v1',
    feedbackRerunIds: ['run-contract-after'],
  });
});

test('work Agent generation tool rejects sessions without the active confirmed work brief', async () => {
  const state = createInitialState('未开始项目');
  state.brief.revision = 1;
  state.brief.confirmedRevision = 1;
  state.work = { sessionId: null, activeRevision: null, activation: null };
  const tool = createWorkAgentGenerationTool({
    async contextForAgent() {
      return { workspaceId: 'workspace-1', workspacePath: '/managed/project', state };
    },
  }, { async generate() { assert.fail('inactive project must not generate'); } }, {
    async execute() { assert.fail('inactive project must not evaluate'); },
  });

  await assert.rejects(tool.execute({
    workflowSource: "process.stdout.write('{}')",
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    smokeCase: { id: 'smoke-v1', title: '冒烟', input: {}, expected: {} },
  }, { agent: { id: 'session-root', session: { header: {} } } }), {
    code: 'agent_generation_activation_required',
    statusCode: 409,
  });
});

test('work Agent generation tool accepts the confirmed activation prompt while it is pending', async () => {
  const agent = { id: 'session-root', session: { header: {} } };
  const state = createInitialState('待启动项目');
  state.brief.revision = 2;
  state.brief.confirmedRevision = 2;
  state.brief.confirmedAnswers = { ...state.brief.answers };
  state.work = {
    sessionId: 'session-root',
    activeRevision: null,
    activation: { status: 'pending', briefRevision: 2 },
  };
  const tool = createWorkAgentGenerationTool({
    async contextForAgent() {
      return { workspaceId: 'workspace-1', workspacePath: '/managed/project', state };
    },
  }, {
    async generate(_project, request) {
      return {
        agent: { agentVersion: '1.0.0', workBriefRevision: 2, workflowVersion: '1.0.0', evalRevision: 1 },
        eval: { cases: [{ id: request.smokeCase.id }] },
      };
    },
  }, {
    async execute() { return { status: 'passed' }; },
  });

  const result = await tool.execute({
    workflowSource: "process.stdout.write('{}');\n",
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    smokeCase: { id: 'smoke-v1', title: '冒烟', input: {}, expected: {} },
  }, { agent });

  assert.equal(result.ok, true);
  assert.equal(result.workBriefRevision, 2);
});

test('work Agent generation failure records an accepted contract improvement as recoverable', async () => {
  const agent = { id: 'session-root', session: { header: { cwd: '/managed/project' } } };
  const state = createInitialState('项目');
  state.brief.revision = 2;
  state.brief.confirmedRevision = 2;
  state.brief.confirmedAnswers = { ...state.brief.answers };
  state.work = { sessionId: 'session-root', activeRevision: 2, activation: { status: 'active' } };
  state.improvements = {
    order: ['contract-improvement-1'],
    byId: {
      'contract-improvement-1': {
        id: 'contract-improvement-1', feedbackId: 'feedback-contract-1',
        kind: 'contract', status: 'accepted',
      },
    },
  };
  const failures = [];
  const tool = createWorkAgentGenerationTool({
    async contextForAgent() {
      return { workspaceId: 'workspace-1', workspacePath: '/managed/project', state };
    },
    async failRunFeedbackChange(workspaceId, input) {
      failures.push({ workspaceId, input });
    },
  }, {
    async generate() {
      throw Object.assign(new Error('生成事务中断'), { code: 'agent_update_interrupted' });
    },
  }, { async execute() { assert.fail('generation failure must not run the smoke case'); } });

  await assert.rejects(tool.execute({
    workflowSource: "process.stdout.write('{}');\n",
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    smokeCase: { id: 'smoke-1', title: '案例', input: {}, expected: {} },
  }, { agent }), /生成事务中断/u);
  assert.deepEqual(failures, [{
    workspaceId: 'workspace-1',
    input: {
      improvementId: 'contract-improvement-1',
      error: { code: 'agent_update_interrupted', message: '生成事务中断' },
    },
  }]);
});

test('work-description tool derives the project from the calling root agent and writes inferred sparse fields', async () => {
  const agent = { id: 'session-root', session: { header: {} } };
  const state = createInitialState('客户周报');
  let received;
  const tool = createWorkBriefTool({
    async contextForAgent(actualAgent) {
      assert.equal(actualAgent, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async updateProjectForAgent(actualAgent, baseVersion, patch) {
      received = { actualAgent, baseVersion, patch };
      const next = structuredClone(state);
      next.stateVersion = 2;
      next.brief.revision = 1;
      next.brief.answers.goal = patch.answers.goal;
      next.brief.fieldSources.goal = patch.fieldSources.goal;
      return { workspaceId: 'workspace-1', state: next };
    },
  });

  const result = await tool.execute({
    baseStateVersion: 1,
    patch: { goal: '每周把客户沟通记录整理成周报' },
    reason: '用户给出了真实任务',
  }, { agent });

  assert.equal(received.actualAgent, agent);
  assert.equal(received.baseVersion, 1);
  assert.deepEqual(received.patch, {
    answers: { goal: '每周把客户沟通记录整理成周报' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: [] } },
  });
  assert.deepEqual(result.updatedFields, ['goal']);
  assert.equal(result.workspaceId, 'workspace-1');
  assert.equal(result.stateVersion, 2);
  assert.equal(result.ok, true);
  assert.equal(result.guidance.next.kind, 'inspect_context');
  assert.equal(result.guidance.next.field, 'inputs');
  assert.equal(result.guidance.progress.requiredKnown, 1);
});

test('work-description tool returns a structured current snapshot on CAS conflict', async () => {
  const current = createInitialState('客户周报');
  current.stateVersion = 4;
  current.brief.revision = 2;
  current.brief.answers.goal = '最新目标';
  current.brief.fieldSources.goal = { status: 'inferred', sourceMessageIds: ['message-1'] };
  const tool = createWorkBriefTool({
    async contextForAgent() { return { workspaceId: 'workspace-1', state: current }; },
    async updateProjectForAgent() {
      throw serviceError(409, 'revision_conflict', '项目状态已经变化，请刷新后重试。', { current });
    },
  });

  const result = await tool.execute({ baseStateVersion: 3, patch: { goal: '陈旧目标' } }, {
    agent: { id: 'session-root', session: { header: {} } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'revision_conflict');
  assert.equal(result.current.stateVersion, 4);
  assert.equal(result.current.briefRevision, 2);
  assert.equal(result.current.answers.goal, '最新目标');
  assert.equal(result.guidance.next.kind, 'inspect_context');
  assert.equal(result.guidance.next.field, 'inputs');
  assert.deepEqual(result.guidance, result.current.guidance);
});

test('work-description tool keeps confirmed provenance when the model repeats an unchanged value', async () => {
  let state = updateProjectState(createInitialState('客户周报'), {
    answers: { goal: '生成客户周报' },
    fieldSources: { goal: { status: 'user_confirmed', sourceMessageIds: ['message-1'] } },
  });
  let writes = 0;
  const tool = createWorkBriefTool({
    async contextForAgent() { return { workspaceId: 'workspace-1', state }; },
    async updateProjectForAgent(_agent, baseVersion, patch) {
      assert.equal(baseVersion, state.stateVersion);
      writes += 1;
      state = updateProjectState(state, patch);
      return { workspaceId: 'workspace-1', state };
    },
  });

  const result = await tool.execute({ baseStateVersion: state.stateVersion, patch: { goal: '生成客户周报' } }, {
    agent: { id: 'session-root', session: { header: {} } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.updatedFields, []);
  assert.equal(writes, 1);
  assert.equal(state.brief.fieldSources.goal.status, 'user_confirmed');
  assert.deepEqual(result.guidance.changes, { confirmed: [], inferred: [], unresolved: [] });
  assert.deepEqual(createProjectResponse(state).guidance.changes, result.guidance.changes);
  assert.equal(result.guidance.next.kind, 'inspect_context');
  assert.equal(result.guidance.next.field, 'inputs');
});

test('work-description tool separates explicit user answers, inference and deferred unknowns', async () => {
  let state = createInitialState('客户周报');
  const service = {
    async contextForAgent() { return { workspaceId: 'workspace-1', state }; },
    async updateProjectForAgent(_agent, baseVersion, patch) {
      assert.equal(baseVersion, state.stateVersion);
      state = updateProjectState(state, patch);
      return { workspaceId: 'workspace-1', state };
    },
  };
  const tool = createWorkBriefTool(service);
  const agent = { id: 'session-root', session: { header: {} } };

  const understood = await tool.execute({
    baseStateVersion: state.stateVersion,
    patch: { goal: '每周生成客户周报', output: 'Markdown 周报' },
    confirmedFields: ['goal'],
  }, { agent });
  assert.deepEqual(understood.guidance.changes, {
    confirmed: ['goal'], inferred: ['output'], unresolved: [],
  });
  assert.equal(state.brief.fieldSources.goal.status, 'user_confirmed');
  assert.equal(state.brief.fieldSources.output.status, 'inferred');
  assert.equal(understood.guidance.next.kind, 'inspect_context');

  const deferred = await tool.execute({
    baseStateVersion: state.stateVersion,
    patch: {},
    investigatedFields: ['inputs'],
    unresolvedFields: ['inputs'],
  }, { agent });
  assert.deepEqual(deferred.guidance.changes, {
    confirmed: [], inferred: [], unresolved: ['inputs'],
  });
  assert.equal(state.brief.fieldSources.inputs.status, 'unresolved');
  assert.equal(deferred.guidance.next.kind, 'await_required');
  assert.equal(deferred.guidance.next.audience, null);
});

test('work-description tool records completed read-only investigation before asking for business input', async () => {
  let state = updateProjectState(createInitialState('客户周报'), {
    answers: { goal: '每周生成客户周报' },
    fieldSources: { goal: { status: 'user_confirmed', sourceMessageIds: [] } },
  });
  const tool = createWorkBriefTool({
    async contextForAgent() { return { workspaceId: 'workspace-1', state }; },
    async updateProjectForAgent(_agent, _baseVersion, patch) {
      state = updateProjectState(state, patch);
      return { workspaceId: 'workspace-1', state };
    },
  });

  const result = await tool.execute({
    baseStateVersion: state.stateVersion,
    patch: {},
    investigatedFields: ['inputs'],
  }, { agent: { id: 'session-root', session: { header: {} } } });

  assert.deepEqual(result.guidance.investigatedFields, ['inputs']);
  assert.equal(result.guidance.next.kind, 'ask_field');
  assert.equal(result.guidance.next.field, 'inputs');
  assert.equal(result.guidance.next.audience, 'member');
  assert.match(result.guidance.next.prompt, /业务材料或信息/u);
  assert.doesNotMatch(result.guidance.next.prompt, /请.*文件位置/u);
});

test('project reads, refreshes and work-description updates share one authoritative guidance snapshot', async () => {
  let state = createInitialState('客户周报');
  state = updateProjectState(state, {
    answers: { goal: '生成客户周报' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: ['message-1'] } },
  });
  const tool = createWorkBriefTool({
    async contextForAgent() { return { workspaceId: 'workspace-1', state }; },
    async updateProjectForAgent(_agent, baseVersion, patch) {
      assert.equal(baseVersion, state.stateVersion);
      state = updateProjectState(state, patch);
      return { workspaceId: 'workspace-1', state };
    },
  });

  const read = createProjectResponse(state);
  const update = await tool.execute({ baseStateVersion: state.stateVersion, patch: { goal: '生成客户周报' } }, {
    agent: { id: 'session-root', session: { header: {} } },
  });
  const refresh = createProjectResponse(structuredClone(state));

  assert.deepEqual(read.guidance, read.projection.guidance);
  assert.deepEqual(update.guidance, refresh.guidance);
  assert.deepEqual(refresh.guidance.changes, { confirmed: [], inferred: [], unresolved: [] });
  assert.deepEqual(Object.keys(read.guidance), [
    'schemaVersion',
    'stateVersion',
    'briefRevision',
    'stage',
    'understanding',
    'progress',
    'unresolvedFields',
    'deferredFields',
    'investigatedFields',
    'changes',
    'next',
  ]);
});

test('project responses derive maturity from the current protected evaluation', () => {
  const state = createInitialState('客户周报');
  const evaluation = {
    agentVersion: '1.0.0',
    workflowVersion: '1.0.0',
    evalRevision: 2,
    cases: [
      { id: 'case-1', title: '正常案例', kind: 'normal' },
      { id: 'case-2', title: '边界案例', kind: 'boundary' },
    ],
  };

  const response = createProjectResponse(state, { evaluation });

  assert.equal(response.projection.maturity.evidence.representativeCases.total, 2);
  assert.equal(response.projection.maturity.evidence.representativeCases.boundaryRequired, 2);
  assert.equal(response.evaluation, evaluation);
});

test('work-description prompt exposes one deterministic read-only investigation action and response discipline', () => {
  let state = createInitialState('客户周报');
  state = updateProjectState(state, {
    answers: { goal: '把每周客户沟通记录整理成周报' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: ['message-1'] } },
  });

  const prompt = renderPromptWorkDescription(state, deriveProjectState(state), false);

  assert.match(prompt, /唯一下一步：inspect_context/u);
  assert.match(prompt, /对应字段：输入与资料来源/u);
  assert.match(prompt, /只读检查后更新工作说明/u);
  assert.match(prompt, /执行对象：万象/u);
  assert.match(prompt, /先更新工作说明，再用 1–2 句复述当前理解/u);
  assert.match(prompt, /只有 ask_field 可以向用户提问/u);
});

test('making policy requires one automatic full Eval immediately after every Workflow change', () => {
  assert.match(evaluationPolicy, /After every successful change/u);
  assert.match(evaluationPolicy, /call wanxiang_run_evaluation once without caseId/u);
  assert.match(evaluationPolicy, /all protected cases/u);
  assert.match(evaluationPolicy, /do not wait for another user message/u);
});

test('successful Workflow mutations through any tool force one full Eval in the same Agent execution', async (t) => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'wanxiang-auto-eval-'));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const artifactRoot = path.join(workspacePath, '.wanxiang');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'old source');
  await writeFile(path.join(artifactRoot, 'workflow.json'), '{}');
  await writeFile(path.join(artifactRoot, 'agent.json'), '{"agentVersion":"1.0.0"}');
  const agent = { id: 'session-root', session: { header: { cwd: workspacePath } } };
  const state = { brief: { revision: 4 }, work: { sessionId: agent.id, activeRevision: 4 } };
  const calls = [];
  const revisions = [];
  const hooks = createAutomaticEvaluationHooks({
    projectService: {
      async contextForAgent(actual) {
        assert.equal(actual, agent);
        return { workspaceId: 'workspace-1', workspacePath, state };
      },
    },
    evaluationTool: {
      async execute(args, execution) {
        calls.push({ args, execution });
        return { status: 'passed', summary: '5 个代理案例全部通过' };
      },
    },
    evaluationStore: {
      async reviseGeneratedAgent(project) { revisions.push(project); },
    },
  });
  const accepted = { kind: 'accept' };
  const execution = {
    name: 'run_code', agent, signal: new AbortController().signal,
    arguments: { code: 'arbitrary file mutation' },
  };

  assert.equal(await hooks.before(execution, async () => accepted), accepted);
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'new source');
  const decision = await hooks.after(execution, { isError: false }, async () => accepted);
  assert.equal(decision.kind, 'accept');
  assert.match(decision.additionalContexts[0].content[0].text, /5 个代理案例全部通过/u);
  assert.equal(calls.length, 1);
  assert.deepEqual(revisions, [{ workspaceId: 'workspace-1', workspacePath }]);
  assert.deepEqual(calls[0].args, {});
  assert.equal(calls[0].execution, execution);

  const unrelated = { ...execution, arguments: { code: 'write README' } };
  await hooks.before(unrelated, async () => accepted);
  await writeFile(path.join(workspacePath, 'README.md'), 'unrelated');
  await hooks.after(unrelated, { isError: false }, async () => accepted);
  assert.equal(calls.length, 1);
  assert.equal(revisions.length, 1);

  const partialFailure = { ...execution, arguments: { code: 'write then exit nonzero' } };
  await hooks.before(partialFailure, async () => accepted);
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'changed before tool error');
  await hooks.after(partialFailure, { isError: true }, async () => accepted);
  assert.equal(calls.length, 2);
  assert.equal(revisions.length, 2);

  const controller = new AbortController();
  const cancelledAfterWrite = { ...execution, signal: controller.signal };
  await hooks.before(cancelledAfterWrite, async () => accepted);
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'changed before cancellation');
  controller.abort();
  await hooks.after(cancelledAfterWrite, { isError: true }, async () => accepted);
  assert.equal(calls.length, 3);
  assert.equal(revisions.length, 3);
  assert.equal(calls[2].execution.signal.aborted, false);
});

test('automatic Eval infrastructure failures notify the Agent without rewriting a successful file edit', async (t) => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'wanxiang-auto-eval-failure-'));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const artifactRoot = path.join(workspacePath, '.wanxiang');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'old source');
  await writeFile(path.join(artifactRoot, 'workflow.json'), '{}');
  const agent = { id: 'session-root', session: { header: { cwd: workspacePath } } };
  const hooks = createAutomaticEvaluationHooks({
    projectService: {
      async contextForAgent() {
        return {
          workspacePath,
          state: { brief: { revision: 1 }, work: { sessionId: agent.id, activeRevision: 1 } },
        };
      },
    },
    evaluationTool: {
      async execute() { throw Object.assign(new Error('评测服务不可用'), { code: 'evaluation_unavailable' }); },
    },
  });

  const execution = {
    name: 'write', agent, signal: new AbortController().signal,
    arguments: { file_path: '.wanxiang/workflow.mjs', content: 'source' },
  };
  await hooks.before(execution, async () => ({ kind: 'allow' }));
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'new source');
  const decision = await hooks.after(execution, { isError: false }, async () => ({ kind: 'accept' }));

  assert.equal(decision.kind, 'accept');
  assert.match(decision.additionalContexts[0].content[0].text, /自动评测未完成.*评测服务不可用/u);
});

test('planned implementation feedback automatically bumps the Agent, runs protected Eval and retries the source case', async (t) => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'wanxiang-feedback-loop-'));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const artifactRoot = path.join(workspacePath, '.wanxiang');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'old source');
  await writeFile(path.join(artifactRoot, 'workflow.json'), '{}');
  await writeFile(path.join(artifactRoot, 'agent.json'), '{"agentVersion":"1.0.0"}');
  const improvement = {
    id: 'improvement-1', feedbackId: 'feedback-1', status: 'planned', kind: 'implementation',
    before: { agentVersion: '1.0.0', workBriefRevision: 4, evalRevision: 2 },
  };
  const state = {
    brief: { revision: 4 }, work: { sessionId: 'session-root', activeRevision: 4 },
    improvements: { order: ['improvement-1'], byId: { 'improvement-1': improvement } },
  };
  const agent = { id: 'session-root', session: { header: { cwd: workspacePath } } };
  const completed = [];
  const hooks = createAutomaticEvaluationHooks({
    projectService: {
      async contextForAgent() { return { workspaceId: 'workspace-1', workspacePath, state }; },
      async completeRunFeedbackChange(workspaceId, input) { completed.push({ workspaceId, input }); },
      async failRunFeedbackChange() { assert.fail('successful feedback loop must not be failed'); },
    },
    evaluationStore: {
      async reviseGeneratedAgent() {
        return { agent: { agentVersion: '1.0.1' }, eval: { revision: 2 } };
      },
    },
    evaluationTool: { async execute() { return { status: 'passed', summary: '受保护评测通过' }; } },
    workRun: {
      async retryFeedback(feedbackId, execution) {
        assert.equal(feedbackId, 'feedback-1');
        assert.equal(execution.agent, agent);
        return { runId: 'run-after', status: 'passed' };
      },
    },
  });
  const execution = { name: 'write', agent, signal: new AbortController().signal };

  await hooks.before(execution, async () => ({ kind: 'allow' }));
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'new source');
  const decision = await hooks.after(execution, { isError: false }, async () => ({ kind: 'accept' }));

  assert.deepEqual(completed, [{
    workspaceId: 'workspace-1',
    input: { improvementId: 'improvement-1', afterAgentVersion: '1.0.1', rerunId: 'run-after', evalRevision: 2 },
  }]);
  assert.match(decision.additionalContexts[0].content[0].text, /原真实案例已自动重跑/u);
});

test('feedback change tool separates implementation fixes from contract proposals and decisions stay explicit', async () => {
  const state = { stateVersion: 8, work: { sessionId: 'session-root' } };
  const agent = { id: 'session-root' };
  const planned = [];
  const service = {
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async planRunFeedbackChange(workspaceId, baseVersion, input, sessionId) {
      planned.push({ workspaceId, baseVersion, input, sessionId });
      return {
        ...state,
        improvements: {
          order: ['improvement-1'],
          byId: { 'improvement-1': { id: 'improvement-1', feedbackId: input.feedbackId, kind: input.kind, status: input.kind === 'contract' ? 'awaiting_confirmation' : 'planned', diff: [] } },
        },
      };
    },
  };
  const tool = createRunFeedbackChangeTool(service);
  const result = await tool.execute({
    baseStateVersion: 8, feedbackId: 'feedback-1', kind: 'implementation',
  }, { agent });

  assert.equal(result.improvementId, 'improvement-1');
  assert.equal(result.status, 'planned');
  assert.deepEqual(planned[0], {
    workspaceId: 'workspace-1', baseVersion: 8,
    input: { feedbackId: 'feedback-1', kind: 'implementation' }, sessionId: 'session-root',
  });

  await tool.execute({
    baseStateVersion: 8,
    feedbackId: 'feedback-2',
    kind: 'contract',
    contractPatch: { permissions: '需要读取公开网络；外部发送仍需成员逐次确认' },
  }, { agent });
  assert.deepEqual(planned[1], {
    workspaceId: 'workspace-1', baseVersion: 8,
    input: {
      feedbackId: 'feedback-2', kind: 'contract',
      contractPatch: { permissions: '需要读取公开网络；外部发送仍需成员逐次确认' },
    },
    sessionId: 'session-root',
  });

  let decision;
  const handler = createRunFeedbackChangeDecisionApiHandler(activationContext('workspace-write').ctx, {
    async decideRunFeedbackChange(workspaceId, baseVersion, input, sessionId) {
      decision = { workspaceId, baseVersion, input, sessionId };
      return createInitialState('项目');
    },
    async getProjectEvidence() { return { evaluation: null }; },
    async contextForAgent() { return { workspaceId: 'workspace-1', state: activationState('active') }; },
  });
  const [status] = await handler(jsonRequest('POST', {
    workspaceId: 'workspace-1', sessionId: 'session-root', baseVersion: 8,
    improvementId: 'improvement-1', decision: 'reject',
  }));
  assert.equal(status, 200);
  assert.deepEqual(decision, {
    workspaceId: 'workspace-1', baseVersion: 8,
    input: { improvementId: 'improvement-1', decision: 'reject' }, sessionId: 'session-root',
  });
});

test('work-description tool rejects unknown and empty patches before state mutation', async () => {
  let calls = 0;
  const tool = createWorkBriefTool({ async updateProjectForAgent() { calls += 1; } });

  await assert.rejects(
    tool.execute({ baseStateVersion: 1, patch: { unknown: 'value' } }, {}),
    (error) => error.code === 'invalid_request',
  );
  await assert.rejects(
    tool.execute({ baseStateVersion: 1, patch: {} }, {}),
    (error) => error.code === 'empty_patch',
  );
  assert.equal(calls, 0);
});

test('public web reader delegates to the credential-free provider and rejects extra input', async () => {
  const signal = new AbortController().signal;
  let received;
  const tool = createPublicWebFetchTool({
    async fetch(input, actualSignal) {
      received = { input, actualSignal };
      return {
        url: input.url,
        statusCode: 200,
        body: { kind: 'text', content: '可公开读取的正文' },
        truncated: false,
      };
    },
  });

  const result = await tool.execute({ url: 'https://example.com/page' }, { signal });

  assert.deepEqual(received, { input: { url: 'https://example.com/page' }, actualSignal: signal });
  assert.equal(result.statusCode, 200);
  assert.match(tool.output.render({}, result)[0].text, /可公开读取的正文/u);
  await assert.rejects(
    tool.execute({ url: 'https://example.com', headers: { authorization: 'secret' } }, { signal }),
    (error) => error.code === 'invalid_request',
  );
});

test('discovery file reads stay inside the managed workspace, including through symlinks', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'wanxiang-policy-'));
  const workspacePath = path.join(sandbox, 'workspace');
  const outsidePath = path.join(sandbox, 'outside.txt');
  try {
    await writeFile(outsidePath, 'secret');
    await writeFileAfterMkdir(path.join(workspacePath, 'inside.txt'), 'allowed');
    await symlink(outsidePath, path.join(workspacePath, 'escape.txt'));
    const agent = { session: { header: { cwd: workspacePath } } };
    const ctx = { workspaceRegistry: { get: () => ({ path: workspacePath }) } };
    const context = { workspaceId: 'workspace-1' };
    const execution = (filePath) => ({ name: 'read', arguments: { file_path: filePath }, agent });

    assert.equal(await discoveryToolAllowed(ctx, context, execution('inside.txt')), true);
    assert.equal(await discoveryToolAllowed(ctx, context, execution('../outside.txt')), false);
    assert.equal(await discoveryToolAllowed(ctx, context, execution('escape.txt')), false);
    assert.equal(await discoveryToolAllowed(ctx, context, { name: 'write', arguments: {}, agent }), false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('monotonic discovery guard blocks manual permission bypasses', () => {
  const session = { id: 'session-root', header: { cwd: '/managed/project' } };
  const agent = { id: 'session-root', session };
  const ctx = {
    workspaceRegistry: {
      list: () => [{ id: 'workspace-1', path: '/managed/project', sessionIds: ['session-root'] }],
    },
  };
  const allowed = new WeakSet();
  let buildAuthorized = false;
  const guard = createDiscoveryAuthorizationGuard(ctx, {
    isBuildAuthorized: () => buildAuthorized,
    isDiscoveryExecutionAllowed: (execution) => allowed.has(execution),
  });
  const write = { name: 'write', arguments: {}, agent };
  const proxyRun = { name: 'wanxiang_run_evaluation', arguments: { caseId: 'preset-proxy-run-v1' }, agent };
  const read = { name: 'read', arguments: { file_path: 'inside.txt' }, agent };

  assert.match(guard(write), /只允许读取/u);
  assert.match(guard(proxyRun), /只允许读取/u);
  allowed.add(read);
  assert.equal(guard(read), undefined);
  buildAuthorized = true;
  assert.equal(guard(write), undefined);
  assert.equal(guard(proxyRun), undefined);
});

test('discovery question guard only allows the Host-selected single member question', async () => {
  let state = createInitialState('客户周报');
  const ctx = { workspaceRegistry: {} };
  const context = { state };
  const execution = (questions) => ({ name: 'ask_user_question', arguments: { questions } });

  assert.equal(await discoveryToolAllowed(ctx, context, execution([
    { question: '提前问输入？' },
    { question: '再问输出？' },
  ])), false);
  assert.equal(await discoveryToolAllowed(ctx, context, execution([
    { question: '提前问输入？' },
  ])), false);
  assert.equal(await discoveryToolAllowed(ctx, context, execution([
    { question: deriveProjectState(state).guidance.next.prompt },
  ])), true);

  state = updateProjectState(state, {
    answers: { goal: '每周生成客户周报' },
    fieldSources: { goal: { status: 'user_confirmed', sourceMessageIds: [] } },
  });
  context.state = state;
  assert.equal(deriveProjectState(state).guidance.next.kind, 'inspect_context');
  assert.equal(await discoveryToolAllowed(ctx, context, execution([
    { question: '现在请告诉我文件在哪里？' },
  ])), false);
});

test('activation reserves the same idle root session then durably switches it to project-write', async () => {
  const state = activationState('pending');
  const { ctx, agent, permission, flushes } = activationContext();
  let requestSeen;
  const service = {
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async reserveActivation(workspaceId, request) {
      requestSeen = { workspaceId, request };
      return { disposition: 'reserved', state, activation: state.work.activation };
    },
  };
  const handler = createActivationApiHandler(ctx, service);

  const [status, body] = await handler(jsonRequest('POST', {
    workspaceId: 'workspace-1',
    sessionId: 'session-root',
    baseVersion: 7,
    briefRevision: 3,
  }));

  assert.equal(status, 200);
  assert.equal(body.result, 'reserved');
  assert.equal(body.activationId, 'activation-1');
  assert.equal(body.permission.mode, 'build');
  assert.equal(permission.get(agent.session), 'workspace-write');
  assert.equal(flushes.count, 1);
  assert.deepEqual(requestSeen, {
    workspaceId: 'workspace-1',
    request: {
      baseVersion: 7,
      briefRevision: 3,
      sessionId: 'session-root',
      retry: false,
    },
  });
});

test('activation fails closed when neither permission transition nor failure finalization is durable', async () => {
  const state = activationState('pending');
  const { ctx, agent, permission } = activationContext();
  const originalSet = ctx.permissionPresets.set;
  ctx.permissionPresets.set = (session, preset) => {
    if (preset === 'workspace-write') throw new Error('permission store offline');
    originalSet(session, preset);
  };
  const denied = [];
  const authorization = {
    deny(sessionId) { denied.push(sessionId); },
    update() { assert.fail('pending state must not become host-authorized'); },
  };
  const service = {
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async reserveActivation() {
      return { disposition: 'reserved', state, activation: state.work.activation };
    },
    async finalizeActivation() {
      throw new Error('state store offline');
    },
  };
  const handler = createActivationApiHandler(ctx, service, authorization);

  await assert.rejects(handler(jsonRequest('POST', {
    workspaceId: 'workspace-1',
    sessionId: 'session-root',
    baseVersion: 7,
    briefRevision: 3,
  })), (error) => error.code === 'activation_recovery_failed');

  assert.deepEqual(denied, ['session-root']);
  assert.equal(permission.get(agent.session), 'read-only');
});

test('failed activation finalization rolls the same session back to read-only', async () => {
  const state = activationState('pending');
  const { ctx, agent, permission, flushes } = activationContext('workspace-write');
  let finalized;
  const service = {
    async getProject() { return state; },
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async finalizeActivation(_workspaceId, request) {
      finalized = request;
      const next = structuredClone(state);
      next.work.activation.status = 'failed';
      next.work.activation.error = request.error;
      return next;
    },
  };
  const handler = createActivationApiHandler(ctx, service);

  const [status, body] = await handler(jsonRequest('PUT', {
    workspaceId: 'workspace-1',
    activationId: 'activation-1',
    status: 'failed',
    error: { code: 'model_unavailable', message: '请先连接模型', recoverable: true },
  }));

  assert.equal(status, 200);
  assert.equal(body.state.work.activation.status, 'failed');
  assert.equal(finalized.activationId, 'activation-1');
  assert.equal(permission.get(agent.session), 'read-only');
  assert.equal(flushes.count, 1);
});

test('failed resynchronization keeps the previous active contract in project-write mode', async () => {
  const state = activationState('pending');
  state.work.activeRevision = 2;
  const { ctx, agent, permission, flushes } = activationContext('workspace-write');
  const service = {
    async getProject() { return state; },
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async finalizeActivation(_workspaceId, request) {
      const next = structuredClone(state);
      next.work.activation.status = request.status;
      next.work.activation.error = request.error;
      next.brief.confirmedRevision = 2;
      return next;
    },
  };
  const handler = createActivationApiHandler(ctx, service);

  const [status, body] = await handler(jsonRequest('PUT', {
    workspaceId: 'workspace-1',
    activationId: 'activation-1',
    status: 'failed',
    error: { code: 'network_interrupted', message: '消息未发出', recoverable: true },
  }));

  assert.equal(status, 200);
  assert.equal(body.state.work.activeRevision, 2);
  assert.equal(permission.get(agent.session), 'workspace-write');
  assert.equal(flushes.count, 1);
});

test('activation rejects a cross-workspace session before reserving state', async () => {
  const { ctx } = activationContext();
  let reserves = 0;
  const service = {
    async contextForAgent() { return { workspaceId: 'workspace-other' }; },
    async reserveActivation() { reserves += 1; },
  };
  const handler = createActivationApiHandler(ctx, service);

  await assert.rejects(handler(jsonRequest('POST', {
    workspaceId: 'workspace-1',
    sessionId: 'session-root',
    baseVersion: 1,
    briefRevision: 1,
  })), (error) => error.code === 'session_workspace_mismatch');
  assert.equal(reserves, 0);
});

test('manual rerun API executes the current Eval through the live canonical session', async () => {
  const { ctx, agent } = activationContext('workspace-write');
  let execution;
  const state = activationState('active');
  const service = {
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async getProjectEvidence(workspaceId) {
      assert.equal(workspaceId, 'workspace-1');
      return { state, evaluation: { workflowVersion: '2.0.0', evalRevision: 1, cases: [] } };
    },
  };
  const evaluationTool = {
    async execute(args, value) {
      execution = { args, value };
      return { status: 'passed', summary: '5 个代理案例全部通过', results: [{ runId: 'run-1' }] };
    },
  };
  const handler = createEvaluationApiHandler(ctx, service, evaluationTool);

  const [status, body] = await handler(jsonRequest('POST', {
    workspaceId: 'workspace-1',
    sessionId: 'session-root',
  }));

  assert.equal(status, 200);
  assert.deepEqual(execution.args, {});
  assert.equal(execution.value.agent, agent);
  assert.equal(body.evaluationRun.status, 'passed');
  assert.equal(body.state, state);
});

test('real work APIs run member input and append version-bound feedback through the canonical session', async () => {
  const { ctx, agent } = activationContext('workspace-write');
  const state = activationState('active');
  let runExecution;
  let feedbackRequest;
  const service = {
    async contextForAgent(actual) {
      assert.equal(actual, agent);
      return { workspaceId: 'workspace-1', state };
    },
    async getProjectEvidence() {
      return { state, evaluation: { agentVersion: '1.0.0', workflowVersion: '1.0.0', evalRevision: 2, cases: [] } };
    },
    async recordRunFeedback(workspaceId, baseVersion, value, sessionId) {
      feedbackRequest = { workspaceId, baseVersion, value, sessionId };
      return state;
    },
  };
  const workRun = {
    async execute(args, value) {
      runExecution = { args, value };
      return { runId: 'run-real-1', status: 'passed', output: { action: '安排回访' } };
    },
  };

  const runRequest = jsonRequest('POST', {
    workspaceId: 'workspace-1', sessionId: 'session-root', caseTitle: '九月客户记录',
    input: { transcript: '客户希望下周回访' },
  });
  const staleRequest = new AbortController();
  staleRequest.abort();
  runRequest.signal = staleRequest.signal;
  const [runStatus, runBody] = await createRealWorkRunApiHandler(ctx, service, workRun)(runRequest);
  assert.equal(runStatus, 200);
  assert.deepEqual(runExecution.args, { caseTitle: '九月客户记录', input: { transcript: '客户希望下周回访' } });
  assert.equal(runExecution.value.agent, agent);
  assert.equal(runExecution.value.signal, undefined);
  assert.equal(runBody.workRun.runId, 'run-real-1');

  const [feedbackStatus] = await createRunFeedbackApiHandler(ctx, service)(jsonRequest('POST', {
    workspaceId: 'workspace-1', sessionId: 'session-root', baseVersion: 7,
    runId: 'run-real-1', verdict: 'needs_changes', note: '缺少负责人。',
  }));
  assert.equal(feedbackStatus, 200);
  assert.deepEqual(feedbackRequest, {
    workspaceId: 'workspace-1', baseVersion: 7,
    value: { runId: 'run-real-1', verdict: 'needs_changes', note: '缺少负责人。' }, sessionId: 'session-root',
  });
});

function activationState(status) {
  const state = createInitialState('客户周报');
  state.stateVersion = 7;
  state.brief.revision = 3;
  state.brief.confirmedRevision = 3;
  state.work = {
    sessionId: 'session-root',
    activeRevision: status === 'active' ? 3 : null,
    activation: {
      id: 'activation-1',
      briefRevision: 3,
      sessionId: 'session-root',
      status,
      messageId: null,
      error: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  };
  return state;
}

function activationContext(initialPreset = 'read-only') {
  const session = { id: 'session-root', header: {} };
  const agent = { id: 'session-root', session, status: 'idle' };
  const permission = new Map([[session, initialPreset]]);
  const flushes = { count: 0 };
  const ctx = {
    agents: { get: (id) => id === agent.id ? agent : undefined },
    permissionPresets: {
      names: ['read-only', 'workspace-write'],
      current: (value) => permission.get(value),
      set: (value, preset) => permission.set(value, preset),
    },
    sessions: {
      get: (id) => id === session.id ? session : undefined,
      async flush() { flushes.count += 1; return true; },
    },
  };
  return { ctx, agent, permission, flushes };
}

function jsonRequest(method, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    method,
    async *[Symbol.asyncIterator]() { yield body; },
  };
}

async function writeFileAfterMkdir(filename, contents) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}
