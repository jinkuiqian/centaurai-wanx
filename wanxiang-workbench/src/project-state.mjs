import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const BRIEF_FIELDS = [
  ['goal', '真实任务与目标'],
  ['inputs', '输入与资料来源'],
  ['examples', '代表案例'],
  ['rules', '判断与优先级规则'],
  ['output', '交付结果'],
  ['boundaries', '排除项与风险边界'],
  ['success', '验收标准'],
];

export const REQUIRED_BRIEF_FIELDS = ['goal', 'inputs', 'output', 'success'];
export const OPTIONAL_BRIEF_FIELDS = ['examples', 'rules', 'boundaries'];
export const FIELD_SOURCE_STATUSES = ['user_confirmed', 'inferred', 'unresolved'];

const GUIDANCE_QUESTIONS = {
  goal: '请用一个最近真实发生的例子告诉我：你最终希望这项工作产出什么结果？',
  inputs: '这项工作实际会收到哪些业务材料或信息？项目中的文件位置和技术细节由万象自己检查。',
  output: '完成后你希望拿到什么交付物，以什么格式、给谁使用？',
  success: '用一份真实输入验收时，满足哪些可观察的条件就算可以使用？',
};

const GUIDANCE_RULES = [
  { field: 'goal', dependsOn: [], inspectContext: false },
  { field: 'inputs', dependsOn: ['goal'], inspectContext: true },
  { field: 'output', dependsOn: ['goal'], inspectContext: false },
  { field: 'success', dependsOn: ['goal', 'inputs', 'output'], inspectContext: false },
];

const INPUT_INSPECTION_PROMPT = '请先在当前项目和用户已选择的材料中查找实际输入的类型、位置和结构；只读检查后更新工作说明，不要把这些可查事实转问用户。';

const SECTION_ALIASES = {
  goal: ['真实任务与目标', '目标', 'objective'],
  inputs: ['输入与资料来源', '输入与资料', '输入', 'inputs'],
  examples: ['代表案例', '真实案例', '案例', 'examples'],
  rules: ['判断与优先级规则', '判断规则', '规则', 'rules'],
  output: ['交付结果', '输出', 'outputs'],
  boundaries: ['排除项与风险边界', '边界与风险', '边界', 'boundaries / out of scope'],
  success: ['验收标准', '完成标准', 'definition of done'],
};

const workspaceLocks = new Map();
const globalLocks = new Map();
const agentsBlockStart = '<!-- WANXIANG:MANAGED:START version=2 -->';
const agentsBlockEnd = '<!-- WANXIANG:MANAGED:END -->';
const legacyAgents = `# 万象 Builder 工作区

- 先阅读 \`.wanxiang/work-brief.md\` 和 \`.wanxiang/data-contract.json\`。
- 构建与验证是同一个循环：每次实现后立即运行代表性案例和边界案例，再根据证据修正。
- 只在当前工作区内读写；产物必须可读、可审查、可版本化。
- 当前 Data Agent 仅有示例契约。不得声称已连接真实数据，不得访问真实凭证或执行外部写操作。
- 高风险动作必须先预览并获得用户明确批准。
- 用普通人能理解的语言解释当前判断、证据、风险和下一步。`;

export function createInitialState(projectName, timestamp = new Date().toISOString()) {
  return {
    schemaVersion: 2,
    stateVersion: 1,
    projectName,
    brief: {
      answers: Object.fromEntries(BRIEF_FIELDS.map(([key]) => [key, ''])),
      fieldSources: Object.fromEntries(BRIEF_FIELDS.map(([key]) => [key, unresolvedFieldSource()])),
      deferredFields: [],
      investigatedFields: [],
      lastChanges: emptyGuidanceChanges(),
      revision: 0,
      confirmedRevision: null,
      confirmedAnswers: null,
      confirmedFieldSources: null,
    },
    work: { sessionId: null, activeRevision: null, activation: null },
    runs: initialEvaluationRuns(),
    feedback: initialRunFeedback(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function initialEvaluationRuns() {
  return { latestRunId: null, order: [], byId: {} };
}

function initialRunFeedback() {
  return { order: [], byId: {} };
}

function startRunState(current, input, runtimeId) {
  if (!isRunStart(input)) {
    throw serviceError(400, 'run_invalid', '运行证据无效。');
  }
  if (current.runs.byId[input.runId]) {
    throw serviceError(409, 'evaluation_run_id_conflict', '这个运行 ID 已经存在，不能复用。');
  }
  if (input.retryOf !== null) {
    const previous = current.runs.byId[input.retryOf];
    if (!previous || previous.status === 'running' || previous.caseId !== input.caseId) {
      throw serviceError(409, 'evaluation_retry_invalid', '重试必须关联同一案例中已经结束的前一次运行。');
    }
  }
  const run = {
    ...structuredClone(input),
    runtimeInstanceId: runtimeId,
    status: 'running',
    completedAt: null,
    conclusion: null,
    evidence: null,
  };
  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    runs: {
      latestRunId: run.runId,
      order: [...current.runs.order, run.runId],
      byId: { ...current.runs.byId, [run.runId]: run },
    },
    updatedAt: run.startedAt,
  };
}

function finishRunState(current, input) {
  if (!isRunFinish(input)) {
    throw serviceError(400, 'run_invalid', '运行结论无效。');
  }
  const run = current.runs.byId[input.runId];
  if (!run) throw serviceError(404, 'evaluation_run_not_found', '找不到这次运行。');
  const completed = { ...run, ...structuredClone(input) };
  if (run.status !== 'running') {
    if (JSON.stringify(run) === JSON.stringify(completed)) return current;
    throw serviceError(409, 'evaluation_run_already_finalized', '这次运行已经结束，不能改写结论。', { current: run });
  }
  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    runs: {
      ...current.runs,
      byId: { ...current.runs.byId, [run.runId]: completed },
    },
    updatedAt: input.completedAt,
  };
}

function recordRunFeedbackState(current, workspaceId, input, sessionId, timestamp, id) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.runId !== 'string' || !input.runId
    || !['correct', 'needs_changes', 'unacceptable'].includes(input.verdict)
    || typeof input.note !== 'string' || input.note.length > 12_000
    || Object.keys(input).some((key) => !['runId', 'verdict', 'note'].includes(key))) {
    throw serviceError(400, 'run_feedback_invalid', '请选择反馈结论，并填写有效的补充说明。');
  }
  const run = current.runs.byId[input.runId];
  if (!run || run.kind !== 'real' || run.status === 'running') {
    throw serviceError(409, 'run_feedback_unavailable', '只能评价已经结束的影子运行。');
  }
  if (run.sessionId !== sessionId) {
    throw serviceError(403, 'run_feedback_session_mismatch', '只能在运行这个案例的当前制作会话中提交反馈。');
  }
  const feedback = {
    id,
    workspaceId,
    runId: run.runId,
    caseId: run.caseId,
    verdict: input.verdict,
    note: input.note.trim(),
    workBriefRevision: run.workBriefRevision,
    agentVersion: run.agentVersion,
    createdAt: timestamp,
  };
  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    feedback: {
      order: [...current.feedback.order, feedback.id],
      byId: { ...current.feedback.byId, [feedback.id]: feedback },
    },
    updatedAt: timestamp,
  };
}

