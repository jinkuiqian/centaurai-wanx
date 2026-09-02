export const CURRENT_AGENT_PERMISSION_CONTRACT = '工作 Agent 仅可读写当前项目；Workflow 禁止网络和外部副作用';

const PERMISSION_BOUNDARY_MARKER = '\n\n权限要求（仍受当前产品安全上限约束）：';
const IMPROVEMENT_STATUSES = [
  'planned', 'awaiting_confirmation', 'accepted', 'rejected', 'completed', 'failed',
];
const OPEN_IMPROVEMENT_STATUSES = new Set(['planned', 'awaiting_confirmation']);

export function createFeedbackImprovementState({ briefFields, applyBriefUpdate }) {
  const contractFields = [...briefFields, ['permissions', '权限']];

  function plan(current, workspaceId, input, sessionId, timestamp, id) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.feedbackId !== 'string' || !input.feedbackId
      || !['implementation', 'contract'].includes(input.kind)
      || Object.keys(input).some((key) => !['feedbackId', 'kind', 'contractPatch'].includes(key))) {
      throw feedbackError(400, 'feedback_change_invalid', '反馈修改计划无效。');
    }
    const feedback = current.feedback.byId[input.feedbackId];
    const run = current.runs.byId[feedback?.runId];
    if (!feedback || !run || feedback.verdict === 'correct') {
      throw feedbackError(409, 'feedback_change_unavailable', '只有需要修改或不可接受的反馈才能开始改进。');
    }
    if (run.sessionId !== sessionId) {
      throw feedbackError(403, 'feedback_change_session_mismatch', '只能在原制作会话中处理这条反馈。');
    }
    const open = current.improvements.order
      .map((improvementId) => current.improvements.byId[improvementId])
      .find((item) => OPEN_IMPROVEMENT_STATUSES.has(item.status));
    if (open?.feedbackId === feedback.id && open.kind === input.kind) return current;
    if (open) {
      throw feedbackError(409, 'feedback_change_in_progress', '请先完成当前反馈修改或工作说明决定。');
    }

    const contractPatch = input.kind === 'contract' ? validateContractPatch(input.contractPatch) : null;
    if (input.kind === 'implementation' && input.contractPatch !== undefined) {
      throw feedbackError(400, 'feedback_change_invalid', '实现范围内的修改不能携带工作说明变更。');
    }
    const confirmed = current.brief.confirmedAnswers || current.brief.answers;
    const confirmedPermission = permissionContractFromBoundaries(confirmed.boundaries);
    const diff = contractPatch ? contractFields
      .filter(([key]) => Object.hasOwn(contractPatch, key))
      .map(([field, label]) => ({
        field,
        label,
        before: field === 'permissions' ? confirmedPermission : confirmed[field],
        after: contractPatch[field],
      }))
      .filter(({ before, after }) => before !== after) : [];
    if (input.kind === 'contract' && diff.length === 0) {
      throw feedbackError(400, 'feedback_contract_diff_empty', '工作说明提案必须包含至少一项实际变化。');
    }
    const latestVersion = [...current.improvements.order].reverse()
      .map((improvementId) => current.improvements.byId[improvementId])
      .find((item) => item.after)?.after;
    const improvement = {
      id,
      workspaceId,
      feedbackId: feedback.id,
      sourceRunId: run.runId,
      sourceCaseId: run.caseId,
      sessionId,
      kind: input.kind,
      status: input.kind === 'contract' ? 'awaiting_confirmation' : 'planned',
      before: structuredClone(latestVersion || {
        agentVersion: run.agentVersion,
        workBriefRevision: run.workBriefRevision,
        evalRevision: run.evalRevision,
      }),
      contractPatch,
      diff,
      after: null,
      rerunId: null,
      error: null,
      nextAction: input.kind === 'contract'
        ? '请成员核对工作说明差异并确认或拒绝。'
        : '修改实现后自动运行受保护评测，并用原输入重跑。',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return {
      ...current,
      stateVersion: current.stateVersion + 1,
      improvements: {
        order: [...current.improvements.order, improvement.id],
        byId: { ...current.improvements.byId, [improvement.id]: improvement },
      },
      updatedAt: timestamp,
    };
  }

  function decide(current, input, sessionId, timestamp) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.improvementId !== 'string' || !input.improvementId
      || !['accept', 'reject'].includes(input.decision)
      || Object.keys(input).some((key) => !['improvementId', 'decision'].includes(key))) {
      throw feedbackError(400, 'feedback_change_decision_invalid', '工作说明提案决定无效。');
    }
    const improvement = current.improvements.byId[input.improvementId];
    if (!improvement || improvement.kind !== 'contract') {
      throw feedbackError(404, 'feedback_change_not_found', '找不到这项工作说明提案。');
    }
    if (improvement.sessionId !== sessionId) {
      throw feedbackError(403, 'feedback_change_session_mismatch', '只能在原制作会话中决定这项提案。');
    }
    if (improvement.status !== 'awaiting_confirmation') {
      throw feedbackError(409, 'feedback_change_already_decided', '这项工作说明提案已经处理。');
    }
    const nextImprovement = {
      ...improvement,
      status: input.decision === 'accept' ? 'accepted' : 'rejected',
      nextAction: input.decision === 'accept'
        ? '请同步并重新确认新版工作说明后再继续修改。'
        : '继续使用当前已确认的工作说明和 Agent。',
      updatedAt: timestamp,
    };
    const briefPatch = Object.fromEntries(Object.entries(improvement.contractPatch)
      .filter(([key]) => key !== 'permissions'));
    if (Object.hasOwn(improvement.contractPatch, 'permissions')) {
      const boundaries = briefPatch.boundaries ?? current.brief.answers.boundaries;
      briefPatch.boundaries = `${boundariesWithoutPermissionContract(boundaries)}${PERMISSION_BOUNDARY_MARKER}${improvement.contractPatch.permissions}`;
    }
    const base = input.decision === 'accept'
      ? applyBriefUpdate(current, {
        answers: briefPatch,
        fieldSources: Object.fromEntries(Object.keys(briefPatch).map((key) => [key, {
          status: 'user_confirmed', sourceMessageIds: [],
        }])),
      }, timestamp)
      : { ...current, stateVersion: current.stateVersion + 1, updatedAt: timestamp };
    return {
      ...base,
      improvements: {
        ...base.improvements,
        byId: { ...base.improvements.byId, [improvement.id]: nextImprovement },
      },
    };
  }

  function complete(current, input, timestamp) {
    const improvement = current.improvements.byId[input?.improvementId];
    const rerun = current.runs.byId[input?.rerunId];
    const completable = (improvement?.kind === 'implementation' && improvement.status === 'planned')
      || (improvement?.kind === 'contract' && improvement.status === 'accepted');
    if (!completable
      || typeof input.afterAgentVersion !== 'string' || !input.afterAgentVersion
      || !Number.isInteger(input.evalRevision) || input.evalRevision < 1
      || !rerun || rerun.retryOf !== improvement.sourceRunId || rerun.caseId !== improvement.sourceCaseId
      || rerun.agentVersion !== input.afterAgentVersion || rerun.evalRevision !== input.evalRevision
      || (improvement.kind === 'contract' && rerun.workBriefRevision <= improvement.before.workBriefRevision)) {
      throw feedbackError(409, 'feedback_change_completion_invalid', '反馈修改结果与原运行或新版本不匹配。');
    }
    return replace(current, {
      ...improvement,
      status: 'completed',
      after: {
        agentVersion: input.afterAgentVersion,
        workBriefRevision: rerun.workBriefRevision,
        evalRevision: input.evalRevision,
      },
      rerunId: rerun.runId,
      error: null,
      nextAction: rerun.status === 'passed'
        ? '请成员核对重跑结果并提交反馈。'
        : '根据失败证据修正后重试，不要改写验收标准。',
      updatedAt: timestamp,
    }, timestamp);
  }

  function fail(current, input, timestamp) {
    const improvement = current.improvements.byId[input?.improvementId];
    const failable = (improvement?.kind === 'implementation' && improvement.status === 'planned')
      || (improvement?.kind === 'contract' && improvement.status === 'accepted');
    if (!failable
      || !input.error || typeof input.error.code !== 'string' || typeof input.error.message !== 'string') {
      throw feedbackError(409, 'feedback_change_failure_invalid', '反馈修改失败记录无效。');
    }
    return replace(current, {
      ...improvement,
      status: 'failed',
      after: input.afterAgentVersion ? {
        agentVersion: input.afterAgentVersion,
        workBriefRevision: Number.isInteger(input.workBriefRevision)
          ? input.workBriefRevision : improvement.before.workBriefRevision,
        evalRevision: Number.isInteger(input.evalRevision) ? input.evalRevision : improvement.before.evalRevision,
      } : null,
      rerunId: typeof input.rerunId === 'string' ? input.rerunId : null,
      error: { code: input.error.code, message: input.error.message },
      nextAction: '保留当前状态；检查失败原因后从原反馈重新开始修改。',
      updatedAt: timestamp,
    }, timestamp);
  }

  function validateContractPatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw feedbackError(400, 'brief_patch_invalid', '工作说明更新格式无效。');
    }
    const known = new Set(contractFields.map(([key]) => key));
    const patch = {};
    for (const [key, answer] of Object.entries(value)) {
      if (!known.has(key) || typeof answer !== 'string') {
        throw feedbackError(400, 'brief_patch_invalid', '工作说明更新格式无效。');
      }
      patch[key] = answer;
    }
    if (Object.keys(patch).length === 0) {
      throw feedbackError(400, 'feedback_contract_diff_empty', '工作说明提案不能为空。');
    }
    return patch;
  }

  function isStore(value, feedbackStore, runs) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.order) || !value.byId || typeof value.byId !== 'object' || Array.isArray(value.byId)
      || new Set(value.order).size !== value.order.length
      || value.order.some((improvementId) => typeof improvementId !== 'string'
        || !isImprovement(value.byId[improvementId], feedbackStore, runs))
      || Object.keys(value.byId).length !== value.order.length) return false;
    return Object.entries(value.byId).every(([improvementId, improvement]) => improvement.id === improvementId);
  }

  function isImprovement(value, feedbackStore, runs) {
    const feedback = feedbackStore.byId[value?.feedbackId];
    const sourceRun = runs.byId[value?.sourceRunId];
    const rerun = value?.rerunId === null ? null : runs.byId[value?.rerunId];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => ![
        'id', 'workspaceId', 'feedbackId', 'sourceRunId', 'sourceCaseId', 'sessionId', 'kind', 'status',
        'before', 'contractPatch', 'diff', 'after', 'rerunId', 'error', 'nextAction', 'createdAt', 'updatedAt',
      ].includes(key))
      || !['id', 'workspaceId', 'feedbackId', 'sourceRunId', 'sourceCaseId', 'sessionId', 'nextAction', 'createdAt', 'updatedAt']
        .every((key) => typeof value[key] === 'string' && value[key])
      || !['implementation', 'contract'].includes(value.kind) || !IMPROVEMENT_STATUSES.includes(value.status)
      || !isVersionTrace(value.before)
      || !(value.after === null || isVersionTrace(value.after))
      || !(value.rerunId === null || typeof value.rerunId === 'string')
      || !(value.error === null || isStructuredError(value.error))
      || !Array.isArray(value.diff)
      || feedback?.runId !== value.sourceRunId || feedback.verdict === 'correct'
      || sourceRun?.caseId !== value.sourceCaseId || sourceRun.sessionId !== value.sessionId) return false;
    if (value.kind === 'implementation') {
      if (value.contractPatch !== null || value.diff.length !== 0) return false;
    } else if (!value.contractPatch || !isContractPatch(value.contractPatch)
      || value.diff.length === 0 || value.diff.some((item) => !isContractDiff(item))) return false;
    if (value.status === 'completed') {
      return value.after !== null && rerun?.retryOf === value.sourceRunId
        && rerun.caseId === value.sourceCaseId && rerun.agentVersion === value.after.agentVersion
        && rerun.evalRevision === value.after.evalRevision;
    }
    if (value.status === 'failed') return value.error !== null;
    return value.after === null && value.rerunId === null && value.error === null;
  }

  function isContractPatch(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length > 0
      && Object.entries(value).every(([key, item]) => (
        contractFields.some(([field]) => field === key) && typeof item === 'string'
      ));
  }

  function isContractDiff(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.field === 'string' && contractFields.some(([key]) => key === value.field)
      && typeof value.label === 'string' && typeof value.before === 'string' && typeof value.after === 'string'
      && value.before !== value.after;
  }

  return { plan, decide, complete, fail, isStore };
}

function replace(current, improvement, timestamp) {
  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    improvements: {
      ...current.improvements,
      byId: { ...current.improvements.byId, [improvement.id]: improvement },
    },
    updatedAt: timestamp,
  };
}

function permissionContractFromBoundaries(boundaries) {
  const markerIndex = String(boundaries || '').lastIndexOf(PERMISSION_BOUNDARY_MARKER);
  return markerIndex === -1
    ? CURRENT_AGENT_PERMISSION_CONTRACT
    : boundaries.slice(markerIndex + PERMISSION_BOUNDARY_MARKER.length);
}

function boundariesWithoutPermissionContract(boundaries) {
  const value = String(boundaries || '');
  const markerIndex = value.lastIndexOf(PERMISSION_BOUNDARY_MARKER);
  return markerIndex === -1 ? value : value.slice(0, markerIndex);
}

function isVersionTrace(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.agentVersion === 'string' && value.agentVersion
    && Number.isInteger(value.workBriefRevision) && value.workBriefRevision >= 0
    && Number.isInteger(value.evalRevision) && value.evalRevision > 0;
}

function isStructuredError(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.code === 'string' && typeof value.message === 'string';
}

function feedbackError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}
