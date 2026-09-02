import { createHash, randomUUID } from 'node:crypto';
import { recordRunResult } from './run-evidence.mjs';

export const WORK_RUN_WORKFLOW_NAME = 'wanxiang-real-work-run';

export function initialWorkRunProjection() {
  return { status: 'idle', runCount: 0, latest: null, runs: {} };
}

export function applyWorkRunEvent(state, event) {
  if (event?.type === 'tool-workflow/run-start' && event.data?.name === WORK_RUN_WORKFLOW_NAME) {
    const data = event.data;
    if (state.runs[data.runId]) return state;
    const latest = {
      runId: data.runId,
      projectId: data.projectId,
      sessionId: data.sessionId,
      caseId: data.caseId,
      caseTitle: data.caseTitle,
      kind: 'real',
      agentVersion: data.agentVersion,
      workflowVersion: data.workflowVersion,
      evalRevision: data.evalRevision,
      workBriefRevision: data.workBriefRevision,
      status: 'running',
      startedAt: data.startedAt,
      completedAt: null,
      conclusion: null,
      evidence: null,
    };
    return {
      status: 'running',
      runCount: state.runCount + 1,
      latest,
      runs: { ...state.runs, [data.runId]: latest },
    };
  }
  if (event?.type !== 'tool-workflow/run-end') return state;
  const current = state.runs[event.data?.runId];
  if (!current || current.status !== 'running') return state;
  const completed = {
    ...current,
    status: event.data.status,
    completedAt: event.data.completedAt,
    conclusion: event.data.conclusion ?? inferConclusion(event.data),
    evidence: event.data.evidence,
  };
  return {
    ...state,
    status: event.data.runId === state.latest?.runId ? event.data.status : state.status,
    latest: event.data.runId === state.latest?.runId ? completed : state.latest,
    runs: { ...state.runs, [event.data.runId]: completed },
  };
}

export function createWorkRunProjectionDefinition() {
  const schema = workRunProjectionSchema();
  return {
    key: 'wanxiang.work-run',
    stateSchema: schema,
    stateVersion: 1,
    init: initialWorkRunProjection,
    apply: applyWorkRunEvent,
    wire: { viewSchema: schema, view: (state) => state },
  };
}