export function parseLegacyBrief(markdown, fallbackName, timestamp = new Date().toISOString()) {
  const source = String(markdown || '').replaceAll('\r\n', '\n');
  const heading = source.match(/^#\s+(.+?)(?:\s*[·｜|]\s*已确认工作简报)?\s*$/mu);
  const projectName = heading?.[1]?.trim() || fallbackName;
  const sections = splitSections(source);
  const answers = {};
  for (const [key] of BRIEF_FIELDS) {
    answers[key] = findSection(sections, SECTION_ALIASES[key]);
  }
  const state = createInitialState(projectName, timestamp);
  const hasLegacyContent = Object.values(answers).some(Boolean);
  state.brief.answers = answers;
  state.brief.fieldSources = Object.fromEntries(BRIEF_FIELDS.map(([key]) => [
    key,
    isPlaceholder(answers[key]) ? unresolvedFieldSource() : { status: 'user_confirmed', sourceMessageIds: [] },
  ]));
  state.brief.revision = hasLegacyContent ? 1 : 0;
  if (BRIEF_FIELDS.filter(([key]) => key !== 'examples').every(([key]) => !isPlaceholder(answers[key]))) {
    state.brief.confirmedRevision = 1;
    state.brief.confirmedAnswers = { ...answers };
    state.brief.confirmedFieldSources = cloneFieldSources(state.brief.fieldSources);
  }
  return state;
}

export function updateProjectState(current, update, timestamp = new Date().toISOString()) {
  if (current.work.activation?.status === 'pending') {
    throw serviceError(409, 'activation_in_progress', '工作说明正在确认，请等待当前操作完成后再修改。', { current });
  }
  const projectName = update.projectName ?? current.projectName;
  const answerPatch = validateAnswerPatch(update.answers || {});
  const sourcePatch = validateFieldSourcePatch(update.fieldSources || {});
  const requestedDeferredFields = validateFieldKeyList(update.deferredFields || [], '工作说明暂缓字段无效。');
  const requestedInvestigatedFields = validateFieldKeyList(update.investigatedFields || [], '工作说明调查字段无效。');
  const answers = { ...current.brief.answers, ...answerPatch };
  const fieldSources = { ...current.brief.fieldSources };
  const deferredFields = new Set(current.brief.deferredFields || []);
  const investigatedFields = new Set(current.brief.investigatedFields || []);
  for (const [key, value] of Object.entries(answerPatch)) {
    if (isExplicitDeferral(value)) deferredFields.add(key);
    else if (!isPlaceholder(value)) deferredFields.delete(key);
    if (!Object.hasOwn(sourcePatch, key) && current.brief.answers[key] !== value) {
      fieldSources[key] = isPlaceholder(value)
        ? unresolvedFieldSource()
        : { status: 'user_confirmed', sourceMessageIds: [] };
    }
  }
  for (const [key, value] of Object.entries(sourcePatch)) {
    if (isPlaceholder(answers[key])) {
      fieldSources[key] = unresolvedFieldSource();
      continue;
    }
    const answerChanged = Object.hasOwn(answerPatch, key) && current.brief.answers[key] !== answers[key];
    if (!answerChanged && sourceStatusRank(value.status) < sourceStatusRank(current.brief.fieldSources[key].status)) continue;
    fieldSources[key] = value;
  }
  for (const key of requestedDeferredFields) {
    answers[key] = '';
    fieldSources[key] = unresolvedFieldSource();
    deferredFields.add(key);
  }
  const goalChanged =
    Object.hasOwn(answerPatch, 'goal')
    && current.brief.answers.goal !== answers.goal;
  const inputsChanged =
    Object.hasOwn(answerPatch, 'inputs')
    && current.brief.answers.inputs !== answers.inputs;
  const invalidatedInferredInputs =
    goalChanged
    && investigatedFields.has('inputs')
    && !Object.hasOwn(answerPatch, 'inputs')
    && fieldSources.inputs.status === 'inferred';
  if (goalChanged || inputsChanged) investigatedFields.delete('inputs');
  if (invalidatedInferredInputs) {
    answers.inputs = '';
    fieldSources.inputs = unresolvedFieldSource();
    deferredFields.delete('inputs');
  }
  for (const key of requestedInvestigatedFields) investigatedFields.add(key);
  const orderedDeferredFields = orderedFieldKeys(deferredFields);
  const orderedInvestigatedFields = orderedFieldKeys(investigatedFields);
  const changedFields = BRIEF_FIELDS.map(([key]) => key).filter((key) => (
    current.brief.answers[key] !== answers[key]
      || !fieldSourcesEqual(current.brief.fieldSources[key], fieldSources[key])
      || (current.brief.deferredFields || []).includes(key) !== deferredFields.has(key)
  ));
  const briefChanged = current.projectName !== projectName
    || changedFields.length > 0
    || !fieldKeyListsEqual(current.brief.investigatedFields || [], orderedInvestigatedFields);
  const guidanceChangesConsumed = update.consumeGuidanceChanges === true
    && Object.values(current.brief.lastChanges || emptyGuidanceChanges())
      .some((fields) => fields.length > 0);
  if (!briefChanged && !guidanceChangesConsumed) return current;
  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    projectName,
    brief: {
      ...current.brief,
      answers,
      fieldSources,
      deferredFields: orderedDeferredFields,
      investigatedFields: orderedInvestigatedFields,
      lastChanges: classifyGuidanceChanges(changedFields, fieldSources),
      revision: current.brief.revision + (briefChanged ? 1 : 0),
    },
    updatedAt: timestamp,
  };
}

export function confirmProjectState(current, briefRevision, timestamp = new Date().toISOString()) {
  if (current.brief.revision !== briefRevision) {
    throw serviceError(409, 'brief_revision_conflict', '工作简报已经变化，请确认最新版本。', { current });
  }
  if (!deriveReadiness(current).ready) {
    throw serviceError(400, 'brief_incomplete', '请先确认目标、真实输入、交付物和可执行的验收标准。');
  }
  const fieldSources = Object.fromEntries(BRIEF_FIELDS.map(([key]) => [
    key,
    isPlaceholder(current.brief.answers[key])
      ? unresolvedFieldSource()
      : { ...current.brief.fieldSources[key], status: 'user_confirmed' },
  ]));
  const sourcesChanged = BRIEF_FIELDS.some(([key]) => !fieldSourcesEqual(
    current.brief.fieldSources[key],
    fieldSources[key],
  ));
  const snapshotsCurrent = answersEqual(current.brief.confirmedAnswers, current.brief.answers)
    && fieldSourceMapsEqual(current.brief.confirmedFieldSources, fieldSources);
  if (current.brief.confirmedRevision === briefRevision && !sourcesChanged && snapshotsCurrent) return current;
  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    brief: {
      ...current.brief,
      fieldSources,
      deferredFields: (current.brief.deferredFields || []).filter((key) => isPlaceholder(current.brief.answers[key])),
      lastChanges: classifyGuidanceChanges(
        BRIEF_FIELDS.map(([key]) => key).filter((key) => !fieldSourcesEqual(current.brief.fieldSources[key], fieldSources[key])),
        fieldSources,
      ),
      confirmedRevision: briefRevision,
      confirmedAnswers: { ...current.brief.answers },
      confirmedFieldSources: cloneFieldSources(fieldSources),
    },
    updatedAt: timestamp,
  };
}

export function deriveReadiness(state) {
  const missingRequired = REQUIRED_BRIEF_FIELDS.filter((key) => !fieldResolved(state, key));
  const unresolvedOptional = OPTIONAL_BRIEF_FIELDS.filter((key) => !fieldResolved(state, key));
  return { ready: missingRequired.length === 0, missingRequired, unresolvedOptional };
}

export function deriveGuidance(state) {
  const known = (key) => fieldResolved(state, key);
  const confirmed = (key) => known(key) && state.brief.fieldSources[key]?.status === 'user_confirmed';
  const progress = {
    requiredKnown: REQUIRED_BRIEF_FIELDS.filter(known).length,
    requiredConfirmed: REQUIRED_BRIEF_FIELDS.filter(confirmed).length,
    requiredTotal: REQUIRED_BRIEF_FIELDS.length,
    allKnown: BRIEF_FIELDS.filter(([key]) => known(key)).length,
    allTotal: BRIEF_FIELDS.length,
  };
  const explicitlyDeferred = new Set(state.brief.deferredFields || []);
  const deferredFields = BRIEF_FIELDS.map(([key]) => key).filter((key) => (
    explicitlyDeferred.has(key) || (OPTIONAL_BRIEF_FIELDS.includes(key) && !known(key))
  ));
  const investigatedFields = orderedFieldKeys(new Set(state.brief.investigatedFields || []));
  const activation = state.work.activation;
  const result = (...args) => guidance(state, progress, deferredFields, investigatedFields, ...args);

  if (activation?.status === 'pending') {
    return result('activating', 'activation_pending', null, null,
      '万象正在安全切换到制作状态，请等待当前操作完成。');
  }
  if (activation?.status === 'failed' && activation.briefRevision === state.brief.revision) {
    return result('failed', 'retry_activation', null, null,
      '上次开始制作没有完成，请检查失败原因后重试。');
  }
  if (state.work.activeRevision !== null && state.brief.revision > state.work.activeRevision) {
    return result('changed', 'sync_changes', null, null,
      '工作说明已有修改，请确认同步后继续制作。');
  }
  if (state.work.activeRevision !== null && state.work.activeRevision === state.brief.revision) {
    return result('making', 'continue_making', null, null,
      '工作说明已经生效，请继续制作并用真实材料验证。');
  }

  const nextRule = GUIDANCE_RULES.find(({ field, dependsOn }) => (
    !known(field) && !explicitlyDeferred.has(field) && dependsOn.every(known)
  ));
  if (nextRule) {
    if (nextRule.inspectContext && !investigatedFields.includes(nextRule.field)) {
      return result('understanding', 'inspect_context', nextRule.field, 'agent', INPUT_INSPECTION_PROMPT);
    }
    return result('understanding', 'ask_field', nextRule.field, 'member', GUIDANCE_QUESTIONS[nextRule.field]);
  }
  const unresolvedRequired = REQUIRED_BRIEF_FIELDS.find((key) => !known(key));
  if (unresolvedRequired) {
    const label = BRIEF_FIELDS.find(([key]) => key === unresolvedRequired)?.[1] || unresolvedRequired;
    return result('understanding', 'await_required', unresolvedRequired, null,
      `${label}仍待补充；准备好后可以直接在工作说明中更新，万象不会把未知内容当成事实。`);
  }
  if (REQUIRED_BRIEF_FIELDS.some((key) => !confirmed(key))) {
    return result('reviewing', 'review_and_confirm', null, null,
      '请打开工作说明，核对制作前的四项关键内容；有误直接修改，确认无误后再开始制作。');
  }
  return result('ready', 'start_making', null, null,
    '工作说明已经确认，可以在当前对话中开始制作。');
}

function guidance(state, progress, deferredFields, investigatedFields, stage, kind, field, audience, prompt) {
  const unresolvedFields = BRIEF_FIELDS.map(([key]) => key).filter((key) => (
    isPlaceholder(state.brief.answers[key]) || state.brief.fieldSources[key]?.status === 'unresolved'
  ));
  return {
    schemaVersion: 2,
    stateVersion: state.stateVersion,
    briefRevision: state.brief.revision,
    stage,
    understanding: {
      answers: { ...state.brief.answers },
      fieldSources: cloneFieldSources(state.brief.fieldSources),
    },
    progress,
    unresolvedFields,
    deferredFields,
    investigatedFields,
    changes: cloneGuidanceChanges(state.brief.lastChanges || emptyGuidanceChanges()),
    next: { kind, field, audience, prompt },
  };
}

