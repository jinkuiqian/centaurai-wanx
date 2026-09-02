import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BRIEF_FIELDS,
  REQUIRED_BRIEF_FIELDS,
  WanxiangStateService,
  canonicalProjectStatePath,
  confirmProjectState,
  createInitialState,
  deriveGuidance,
  deriveProjectState,
  finalizeActivation,
  migrateProjectState,
  parseLegacyBrief,
  renderBrief,
  reserveActivation,
  reserveDispatch,
  updateProjectState,
} from '../src/project-state.mjs';

const completeAnswers = () => Object.fromEntries(BRIEF_FIELDS.map(([key]) => [key, `${key} answer`]));

test('legacy briefs migrate as confirmed only when every field is substantive', () => {
  const complete = `# 客户跟进 · 已确认工作简报

## 真实任务与目标

每周整理客户

## 输入与资料

客户表

## 判断规则

按日期排序

## 交付结果

一张清单

## 边界与风险

不发送消息

## 验收标准

可以直接执行
`;
  const confirmed = parseLegacyBrief(complete, 'fallback', '2026-01-01T00:00:00.000Z');
  assert.equal(confirmed.projectName, '客户跟进');
  assert.equal(confirmed.schemaVersion, 2);
  assert.equal(confirmed.brief.revision, 1);
  assert.equal(confirmed.brief.confirmedRevision, 1);
  assert.equal(confirmed.brief.answers.examples, '');
  assert.deepEqual(confirmed.brief.fieldSources.examples, { status: 'unresolved', sourceMessageIds: [] });

  const draft = parseLegacyBrief(complete.replace('客户表', '待在万象需求发现中继续确认'), 'fallback');
  assert.equal(draft.brief.revision, 1);
  assert.equal(draft.brief.confirmedRevision, null);
});

test('initial v2 state exposes seven fields, provenance and derived readiness', () => {
  const state = createInitialState('新项目', '2026-01-01T00:00:00.000Z');

  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(Object.keys(state.brief.answers), BRIEF_FIELDS.map(([key]) => key));
  assert.deepEqual(Object.keys(state.brief.fieldSources), BRIEF_FIELDS.map(([key]) => key));
  assert.deepEqual(state.work, { sessionId: null, activeRevision: null, activation: null });
  assert.deepEqual(deriveProjectState(state), {
    phase: 'understanding',
    readiness: {
      ready: false,
      missingRequired: REQUIRED_BRIEF_FIELDS,
      unresolvedOptional: ['examples', 'rules', 'boundaries'],
    },
    guidance: {
      stage: 'understanding',
      progress: {
        requiredKnown: 0,
        requiredConfirmed: 0,
        requiredTotal: 4,
        allKnown: 0,
        allTotal: 7,
      },
      deferredFields: ['examples', 'rules', 'boundaries'],
      next: {
        kind: 'ask_field',
        field: 'goal',
        prompt: '请用一个最近真实发生的例子告诉我：你最终希望这项工作产出什么结果？',
      },
    },
  });
});

test('guidance advances through one fixed required-field question and then requests one review', () => {
  let state = createInitialState('客户周报');
  const expectedOrder = ['goal', 'inputs', 'output', 'success'];

  for (const key of expectedOrder) {
    assert.equal(deriveGuidance(state).next.field, key);
    state = updateProjectState(state, {
      answers: { [key]: `${key} answer` },
      fieldSources: { [key]: { status: 'inferred', sourceMessageIds: [`message-${key}`] } },
    });
  }

  const review = deriveGuidance(state);
  assert.equal(review.stage, 'reviewing');
  assert.equal(review.next.kind, 'review_and_confirm');
  assert.deepEqual(review.progress, {
    requiredKnown: 4,
    requiredConfirmed: 0,
    requiredTotal: 4,
    allKnown: 4,
    allTotal: 7,
  });
  assert.deepEqual(review.deferredFields, ['examples', 'rules', 'boundaries']);

  state = updateProjectState(state, {
    fieldSources: Object.fromEntries(expectedOrder.map((key) => [key, {
      status: 'user_confirmed',
      sourceMessageIds: state.brief.fieldSources[key].sourceMessageIds,
    }])),
  });
  const ready = deriveGuidance(state);
  assert.equal(ready.stage, 'ready');
  assert.equal(ready.next.kind, 'start_making');
  assert.equal(ready.progress.requiredConfirmed, 4);
});

