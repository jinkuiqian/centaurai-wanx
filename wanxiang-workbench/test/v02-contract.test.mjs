import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BRIEF_FIELDS,
  WanxiangStateService,
  deriveProjectState,
} from '../src/project-state.mjs';

const ANSWER_KEYS = BRIEF_FIELDS.map(([key]) => key);

test('v0.3 state contract survives understand-to-make in one canonical session', async (t) => {
  const fixture = await createFixture(t);
  let state = await fixture.service.getProject(fixture.workspace.id);

  assertStateContract(state, {
    projectName: '客户周报项目',
    stateVersion: 1,
    briefRevision: 0,
    confirmedRevision: null,
  });
  assert.deepEqual(deriveProjectState(state), {
    phase: 'understanding',
    readiness: {
      ready: false,
      missingRequired: ['goal', 'inputs', 'output', 'success'],
      unresolvedOptional: ['examples', 'rules', 'boundaries'],
    },
    guidance: {
      schemaVersion: 2,
      stateVersion: 1,
      briefRevision: 0,
      stage: 'understanding',
      understanding: {
        answers: Object.fromEntries(ANSWER_KEYS.map((key) => [key, ''])),
        fieldSources: Object.fromEntries(ANSWER_KEYS.map((key) => [key, {
          status: 'unresolved',
          sourceMessageIds: [],
        }])),
      },
      progress: {
        requiredKnown: 0,
        requiredConfirmed: 0,
        requiredTotal: 4,
        allKnown: 0,
        allTotal: 7,
      },
      unresolvedFields: ANSWER_KEYS,
      deferredFields: ['examples', 'rules', 'boundaries'],
      investigatedFields: [],
      changes: { confirmed: [], inferred: [], unresolved: [] },
      next: {
        kind: 'ask_field',
        field: 'goal',
        audience: 'member',
        prompt: '请用一个最近真实发生的例子告诉我：你最终希望这项工作产出什么结果？',
      },
    },
    maturity: {
      stage: 'understanding',
      label: '理解中',
      acceptedRealRunCount: 0,
      evidence: {
        confirmedCoreFields: { confirmed: 0, required: 4, satisfied: false },
        representativeCases: { passed: 0, total: 0, boundaryPassed: 0, boundaryRequired: 2, satisfied: false },
        acceptedRealRuns: { total: 0, consecutive: 0, requiredForTry: 1, requiredForUse: 3 },
        approvalPolicy: { satisfied: true, source: '产品内置安全策略', summary: '高风险动作必须先预览并获得用户明确批准。' },
      },
      next: {
        stage: 'can_make',
        label: '可以开始制作',
        missing: ['还需确认 4 项核心工作条件。'],
      },
    },
  });

  for (const [index, key] of ANSWER_KEYS.entries()) {
    state = await fixture.service.updateProject(fixture.workspace.id, state.stateVersion, {
      answers: { [key]: `第 ${index + 1} 项工作说明：${key}` },
    });
    assertStateContract(state, {
      projectName: '客户周报项目',
      stateVersion: index + 2,
      briefRevision: index + 1,
      confirmedRevision: null,
    });
    assert.equal(state.brief.answers[key], `第 ${index + 1} 项工作说明：${key}`);
    assert.equal(state.brief.fieldSources[key].status, 'user_confirmed');
  }

  assert.equal(deriveProjectState(state).phase, 'ready');
  const reserved = await fixture.service.reserveActivation(fixture.workspace.id, {
    baseVersion: state.stateVersion,
    briefRevision: state.brief.revision,
    sessionId: 'session-primary',
  });
  assert.equal(reserved.disposition, 'reserved');
  assert.equal(reserved.activation.status, 'pending');
  assert.equal(reserved.activation.sessionId, 'session-primary');
  assert.equal(reserved.state.work.sessionId, 'session-primary');
  assert.equal(reserved.state.brief.confirmedRevision, state.brief.revision);
  assert.deepEqual(reserved.state.brief.confirmedAnswers, reserved.state.brief.answers);
  assert.notEqual(reserved.state.brief.confirmedAnswers, reserved.state.brief.answers);
  assert.equal(deriveProjectState(reserved.state).phase, 'ready');
  assert.match(
    await readFile(path.join(fixture.workspace.path, '.wanxiang', 'work-brief.md'), 'utf8'),
    /^# 客户周报项目 · 已确认工作简报/mu,
  );

  state = await fixture.service.finalizeActivation(fixture.workspace.id, {
    activationId: reserved.activation.id,
    status: 'active',
    messageId: 'message-primary',
  });
  assert.equal(state.work.sessionId, 'session-primary');
  assert.equal(state.work.activeRevision, state.brief.revision);
  assert.equal(state.work.activation.status, 'active');
  assert.equal(state.work.activation.messageId, 'message-primary');
  assert.equal(deriveProjectState(state).phase, 'making');

  const activeContract = { ...state.brief.confirmedAnswers };
  state = await fixture.service.updateProject(fixture.workspace.id, state.stateVersion, {
    answers: { examples: '第二份真实客户材料' },
  });
  assert.equal(deriveProjectState(state).phase, 'changed');
  assert.equal(state.brief.answers.examples, '第二份真实客户材料');
  assert.equal(state.brief.confirmedAnswers.examples, activeContract.examples);

  const next = await fixture.service.reserveActivation(fixture.workspace.id, {
    baseVersion: state.stateVersion,
    briefRevision: state.brief.revision,
    sessionId: 'session-primary',
  });
  assert.equal(next.disposition, 'reserved');
  assert.equal(next.activation.sessionId, 'session-primary');
  assert.equal(next.state.brief.confirmedAnswers.examples, '第二份真实客户材料');
  assert.equal(next.state.work.activeRevision, reserved.state.brief.revision);
});