export function deriveProjectState(state) {
  const readiness = deriveReadiness(state);
  const guidance = deriveGuidance(state);
  const activation = state.work.activation;
  let phase = 'understanding';
  if (activation?.status === 'failed' && activation.briefRevision === state.brief.revision) phase = 'failed';
  else if (state.work.activeRevision !== null && state.brief.revision > state.work.activeRevision) phase = 'changed';
  else if (activation?.status === 'active' && state.work.activeRevision === state.brief.revision) phase = 'making';
  else if (readiness.ready) phase = 'ready';
  const acceptedRealRuns = new Set(state.feedback.order
    .map((feedbackId) => state.feedback.byId[feedbackId])
    .filter((feedback) => feedback.verdict === 'correct'
      && state.runs.byId[feedback.runId]?.status === 'passed')
    .map((feedback) => feedback.runId));
  const maturity = {
    stage: acceptedRealRuns.size > 0 ? 'can_try' : phase === 'making' ? 'making' : phase,
    acceptedRealRunCount: acceptedRealRuns.size,
  };
  return { phase, readiness, guidance, maturity };
}

export function reserveActivation(current, request, timestamp = new Date().toISOString(), id = randomUUID()) {
  const { briefRevision, sessionId, retry = false } = request;
  if (current.brief.confirmedRevision !== briefRevision || current.brief.revision !== briefRevision) {
    throw serviceError(409, 'brief_not_confirmed', '只能开始制作当前已确认的工作说明。', { current });
  }
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw serviceError(400, 'session_required', '需要在当前对话中开始制作。');
  }
  const previous = current.work.activation;
  const sameRevision = previous?.briefRevision === briefRevision;
  if (sameRevision && previous.status === 'active') {
    return { disposition: 'already-active', state: current, activation: previous };
  }
  if (sameRevision && previous.status === 'pending') {
    return { disposition: 'in-progress', state: current, activation: previous };
  }
  if (failedActivationBelongsToAnotherSession(current, request)) {
    return { disposition: 'existing-session', state: current, activation: previous };
  }
  if (current.work.sessionId && current.work.sessionId !== sessionId) {
    return { disposition: 'existing-session', state: current, activation: current.work.activation };
  }
  if (previous?.status === 'pending') {
    throw serviceError(409, 'activation_in_progress', '上一版工作说明仍在启动，请先恢复该次操作。', { current });
  }
  if (sameRevision && previous.status === 'failed' && !retry) {
    throw serviceError(409, 'activation_failed', '上次开始制作失败；确认重试后可再次启动。', { current });
  }
  const activation = {
    id,
    briefRevision,
    sessionId,
    status: 'pending',
    messageId: null,
    error: null,
    previousConfirmed: Object.hasOwn(request, 'previousConfirmed')
      ? cloneConfirmedSnapshot(request.previousConfirmed)
      : confirmedSnapshot(current),
    previousBriefMetadata: Object.hasOwn(request, 'previousBriefMetadata')
      ? cloneBriefMetadata(request.previousBriefMetadata)
      : briefMetadata(current.brief),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const state = {
    ...current,
    stateVersion: current.stateVersion + 1,
    work: { ...current.work, sessionId, activation },
    updatedAt: timestamp,
  };
  return { disposition: 'reserved', state, activation };
}

export function finalizeActivation(current, request, timestamp = new Date().toISOString()) {
  const activation = current.work.activation;
  if (!activation || activation.id !== request.activationId) {
    throw serviceError(404, 'activation_not_found', '找不到这次制作启动记录。');
  }
  if (!['active', 'failed'].includes(request.status)) {
    throw serviceError(400, 'activation_status_invalid', '制作启动状态无效。');
  }
  const messageId = request.status === 'active' ? request.messageId : null;
  const error = request.status === 'failed' ? request.error ?? null : null;
  if (request.status === 'active' && (typeof messageId !== 'string' || !messageId.trim())) {
    throw serviceError(400, 'activation_message_required', '启动制作后必须记录对话消息。');
  }
  if (activation.status !== 'pending') {
    if (activation.status === request.status && activation.messageId === messageId
      && dispatchErrorsEqual(activation.error, error)) return current;
    throw serviceError(409, 'activation_already_finalized', '这次制作启动已经结束，不能重复改写结果。', { current });
  }
  const { previousConfirmed, previousBriefMetadata, ...finalizedActivation } = activation;
  let brief = request.status === 'failed'
    ? restoreConfirmedSnapshot(current.brief, previousConfirmed)
    : current.brief;
  if (request.status === 'failed' && previousBriefMetadata) {
    brief = restoreBriefMetadata(brief, previousBriefMetadata);
  }
  const sessionId = request.status === 'failed' && current.work.activeRevision === null
    ? null
    : current.work.sessionId;
  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    brief,
    work: {
      ...current.work,
      sessionId,
      activeRevision: request.status === 'active' ? activation.briefRevision : current.work.activeRevision,
      activation: { ...finalizedActivation, status: request.status, messageId, error, updatedAt: timestamp },
    },
    updatedAt: timestamp,
  };
}

export function reserveDispatch(current, request, timestamp = new Date().toISOString(), id = randomUUID()) {
  const result = reserveActivation(current, {
    briefRevision: request.briefRevision,
    sessionId: request.builderSessionId,
    retry: request.retry,
  }, timestamp, id);
  const dispositions = {
    reserved: 'reserved',
    'in-progress': 'in-progress',
    'already-active': 'already-sent',
    'existing-session': 'in-progress',
  };
  return {
    disposition: dispositions[result.disposition],
    state: result.state,
    dispatch: activationToLegacyDispatch(result.activation),
  };
}

export function finalizeDispatch(current, request, timestamp = new Date().toISOString()) {
  return finalizeActivation(current, {
    activationId: request.dispatchId,
    status: request.status === 'sent' ? 'active' : request.status,
    messageId: request.messageId,
    error: request.error,
  }, timestamp);
}

export function renderBrief({ projectName, brief }) {
  const answers = brief.confirmedAnswers || brief.answers;
  const sections = BRIEF_FIELDS
    .map(([key, label]) => {
      const value = answers[key]?.trim()
        || (OPTIONAL_BRIEF_FIELDS.includes(key) ? '制作中验证' : '待确认');
      return `## ${label}\n\n${value}`;
    })
    .join('\n\n');
  return `# ${projectName} · 已确认工作简报\n\n${sections}\n`;
}

export class WanxiangStateService {
  constructor({ workspaceRegistry, projectsRoot, dataRoot, evaluationStore = null, now = () => new Date().toISOString(), id = randomUUID, runtimeId = randomUUID() }) {
    this.workspaceRegistry = workspaceRegistry;
    this.projectsRoot = projectsRoot;
    this.dataRoot = dataRoot;
    this.evaluationStore = evaluationStore;
    this.now = now;
    this.id = id;
    this.runtimeId = runtimeId;
  }

  async prepareRoots() {
    await Promise.all([
      this.projectsRoot ? mkdir(this.projectsRoot, { recursive: true }) : undefined,
      this.dataRoot ? mkdir(this.dataRoot, { recursive: true }) : undefined,
    ]);
  }

  async resolveWorkspace(workspaceId) {
    const workspace = this.workspaceRegistry.get(workspaceId);
    if (!workspace) throw serviceError(404, 'workspace_not_found', '找不到指定的项目。');
    if (!this.projectsRoot) throw serviceError(503, 'project_root_unavailable', '万象项目目录尚未配置。');
    let managedRoot;
    let workspacePath;
    try {
      await mkdir(this.projectsRoot, { recursive: true });
      [managedRoot, workspacePath] = await Promise.all([realpath(this.projectsRoot), realpath(workspace.path)]);
    } catch (error) {
      throw serviceError(403, 'workspace_unavailable', '当前项目无法安全访问。', { cause: error });
    }
    if (!isPathInside(managedRoot, workspacePath) && !await this.#isImportedWorkspace(String(workspace.id), workspacePath)) {
      throw serviceError(403, 'workspace_outside_managed_root', '当前目录尚未导入为受管理的万象项目。');
    }
    return workspace;
  }