test('guidance treats optional fields as non-blocking and covers the activation lifecycle', () => {
  let state = createInitialState('客户周报');
  state = updateProjectState(state, {
    answers: Object.fromEntries(REQUIRED_BRIEF_FIELDS.map((key) => [key, `${key} answer`])),
  });
  assert.equal(deriveGuidance(state).next.kind, 'start_making');
  assert.deepEqual(deriveGuidance(state).deferredFields, ['examples', 'rules', 'boundaries']);
  state = confirmProjectState(state, state.brief.revision);
  const reserved = reserveActivation(state, {
    briefRevision: state.brief.revision,
    sessionId: 'session-1',
  }, '2026-01-01T00:00:01.000Z', 'activation-1');
  assert.equal(deriveGuidance(reserved.state).next.kind, 'activation_pending');

  const active = finalizeActivation(reserved.state, {
    activationId: 'activation-1',
    status: 'active',
    messageId: 'message-1',
  });
  assert.equal(deriveGuidance(active).next.kind, 'continue_making');

  const changed = updateProjectState(active, { answers: { output: 'updated output' } });
  assert.equal(deriveGuidance(changed).next.kind, 'sync_changes');

  const retryReservation = reserveActivation(state, {
    briefRevision: state.brief.revision,
    sessionId: 'session-1',
  }, '2026-01-01T00:00:01.000Z', 'activation-2');
  const failed = finalizeActivation(retryReservation.state, {
    activationId: 'activation-2',
    status: 'failed',
    error: { code: 'permission_failed', message: 'permission failed' },
  });
  assert.equal(deriveGuidance(failed).next.kind, 'retry_activation');
});