export function createWorkRunAdapter({
  projectService,
  evaluationStore,
  runner,
  evidenceStore,
  flushSession,
  createRunId = randomUUID,
  now = () => new Date().toISOString(),
}) {
  async function executeRun(args, execution, retry = null) {
      validateWorkRunArgs(args);
      const agent = execution?.agent;
      const sessionId = String(agent?.id || '');
      if (!agent?.session || !sessionId || agent.session.header?.origin === 'subagent') {
        throw workRunError('work_run_session_required', '需要在当前原生会话中开始影子运行。', 403);
      }
      const context = retry?.context ?? await projectService.contextForAgent(agent);
      if (!context?.state || context.state.work?.sessionId !== sessionId
        || context.state.work?.activeRevision !== context.state.brief?.revision) {
        throw workRunError('work_run_activation_required', '请先在当前会话确认工作说明并开始制作。', 409);
      }
      if (!evaluationStore || !runner || !context.workspacePath
        || typeof projectService.startRealWorkRun !== 'function'
        || typeof projectService.finishRun !== 'function') {
        throw workRunError('work_run_configuration_invalid', '当前项目的影子运行环境尚未就绪。');
      }
      const evaluation = await evaluationStore.load({
        workspaceId: context.workspaceId,
        workspacePath: context.workspacePath,
      });
      if (!evaluation.agent?.agentVersion
        || evaluation.agent.workBriefRevision !== undefined
          && evaluation.agent.workBriefRevision !== context.state.brief.revision) {
        throw workRunError('work_agent_required', '请先生成与当前工作说明一致的工作 Agent。', 409);
      }
      const runId = String(createRunId());
      const startedAt = now();
      const input = structuredClone(args.input);
      const runStart = {
        runId,
        sessionId,
        caseId: retry?.sourceRun.caseId ?? `real-case-${runId}`,
        caseTitle: args.caseTitle.trim(),
        kind: 'real',
        input,
        agentVersion: evaluation.agent.agentVersion,
        workflowVersion: evaluation.workflow.workflowVersion,
        evalRevision: evaluation.eval.revision,
        workBriefRevision: context.state.brief.revision,
        retryOf: retry?.sourceRun.runId ?? null,
        startedAt,
      };
      await projectService.startRealWorkRun(String(context.workspaceId), runStart);
      try {
        agent.session.append('tool-workflow/run-start', {
          ...runStart,
          name: WORK_RUN_WORKFLOW_NAME,
          projectId: context.workspaceId,
        });
        await flushSession(agent.session);
        const output = await runner.run({
          workspacePath: context.workspacePath,
          entrypoint: evaluation.workflow.entrypoint,
          source: evaluation.source,
          input: structuredClone(input),
          signal: execution.signal,
        });
        const evidence = workRunEvidence({
          runStart, context, output, completedAt: now(), status: 'passed',
          summary: '工作 Agent 已完成影子运行。',
        });
        await recordRunResult({
          session: agent.session, evidenceStore,
          finishRun: (projectId, value) => projectService.finishRun(projectId, value),
          flushSession, evidence,
          conclusion: 'passed', stopReason: 'completed',
        });
        return evidence;
      } catch (error) {
        if (error?.runTerminalCommitted) throw error;
        const failure = normalizeFailure(error, execution.signal);
        const terminal = terminalForFailure(failure);
        const evidence = workRunEvidence({
          runStart, context, completedAt: now(), status: terminal.status,
          summary: failure.message, error: failure,
        });
        await recordRunResult({
          session: agent.session, evidenceStore,
          finishRun: (projectId, value) => projectService.finishRun(projectId, value),
          flushSession, evidence,
          conclusion: terminal.conclusion,
          stopReason: terminal.status === 'cancelled' ? 'cancelled' : 'error',
        });
        throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure, {
          runTerminalCommitted: true,
          evidence,
        });
      }
  }

  return {
    execute(args, execution) {
      return executeRun(args, execution);
    },
    async retryFeedback(feedbackId, execution) {
      if (typeof feedbackId !== 'string' || !feedbackId) {
        throw workRunError('feedback_retry_invalid', '反馈重跑请求无效。', 400);
      }
      const agent = execution?.agent;
      const context = await projectService.contextForAgent(agent);
      const feedback = context?.state?.feedback?.byId?.[feedbackId];
      const improvement = context?.state?.improvements?.order
        ?.map((improvementId) => context.state.improvements.byId[improvementId])
        .find((item) => item.feedbackId === feedbackId && (
          (item.kind === 'implementation' && item.status === 'planned')
          || (item.kind === 'contract' && item.status === 'accepted')
        ));
      const sourceRun = context?.state?.runs?.byId?.[feedback?.runId];
      if (!improvement || !sourceRun || sourceRun.kind !== 'real' || sourceRun.status === 'running') {
        throw workRunError('feedback_retry_unavailable', '找不到可重跑的原反馈和真实案例。', 409);
      }
      return executeRun({ caseTitle: sourceRun.caseTitle, input: sourceRun.input }, execution, {
        context,
        sourceRun,
      });
    },
  };
}

function validateWorkRunArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || typeof args.caseTitle !== 'string' || !args.caseTitle.trim() || args.caseTitle.length > 200
    || !args.input || typeof args.input !== 'object' || Array.isArray(args.input)
    || Object.keys(args).some((key) => !['caseTitle', 'input'].includes(key))) {
    throw workRunError('work_run_input_invalid', '请提供案例名称和有效的真实工作输入。', 400);
  }
}

