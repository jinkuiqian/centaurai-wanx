import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PROXY_RUN_CASE_ID, PROXY_RUN_CASE_IDS } from './evaluation-state.mjs';

export const PROXY_RUN_TOOL_NAME = 'wanxiang_run_evaluation';
export const PROXY_RUN_EVAL_REVISION = 1;
export const PROXY_RUN_WORKFLOW_NAME = 'wanxiang-preset-proxy-run';
export const PROXY_RUN_WORKFLOW_VERSION = '2.0.0';
export { DEFAULT_PROXY_RUN_CASE_ID, PROXY_RUN_CASE_IDS };

const PROXY_RUN_SCRIPT = `const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const expected = args.expected;
const actual = args.actual;
const assertions = [{
  id: "structured-missing-follow-ups",
  passed: JSON.stringify(stable(actual.missingFollowUps)) === JSON.stringify(stable(expected.missingFollowUps)),
}];
for (const [group, fragments] of Object.entries(expected.markdown)) {
  fragments.forEach((fragment, index) => assertions.push({
    id: "markdown-" + group + "-" + index,
    passed: typeof actual.reportMarkdown === "string" && actual.reportMarkdown.includes(fragment),
  }));
}
const passed = assertions.every((item) => item.passed);
return {
  status: passed ? "passed" : "failed",
  summary: passed ? "代理运行通过" : "代理运行未通过",
  assertions,
  output: actual,
};`;

const PRESET_INPUT = Object.freeze({
  caseId: DEFAULT_PROXY_RUN_CASE_ID,
  actual: {
    reportMarkdown: '# 客户跟进代理周报\n\n## 本周概览\n\n安行科技\n\n## 漏跟进客户\n\n- 无\n\n证据：2026-08-28，林岚',
    missingFollowUps: [],
  },
  expected: {
    missingFollowUps: [],
    markdown: {
      requiredSections: ['# 客户跟进代理周报', '## 本周概览', '## 漏跟进客户'],
      customerReferences: ['安行科技'],
      evidenceReferences: ['2026-08-28', '林岚'],
    },
  },
});

export function initialProxyRunProjection() {
  return { status: 'idle', runCount: 0, latest: null, cases: {} };
}

export function applyProxyRunEvent(state, event) {
  if (event?.type === 'tool-workflow/run-start' && event.data?.name === PROXY_RUN_WORKFLOW_NAME) {
    const data = event.data;
    const latest = {
      runId: data.runId,
      projectId: data.projectId,
      sessionId: data.sessionId,
      caseId: data.caseId,
      workflowVersion: data.workflowVersion,
      evalRevision: data.evalRevision,
      workBriefRevision: data.workBriefRevision,
      status: 'running',
      startedAt: data.startedAt,
      completedAt: null,
      evidence: null,
    };
    return {
      status: 'running',
      runCount: state.runCount + 1,
      latest,
      cases: { ...state.cases, [data.caseId]: latest },
    };
  }
  if (event?.type !== 'tool-workflow/run-end') return state;
  const caseId = Object.keys(state.cases).find((id) => state.cases[id].runId === event.data?.runId);
  if (!caseId) return state;
  const completed = {
    ...state.cases[caseId],
    status: event.data.status,
    completedAt: event.data.completedAt,
    evidence: event.data.evidence,
  };
  const isLatest = event.data.runId === state.latest?.runId;
  return {
    ...state,
    status: isLatest ? event.data.status : state.status,
    latest: isLatest ? completed : state.latest,
    cases: { ...state.cases, [caseId]: completed },
  };
}

export function createProxyRunProjectionDefinition() {
  const schema = proxyRunProjectionSchema();
  return {
    key: 'wanxiang.proxy-run',
    stateSchema: schema,
    stateVersion: 2,
    init: initialProxyRunProjection,
    apply: applyProxyRunEvent,
    wire: {
      viewSchema: schema,
      view: (state) => state,
    },
  };
}

export class RunEvidenceStore {
  constructor({ dataRoot, createPendingId = randomUUID }) {
    this.dataRoot = dataRoot;
    this.createPendingId = createPendingId;
  }