test('competing tabs keep one activation and never bind a second session', async (t) => {
  const fixture = await createFixture(t);
  let state = await fixture.service.getProject(fixture.workspace.id);
  state = await fixture.service.updateProject(fixture.workspace.id, state.stateVersion, {
    answers: Object.fromEntries(ANSWER_KEYS.map((key) => [key, `${key} answer`])),
  });

  const request = {
    baseVersion: state.stateVersion,
    briefRevision: state.brief.revision,
    sessionId: 'session-winner',
  };
  const results = await Promise.allSettled([
    fixture.service.reserveActivation(fixture.workspace.id, request),
    fixture.service.reserveActivation(fixture.workspace.id, { ...request, sessionId: 'session-competitor' }),
  ]);
  const winner = results.find((result) => result.status === 'fulfilled')?.value;
  const stale = results.find((result) => result.status === 'rejected')?.reason;
  assert.ok(winner);
  assert.equal(winner.disposition, 'reserved');
  assert.equal(stale?.code, 'revision_conflict');
  const winningSessionId = winner.activation.sessionId;
  assert.ok(['session-winner', 'session-competitor'].includes(winningSessionId));

  const reloaded = await fixture.service.getProject(fixture.workspace.id);
  const duplicate = await fixture.service.reserveActivation(fixture.workspace.id, {
    baseVersion: reloaded.stateVersion,
    briefRevision: reloaded.brief.revision,
    sessionId: 'session-competitor',
  });
  assert.equal(duplicate.disposition, 'in-progress');
  assert.equal(duplicate.activation.id, winner.activation.id);
  assert.equal(duplicate.activation.sessionId, winningSessionId);
  assert.equal(duplicate.state.work.sessionId, winningSessionId);

  const active = await fixture.service.finalizeActivation(fixture.workspace.id, {
    activationId: winner.activation.id,
    status: 'active',
    messageId: 'message-once',
  });
  const afterSend = await fixture.service.reserveActivation(fixture.workspace.id, {
    baseVersion: active.stateVersion,
    briefRevision: active.brief.revision,
    sessionId: 'session-competitor',
  });
  assert.equal(afterSend.disposition, 'already-active');
  assert.equal(afterSend.activation.id, winner.activation.id);
  assert.equal(afterSend.activation.sessionId, winningSessionId);
  assert.equal(afterSend.state.stateVersion, active.stateVersion);
  assert.equal(afterSend.state.work.sessionId, winningSessionId);
});

function assertStateContract(state, expected) {
  assert.deepEqual(Object.keys(state).sort(), [
    'brief',
    'createdAt',
    'feedback',
    'improvements',
    'projectName',
    'runs',
    'safety',
    'schemaVersion',
    'stateVersion',
    'updatedAt',
    'work',
  ]);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.stateVersion, expected.stateVersion);
  assert.equal(state.projectName, expected.projectName);
  assert.equal(typeof state.createdAt, 'string');
  assert.equal(typeof state.updatedAt, 'string');
  assert.deepEqual(state.runs, { latestRunId: null, order: [], byId: {} });
  assert.deepEqual(state.feedback, { order: [], byId: {} });
  assert.deepEqual(state.improvements, { order: [], byId: {} });
  assert.deepEqual(state.safety, {
    approvalPolicy: {
      mode: 'explicit_user_approval',
      source: 'host_enforced',
      highRiskActions: ['external_write', 'message', 'delete', 'payment', 'credential_use'],
      summary: '高风险动作必须先预览并获得用户明确批准。',
    },
  });
  assert.deepEqual(Object.keys(state.brief).sort(), [
    'answers',
    'confirmedAnswers',
    'confirmedFieldSources',
    'confirmedRevision',
    'deferredFields',
    'fieldSources',
    'investigatedFields',
    'lastChanges',
    'revision',
  ]);
  assert.deepEqual(Object.keys(state.brief.answers), ANSWER_KEYS);
  assert.deepEqual(Object.keys(state.brief.fieldSources), ANSWER_KEYS);
  assert.equal(state.brief.revision, expected.briefRevision);
  assert.equal(state.brief.confirmedRevision, expected.confirmedRevision);
  assert.ok(Array.isArray(state.brief.deferredFields));
  assert.ok(Array.isArray(state.brief.investigatedFields));
  assert.deepEqual(Object.keys(state.brief.lastChanges).sort(), ['confirmed', 'inferred', 'unresolved']);
  assert.deepEqual(Object.keys(state.work).sort(), ['activation', 'activeRevision', 'sessionId']);
}

async function createFixture(t) {
  const projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'wanxiang-v03-contract-'));
  t.after(() => rm(projectsRoot, { recursive: true, force: true }));
  const workspace = {
    id: 'workspace-contract',
    path: path.join(projectsRoot, 'customer-weekly'),
    title: '客户周报项目',
  };
  await mkdir(workspace.path);
  const registry = {
    get(id) { return id === workspace.id ? workspace : undefined; },
  };
  let clock = 0;
  let sequence = 0;
  const service = new WanxiangStateService({
    workspaceRegistry: registry,
    projectsRoot,
    dataRoot: path.join(projectsRoot, '.data'),
    now: () => `2026-09-01T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    id: () => `contract-${++sequence}`,
  });
  return { service, workspace };
}