  async importProject(workspaceId) {
    const workspace = this.workspaceRegistry.get(workspaceId);
    if (!workspace) throw serviceError(404, 'workspace_not_found', '找不到指定的项目。');
    if (!this.projectsRoot) throw serviceError(503, 'project_root_unavailable', '万象项目目录尚未配置。');
    if (!this.dataRoot) throw serviceError(503, 'data_root_unavailable', '万象本地数据目录尚未配置。');
    await this.prepareRoots();
    let managedRoot;
    let workspacePath;
    try {
      [managedRoot, workspacePath] = await Promise.all([realpath(this.projectsRoot), realpath(workspace.path)]);
    } catch (error) {
      throw serviceError(403, 'workspace_unavailable', '当前项目无法安全访问。', { cause: error });
    }
    const imported = !isPathInside(managedRoot, workspacePath);
    if (imported) {
      await this.#withImportedWorkspaces(async (store, save) => {
        store.items[String(workspace.id)] = { path: workspacePath, importedAt: this.now() };
        await save(store);
      });
    }
    try {
      const state = await withSerialLock(workspaceLocks, String(workspace.id), () => this.#loadState(workspace));
      return { workspace, state };
    } catch (error) {
      if (imported) {
        await this.#withImportedWorkspaces(async (store, save) => {
          if (store.items[String(workspace.id)]?.path === workspacePath) {
            delete store.items[String(workspace.id)];
            await save(store);
          }
        }).catch(() => {});
      }
      throw error;
    }
  }

  async createProject(projectName) {
    if (!this.projectsRoot) {
      throw serviceError(503, 'project_root_unavailable', '万象项目目录尚未配置。');
    }
    await mkdir(this.projectsRoot, { recursive: true });
    const destination = path.join(this.projectsRoot, `${projectSlug(projectName)}-${this.id().slice(0, 8)}`);
    await mkdir(destination, { recursive: false });
    let workspace;
    try {
      workspace = await this.workspaceRegistry.create(destination, projectName);
      const state = createInitialState(projectName, this.now());
      await withSerialLock(workspaceLocks, String(workspace.id), async () => {
        await writeProjectState(workspace, state, this.dataRoot, this.id);
      });
      return { workspace, state };
    } catch (error) {
      const rollbackErrors = [];
      let registrationRemoved = !workspace;
      if (workspace) {
        try {
          registrationRemoved = await this.workspaceRegistry.delete(workspace.id);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (registrationRemoved) {
        try {
          await rm(destination, { recursive: true, force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length && error && typeof error === 'object') {
        error.rollbackErrors = rollbackErrors.map(String);
      }
      throw error;
    }
  }

  async getProject(workspaceId) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), () => this.#loadState(workspace));
  }

  async getProjectEvidence(workspaceId) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const state = await this.#loadState(workspace);
      if (!this.evaluationStore) return { state, evaluation: null };
      const evaluation = await this.evaluationStore.load({
        workspaceId: String(workspace.id),
        workspacePath: workspace.path,
      });
      return {
        state,
        evaluation: {
          agentVersion: evaluation.agent?.agentVersion ?? null,
          workflowVersion: evaluation.workflow.workflowVersion,
          evalRevision: evaluation.eval.revision,
          cases: evaluation.eval.cases.map(({ id, title, kind }) => ({ id, title, kind })),
        },
      };
    });
  }

  async startEvaluationRun(workspaceId, input) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      const next = startRunState(current, input, this.runtimeId);
      await writeProjectState(workspace, next, this.dataRoot, this.id);
      return next;
    });
  }

  async startRealWorkRun(workspaceId, input) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      const next = startRunState(current, { ...input, kind: 'real' }, this.runtimeId);
      await writeProjectState(workspace, next, this.dataRoot, this.id);
      return next;
    });
  }

  async finishRun(workspaceId, input) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      const next = finishRunState(current, input);
      if (next !== current) await writeProjectState(workspace, next, this.dataRoot, this.id);
      return next;
    });
  }

  async finishEvaluationRun(workspaceId, input) {
    return this.finishRun(workspaceId, input);
  }

  async recordRunFeedback(workspaceId, baseVersion, input, sessionId) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      assertBaseVersion(current, baseVersion);
      const next = recordRunFeedbackState(
        current, String(workspace.id), input, sessionId, this.now(), this.id(),
      );
      await writeProjectState(workspace, next, this.dataRoot, this.id);
      return next;
    });
  }

  async updateProject(workspaceId, baseVersion, update) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      assertBaseVersion(current, baseVersion);
      const next = updateProjectState(current, update, this.now());
      if (next !== current) await writeProjectState(workspace, next, this.dataRoot, this.id);
      return next;
    });
  }

  async updateProjectForAgent(agent, baseVersion, update) {
    const workspace = await this.#workspaceForAgent(agent);
    if (!workspace) throw serviceError(403, 'agent_workspace_unavailable', '当前对话不能更新这个项目的工作说明。');
    const state = await this.updateProject(String(workspace.id), baseVersion, update);
    return { workspaceId: String(workspace.id), state };
  }

  async confirmProject(workspaceId, baseVersion, briefRevision) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      assertBaseVersion(current, baseVersion);
      const next = confirmProjectState(current, briefRevision, this.now());
      const root = path.join(workspace.path, '.wanxiang');
      await mkdir(root, { recursive: true });
      if (next === current) {
        await reconcileBriefArtifact(workspace.path, next, this.id);
        return next;
      }
      const pending = path.join(root, '.work-brief.pending.md');
      await atomicWrite(pending, renderBrief(next), this.id);
      try {
        await writeProjectState(workspace, next, this.dataRoot, this.id);
      } catch (error) {
        await unlink(pending).catch(() => {});
        throw error;
      }
      try {
        await rename(pending, path.join(root, 'work-brief.md'));
      } catch (error) {
        throw serviceError(500, 'brief_artifact_pending', '工作简报已确认，派生文件将在重新载入时恢复。', { cause: error });
      }
      return next;
    });
  }

  async reserveActivation(workspaceId, request) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      assertBaseVersion(current, request.baseVersion);
      const sameOpenActivation = current.work.activation?.briefRevision === request.briefRevision
        && ['pending', 'active'].includes(current.work.activation.status);
      if (failedActivationBelongsToAnotherSession(current, request)) {
        return { disposition: 'existing-session', state: current, activation: current.work.activation };
      }
      if (current.work.sessionId && current.work.sessionId !== request.sessionId && !sameOpenActivation) {
        return { disposition: 'existing-session', state: current, activation: current.work.activation };
      }
      const previousConfirmed = confirmedSnapshot(current);
      const previousBriefMetadata = briefMetadata(current.brief);
      const confirmed = confirmProjectState(current, request.briefRevision, this.now());
      const result = reserveActivation(confirmed, {
        ...request,
        previousConfirmed,
        previousBriefMetadata,
      }, this.now(), this.id());
      if (result.state !== current) {
        await writeProjectState(workspace, result.state, this.dataRoot, this.id);
      }
      try {
        await reconcileBriefArtifact(workspace.path, result.state, this.id);
      } catch (cause) {
        if (result.disposition !== 'reserved') throw cause;
        const failed = finalizeActivation(result.state, {
          activationId: result.activation.id,
          status: 'failed',
          error: { code: 'brief_artifact_failed', message: '已确认的工作说明暂时无法写入项目。' },
        }, this.now());
        await writeProjectState(workspace, failed, this.dataRoot, this.id);
        throw serviceError(500, 'brief_artifact_failed', '工作说明未能安全写入，已取消本次制作启动。', {
          current: failed,
          cause,
        });
      }
      return result;
    });
  }

  async finalizeActivation(workspaceId, request) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      const next = finalizeActivation(current, request, this.now());
      if (next !== current) await writeProjectState(workspace, next, this.dataRoot, this.id);
      if (next !== current && request.status === 'failed') {
        await reconcileFailedActivationArtifact(workspace.path, next, this.id);
      }
      return next;
    });
  }

  async reserveDispatch(workspaceId, request) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      const result = reserveDispatch(current, request, this.now(), this.id());
      if (result.state !== current) await writeProjectState(workspace, result.state, this.dataRoot, this.id);
      return result;
    });
  }

  async finalizeDispatch(workspaceId, request) {
    const workspace = await this.resolveWorkspace(workspaceId);
    return withSerialLock(workspaceLocks, String(workspace.id), async () => {
      const current = await this.#loadState(workspace);
      const next = finalizeDispatch(current, request, this.now());
      if (next !== current) await writeProjectState(workspace, next, this.dataRoot, this.id);
      return next;
    });
  }

  async listOutbox() {
    return this.#withOutbox(async (store) => store.items);
  }

  async getSessionContext(workspaceId, sessionId) {
    const workspace = await this.#resolveSessionWorkspace(workspaceId, sessionId);
    const state = await withSerialLock(workspaceLocks, String(workspace.id), () => this.#loadState(workspace));
    return this.#sessionContextValue(state, sessionId);
  }

  async setSessionContext(workspaceId, sessionId, enabled) {
    const workspace = await this.#resolveSessionWorkspace(workspaceId, sessionId);
    const state = await withSerialLock(workspaceLocks, String(workspace.id), () => this.#loadState(workspace));
    const builder = state.work.sessionId === sessionId;
    if (!builder && state.brief.confirmedRevision !== null) {
      await this.#withSessionContexts(async (store, save) => {
        store.overrides[sessionId] = enabled;
        await save(store);
      });
    }
    return this.#sessionContextValue(state, sessionId);
  }

  async contextForAgent(agent) {
    const sessionId = String(agent?.id || '');
    const workspace = await this.#workspaceForAgent(agent);
    if (!workspace) return null;
    const state = await withSerialLock(workspaceLocks, String(workspace.id), () => this.#loadState(workspace));
    if (this.evaluationStore) {
      await this.evaluationStore.load({ workspaceId: String(workspace.id), workspacePath: workspace.path });
    }
    const preference = await this.#sessionContextValue(state, sessionId);
    const base = {
      ...preference,
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      state,
      projection: deriveProjectState(state),
    };
    if (!preference.enabled || state.brief.confirmedRevision === null) return { ...base, text: '' };
    let text = '';
    try {
      text = await readFile(path.join(workspace.path, '.wanxiang', 'work-brief.md'), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { ...base, text };
  }

  async #loadState(workspace) {
    return loadOrMigrate(workspace, this.now(), this.id, this.dataRoot, this.runtimeId);
  }

  async addOutboxItem(input) {
    if (input.workspaceId) await this.resolveWorkspace(input.workspaceId);
    return this.#withOutbox(async (store, save) => {
      const item = {
        id: this.id(),
        workspaceId: input.workspaceId || null,
        kind: input.kind,
        message: input.message,
        status: 'local-draft',
        createdAt: this.now(),
      };
      store.items.unshift(item);
      await save(store);
      return item;
    });
  }

  async deleteOutboxItem(id) {
    return this.#withOutbox(async (store, save) => {
      const index = store.items.findIndex((item) => item.id === id);
      if (index === -1) throw serviceError(404, 'outbox_item_not_found', '找不到这条本地社群草稿。');
      const [removed] = store.items.splice(index, 1);
      await save(store);
      return removed;
    });
  }

  async #withOutbox(operation) {
    if (!this.dataRoot) throw serviceError(503, 'data_root_unavailable', '万象本地数据目录尚未配置。');
    return withSerialLock(globalLocks, this.dataRoot, async () => {
      await mkdir(this.dataRoot, { recursive: true });
      const filename = path.join(this.dataRoot, 'community-outbox.json');
      const store = await readOutbox(filename);
      const save = (next) => atomicWrite(filename, `${JSON.stringify(next, null, 2)}\n`, this.id);
      return operation(store, save);
    });
  }

  async #resolveSessionWorkspace(workspaceId, sessionId) {
    const workspace = await this.resolveWorkspace(workspaceId);
    if (!workspace.sessionIds.includes(sessionId)) {
      throw serviceError(403, 'session_workspace_mismatch', '这个会话不属于当前项目。');
    }
    return workspace;
  }

  async #workspaceForAgent(agent) {
    const sessionId = String(agent?.id || '');
    if (!sessionId || agent?.session?.header?.origin === 'subagent') return null;
    const workspaces = typeof this.workspaceRegistry.list === 'function' ? this.workspaceRegistry.list() : [];
    let workspace = workspaces.find((candidate) => candidate.sessionIds?.includes(sessionId));
    const cwd = agent?.session?.header?.cwd;
    if (!workspace && typeof cwd === 'string' && cwd && typeof this.workspaceRegistry.resolveByPath === 'function') {
      workspace = await this.workspaceRegistry.resolveByPath(cwd).catch(() => undefined);
    }
    if (!workspace) return null;
    await this.resolveWorkspace(String(workspace.id));
    return workspace;
  }

  async #sessionContextValue(state, sessionId) {
    const builder = state.work.sessionId === sessionId;
    const confirmed = state.brief.confirmedRevision !== null;
    if (builder) return { sessionId, builder: true, confirmed, confirmedRevision: state.brief.confirmedRevision, enabled: true };
    if (!confirmed) return { sessionId, builder: false, confirmed: false, confirmedRevision: null, enabled: false };
    const store = await this.#withSessionContexts(async (value) => value);
    return {
      sessionId,
      builder: false,
      confirmed: true,
      confirmedRevision: state.brief.confirmedRevision,
      enabled: Object.hasOwn(store.overrides, sessionId) ? store.overrides[sessionId] : true,
    };
  }

  async #withSessionContexts(operation) {
    if (!this.dataRoot) throw serviceError(503, 'data_root_unavailable', '万象本地数据目录尚未配置。');
    return withSerialLock(globalLocks, `${this.dataRoot}:session-context`, async () => {
      await mkdir(this.dataRoot, { recursive: true });
      const filename = path.join(this.dataRoot, 'session-context.json');
      const store = await readSessionContexts(filename);
      const save = (next) => atomicWrite(filename, `${JSON.stringify(next, null, 2)}\n`, this.id);
      return operation(store, save);
    });
  }

  async #isImportedWorkspace(workspaceId, workspacePath) {
    if (!this.dataRoot) return false;
    return this.#withImportedWorkspaces(async (store) => store.items[workspaceId]?.path === workspacePath);
  }

  async #withImportedWorkspaces(operation) {
    if (!this.dataRoot) throw serviceError(503, 'data_root_unavailable', '万象本地数据目录尚未配置。');
    return withSerialLock(globalLocks, `${this.dataRoot}:imported-workspaces`, async () => {
      await mkdir(this.dataRoot, { recursive: true });
      const filename = path.join(this.dataRoot, 'imported-workspaces.json');
      const store = await readImportedWorkspaces(filename);
      const save = (next) => atomicWrite(filename, `${JSON.stringify(next, null, 2)}\n`, this.id);
      return operation(store, save);
    });
  }
}