  async save(evidence) {
    if (!this.dataRoot) throw proxyRunError('data_root_unavailable', '万象本地数据目录尚未配置。');
    const directory = path.join(this.dataRoot, 'proxy-run-evidence', digest(evidence.projectId));
    const filename = path.join(directory, `${digest(evidence.runId)}.json`);
    const pending = path.join(directory, `.${digest(evidence.runId)}.${this.createPendingId()}.pending`);
    await mkdir(directory, { recursive: true });
    await writeFile(pending, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(pending, filename);
    return filename;
  }
}

export function createPresetProxyRunWorkflowRequest(parent, signal) {
  return {
    script: PROXY_RUN_SCRIPT,
    meta: {
      name: PROXY_RUN_WORKFLOW_NAME,
      description: 'Run Wanxiang\'s deterministic preset proxy run over synthetic material.',
    },
    args: {
      caseId: DEFAULT_PROXY_RUN_CASE_ID,
      actual: structuredClone(PRESET_INPUT.actual),
      expected: structuredClone(PRESET_INPUT.expected),
    },
    parent,
    signal,
  };
}

export function createProxyRunToolAdapter({
  projectService,
  evaluationStore,
  runner,
  workflowEngine,
  evidenceStore,
  flushSession,
  createRunId = randomUUID,
  now = () => new Date().toISOString(),
}) {
  return {
    name: PROXY_RUN_TOOL_NAME,
    description: 'DSH adapter: run Wanxiang\'s deterministic preset proxy run for the current project in the workflow execution environment.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        caseId: {
          type: 'string',
          description: 'A representative case ID from the current confirmed acceptance revision.',
        },
      },
      required: ['caseId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          runId: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['runId', 'status'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({
        kind: 'wanxiang-proxy-run',
        runId: value.runId,
        status: value.status,
      }),
    },
    async execute(args, execution) {
      if (!args || typeof args.caseId !== 'string' || !args.caseId.trim()
        || Object.keys(args).some((key) => key !== 'caseId')) {
        throw proxyRunError('proxy_run_case_invalid', '需要指定当前验收标准中的代表案例。', 400);
      }
      const agent = execution.agent;
      const sessionId = String(agent?.id || '');
      if (!agent?.session || !sessionId || agent.session.header?.origin === 'subagent') {
        throw proxyRunError('proxy_run_session_required', '需要在当前原生会话中开始代理运行。', 403);
      }
      const context = await projectService.contextForAgent(agent);
      if (!context?.state) throw proxyRunError('proxy_run_project_required', '当前会话没有可代理运行的万象项目。', 403);
      if (context.state.work?.sessionId !== sessionId
        || context.state.work?.activeRevision !== context.state.brief?.revision) {
        throw proxyRunError('proxy_run_activation_required', '请先在当前会话确认工作说明并开始制作。', 409);
      }
      if (!evaluationStore || !runner || !context.workspacePath) {
        throw proxyRunError('proxy_run_configuration_invalid', '当前项目的受限评测环境尚未就绪。');
      }
      const evaluation = await evaluationStore.load({
        workspaceId: context.workspaceId,
        workspacePath: context.workspacePath,
      });
      const evalCase = evaluation.eval.cases.find((candidate) => candidate.id === args.caseId);
      if (!evalCase) throw proxyRunError('proxy_run_case_invalid', '当前验收标准不包含这个代表案例。', 400);
      const runId = String(createRunId());
      const startedAt = now();
      agent.session.append('tool-workflow/run-start', {
        runId,
        name: PROXY_RUN_WORKFLOW_NAME,
        projectId: context.workspaceId,
        sessionId,
        caseId: evalCase.id,
        workflowVersion: evaluation.workflow.workflowVersion,
        evalRevision: evaluation.eval.revision,
        workBriefRevision: context.state.brief.revision,
        startedAt,
      });
      await flushSession(agent.session);

      try {
        const actual = await runner.run({
          workspacePath: context.workspacePath,
          entrypoint: evaluation.workflow.entrypoint,
          source: evaluation.source,
          input: structuredClone(evalCase.input),
        });
        const request = {
          script: PROXY_RUN_SCRIPT,
          meta: {
            name: PROXY_RUN_WORKFLOW_NAME,
            description: 'Evaluate deterministic Wanxiang Workflow output against the protected acceptance revision.',
          },
          args: { caseId: evalCase.id, actual, expected: structuredClone(evalCase.expected) },
          parent: agent,
          signal: execution.signal,
          maxTotalAgents: 1,
        };
        const run = workflowEngine.start(request);
        let result;
        try {
          result = await run.result;
        } finally {
          await run.dispose();
        }
        const value = normalizeProxyRunValue(result);
        const evidence = evaluationEvidence({
          runId, context, sessionId, evaluation, evalCase, startedAt, completedAt: now(), value,
        });
        await recordEvaluationResult(agent.session, evidenceStore, flushSession, evidence, result.stopReason);
        if (result.stopReason !== 'completed') {
          throw Object.assign(proxyRunError('proxy_run_workflow_failed', result.error || '代理运行未能完成。'), { evaluationRecorded: true });
        }
        if (evidence.status !== 'passed') {
          throw Object.assign(proxyRunError('proxy_run_assertion_failed', evidence.summary), { evaluationRecorded: true });
        }
        return evidence;
      } catch (error) {
        if (error?.evaluationRecorded) throw error;
        const failure = normalizeFailure(error);
        const evidence = evaluationEvidence({
          runId,
          context,
          sessionId,
          evaluation,
          evalCase,
          startedAt,
          completedAt: now(),
          value: { status: 'failed', summary: failure.message, assertions: [], error: failure },
        });
        await recordEvaluationResult(agent.session, evidenceStore, flushSession, evidence, 'error');
        throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure, { evaluationRecorded: true });
      }
    },
  };
}