test('v1 builder dispatch migrates safely into the canonical v2 work session', () => {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const answers = Object.fromEntries(BRIEF_FIELDS
    .filter(([key]) => key !== 'examples')
    .map(([key]) => [key, `${key} answer`]));
  const migrated = migrateProjectState({
    schemaVersion: 1,
    stateVersion: 7,
    projectName: '旧项目',
    brief: { answers, revision: 3, confirmedRevision: 3 },
    builder: {
      sessionId: 'session-old',
      lastDispatch: {
        id: 'dispatch-old',
        briefRevision: 3,
        builderSessionId: 'session-old',
        status: 'sent',
        attempt: 1,
        messageId: 'message-old',
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.stateVersion, 7);
  assert.equal(migrated.brief.answers.examples, '');
  assert.deepEqual(migrated.work, {
    sessionId: 'session-old',
    activeRevision: 3,
    activation: {
      id: 'dispatch-old',
      briefRevision: 3,
      sessionId: 'session-old',
      status: 'active',
      messageId: 'message-old',
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  assert.equal(deriveProjectState(migrated).phase, 'making');
});

test('sparse brief patches preserve provenance and exact no-op versions', () => {
  const initial = createInitialState('项目', '2026-01-01T00:00:00.000Z');
  const inferred = updateProjectState(initial, {
    answers: { goal: '每周生成客户跟进清单' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: ['message-1'] } },
  }, '2026-01-01T00:00:01.000Z');

  assert.equal(inferred.stateVersion, 2);
  assert.equal(inferred.brief.revision, 1);
  assert.deepEqual(inferred.brief.fieldSources.goal, {
    status: 'inferred',
    sourceMessageIds: ['message-1'],
  });
  const noOp = updateProjectState(inferred, {
    answers: { goal: '每周生成客户跟进清单' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: ['message-1'] } },
  });
  assert.equal(noOp, inferred);

  const userCorrection = updateProjectState(inferred, { answers: { goal: '每日生成跟进清单' } });
  assert.deepEqual(userCorrection.brief.fieldSources.goal, {
    status: 'user_confirmed',
    sourceMessageIds: [],
  });
  const repeatedByModel = updateProjectState(userCorrection, {
    answers: { goal: '每日生成跟进清单' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: ['message-2'] } },
  });
  assert.equal(repeatedByModel, userCorrection);
});

test('migration writes project.json without replacing the legacy work brief', async (t) => {
  const root = await temporaryDirectory(t);
  const artifactRoot = path.join(root, '.wanxiang');
  await mkdir(artifactRoot);
  const legacy = '# 草稿项目 · 已确认工作简报\n\n## 真实任务与目标\n\n待在万象需求发现中继续确认\n';
  await writeFile(path.join(artifactRoot, 'work-brief.md'), legacy);
  await writeFile(path.join(root, 'AGENTS.md'), '# 用户自己的项目规则\n');
  await writeFile(path.join(artifactRoot, 'data-contract.json'), `${JSON.stringify({ status: 'sample-contract-only', connected: false, sources: [{ id: 'legacy-source' }], restrictions: ['no writes'] })}\n`);
  const registry = registryFor({ id: 'workspace-1', path: root, title: '工作区标题' });
  const service = serviceFor(registry);

  const state = await service.getProject('workspace-1');

  assert.equal(state.projectName, '草稿项目');
  assert.equal(state.brief.confirmedRevision, null);
  assert.equal(await readFile(path.join(artifactRoot, 'work-brief.md'), 'utf8'), legacy);
  assert.equal(JSON.parse(await readFile(path.join(artifactRoot, 'project.json'), 'utf8')).schemaVersion, 2);
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /# 用户自己的项目规则[\s\S]*WANXIANG:MANAGED:START version=2/u);
  assert.doesNotMatch(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /万象 Builder 项目规则/u);
  const contract = JSON.parse(await readFile(path.join(artifactRoot, 'data-contract.json'), 'utf8'));
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.stateVersion, 1);
  assert.equal(contract.managedBy, 'wanxiang');
  assert.equal(contract.sources[0].id, 'legacy-source');
});

test('workspace serialization makes concurrent CAS updates accept only one writer', async (t) => {
  const root = await temporaryDirectory(t);
  const registry = registryFor({ id: 'workspace-2', path: root, title: '项目' });
  const service = serviceFor(registry);
  const initial = await service.getProject('workspace-2');
  const first = { projectName: '版本 A', answers: completeAnswers() };
  const second = { projectName: '版本 B', answers: completeAnswers() };

  const results = await Promise.allSettled([
    service.updateProject('workspace-2', initial.stateVersion, first),
    service.updateProject('workspace-2', initial.stateVersion, second),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'revision_conflict');
  assert.equal(rejected.reason.current.stateVersion, 2);
});

test('work-brief.md is generated atomically only by confirm', async (t) => {
  const root = await temporaryDirectory(t);
  const registry = registryFor({ id: 'workspace-3', path: root, title: '项目' });
  const service = serviceFor(registry);
  const initial = await service.getProject('workspace-3');
  const updated = await service.updateProject('workspace-3', initial.stateVersion, {
    projectName: '已确认项目',
    answers: completeAnswers(),
  });
  await assert.rejects(readFile(path.join(root, '.wanxiang', 'work-brief.md')), { code: 'ENOENT' });

  const confirmed = await service.confirmProject('workspace-3', updated.stateVersion, updated.brief.revision);

  assert.equal(confirmed.brief.confirmedRevision, updated.brief.revision);
  assert.match(await readFile(path.join(root, '.wanxiang', 'work-brief.md'), 'utf8'), /^# 已确认项目 · 已确认工作简报/mu);
});

test('confirmed brief renders unresolved optional fields as production-time validation', () => {
  const state = createInitialState('可验证项目', '2026-01-01T00:00:00.000Z');
  for (const key of REQUIRED_BRIEF_FIELDS) state.brief.answers[key] = `${key} answer`;
  state.brief.revision = 1;
  const confirmed = confirmProjectState(state, 1);

  const markdown = renderBrief(confirmed);

  assert.match(markdown, /## 代表案例\n\n制作中验证/u);
  assert.match(markdown, /## 判断与优先级规则\n\n制作中验证/u);
  assert.match(markdown, /## 排除项与风险边界\n\n制作中验证/u);
});

test('activation atomically confirms and binds the same session exactly once', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = await temporaryDirectory(t);
  const registry = registryFor({ id: 'workspace-activation', path: root, title: '项目', sessionIds: ['session-1', 'session-2'] });
  const service = serviceFor(registry, { dataRoot });
  let state = await service.getProject('workspace-activation');
  state = await service.updateProject('workspace-activation', state.stateVersion, {
    answers: Object.fromEntries(REQUIRED_BRIEF_FIELDS.map((key) => [key, `${key} answer`])),
  });

  const reserved = await service.reserveActivation('workspace-activation', {
    baseVersion: state.stateVersion,
    briefRevision: state.brief.revision,
    sessionId: 'session-1',
  });

  assert.equal(reserved.disposition, 'reserved');
  assert.equal(reserved.state.brief.confirmedRevision, state.brief.revision);
  assert.equal(reserved.state.work.sessionId, 'session-1');
  assert.equal(reserved.activation.status, 'pending');
  assert.equal(deriveProjectState(reserved.state).phase, 'ready');
  assert.match(await readFile(path.join(root, '.wanxiang', 'work-brief.md'), 'utf8'), /制作中验证/u);

  const duplicate = await service.reserveActivation('workspace-activation', {
    baseVersion: reserved.state.stateVersion,
    briefRevision: state.brief.revision,
    sessionId: 'session-1',
  });
  assert.equal(duplicate.disposition, 'in-progress');
  assert.equal(duplicate.state.stateVersion, reserved.state.stateVersion);
  assert.equal(duplicate.activation.id, reserved.activation.id);

  const active = await service.finalizeActivation('workspace-activation', {
    activationId: reserved.activation.id,
    status: 'active',
    messageId: 'message-activation',
  });
  assert.equal(active.work.activeRevision, state.brief.revision);
  assert.equal(deriveProjectState(active).phase, 'making');
  const activeContract = await readFile(path.join(root, '.wanxiang', 'work-brief.md'), 'utf8');

  const competingSession = await service.reserveActivation('workspace-activation', {
    baseVersion: active.stateVersion,
    briefRevision: state.brief.revision,
    sessionId: 'session-2',
  });
  assert.equal(competingSession.disposition, 'already-active');
  assert.equal(competingSession.state.stateVersion, active.stateVersion);
  assert.equal(competingSession.activation.sessionId, 'session-1');

  const changed = await service.updateProject('workspace-activation', active.stateVersion, {
    answers: { examples: '上周客户跟进表' },
  });
  assert.equal(deriveProjectState(changed).phase, 'changed');
  assert.equal(changed.brief.answers.examples, '上周客户跟进表');
  assert.equal(changed.brief.confirmedAnswers.examples, '');
  assert.equal(await readFile(path.join(root, '.wanxiang', 'work-brief.md'), 'utf8'), activeContract);

  await writeFile(path.join(root, '.wanxiang', 'work-brief.md'), '# 被篡改的契约\n');
  await service.getProject('workspace-activation');
  assert.equal(await readFile(path.join(root, '.wanxiang', 'work-brief.md'), 'utf8'), activeContract);

  const syncing = await service.reserveActivation('workspace-activation', {
    baseVersion: changed.stateVersion,
    briefRevision: changed.brief.revision,
    sessionId: 'session-1',
  });
  assert.equal(syncing.state.brief.confirmedAnswers.examples, '上周客户跟进表');
  const rolledBack = await service.finalizeActivation('workspace-activation', {
    activationId: syncing.activation.id,
    status: 'failed',
    error: { code: 'permission_transition_failed', message: '权限切换失败' },
  });
  assert.equal(rolledBack.work.activeRevision, active.work.activeRevision);
  assert.equal(rolledBack.brief.confirmedRevision, active.brief.confirmedRevision);
  assert.equal(rolledBack.brief.confirmedAnswers.examples, '');
  assert.equal(rolledBack.brief.answers.examples, '上周客户跟进表');
  assert.equal(deriveProjectState(rolledBack).phase, 'failed');
  assert.equal(await readFile(path.join(root, '.wanxiang', 'work-brief.md'), 'utf8'), activeContract);
});

test('first activation failure rolls confirmation back to an unconfirmed draft', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = await temporaryDirectory(t);
  const workspace = { id: 'workspace-first-failure', path: root, title: '项目', sessionIds: ['session-1'] };
  const service = serviceFor(registryFor(workspace), { dataRoot });
  let state = await service.getProject(workspace.id);
  state = await service.updateProject(workspace.id, state.stateVersion, {
    answers: Object.fromEntries(REQUIRED_BRIEF_FIELDS.map((key) => [key, `${key} answer`])),
  });
  const reserved = await service.reserveActivation(workspace.id, {
    baseVersion: state.stateVersion,
    briefRevision: state.brief.revision,
    sessionId: 'session-1',
  });

  const failed = await service.finalizeActivation(workspace.id, {
    activationId: reserved.activation.id,
    status: 'failed',
    error: { code: 'permission_transition_failed', message: '权限切换失败' },
  });

  assert.equal(failed.brief.confirmedRevision, null);
  assert.equal(failed.brief.confirmedAnswers, null);
  assert.equal(failed.work.activeRevision, null);
  assert.equal(failed.work.activation.status, 'failed');
  assert.equal(Object.hasOwn(failed.work.activation, 'previousConfirmed'), false);
  await assert.rejects(readFile(path.join(root, '.wanxiang', 'work-brief.md')), { code: 'ENOENT' });
});

test('failed activation is retry-safe and derived as a recoverable failure', () => {
  const state = createInitialState('项目', '2026-01-01T00:00:00.000Z');
  state.brief.answers = completeAnswers();
  state.brief.revision = 1;
  const confirmed = confirmProjectState(state, 1);
  const reserved = reserveActivation(confirmed, {
    briefRevision: 1,
    sessionId: 'session-1',
  }, '2026-01-01T00:00:01.000Z', 'activation-1');
  const failed = finalizeActivation(reserved.state, {
    activationId: 'activation-1',
    status: 'failed',
    error: { code: 'runtime_disconnected', message: '运行时断开' },
  }, '2026-01-01T00:00:02.000Z');

  assert.equal(deriveProjectState(failed).phase, 'failed');
  assert.throws(() => reserveActivation(failed, { briefRevision: 1, sessionId: 'session-1' }), {
    code: 'activation_failed',
  });
  const retry = reserveActivation(failed, { briefRevision: 1, sessionId: 'session-1', retry: true }, undefined, 'activation-2');
  assert.equal(retry.disposition, 'reserved');
  assert.equal(retry.activation.id, 'activation-2');
});

test('dispatch reservation is idempotent and finalization prevents a second send', () => {
  const initial = createInitialState('项目', '2026-01-01T00:00:00.000Z');
  initial.brief.answers = completeAnswers();
  initial.brief.revision = 1;
  initial.brief.confirmedRevision = 1;
  const reserved = reserveDispatch(initial, {
    briefRevision: 1,
    builderSessionId: 'session-1',
  }, '2026-01-01T00:00:01.000Z', 'dispatch-1');
  assert.equal(reserved.disposition, 'reserved');

  const duplicate = reserveDispatch(reserved.state, {
    briefRevision: 1,
    builderSessionId: 'session-1',
  });
  assert.equal(duplicate.disposition, 'in-progress');
  assert.equal(duplicate.dispatch.id, 'dispatch-1');

  const competingSession = reserveDispatch(reserved.state, {
    briefRevision: 1,
    builderSessionId: 'session-2',
  });
  assert.equal(competingSession.disposition, 'in-progress');
  assert.equal(competingSession.dispatch.builderSessionId, 'session-1');
});

test('confirmed canonical state repairs a pending derived brief after restart', async (t) => {
  const root = await temporaryDirectory(t);
  const artifactRoot = path.join(root, '.wanxiang');
  await mkdir(artifactRoot);
  const state = createInitialState('可恢复项目', '2026-01-01T00:00:00.000Z');
  state.brief.answers = completeAnswers();
  state.brief.revision = 1;
  const confirmed = confirmProjectState(state, 1);
  await writeFile(path.join(artifactRoot, 'project.json'), `${JSON.stringify(confirmed)}\n`);
  await writeFile(path.join(artifactRoot, '.work-brief.pending.md'), renderBrief(confirmed));
  const service = serviceFor(registryFor({ id: 'workspace-recovery', path: root, title: '项目' }));

  await service.getProject('workspace-recovery');

  assert.equal(await readFile(path.join(artifactRoot, 'work-brief.md'), 'utf8'), renderBrief(confirmed));
  await assert.rejects(readFile(path.join(artifactRoot, '.work-brief.pending.md')), { code: 'ENOENT' });
});

test('protected canonical state repairs an Agent-tampered workspace mirror', async (t) => {
  const parent = await temporaryDirectory(t);
  const workspacePath = path.join(parent, 'workspace');
  const dataRoot = path.join(parent, 'runtime-data');
  await mkdir(workspacePath);
  const workspace = { id: 'workspace/canonical', path: workspacePath, title: '权威项目', sessionIds: [] };
  const service = serviceFor(registryFor(workspace), { projectsRoot: parent, dataRoot });
  let state = await service.getProject(workspace.id);
  state = await service.updateProject(workspace.id, state.stateVersion, {
    projectName: '真实项目',
    answers: { goal: '处理真实任务' },
  });
  const canonicalFilename = canonicalProjectStatePath(dataRoot, workspace.id);
  assert.equal(JSON.parse(await readFile(canonicalFilename, 'utf8')).projectName, '真实项目');

  const forged = { ...state, stateVersion: 999, projectName: '被 Agent 篡改' };
  await writeFile(path.join(workspacePath, '.wanxiang', 'project.json'), `${JSON.stringify(forged, null, 2)}\n`);

  const reloaded = await service.getProject(workspace.id);

  assert.equal(reloaded.stateVersion, state.stateVersion);
  assert.equal(reloaded.projectName, '真实项目');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(workspacePath, '.wanxiang', 'project.json'), 'utf8')),
    reloaded,
  );
});

test('existing v1 mirror seeds protected canonical storage once', async (t) => {
  const parent = await temporaryDirectory(t);
  const workspacePath = path.join(parent, 'workspace');
  const dataRoot = path.join(parent, 'runtime-data');
  const artifactRoot = path.join(workspacePath, '.wanxiang');
  await mkdir(artifactRoot, { recursive: true });
  const legacy = {
    schemaVersion: 1,
    stateVersion: 4,
    projectName: '迁移项目',
    brief: {
      answers: Object.fromEntries(BRIEF_FIELDS.filter(([key]) => key !== 'examples').map(([key]) => [key, `${key} answer`])),
      revision: 1,
      confirmedRevision: 1,
    },
    builder: { sessionId: null, lastDispatch: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(path.join(artifactRoot, 'project.json'), `${JSON.stringify(legacy)}\n`);
  const workspace = { id: 'workspace-migrate-v1', path: workspacePath, title: '项目', sessionIds: [] };
  const service = serviceFor(registryFor(workspace), { projectsRoot: parent, dataRoot });

  const migrated = await service.getProject(workspace.id);

  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.stateVersion, 4);
  assert.equal(migrated.brief.answers.examples, '');
  assert.deepEqual(
    JSON.parse(await readFile(canonicalProjectStatePath(dataRoot, workspace.id), 'utf8')),
    migrated,
  );
});

test('dirty v1 migration recovers the confirmed contract from work-brief.md', async (t) => {
  const parent = await temporaryDirectory(t);
  const workspacePath = path.join(parent, 'workspace');
  const dataRoot = path.join(parent, 'runtime-data');
  const artifactRoot = path.join(workspacePath, '.wanxiang');
  await mkdir(artifactRoot, { recursive: true });
  const legacyKeys = BRIEF_FIELDS.map(([key]) => key).filter((key) => key !== 'examples');
  const confirmedAnswers = Object.fromEntries(legacyKeys.map((key) => [key, `old ${key}`]));
  const draftAnswers = { ...confirmedAnswers, goal: 'new goal' };
  const v1 = {
    schemaVersion: 1,
    stateVersion: 5,
    projectName: '有修改的旧项目',
    brief: { answers: draftAnswers, revision: 2, confirmedRevision: 1 },
    builder: { sessionId: null, lastDispatch: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
  const legacyMarkdown = `# 有修改的旧项目 · 已确认工作简报\n\n${BRIEF_FIELDS
    .filter(([key]) => key !== 'examples')
    .map(([key, label]) => `## ${label}\n\n${confirmedAnswers[key]}`)
    .join('\n\n')}\n`;
  await writeFile(path.join(artifactRoot, 'project.json'), `${JSON.stringify(v1)}\n`);
  await writeFile(path.join(artifactRoot, 'work-brief.md'), legacyMarkdown);
  const workspace = { id: 'workspace-dirty-v1', path: workspacePath, title: '项目', sessionIds: [] };
  const service = serviceFor(registryFor(workspace), { projectsRoot: parent, dataRoot });

  const migrated = await service.getProject(workspace.id);

  assert.equal(migrated.brief.answers.goal, 'new goal');
  assert.equal(migrated.brief.confirmedAnswers.goal, 'old goal');
  assert.equal(migrated.brief.confirmedRevision, 1);
  assert.equal(await readFile(path.join(artifactRoot, 'work-brief.md'), 'utf8'), renderBrief(migrated));
});

test('rejects a registered workspace outside the managed project root', async (t) => {
  const managedRoot = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  const registry = registryFor({ id: 'outside', path: outside, title: '外部目录' });
  const service = serviceFor(registry, { projectsRoot: managedRoot });

  await assert.rejects(service.getProject('outside'), { code: 'workspace_outside_managed_root', statusCode: 403 });
});

test('explicit import persists the registered workspace real path and rejects path substitution', async (t) => {
  const managedRoot = await temporaryDirectory(t);
  const dataRoot = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  const replacement = await temporaryDirectory(t);
  let workspace = { id: 'imported', path: outside, title: '已有项目', sessionIds: [] };
  const registry = {
    get(id) { return id === workspace.id ? workspace : undefined; },
    list() { return [workspace]; },
    async resolveByPath(workspacePath) { return workspace.path === workspacePath ? workspace : undefined; },
  };
  const service = serviceFor(registry, { projectsRoot: managedRoot, dataRoot });

  await assert.rejects(service.getProject(workspace.id), { code: 'workspace_outside_managed_root' });
  const imported = await service.importProject(workspace.id);
  assert.equal(imported.state.projectName, '已有项目');
  assert.equal(JSON.parse(await readFile(path.join(outside, '.wanxiang', 'project.json'), 'utf8')).schemaVersion, 2);

  const restarted = serviceFor(registry, { projectsRoot: managedRoot, dataRoot });
  assert.equal((await restarted.getProject(workspace.id)).projectName, '已有项目');

  workspace = { ...workspace, path: replacement };
  await assert.rejects(restarted.getProject(workspace.id), { code: 'workspace_outside_managed_root' });
});

test('project creation rolls back its registry record and directory when initialization fails', async (t) => {
  const projectsRoot = await temporaryDirectory(t);
  const invalidWorkspacePath = path.join(projectsRoot, 'not-a-directory');
  await writeFile(invalidWorkspacePath, 'file');
  let deletedId = null;
  let createdPath = null;
  const registry = {
    get() {},
    async create(workspacePath) {
      createdPath = workspacePath;
      return { id: 'ghost', path: invalidWorkspacePath, title: '失败项目' };
    },
    async delete(id) { deletedId = id; return true; },
  };
  const service = serviceFor(registry, { projectsRoot });

  await assert.rejects(service.createProject('失败项目'));

  assert.equal(deletedId, 'ghost');
  await assert.rejects(readFile(createdPath), { code: 'ENOENT' });
});

test('community outbox persists local drafts globally and deletes by id', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const registry = registryFor({ id: 'workspace-4', path: workspace, title: '项目' });
  const service = serviceFor(registry, { dataRoot });

  const item = await service.addOutboxItem({ workspaceId: 'workspace-4', kind: 'feedback', message: '希望支持导出' });
  assert.equal(item.status, 'local-draft');
  assert.deepEqual(await service.listOutbox(), [item]);
  assert.equal((await service.deleteOutboxItem(item.id)).id, item.id);
  assert.deepEqual(await service.listOutbox(), []);
});

test('session brief context defaults safely and persists explicit ordinary-session overrides', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = path.join(root, 'data');
  const workspacePath = path.join(root, 'workspace');
  await mkdir(workspacePath);
  const workspace = { id: 'workspace-context', path: workspacePath, title: '项目', sessionIds: ['builder', 'chat'] };
  const registry = registryFor(workspace);
  const service = serviceFor(registry, { projectsRoot: root, dataRoot });
  const initial = await service.getProject(workspace.id);
  const updated = await service.updateProject(workspace.id, initial.stateVersion, { projectName: '上下文项目', answers: completeAnswers() });
  const confirmed = await service.confirmProject(workspace.id, updated.stateVersion, updated.brief.revision);
  await service.reserveDispatch(workspace.id, { briefRevision: confirmed.brief.revision, builderSessionId: 'builder' });

  assert.deepEqual(await service.getSessionContext(workspace.id, 'builder'), {
    sessionId: 'builder', builder: true, confirmed: true, confirmedRevision: 1, enabled: true,
  });
  assert.equal((await service.getSessionContext(workspace.id, 'chat')).enabled, true);
  assert.equal((await service.setSessionContext(workspace.id, 'chat', false)).enabled, false);
  assert.equal((await service.getSessionContext(workspace.id, 'chat')).enabled, false);
  assert.equal((await service.contextForAgent({ id: 'chat', session: { header: { cwd: workspacePath, origin: 'user' } } })).text, '');
  await service.setSessionContext(workspace.id, 'chat', true);
  const context = await service.contextForAgent({ id: 'chat', session: { header: { cwd: workspacePath, origin: 'user' } } });
  assert.match(context.text, /^# 上下文项目/u);
  assert.equal(context.workspaceId, workspace.id);
  assert.equal(context.state.schemaVersion, 2);
  assert.equal(context.projection.phase, 'ready');
  assert.equal(await service.contextForAgent({ id: 'child', session: { header: { cwd: workspacePath, origin: 'subagent' } } }), null);
  await assert.rejects(service.getSessionContext(workspace.id, 'other'), { code: 'session_workspace_mismatch' });
});

test('Agent brief updates derive the managed workspace and reject subagents', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = await temporaryDirectory(t);
  const workspace = { id: 'workspace-agent', path: root, title: '项目', sessionIds: ['root-session'] };
  const service = serviceFor(registryFor(workspace), { dataRoot });
  const initial = await service.getProject(workspace.id);
  const agent = { id: 'root-session', session: { header: { cwd: root } } };

  const updated = await service.updateProjectForAgent(agent, initial.stateVersion, {
    answers: { goal: '整理每周客户信息' },
    fieldSources: { goal: { status: 'inferred', sourceMessageIds: ['message-1'] } },
  });

  assert.equal(updated.workspaceId, workspace.id);
  assert.equal(updated.state.brief.answers.goal, '整理每周客户信息');
  await assert.rejects(service.updateProjectForAgent({
    id: 'child',
    session: { header: { cwd: root, origin: 'subagent' } },
  }, updated.state.stateVersion, { answers: { goal: '越权修改' } }), {
    code: 'agent_workspace_unavailable',
  });
});

test('protected project state keeps immutable evaluation attempts and retry lineage by runId', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = await temporaryDirectory(t);
  const workspace = { id: 'workspace-runs', path: root, title: '项目', sessionIds: ['session-1'] };
  const service = serviceFor(registryFor(workspace), { dataRoot });
  const run = {
    runId: 'run-1',
    sessionId: 'session-1',
    caseId: 'case-1',
    workflowVersion: '2.0.0',
    evalRevision: 3,
    workBriefRevision: 7,
    retryOf: null,
    startedAt: '2026-09-02T10:00:00.000Z',
  };

  const running = await service.startEvaluationRun(workspace.id, run);
  assert.equal(running.runs.byId['run-1'].status, 'running');
  assert.equal(running.runs.latestRunId, 'run-1');

  const failed = await service.finishEvaluationRun(workspace.id, {
    runId: 'run-1',
    status: 'failed',
    conclusion: 'timed_out',
    completedAt: '2026-09-02T10:00:05.000Z',
    evidence: { summary: 'Workflow 超时。', assertions: [], error: { code: 'workflow_timeout', message: 'Workflow 超时。' } },
  });
  const failedVersion = failed.stateVersion;
  assert.equal(failed.runs.byId['run-1'].conclusion, 'timed_out');

  const duplicate = await service.finishEvaluationRun(workspace.id, {
    runId: 'run-1',
    status: 'failed',
    conclusion: 'timed_out',
    completedAt: '2026-09-02T10:00:05.000Z',
    evidence: { summary: 'Workflow 超时。', assertions: [], error: { code: 'workflow_timeout', message: 'Workflow 超时。' } },
  });
  assert.equal(duplicate.stateVersion, failedVersion);
  await assert.rejects(service.finishEvaluationRun(workspace.id, {
    runId: 'run-1', status: 'passed', conclusion: 'passed', completedAt: '2026-09-02T10:00:06.000Z', evidence: {},
  }), { code: 'evaluation_run_already_finalized' });

  const retried = await service.startEvaluationRun(workspace.id, {
    ...run,
    runId: 'run-2',
    retryOf: 'run-1',
    startedAt: '2026-09-02T10:01:00.000Z',
  });
  assert.deepEqual(retried.runs.order, ['run-1', 'run-2']);
  assert.equal(retried.runs.byId['run-2'].retryOf, 'run-1');
  assert.equal(retried.runs.byId['run-1'].status, 'failed');
  const competing = await Promise.allSettled([
    service.finishEvaluationRun(workspace.id, {
      runId: 'run-2', status: 'passed', conclusion: 'passed', completedAt: '2026-09-02T10:01:01.000Z',
      evidence: { summary: '通过', assertions: [{ id: 'a', passed: true }] },
    }),
    service.finishEvaluationRun(workspace.id, {
      runId: 'run-2', status: 'cancelled', conclusion: 'cancelled', completedAt: '2026-09-02T10:01:02.000Z',
      evidence: { summary: '取消', assertions: [], error: { code: 'workflow_cancelled', message: '取消' } },
    }),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competing.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(competing.find((result) => result.status === 'rejected').reason.code, 'evaluation_run_already_finalized');
  await assert.rejects(service.startEvaluationRun(workspace.id, { ...run, runId: 'run-1' }), {
    code: 'evaluation_run_id_conflict',
  });

  const canonical = JSON.parse(await readFile(canonicalProjectStatePath(dataRoot, workspace.id), 'utf8'));
  const mirror = JSON.parse(await readFile(path.join(root, '.wanxiang', 'project.json'), 'utf8'));
  assert.equal(canonical.runs.byId['run-2'].retryOf, 'run-1');
  assert.notEqual(canonical.runs.byId['run-2'].status, 'running');
  assert.equal(mirror.runs.byId['run-1'].conclusion, 'timed_out');
});

test('runtime restart recovers unfinished evaluation attempts as explicit fail-closed evidence', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = await temporaryDirectory(t);
  const workspace = { id: 'workspace-restart', path: root, title: '项目', sessionIds: ['session-1'] };
  const registry = registryFor(workspace);
  const firstRuntime = serviceFor(registry, { dataRoot, runtimeId: 'runtime-1' });
  await firstRuntime.startEvaluationRun(workspace.id, {
    runId: 'run-interrupted',
    sessionId: 'session-1',
    caseId: 'case-1',
    workflowVersion: '2.0.0',
    evalRevision: 1,
    workBriefRevision: 1,
    retryOf: null,
    startedAt: '2026-09-02T10:00:00.000Z',
  });

  assert.equal((await firstRuntime.getProject(workspace.id)).runs.byId['run-interrupted'].status, 'running');

  const restartedRuntime = serviceFor(registry, { dataRoot, runtimeId: 'runtime-2' });
  const recovered = await restartedRuntime.getProject(workspace.id);
  assert.equal(recovered.runs.byId['run-interrupted'].status, 'failed');
  assert.equal(recovered.runs.byId['run-interrupted'].conclusion, 'interrupted');
  assert.equal(recovered.runs.byId['run-interrupted'].evidence.error.code, 'runtime_restarted');

  const canonical = JSON.parse(await readFile(canonicalProjectStatePath(dataRoot, workspace.id), 'utf8'));
  const mirror = JSON.parse(await readFile(path.join(root, '.wanxiang', 'project.json'), 'utf8'));
  assert.equal(canonical.runs.byId['run-interrupted'].conclusion, 'interrupted');
  assert.equal(mirror.runs.byId['run-interrupted'].conclusion, 'interrupted');
});

test('project evidence snapshot joins protected workflow, eval and run facts for refresh recovery', async (t) => {
  const root = await temporaryDirectory(t);
  const dataRoot = await temporaryDirectory(t);
  const workspace = { id: 'workspace-evidence', path: root, title: '项目', sessionIds: ['session-1'] };
  const evaluationStore = {
    async load(project) {
      assert.deepEqual(project, { workspaceId: workspace.id, workspacePath: root });
      return {
        workflow: { workflowVersion: '2.3.0' },
        eval: { revision: 4, cases: [{ id: 'case-1', title: '超过 14 天未跟进', kind: 'normal', input: {}, expected: {} }] },
      };
    },
  };
  const service = serviceFor(registryFor(workspace), { dataRoot, evaluationStore, runtimeId: 'runtime-1' });
  await service.startEvaluationRun(workspace.id, {
    runId: 'run-1', sessionId: 'session-1', caseId: 'case-1', workflowVersion: '2.3.0',
    evalRevision: 4, workBriefRevision: 1, retryOf: null, startedAt: '2026-09-02T10:00:00.000Z',
  });

  const snapshot = await service.getProjectEvidence(workspace.id);
  assert.equal(snapshot.evaluation.workflowVersion, '2.3.0');
  assert.equal(snapshot.evaluation.evalRevision, 4);
  assert.deepEqual(snapshot.evaluation.cases, [{ id: 'case-1', title: '超过 14 天未跟进', kind: 'normal' }]);
  assert.equal(snapshot.state.runs.byId['run-1'].runId, 'run-1');
});

test('project creation requires a host-owned root', async () => {
  const service = serviceFor(registryFor());
  await assert.rejects(service.createProject('新项目'), { code: 'project_root_unavailable', statusCode: 503 });
});

function serviceFor(workspaceRegistry, options = {}) {
  let sequence = 0;
  return new WanxiangStateService({
    workspaceRegistry,
    projectsRoot: Object.hasOwn(options, 'projectsRoot') ? options.projectsRoot : workspaceRegistry.managedRoot || null,
    dataRoot: options.dataRoot || null,
    evaluationStore: options.evaluationStore || null,
    runtimeId: options.runtimeId,
    now: () => `2026-01-01T00:00:0${Math.min(sequence, 9)}.000Z`,
    id: () => `id-${++sequence}`,
  });
}

function registryFor(initial) {
  const workspaces = new Map(initial ? [[initial.id, initial]] : []);
  return {
    managedRoot: initial?.path || null,
    get(id) { return workspaces.get(id); },
    list() { return [...workspaces.values()]; },
    async resolveByPath(workspacePath) { return [...workspaces.values()].find((workspace) => workspace.path === workspacePath); },
    async create(workspacePath, title) {
      const workspace = { id: `workspace-${workspaces.size + 1}`, path: workspacePath, title };
      workspaces.set(workspace.id, workspace);
      return workspace;
    },
    async delete(id) { return workspaces.delete(id); },
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