export function serviceError(statusCode, code, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...extra });
}

function corruptState() {
  return serviceError(500, 'state_corrupt', '项目状态文件已损坏。');
}

function unresolvedFieldSource() {
  return { status: 'unresolved', sourceMessageIds: [] };
}

function emptyGuidanceChanges() {
  return { confirmed: [], inferred: [], unresolved: [] };
}

function cloneGuidanceChanges(value) {
  return {
    confirmed: [...value.confirmed],
    inferred: [...value.inferred],
    unresolved: [...value.unresolved],
  };
}

function classifyGuidanceChanges(keys, fieldSources) {
  const changes = emptyGuidanceChanges();
  for (const key of keys) {
    const status = fieldSources[key]?.status;
    if (status === 'user_confirmed') changes.confirmed.push(key);
    else if (status === 'inferred') changes.inferred.push(key);
    else changes.unresolved.push(key);
  }
  return changes;
}

function fieldResolved(state, key) {
  return !isPlaceholder(state.brief.answers[key]) && state.brief.fieldSources[key]?.status !== 'unresolved';
}

function orderedFieldKeys(keys) {
  return BRIEF_FIELDS.map(([key]) => key).filter((key) => keys.has(key));
}

function fieldKeyListsEqual(left, right) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function sourceStatusRank(status) {
  return { unresolved: 0, inferred: 1, user_confirmed: 2 }[status] ?? -1;
}

function validateAnswerPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(400, 'brief_patch_invalid', '工作说明更新格式无效。');
  }
  const known = new Set(BRIEF_FIELDS.map(([key]) => key));
  const patch = {};
  for (const [key, answer] of Object.entries(value)) {
    if (!known.has(key) || typeof answer !== 'string') {
      throw serviceError(400, 'brief_patch_invalid', '工作说明更新格式无效。');
    }
    patch[key] = answer;
  }
  return patch;
}

function validateFieldSourcePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(400, 'brief_source_invalid', '工作说明来源标记无效。');
  }
  const known = new Set(BRIEF_FIELDS.map(([key]) => key));
  const patch = {};
  for (const [key, source] of Object.entries(value)) {
    if (!known.has(key) || !isValidFieldSource(source)) {
      throw serviceError(400, 'brief_source_invalid', '工作说明来源标记无效。');
    }
    patch[key] = { status: source.status, sourceMessageIds: [...new Set(source.sourceMessageIds)] };
  }
  return patch;
}

function validateFieldKeyList(value, message) {
  if (!Array.isArray(value)) throw serviceError(400, 'brief_patch_invalid', message);
  const known = new Set(BRIEF_FIELDS.map(([key]) => key));
  if (value.some((key) => typeof key !== 'string' || !known.has(key))) {
    throw serviceError(400, 'brief_patch_invalid', message);
  }
  return orderedFieldKeys(new Set(value));
}