function evaluationEvidence({ runId, context, sessionId, evaluation, evalCase, startedAt, completedAt, value }) {
  return {
    runId,
    projectId: String(context.workspaceId),
    sessionId,
    workflowVersion: evaluation.workflow.workflowVersion,
    evalRevision: evaluation.eval.revision,
    workBriefRevision: context.state.brief.revision,
    caseId: evalCase.id,
    status: value.status,
    startedAt,
    completedAt,
    summary: value.summary,
    assertions: value.assertions,
    ...(value.output ? { output: value.output } : {}),
    ...(value.error ? { error: value.error } : {}),
  };
}

async function recordEvaluationResult(session, evidenceStore, flushSession, evidence, stopReason) {
  await evidenceStore.save(evidence);
  session.append('tool-workflow/run-end', {
    runId: evidence.runId,
    stopReason,
    status: evidence.status,
    completedAt: evidence.completedAt,
    evidence: {
      summary: evidence.summary,
      assertions: evidence.assertions,
      ...(evidence.output ? { output: evidence.output } : {}),
      ...(evidence.error ? { error: evidence.error } : {}),
    },
  });
  await flushSession(session);
}

function normalizeFailure(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'proxy_run_workflow_failed',
    message: error instanceof Error && error.message ? error.message : '代理运行未能完成。',
  };
}

function normalizeProxyRunValue(result) {
  const value = result?.value;
  if (result?.stopReason !== 'completed' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'failed', summary: result?.error || '代理运行未能完成。', assertions: [] };
  }
  const assertions = Array.isArray(value.assertions)
    ? value.assertions.filter((item) => item && typeof item.id === 'string' && typeof item.passed === 'boolean')
      .map((item) => ({ id: item.id, passed: item.passed }))
    : [];
  const output = value.output && typeof value.output === 'object' && !Array.isArray(value.output)
    ? structuredClone(value.output)
    : null;
  const passed = value.status === 'passed' && assertions.length > 0 && assertions.every((item) => item.passed) && output;
  return {
    status: passed ? 'passed' : 'failed',
    summary: typeof value.summary === 'string' && value.summary ? value.summary : passed ? '代理运行通过' : '代理运行未通过',
    assertions,
    ...(output ? { output } : {}),
  };
}

function proxyRunProjectionSchema() {
  return {
    parse(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['idle', 'running', 'passed', 'failed'].includes(value.status)
        || !Number.isSafeInteger(value.runCount) || value.runCount < 0
        || (value.latest !== null && (typeof value.latest !== 'object' || Array.isArray(value.latest)))
        || !value.cases || typeof value.cases !== 'object' || Array.isArray(value.cases)) {
        throw new Error('invalid Wanxiang proxy-run projection');
      }
      return value;
    },
  };
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function proxyRunError(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}