function workRunEvidence({ runStart, context, output, completedAt, status, summary, error }) {
  const completed = status === 'passed';
  const outputValue = completed ? structuredClone(output) : null;
  return {
    runId: runStart.runId,
    retryOf: runStart.retryOf,
    kind: 'real',
    projectId: String(context.workspaceId),
    sessionId: runStart.sessionId,
    agentVersion: runStart.agentVersion,
    workflowVersion: runStart.workflowVersion,
    evalRevision: runStart.evalRevision,
    workBriefRevision: runStart.workBriefRevision,
    caseId: runStart.caseId,
    caseTitle: runStart.caseTitle,
    status,
    startedAt: runStart.startedAt,
    completedAt,
    input: structuredClone(runStart.input),
    summary,
    steps: executionFacts(runStart, outputValue, completedAt, completed),
    taskSteps: completed ? taskStepsFromOutput(outputValue) : [],
    ...(completed ? { output: outputValue } : {}),
    ...(error ? { error } : {}),
  };
}

function executionFacts(runStart, output, completedAt, completed) {
  return [
    {
      id: 'input-recorded', label: '记录真实工作输入', status: 'completed',
      facts: { sha256: digestJson(runStart.input), fields: Object.keys(runStart.input).sort() },
    },
    {
      id: 'agent-loaded', label: '载入已确认的工作 Agent', status: 'completed',
      facts: { agentVersion: runStart.agentVersion, workBriefRevision: runStart.workBriefRevision },
    },
    {
      id: 'workflow-executed', label: completed ? '在受限环境执行 Workflow' : 'Workflow 执行失败',
      status: completed ? 'completed' : 'failed', facts: { startedAt: runStart.startedAt, completedAt },
    },
    {
      id: 'output-recorded', label: completed ? '记录工作结果' : '没有可记录的工作结果',
      status: completed ? 'completed' : 'skipped',
      facts: completed ? { sha256: digestJson(output), fields: Object.keys(output).sort() } : {},
    },
  ];
}

function taskStepsFromOutput(output) {
  if (!Array.isArray(output?.steps)) return [];
  return output.steps.slice(0, 100).map((step, index) => {
    if (typeof step === 'string') return { id: `task-step-${index + 1}`, label: step };
    if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
    const label = typeof step.label === 'string' ? step.label : typeof step.title === 'string' ? step.title : '';
    if (!label.trim()) return null;
    return { id: typeof step.id === 'string' && step.id ? step.id : `task-step-${index + 1}`, label: label.trim() };
  }).filter(Boolean);
}

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeFailure(error, signal) {
  const cancelled = signal?.aborted || error?.name === 'AbortError' || error?.code === 'workflow_cancelled';
  return {
    code: cancelled ? 'workflow_cancelled' : typeof error?.code === 'string' ? error.code : 'work_run_workflow_failed',
    message: cancelled ? '用户已取消影子运行。' : error instanceof Error && error.message ? error.message : '工作 Agent 未能完成影子运行。',
    ...(Number.isInteger(error?.statusCode) ? { statusCode: error.statusCode } : {}),
  };
}

function terminalForFailure(failure) {
  if (failure.code === 'workflow_cancelled') return { status: 'cancelled', conclusion: 'cancelled' };
  if (failure.code === 'workflow_timeout') return { status: 'failed', conclusion: 'timed_out' };
  return { status: 'failed', conclusion: 'failed' };
}

function inferConclusion(data) {
  if (data.status === 'cancelled') return 'cancelled';
  if (data.status === 'failed' && data.evidence?.error?.code === 'workflow_timeout') return 'timed_out';
  return data.status;
}

function workRunProjectionSchema() {
  return {
    parse(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['idle', 'running', 'passed', 'failed', 'cancelled'].includes(value.status)
        || !Number.isSafeInteger(value.runCount) || value.runCount < 0
        || (value.latest !== null && (typeof value.latest !== 'object' || Array.isArray(value.latest)))
        || !value.runs || typeof value.runs !== 'object' || Array.isArray(value.runs)) {
        throw new Error('invalid Wanxiang work-run projection');
      }
      return value;
    },
  };
}

function workRunError(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}