function isValidGuidanceChanges(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const groups = ['confirmed', 'inferred', 'unresolved'];
  if (Object.keys(value).some((key) => !groups.includes(key))) return false;
  const seen = new Set();
  return groups.every((group) => Array.isArray(value[group]) && value[group].every((key) => {
    if (!BRIEF_FIELDS.some(([field]) => field === key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function isValidFieldSource(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && FIELD_SOURCE_STATUSES.includes(value.status) && Array.isArray(value.sourceMessageIds)
    && value.sourceMessageIds.every((messageId) => typeof messageId === 'string' && messageId.length > 0);
}

function fieldSourcesEqual(left, right) {
  return left?.status === right?.status
    && left?.sourceMessageIds?.length === right?.sourceMessageIds?.length
    && left.sourceMessageIds.every((messageId, index) => messageId === right.sourceMessageIds[index]);
}

function answersEqual(left, right) {
  return Boolean(left && right && BRIEF_FIELDS.every(([key]) => left[key] === right[key]));
}

function fieldSourceMapsEqual(left, right) {
  return Boolean(left && right && BRIEF_FIELDS.every(([key]) => fieldSourcesEqual(left[key], right[key])));
}

function cloneFieldSources(value) {
  return Object.fromEntries(BRIEF_FIELDS.map(([key]) => [key, {
    status: value[key].status,
    sourceMessageIds: [...value[key].sourceMessageIds],
  }]));
}

function briefMetadata(brief) {
  return {
    fieldSources: cloneFieldSources(brief.fieldSources),
    deferredFields: [...brief.deferredFields],
    lastChanges: cloneGuidanceChanges(brief.lastChanges),
  };
}

function cloneBriefMetadata(value) {
  if (!isValidBriefMetadata(value)) {
    throw serviceError(400, 'activation_snapshot_invalid', '制作启动恢复点无效。');
  }
  return {
    fieldSources: cloneFieldSources(value.fieldSources),
    deferredFields: [...value.deferredFields],
    lastChanges: cloneGuidanceChanges(value.lastChanges),
  };
}

function restoreBriefMetadata(brief, snapshot) {
  return {
    ...brief,
    fieldSources: cloneFieldSources(snapshot.fieldSources),
    deferredFields: [...snapshot.deferredFields],
    lastChanges: cloneGuidanceChanges(snapshot.lastChanges),
  };
}

function isValidBriefMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && BRIEF_FIELDS.every(([key]) => isValidFieldSource(value.fieldSources?.[key]))
    && isValidFieldKeyList(value.deferredFields)
    && isValidGuidanceChanges(value.lastChanges);
}

function confirmedSnapshot(state) {
  if (state.brief.confirmedRevision === null) return null;
  const answers = state.brief.confirmedAnswers || state.brief.answers;
  const fieldSources = state.brief.confirmedFieldSources || state.brief.fieldSources;
  return {
    revision: state.brief.confirmedRevision,
    answers: { ...answers },
    fieldSources: cloneFieldSources(fieldSources),
  };
}

function cloneConfirmedSnapshot(snapshot) {
  if (snapshot === null) return null;
  if (!isValidConfirmedSnapshot(snapshot)) {
    throw serviceError(400, 'activation_snapshot_invalid', '制作启动恢复点无效。');
  }
  return {
    revision: snapshot.revision,
    answers: { ...snapshot.answers },
    fieldSources: cloneFieldSources(snapshot.fieldSources),
  };
}

function restoreConfirmedSnapshot(brief, snapshot) {
  if (snapshot === null || snapshot === undefined) {
    return { ...brief, confirmedRevision: null, confirmedAnswers: null, confirmedFieldSources: null };
  }
  return {
    ...brief,
    confirmedRevision: snapshot.revision,
    confirmedAnswers: { ...snapshot.answers },
    confirmedFieldSources: cloneFieldSources(snapshot.fieldSources),
  };
}

function isValidConfirmedSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isInteger(value.revision) && value.revision >= 0
    && BRIEF_FIELDS.every(([key]) => typeof value.answers?.[key] === 'string'
      && isValidFieldSource(value.fieldSources?.[key]));
}

function activationToLegacyDispatch(activation) {
  if (!activation) return null;
  return {
    id: activation.id,
    briefRevision: activation.briefRevision,
    builderSessionId: activation.sessionId,
    status: { pending: 'reserved', active: 'sent', failed: 'failed' }[activation.status],
    attempt: 1,
    messageId: activation.messageId,
    error: activation.error,
    createdAt: activation.createdAt,
    updatedAt: activation.updatedAt,
  };
}

function assertBaseVersion(current, baseVersion) {
  if (current.stateVersion !== baseVersion) {
    throw serviceError(409, 'revision_conflict', '项目状态已经变化，请刷新后重试。', { current });
  }
}

function splitSections(source) {
  const matches = [...source.matchAll(/^##\s+(.+?)\s*$/gmu)];
  return matches.map((match, index) => ({
    title: normalizeSectionTitle(match[1]),
    value: source.slice(match.index + match[0].length, matches[index + 1]?.index ?? source.length).trim(),
  }));
}

function normalizeSectionTitle(title) {
  return title
    .replace(/^\d+[.)、]\s*/u, '')
    .replace(/\s*[（(].*?[）)]\s*$/u, '')
    .trim()
    .toLocaleLowerCase();
}

function findSection(sections, aliases) {
  const normalized = aliases.map((value) => value.toLocaleLowerCase());
  return sections.find((section) => normalized.includes(section.title))?.value || '';
}

function isPlaceholder(value) {
  const text = String(value || '').trim();
  return !text || /^(?:待在.+继续确认|待补充|待填写|待确认|未填写|不知道|暂时不知道|稍后补充|之后补充|todo|n\/a)$/iu.test(text);
}

function isExplicitDeferral(value) {
  return /^(?:不知道|暂时不知道|稍后补充|之后补充)$/u.test(String(value || '').trim());
}

async function loadOrMigrate(workspace, timestamp, id, dataRoot, runtimeId) {
  await ensureManagedArtifacts(workspace.path, id);
  const root = path.join(workspace.path, '.wanxiang');
  const mirror = path.join(root, 'project.json');
  const canonical = dataRoot ? canonicalProjectStatePath(dataRoot, workspace.id) : null;
  const recoverConfirmedAnswers = () => readConfirmedAnswers(root, workspace.title, timestamp);

  if (canonical) {
    const stored = await readStoredState(canonical, recoverConfirmedAnswers);
    if (stored) {
      const state = recoverInterruptedRuns(stored.state, runtimeId, timestamp);
      if (stored.migrated || state !== stored.state) await writeCanonicalProjectFile(canonical, state, id);
      await syncProjectMirror(mirror, state, id).catch(() => {});
      await reconcileBriefArtifact(workspace.path, state, id);
      return state;
    }
  }

  let state;
  const mirrored = await readStoredState(mirror, recoverConfirmedAnswers);
  if (mirrored) {
    state = mirrored.state;
  } else {
    try {
      state = parseLegacyBrief(await readFile(path.join(root, 'work-brief.md'), 'utf8'), workspace.title, timestamp);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      state = createInitialState(workspace.title, timestamp);
    }
  }
  state = recoverInterruptedRuns(state, runtimeId, timestamp);
  if (canonical) await writeCanonicalProjectFile(canonical, state, id);
  if (canonical) await syncProjectMirror(mirror, state, id).catch(() => {});
  else await syncProjectMirror(mirror, state, id);
  await reconcileBriefArtifact(workspace.path, state, id);
  return state;
}

function recoverInterruptedRuns(state, runtimeId, timestamp) {
  const interruptedIds = state.runs.order.filter((runId) => {
    const run = state.runs.byId[runId];
    return run.status === 'running' && run.runtimeInstanceId !== runtimeId;
  });
  if (!interruptedIds.length) return state;
  const byId = { ...state.runs.byId };
  for (const runId of interruptedIds) {
    const isShadowRun = byId[runId].kind === 'real';
    byId[runId] = {
      ...byId[runId],
      status: 'failed',
      conclusion: 'interrupted',
      completedAt: timestamp,
      evidence: {
        ...(byId[runId].input ? { input: structuredClone(byId[runId].input) } : {}),
        summary: `运行时重启前未能确认这次${isShadowRun ? '影子运行' : '代理运行'}的结论。`,
        assertions: [],
        error: {
          code: 'runtime_restarted',
          message: `运行时重启，未完成的${isShadowRun ? '影子运行' : '代理运行'}已按未通过恢复。`,
        },
      },
    };
  }
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    runs: { ...state.runs, byId },
    updatedAt: timestamp,
  };
}

async function ensureManagedArtifacts(workspacePath, id) {
  const artifactRoot = path.join(workspacePath, '.wanxiang');
  await mkdir(artifactRoot, { recursive: true });
  await Promise.all([
    ensureManagedAgents(path.join(workspacePath, 'AGENTS.md'), id),
    ensureDataContract(path.join(artifactRoot, 'data-contract.json'), id),
  ]);
}

async function ensureManagedAgents(filename, id) {
  let current = '';
  try {
    current = await readFile(filename, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const managed = `${agentsBlockStart}\n## 万象项目规则\n\n- \`.wanxiang/project.json\` 是项目状态镜像，不是可直接改写的事实源。\n- 只有当前版本的 \`.wanxiang/work-brief.md\` 才是用户已确认的工作契约；不得把未确认草稿描述成“已确认”。\n- 阅读版本化的 \`.wanxiang/data-contract.json\`，不得声称示例数据源已连接。\n- 制作与验证是同一个循环：每次实现后立即运行代表案例和边界案例，再根据证据修正。\n- 只在当前项目内读写；高风险动作必须先预览并获得用户明确批准。\n${agentsBlockEnd}`;
  const start = current.indexOf('<!-- WANXIANG:MANAGED:START');
  const end = current.indexOf(agentsBlockEnd, Math.max(start, 0));
  let updated;
  if (start >= 0 && end >= start) {
    updated = `${current.slice(0, start)}${managed}${current.slice(end + agentsBlockEnd.length)}`;
  } else if (current.trim() === legacyAgents.trim()) {
    updated = `${managed}\n`;
  } else {
    const prefix = current.trimEnd();
    updated = prefix ? `${prefix}\n\n${managed}\n` : `${managed}\n`;
  }
  if (updated !== current) await atomicWrite(filename, updated, id);
}

async function ensureDataContract(filename, id) {
  let current;
  try {
    current = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw serviceError(500, 'data_contract_corrupt', '示例数据契约文件已损坏。');
      throw error;
    }
  }
  if (current === undefined) {
    await atomicWrite(filename, `${JSON.stringify(sampleDataContract(), null, 2)}\n`, id);
    return;
  }
  if (!isWanxiangDataContract(current)) return;
  const migrated = {
    ...current,
    schemaVersion: 1,
    stateVersion: 1,
    managedBy: 'wanxiang',
    ...(current.status === 'sample-contract-only' ? { connected: false } : {}),
  };
  const rendered = `${JSON.stringify(migrated, null, 2)}\n`;
  if (rendered !== `${JSON.stringify(current, null, 2)}\n`) await atomicWrite(filename, rendered, id);
}

function sampleDataContract() {
  return {
    schemaVersion: 1,
    stateVersion: 1,
    managedBy: 'wanxiang',
    status: 'sample-contract-only',
    connected: false,
    sources: [
      { id: 'customers', mode: 'read', fields: ['status', 'owner', 'lastFollowUpAt'] },
      { id: 'communications', mode: 'read', windowDays: 180, fields: ['summary', 'purchaseIntent'] },
    ],
    restrictions: ['no external writes', 'no messages', 'no credential access'],
  };
}

function isWanxiangDataContract(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (value.managedBy === 'wanxiang' || (value.status === 'sample-contract-only'
      && value.connected === false && Array.isArray(value.sources) && Array.isArray(value.restrictions)));
}

async function reconcileBriefArtifact(workspacePath, state, id) {
  const root = path.join(workspacePath, '.wanxiang');
  const pending = path.join(root, '.work-brief.pending.md');
  if (state.brief.confirmedRevision === null) {
    await unlink(pending).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return;
  }
  const expected = renderBrief(state);
  const destination = path.join(root, 'work-brief.md');
  try {
    if (await readFile(destination, 'utf8') === expected) {
      await unlink(pending).catch(() => {});
      return;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    if (await readFile(pending, 'utf8') === expected) {
      await rename(pending, destination);
      return;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(root, { recursive: true });
  await atomicWrite(destination, expected, id);
  await unlink(pending).catch(() => {});
}

async function reconcileFailedActivationArtifact(workspacePath, state, id) {
  if (state.brief.confirmedRevision !== null) {
    await reconcileBriefArtifact(workspacePath, state, id);
    return;
  }
  const root = path.join(workspacePath, '.wanxiang');
  await Promise.all([
    unlink(path.join(root, 'work-brief.md')).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    }),
    unlink(path.join(root, '.work-brief.pending.md')).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    }),
  ]);
}

export function migrateProjectState(state, { confirmedAnswers: recoveredAnswers = null } = {}) {
  if (state?.schemaVersion === 2) {
    if (Object.hasOwn(state.brief || {}, 'confirmedAnswers')
      && Object.hasOwn(state.brief || {}, 'confirmedFieldSources')) {
      return validateV2State(releaseFailedActivationSession(withGuidanceMetadata(
        withRunFeedback(Object.hasOwn(state, 'runs') ? state : { ...state, runs: initialEvaluationRuns() }),
      )));
    }
    const confirmedAnswers = state.brief?.confirmedRevision === null
      ? null
      : (state.brief.confirmedRevision === state.brief.revision ? state.brief.answers : recoveredAnswers);
    const confirmedFieldSources = confirmedAnswers ? cloneFieldSources(state.brief.fieldSources) : null;
    return validateV2State(releaseFailedActivationSession(withGuidanceMetadata(withRunFeedback({
      ...state,
      brief: {
        ...state.brief,
        confirmedRevision: confirmedAnswers ? state.brief.confirmedRevision : null,
        confirmedAnswers: confirmedAnswers ? { ...confirmedAnswers } : null,
        confirmedFieldSources,
      },
    }))));
  }
  validateV1State(state);
  const answers = Object.fromEntries(BRIEF_FIELDS.map(([key]) => [key, key === 'examples' ? '' : state.brief.answers[key]]));
  const dispatch = state.builder.lastDispatch;
  const sessionId = state.builder.sessionId || dispatch?.builderSessionId || null;
  const confirmedAnswers = state.brief.confirmedRevision === null
    ? null
    : (state.brief.confirmedRevision === state.brief.revision ? answers : recoveredAnswers);
  const confirmedFieldSources = confirmedAnswers
    ? Object.fromEntries(BRIEF_FIELDS.map(([key]) => [
      key,
      isPlaceholder(confirmedAnswers[key]) ? unresolvedFieldSource() : { status: 'user_confirmed', sourceMessageIds: [] },
    ]))
    : null;
  const activation = dispatch ? {
    id: dispatch.id,
    briefRevision: dispatch.briefRevision,
    sessionId: dispatch.builderSessionId,
    status: { reserved: 'pending', sent: 'active', failed: 'failed' }[dispatch.status],
    messageId: dispatch.messageId,
    error: dispatch.error,
    ...(dispatch.status === 'reserved' ? {
      previousConfirmed: confirmedAnswers ? {
        revision: state.brief.confirmedRevision,
        answers: { ...confirmedAnswers },
        fieldSources: cloneFieldSources(confirmedFieldSources),
      } : null,
    } : {}),
    createdAt: dispatch.createdAt,
    updatedAt: dispatch.updatedAt,
  } : null;
  return validateV2State(releaseFailedActivationSession({
    schemaVersion: 2,
    stateVersion: state.stateVersion,
    projectName: state.projectName,
    brief: {
      answers,
      fieldSources: Object.fromEntries(BRIEF_FIELDS.map(([key]) => [
        key,
        isPlaceholder(answers[key]) ? unresolvedFieldSource() : { status: 'user_confirmed', sourceMessageIds: [] },
      ])),
      deferredFields: [],
      investigatedFields: [],
      lastChanges: emptyGuidanceChanges(),
      revision: state.brief.revision,
      confirmedRevision: confirmedAnswers ? state.brief.confirmedRevision : null,
      confirmedAnswers: confirmedAnswers ? { ...confirmedAnswers } : null,
      confirmedFieldSources,
    },
    work: {
      sessionId,
      activeRevision: activation?.status === 'active' ? activation.briefRevision : null,
      activation,
    },
    runs: initialEvaluationRuns(),
    feedback: initialRunFeedback(),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  }));
}

function withRunFeedback(state) {
  return Object.hasOwn(state, 'feedback') ? state : { ...state, feedback: initialRunFeedback() };
}

function withGuidanceMetadata(state) {
  const brief = state.brief || {};
  if (Object.hasOwn(brief, 'deferredFields')
    && Object.hasOwn(brief, 'investigatedFields')
    && Object.hasOwn(brief, 'lastChanges')) return state;
  return {
    ...state,
    brief: {
      ...brief,
      deferredFields: brief.deferredFields || [],
      investigatedFields: brief.investigatedFields || [],
      lastChanges: brief.lastChanges || emptyGuidanceChanges(),
    },
  };
}

function releaseFailedActivationSession(state) {
  if (state.work?.activation?.status !== 'failed'
    || state.work.activeRevision !== null
    || state.work.sessionId === null) return state;
  return { ...state, work: { ...state.work, sessionId: null } };
}

function failedActivationBelongsToAnotherSession(state, request) {
  return state.work.activation?.briefRevision === request.briefRevision
    && state.work.activation.status === 'failed'
    && state.work.activation.sessionId !== request.sessionId;
}

function validateV1State(state) {
  const legacyKeys = BRIEF_FIELDS.map(([key]) => key).filter((key) => key !== 'examples');
  if (!state || state.schemaVersion !== 1 || !Number.isInteger(state.stateVersion) || state.stateVersion < 1
    || typeof state.projectName !== 'string' || !state.projectName.trim() || !state.brief || !state.builder
    || !Number.isInteger(state.brief.revision) || state.brief.revision < 0
    || !(state.brief.confirmedRevision === null || (Number.isInteger(state.brief.confirmedRevision)
      && state.brief.confirmedRevision >= 0 && state.brief.confirmedRevision <= state.brief.revision))
    || !(state.builder.sessionId === null || typeof state.builder.sessionId === 'string')
    || legacyKeys.some((key) => typeof state.brief.answers?.[key] !== 'string')
    || typeof state.createdAt !== 'string' || typeof state.updatedAt !== 'string') {
    throw corruptState();
  }
  const dispatch = state.builder.lastDispatch;
  if (dispatch !== null && (!dispatch || typeof dispatch.id !== 'string'
    || !Number.isInteger(dispatch.briefRevision) || dispatch.briefRevision < 0
    || dispatch.briefRevision > state.brief.revision || typeof dispatch.builderSessionId !== 'string'
    || !['reserved', 'sent', 'failed'].includes(dispatch.status)
    || !Number.isInteger(dispatch.attempt) || dispatch.attempt < 1
    || !(dispatch.messageId === null || typeof dispatch.messageId === 'string')
    || !isActivationError(dispatch.error)
    || typeof dispatch.createdAt !== 'string' || typeof dispatch.updatedAt !== 'string')) {
    throw corruptState();
  }
}

function validateV2State(state) {
  if (!state || state.schemaVersion !== 2 || !Number.isInteger(state.stateVersion) || state.stateVersion < 1
    || typeof state.projectName !== 'string' || !state.projectName.trim() || !state.brief || !state.work
    || !isRuns(state.runs) || !isRunFeedbackStore(state.feedback, state.runs)
    || !Number.isInteger(state.brief.revision) || state.brief.revision < 0
    || !isValidFieldKeyList(state.brief.deferredFields)
    || !isValidFieldKeyList(state.brief.investigatedFields)
    || !isValidGuidanceChanges(state.brief.lastChanges)
    || !(state.brief.confirmedRevision === null || (Number.isInteger(state.brief.confirmedRevision)
      && state.brief.confirmedRevision >= 0 && state.brief.confirmedRevision <= state.brief.revision))
    || (state.brief.confirmedRevision === null
      ? state.brief.confirmedAnswers !== null || state.brief.confirmedFieldSources !== null
      : !state.brief.confirmedAnswers || !state.brief.confirmedFieldSources)
    || !(state.work.sessionId === null || typeof state.work.sessionId === 'string')
    || !(state.work.activeRevision === null || (Number.isInteger(state.work.activeRevision)
      && state.work.activeRevision >= 0 && state.work.activeRevision <= state.brief.revision))
    || (state.work.activeRevision !== null && state.work.sessionId === null)
    || typeof state.createdAt !== 'string' || typeof state.updatedAt !== 'string') {
    throw corruptState();
  }
  for (const [key] of BRIEF_FIELDS) {
    if (typeof state.brief.answers?.[key] !== 'string' || !isValidFieldSource(state.brief.fieldSources?.[key])) {
      throw corruptState();
    }
    if (state.brief.confirmedRevision !== null
      && (typeof state.brief.confirmedAnswers[key] !== 'string'
        || !isValidFieldSource(state.brief.confirmedFieldSources[key]))) throw corruptState();
  }
  if (state.brief.confirmedRevision === state.brief.revision
    && (!answersEqual(state.brief.confirmedAnswers, state.brief.answers)
      || !fieldSourceMapsEqual(state.brief.confirmedFieldSources, state.brief.fieldSources))) {
    throw corruptState();
  }
  if (state.brief.confirmedRevision !== null && state.work.activeRevision !== null
    && state.work.activeRevision > state.brief.confirmedRevision) throw corruptState();
  const activation = state.work.activation;
  if (activation !== null && (!activation || typeof activation.id !== 'string'
    || !Number.isInteger(activation.briefRevision) || activation.briefRevision < 0
    || activation.briefRevision > state.brief.revision || typeof activation.sessionId !== 'string'
    || !['pending', 'active', 'failed'].includes(activation.status)
    || (activation.status !== 'failed' && activation.sessionId !== state.work.sessionId)
    || (activation.status === 'failed' && state.work.sessionId !== null && activation.sessionId !== state.work.sessionId)
    || !(activation.messageId === null || typeof activation.messageId === 'string')
    || !isActivationError(activation.error)
    || typeof activation.createdAt !== 'string' || typeof activation.updatedAt !== 'string'
    || (activation.status === 'active' && state.work.activeRevision !== activation.briefRevision))) {
    throw corruptState();
  }
  if (activation?.status === 'pending') {
    if (!Object.hasOwn(activation, 'previousConfirmed')
      || !(activation.previousConfirmed === null || (isValidConfirmedSnapshot(activation.previousConfirmed)
        && activation.previousConfirmed.revision <= state.brief.revision))
      || (Object.hasOwn(activation, 'previousBriefMetadata')
        && !isValidBriefMetadata(activation.previousBriefMetadata))) throw corruptState();
  } else if (activation && (Object.hasOwn(activation, 'previousConfirmed')
    || Object.hasOwn(activation, 'previousBriefMetadata'))) {
    throw corruptState();
  }
  return state;
}

function isValidFieldKeyList(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) return false;
  const ordered = orderedFieldKeys(new Set(value));
  return fieldKeyListsEqual(value, ordered);
}

function isRuns(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !(value.latestRunId === null || typeof value.latestRunId === 'string')
    || !Array.isArray(value.order) || !value.byId || typeof value.byId !== 'object' || Array.isArray(value.byId)
    || new Set(value.order).size !== value.order.length
    || value.order.some((runId) => typeof runId !== 'string' || !isRun(value.byId[runId]))
    || Object.keys(value.byId).length !== value.order.length
    || (value.latestRunId !== null && value.latestRunId !== value.order.at(-1))) return false;
  return Object.entries(value.byId).every(([runId, run]) => run.runId === runId
    && (run.retryOf === null || (value.byId[run.retryOf] && value.order.indexOf(run.retryOf) < value.order.indexOf(runId))));
}

function isRunStart(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['runId', 'sessionId', 'caseId', 'caseTitle', 'kind', 'input', 'agentVersion', 'workflowVersion', 'evalRevision', 'workBriefRevision', 'retryOf', 'startedAt'].includes(key))
    && ['runId', 'sessionId', 'caseId', 'workflowVersion', 'startedAt'].every((key) => typeof value[key] === 'string' && value[key])
    && (value.agentVersion === undefined || (typeof value.agentVersion === 'string' && value.agentVersion))
    && (value.kind === undefined || ['evaluation', 'real'].includes(value.kind))
    && (value.caseTitle === undefined || (typeof value.caseTitle === 'string' && value.caseTitle))
    && (value.input === undefined || (value.input && typeof value.input === 'object' && !Array.isArray(value.input)))
    && (value.kind !== 'real' || (typeof value.agentVersion === 'string' && value.agentVersion
      && typeof value.caseTitle === 'string' && value.caseTitle
      && value.input && typeof value.input === 'object' && !Array.isArray(value.input)))
    && Number.isInteger(value.evalRevision) && value.evalRevision > 0
    && Number.isInteger(value.workBriefRevision) && value.workBriefRevision >= 0
    && (value.retryOf === null || (typeof value.retryOf === 'string' && value.retryOf));
}

function isRunFinish(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['runId', 'status', 'conclusion', 'completedAt', 'evidence'].includes(key))
    && typeof value.runId === 'string' && value.runId
    && ['passed', 'failed', 'cancelled'].includes(value.status)
    && ((value.status === 'passed' && value.conclusion === 'passed')
      || (value.status === 'failed' && ['failed', 'timed_out', 'interrupted'].includes(value.conclusion))
      || (value.status === 'cancelled' && value.conclusion === 'cancelled'))
    && typeof value.completedAt === 'string' && value.completedAt
    && value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence);
}

