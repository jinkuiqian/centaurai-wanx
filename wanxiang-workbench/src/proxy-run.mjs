import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PROXY_RUN_TOOL_NAME = 'wanxiang_run_evaluation';
export const PROXY_RUN_CASE_ID = 'preset-proxy-run-v1';
export const PROXY_RUN_EVAL_REVISION = 1;
export const PROXY_RUN_WORKFLOW_NAME = 'wanxiang-preset-proxy-run';
export const PROXY_RUN_WORKFLOW_VERSION = '1.0.0';

const PROXY_RUN_SCRIPT = `const stableOutput = {
  title: args.fixture.title,
  itemCount: args.fixture.items.length,
  labels: args.fixture.items.map((item) => item.label).sort(),
};
const expected = args.expected;
const assertions = [
  { id: "stable-title", passed: stableOutput.title === expected.title },
  { id: "stable-count", passed: stableOutput.itemCount === expected.itemCount },
  { id: "stable-labels", passed: JSON.stringify(stableOutput.labels) === JSON.stringify(expected.labels) },
];
const passed = assertions.every((item) => item.passed);
return {
  status: passed ? "passed" : "failed",
  summary: passed ? "代理运行通过" : "代理运行未通过",
  assertions,
  output: stableOutput,
};`;

const PRESET_INPUT = Object.freeze({
  caseId: PROXY_RUN_CASE_ID,
  fixture: {
    title: '客户跟进清单',
    items: [{ label: '待回复' }, { label: '已安排' }],
  },
  expected: {
    title: '客户跟进清单',
    itemCount: 2,
    labels: ['已安排', '待回复'],
  },
});

export function initialProxyRunProjection() {
  return { status: 'idle', runCount: 0, latest: null };
}

export function applyProxyRunEvent(state, event) {
  if (event?.type === 'tool-workflow/run-start' && event.data?.name === PROXY_RUN_WORKFLOW_NAME) {
    const data = event.data;
    return {
      status: 'running',
      runCount: state.runCount + 1,
      latest: {
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
      },
    };
  }
  if (event?.type !== 'tool-workflow/run-end' || event.data?.runId !== state.latest?.runId) return state;
  return {
    ...state,
    status: event.data.status,
    latest: {
      ...state.latest,
      status: event.data.status,
      completedAt: event.data.completedAt,
      evidence: event.data.evidence,
    },
  };
}

export function createProxyRunProjectionDefinition() {
  const schema = proxyRunProjectionSchema();
  return {
    key: 'wanxiang.proxy-run',
    stateSchema: schema,
    stateVersion: 1,
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
    args: structuredClone(PRESET_INPUT),
    parent,
    signal,
  };
}

export function createProxyRunToolAdapter({
  projectService,
  workflowEngine,
  evidenceStore,
  flushSession,
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
          enum: [PROXY_RUN_CASE_ID],
          description: 'The preset synthetic material revision to run through the proxy slice.',
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
      if (!args || args.caseId !== PROXY_RUN_CASE_ID || Object.keys(args).some((key) => key !== 'caseId')) {
        throw proxyRunError('proxy_run_case_invalid', '只支持当前预置代理运行。', 400);
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

      const run = workflowEngine.start(createPresetProxyRunWorkflowRequest(agent, execution.signal));
      const startedAt = now();
      const abort = () => run.cancel('parent step aborted');
      let result;
      try {
        agent.session.append('tool-workflow/run-start', {
          runId: run.id,
          name: PROXY_RUN_WORKFLOW_NAME,
          projectId: context.workspaceId,
          sessionId,
          caseId: PROXY_RUN_CASE_ID,
          workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
          evalRevision: PROXY_RUN_EVAL_REVISION,
          workBriefRevision: context.state.brief.revision,
          startedAt,
        });
        await flushSession(agent.session);
        execution.signal?.addEventListener('abort', abort, { once: true });
        result = await run.result;
      } finally {
        execution.signal?.removeEventListener('abort', abort);
        await run.dispose();
      }

      const completedAt = now();
      const value = normalizeProxyRunValue(result);
      const evidence = {
        runId: String(run.id),
        projectId: String(context.workspaceId),
        sessionId,
        workflowVersion: PROXY_RUN_WORKFLOW_VERSION,
        evalRevision: PROXY_RUN_EVAL_REVISION,
        workBriefRevision: context.state.brief.revision,
        caseId: PROXY_RUN_CASE_ID,
        status: value.status,
        startedAt,
        completedAt,
        summary: value.summary,
        assertions: value.assertions,
      };
      await evidenceStore.save(evidence);
      agent.session.append('tool-workflow/run-end', {
        runId: run.id,
        stopReason: result.stopReason,
        status: evidence.status,
        completedAt,
        evidence: {
          summary: evidence.summary,
          assertions: evidence.assertions,
        },
      });
      await flushSession(agent.session);

      if (result.stopReason !== 'completed') {
        throw proxyRunError('proxy_run_workflow_failed', result.error || '代理运行未能完成。');
      }
      if (evidence.status !== 'passed') {
        throw proxyRunError('proxy_run_assertion_failed', evidence.summary);
      }
      return evidence;
    },
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
  const passed = value.status === 'passed' && assertions.length > 0 && assertions.every((item) => item.passed);
  return {
    status: passed ? 'passed' : 'failed',
    summary: typeof value.summary === 'string' && value.summary ? value.summary : passed ? '代理运行通过' : '代理运行未通过',
    assertions,
  };
}

function proxyRunProjectionSchema() {
  return {
    parse(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['idle', 'running', 'passed', 'failed'].includes(value.status)
        || !Number.isSafeInteger(value.runCount) || value.runCount < 0
        || (value.latest !== null && (typeof value.latest !== 'object' || Array.isArray(value.latest)))) {
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
