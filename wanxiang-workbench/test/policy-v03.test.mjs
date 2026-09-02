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
  createPublicWebFetchTool,
  createWorkBriefTool,
  discoveryToolAllowed,
  evaluationPolicy,
  inject,
  renderPromptWorkDescription,
} from '../src/policy.mjs';
import { createInitialState, deriveProjectState, serviceError, updateProjectState } from '../src/project-state.mjs';

test('workbench composition registers the proxy-run tool adapter and DSH projection seams', () => {
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
  assert.equal(projections.get('wanxiang.proxy-run')?.stateVersion, 3);
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
  assert.equal(result.guidance.next.field, 'inputs');
  assert.equal(result.guidance.progress.requiredKnown, 1);
});

test('work-description tool returns a structured current snapshot on CAS conflict', async () => {
  const current = createInitialState('客户周报');
  current.stateVersion = 4;
  current.brief.revision = 2;
  current.brief.answers.goal = '最新目标';
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
  assert.equal(result.guidance.next.field, 'inputs');
  assert.deepEqual(result.guidance, result.current.guidance);
});

test('work-description tool keeps confirmed provenance when the model repeats an unchanged value', async () => {
  const state = createInitialState('客户周报');
  state.brief.answers.goal = '生成客户周报';
  state.brief.fieldSources.goal = { status: 'user_confirmed', sourceMessageIds: ['message-1'] };
  let writes = 0;
  const tool = createWorkBriefTool({
    async contextForAgent() { return { workspaceId: 'workspace-1', state }; },
    async updateProjectForAgent() { writes += 1; },
  });

  const result = await tool.execute({ baseStateVersion: 1, patch: { goal: '生成客户周报' } }, {
    agent: { id: 'session-root', session: { header: {} } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.updatedFields, []);
  assert.equal(writes, 0);
  assert.equal(state.brief.fieldSources.goal.status, 'user_confirmed');
  assert.equal(result.guidance.next.field, 'inputs');
});

test('work-description prompt exposes one deterministic next question and response discipline', () => {
  let state = createInitialState('客户周报');
  state = updateProjectState(state, {
    answers: { goal: '把每周客户沟通记录整理成周报' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: ['message-1'] } },
  });

  const prompt = renderPromptWorkDescription(state, deriveProjectState(state), false);

  assert.match(prompt, /唯一下一步：ask_field/u);
  assert.match(prompt, /对应字段：输入与资料来源/u);
  assert.match(prompt, /请上传或指出一份最近实际使用过的材料/u);
  assert.match(prompt, /先更新工作说明，再用 1–2 句复述当前理解/u);
  assert.match(prompt, /只能询问上面的唯一问题/u);
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
  const agent = { id: 'session-root', session: { header: { cwd: workspacePath } } };
  const state = { brief: { revision: 4 }, work: { sessionId: agent.id, activeRevision: 4 } };
  const calls = [];
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
  assert.deepEqual(calls[0].args, {});
  assert.equal(calls[0].execution, execution);

  const unrelated = { ...execution, arguments: { code: 'write README' } };
  await hooks.before(unrelated, async () => accepted);
  await writeFile(path.join(workspacePath, 'README.md'), 'unrelated');
  await hooks.after(unrelated, { isError: false }, async () => accepted);
  assert.equal(calls.length, 1);

  const partialFailure = { ...execution, arguments: { code: 'write then exit nonzero' } };
  await hooks.before(partialFailure, async () => accepted);
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'changed before tool error');
  await hooks.after(partialFailure, { isError: true }, async () => accepted);
  assert.equal(calls.length, 2);

  const controller = new AbortController();
  const cancelledAfterWrite = { ...execution, signal: controller.signal };
  await hooks.before(cancelledAfterWrite, async () => accepted);
  await writeFile(path.join(artifactRoot, 'workflow.mjs'), 'changed before cancellation');
  controller.abort();
  await hooks.after(cancelledAfterWrite, { isError: true }, async () => accepted);
  assert.equal(calls.length, 3);
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