function isRun(value) {
  if (!value || !isRunStart({
    runId: value.runId,
    sessionId: value.sessionId,
    caseId: value.caseId,
    ...(value.caseTitle ? { caseTitle: value.caseTitle } : {}),
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.input ? { input: value.input } : {}),
    ...(value.agentVersion ? { agentVersion: value.agentVersion } : {}),
    workflowVersion: value.workflowVersion,
    evalRevision: value.evalRevision,
    workBriefRevision: value.workBriefRevision,
    retryOf: value.retryOf,
    startedAt: value.startedAt,
  }) || !(value.runtimeInstanceId === undefined || (typeof value.runtimeInstanceId === 'string' && value.runtimeInstanceId))) return false;
  if (value.status === 'running') {
    return value.completedAt === null && value.conclusion === null && value.evidence === null;
  }
  return isRunFinish({
    runId: value.runId,
    status: value.status,
    conclusion: value.conclusion,
    completedAt: value.completedAt,
    evidence: value.evidence,
  });
}

function isRunFeedbackStore(value, runs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.order) || !value.byId || typeof value.byId !== 'object' || Array.isArray(value.byId)
    || new Set(value.order).size !== value.order.length
    || value.order.some((feedbackId) => typeof feedbackId !== 'string' || !isRunFeedback(value.byId[feedbackId], runs))
    || Object.keys(value.byId).length !== value.order.length) return false;
  return Object.entries(value.byId).every(([feedbackId, feedback]) => feedback.id === feedbackId);
}

function isRunFeedback(value, runs) {
  const run = runs.byId[value?.runId];
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['id', 'workspaceId', 'runId', 'caseId', 'verdict', 'note', 'workBriefRevision', 'agentVersion', 'createdAt'].includes(key))
    && ['id', 'workspaceId', 'runId', 'caseId', 'note', 'agentVersion', 'createdAt'].every((key) => typeof value[key] === 'string')
    && value.id && value.workspaceId && value.runId && value.caseId && value.agentVersion && value.createdAt
    && ['correct', 'needs_changes', 'unacceptable'].includes(value.verdict)
    && Number.isInteger(value.workBriefRevision) && value.workBriefRevision >= 0
    && run?.kind === 'real' && run.status !== 'running'
    && value.caseId === run.caseId && value.workBriefRevision === run.workBriefRevision
    && value.agentVersion === run.agentVersion;
}

function isStructuredDispatchError(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.code === 'string' && typeof value.message === 'string';
}

function isActivationError(value) {
  return value === null || typeof value === 'string' || isStructuredDispatchError(value);
}

function dispatchErrorsEqual(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function canonicalProjectStatePath(dataRoot, workspaceId) {
  const key = createHash('sha256').update(String(workspaceId), 'utf8').digest('hex');
  return path.join(dataRoot, 'projects', `${key}.json`);
}

async function readStoredState(filename, recoverConfirmedAnswers) {
  let raw;
  try {
    raw = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw corruptState();
    throw error;
  }
  const needsRecoveredSnapshot = raw?.brief?.confirmedRevision !== null
    && raw?.brief?.confirmedRevision !== raw?.brief?.revision
    && !raw?.brief?.confirmedAnswers;
  const confirmedAnswers = needsRecoveredSnapshot && recoverConfirmedAnswers
    ? await recoverConfirmedAnswers()
    : null;
  const state = migrateProjectState(raw, { confirmedAnswers });
  return { state, migrated: state !== raw };
}

async function readConfirmedAnswers(root, fallbackName, timestamp) {
  try {
    return parseLegacyBrief(
      await readFile(path.join(root, 'work-brief.md'), 'utf8'),
      fallbackName,
      timestamp,
    ).brief.answers;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeProjectState(workspace, state, dataRoot, id) {
  validateV2State(state);
  if (dataRoot) {
    await writeCanonicalProjectFile(canonicalProjectStatePath(dataRoot, workspace.id), state, id);
  }
  const mirror = path.join(workspace.path, '.wanxiang', 'project.json');
  if (dataRoot) await syncProjectMirror(mirror, state, id).catch(() => {});
  else await syncProjectMirror(mirror, state, id);
}

async function writeCanonicalProjectFile(filename, state, id) {
  await mkdir(path.dirname(filename), { recursive: true });
  await atomicWrite(filename, `${JSON.stringify(state, null, 2)}\n`, id);
}

async function syncProjectMirror(filename, state, id) {
  const rendered = `${JSON.stringify(state, null, 2)}\n`;
  try {
    if (await readFile(filename, 'utf8') === rendered) return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(filename), { recursive: true });
  await atomicWrite(filename, rendered, id);
}

async function atomicWrite(destination, contents, id) {
  const temporary = `${destination}.${id()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readOutbox(filename) {
  try {
    const store = JSON.parse(await readFile(filename, 'utf8'));
    if (store?.schemaVersion !== 1 || !Array.isArray(store.items)) throw new Error('invalid outbox');
    return store;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, items: [] };
    throw serviceError(500, 'outbox_corrupt', '本地社群草稿文件已损坏。');
  }
}

async function readSessionContexts(filename) {
  try {
    const store = JSON.parse(await readFile(filename, 'utf8'));
    if (store?.schemaVersion !== 1 || !store.overrides || typeof store.overrides !== 'object' || Array.isArray(store.overrides)
      || Object.values(store.overrides).some((value) => typeof value !== 'boolean')) {
      throw new Error('invalid session context store');
    }
    return store;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, overrides: {} };
    throw serviceError(500, 'session_context_corrupt', '会话简报上下文设置已损坏。');
  }
}

async function readImportedWorkspaces(filename) {
  try {
    const store = JSON.parse(await readFile(filename, 'utf8'));
    if (store?.schemaVersion !== 1 || !store.items || typeof store.items !== 'object' || Array.isArray(store.items)
      || Object.values(store.items).some((item) => !item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.path !== 'string' || !path.isAbsolute(item.path) || typeof item.importedAt !== 'string')) {
      throw new Error('invalid imported workspace store');
    }
    return store;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, items: {} };
    throw serviceError(500, 'imported_workspaces_corrupt', '已导入项目清单已损坏。');
  }
}

async function withSerialLock(table, key, operation) {
  const previous = table.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  table.set(key, current);
  try {
    return await current;
  } finally {
    if (table.get(key) === current) table.delete(key);
  }
}

function projectSlug(projectName) {
  const slug = projectName
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48);
  return slug || 'project';
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
