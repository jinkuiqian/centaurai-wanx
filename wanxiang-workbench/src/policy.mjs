import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  BRIEF_FIELDS,
  FIELD_SOURCE_STATUSES,
  WanxiangStateService,
  deriveProjectState,
  serviceError,
} from './project-state.mjs';
import {
  createProxyRunProjectionDefinition,
  createProxyRunToolAdapter,
} from './proxy-run.mjs';
import { EvaluationProjectStore, WORKFLOW_ENTRYPOINT, WORKFLOW_MANIFEST } from './evaluation-state.mjs';
import { RestrictedWorkflowRunner } from './restricted-runner.mjs';
import { RunEvidenceStore, eventEvidenceForRun } from './run-evidence.mjs';
import { createWorkRunAdapter, createWorkRunProjectionDefinition } from './work-run.mjs';

/** Wanxiang's product policy and browser branding, composed into every session. */
export const name = 'wanxiang-workbench';
export const inject = [
  'agents',
  'permissionPresets',
  'sessionProjections',
  'sessions',
  'systemPrompt',
  'tools',
  'web',
  'webServer',
  'workflowEngine',
  'workspaceRegistry',
];

const manifest = JSON.stringify({
  name: '万象',
  short_name: '万象',
  display: 'standalone',
  background_color: '#f3f0e8',
  theme_color: '#2f6656',
  icons: [],
});

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#2f6656"/><path d="M18 19h8v8h12v-8h8v26h-8V35H26v10h-8z" fill="#fffaf0"/><circle cx="32" cy="32" r="4" fill="#d4a964"/></svg>`;
const discoveryPolicy = `You are Wanxiang, helping a non-technical member turn one real, recurring job into a dependable work capability.

You are currently understanding the work. Continue the normal conversation from the user's first message. Follow the single next action in the Wanxiang work-description context. Before the user-visible reply, use wanxiang_update_work_brief for every field made more precise by the latest message or inspected material. Mark fields stated explicitly by the user as confirmedFields; leave your interpretation as inferred; when the user says they do not know or will answer later, use unresolvedFields instead of saving those words as an answer. If the next action is inspect_context, use only the allowed read-only tools and then report investigatedFields, even when nothing useful was found. Then summarize what you now understand in one or two sentences. If the next action is ask_field, ask only its one supplied question and no second question. For every other next action, do not invent another discovery question; explain the supplied action in plain language. Clearly distinguish what the user confirmed from what you inferred.

This phase is read-only. You may inspect user-selected local material and public web pages, but you must not edit project files, send messages, use logged-in browser actions, or create external side effects. Do not claim that you have started making the solution. The user starts that explicitly from the work-description panel.`;

const makingPolicy = `You are Wanxiang, continuing the same conversation in which the user described the work.

The confirmed work description is the current contract. Work in one continuous make-and-verify loop: inspect the real materials, make the smallest useful implementation, run representative and boundary checks immediately, explain failures in plain language, and revise until there is evidence for every acceptance criterion. Code generation alone is not completion.

When a persisted real-run feedback asks for changes, call wanxiang_plan_feedback_change before editing. Classify it as implementation only when goal, inputs, outputs, permissions, boundaries and success criteria stay unchanged; then edit the implementation and let the Host run the protected Eval plus the original real case automatically. Otherwise submit a contractPatch, do not edit files, and wait for the member to accept or reject the visible work-description diff. Never loosen or rewrite evaluation criteria to manufacture a pass.

Before editing a new project's Workflow directly, call wanxiang_generate_work_agent once with a deterministic implementation, task-specific input and output JSON Schemas, and one smoke case derived from the confirmed work description. The Host binds these artifacts to the confirmed work-description revision and runs the protected smoke Eval automatically. Do not reuse customer-follow-up fields unless the confirmed work is actually customer follow-up.

Keep artifacts readable and versionable inside the current project. Never claim a Data Agent or external system is connected when only a sample contract exists. Preview risky writes and obtain the native approval before any external message, deletion, payment, credential use, or other irreversible side effect. The community drawer is external support, not an approval stage.`;
export const evaluationPolicy = `The editable deterministic implementation is .wanxiang/${WORKFLOW_ENTRYPOINT} with its fixed manifest at .wanxiang/${WORKFLOW_MANIFEST}. This is a proxy vertical slice over synthetic material, not a shadow or real run. After every successful change to the Workflow or its manifest, call wanxiang_run_evaluation once without caseId so all protected cases run immediately; do not wait for another user message. Inspect every case result before making the next change. .wanxiang/evals.json is a read-only mirror of protected representative cases and expected results: never edit it to make the implementation pass.`;

const DISCOVERY_TOOLS = new Set([
  'ask_user_question',
  'read',
  'read_image',
  'wanxiang_update_work_brief',
  'web_fetch',
  'web_search',
]);
const DISCOVERY_PRESET_CANDIDATES = ['wanxiang-discovery', 'read-only'];
const BUILD_PRESET_CANDIDATES = ['wanxiang-build', 'workspace-write'];

export function apply(ctx) {
  const dataRoot = dataRootFromEnvironment();
  const evaluationStore = new EvaluationProjectStore({ dataRoot });
  const service = new WanxiangStateService({
    workspaceRegistry: ctx.workspaceRegistry,
    projectsRoot: absoluteRoot(process.env.WANXIANG_WORKSPACE_ROOT),
    dataRoot,
    evaluationStore,
  });
  const runEvidenceStore = new RunEvidenceStore({ dataRoot });
  const runner = new RestrictedWorkflowRunner();
  const authorization = createAuthorizationTracker();
  const evaluationTool = createProxyRunToolAdapter({
    projectService: service,
    evaluationStore,
    runner,
    workflowEngine: ctx.workflowEngine,
    evidenceStore: runEvidenceStore,
    flushSession: (session) => ctx.sessions.flush(session),
  });
  const workRun = createWorkRunAdapter({
    projectService: service,
    evaluationStore,
    runner,
    evidenceStore: runEvidenceStore,
    flushSession: (session) => ctx.sessions.flush(session),
  });
  const generationEvaluations = new WeakSet();
  const automaticEvaluation = createAutomaticEvaluationHooks({
    projectService: service,
    evaluationStore,
    evaluationTool,
    workRun,
    evaluatedExecutions: generationEvaluations,
  });
  void service.prepareRoots().catch(() => {});
  void runEvidenceStore.recover(async (evidence) => {
    const state = await service.getProject(String(evidence.projectId));
    return terminalRunMatchesEvidence(state, evidence);
  }).catch(() => {});

  ctx.effect(() => ctx.tools.register(createWorkBriefTool(service)));
  ctx.effect(() => ctx.sessionProjections.register(createProxyRunProjectionDefinition()));
  ctx.effect(() => ctx.sessionProjections.register(createWorkRunProjectionDefinition()));
  ctx.effect(() => ctx.tools.register(evaluationTool));
  ctx.effect(() => ctx.tools.register(createWorkAgentGenerationTool(
    service, evaluationStore, evaluationTool, generationEvaluations, workRun,
  )));
  ctx.effect(() => ctx.tools.register(createRunFeedbackChangeTool(service)));
  ctx.effect(() => ctx.on('tools/pre-execute', automaticEvaluation.before));
  ctx.effect(() => ctx.on('tools/post-execute', automaticEvaluation.after));
  if (!ctx.tools.get('web_fetch')) {
    ctx.effect(() => ctx.tools.register(createPublicWebFetchTool(ctx.web)));
  }

  ctx.effect(() => ctx.on('tools/pre-execute', async (execution, next) => {
    const agent = execution.agent;
    if (!isRootAgent(agent)) return next();
    let context;
    try {
      context = await service.contextForAgent(agent);
    } catch (error) {
      return isAgentInRegisteredWorkspace(ctx, agent)
        ? { kind: 'deny', reason: '万象暂时无法验证当前项目，已安全阻止工具运行。' }
        : next();
    }
    if (!context) return next();
    authorization.update(context.state, String(agent.id));
    if (isBuildAuthorized(context.state, String(agent.id))) return next();
    if (await discoveryToolAllowed(ctx, context, execution)) {
      authorization.allowDiscoveryExecution(execution);
      return next();
    }
    return {
      kind: 'deny',
      reason: '万象仍在理解工作；此时只允许读取资料和更新工作说明。请由用户确认后再开始制作。',
    };
  }));

  // Waterfall listeners can be reordered by other plugins. This monotonic guard
  // keeps the discovery allowlist authoritative even if another listener tries
  // to replace an earlier decision or a user manually changes a permission preset.
  ctx.effect(() => ctx.tools.guard(createDiscoveryAuthorizationGuard(ctx, authorization)));

  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    const agent = context.agent;
    if (!isRootAgent(agent)) return assembled;
    let resolved;
    try {
      resolved = await service.contextForAgent(agent);
    } catch {
      return assembled;
    }
    if (!resolved) return assembled;
    const state = resolved.state;
    if (!state) return assembled;
    const making = isBuildAuthorized(state, String(agent.id));
    authorization.update(state, String(agent.id));
    const sections = assembled.sections
      .filter((item) => !['wanxiang:builder-policy', 'wanxiang:discovery-policy', 'wanxiang:making-policy'].includes(item.name));
    const contexts = assembled.contexts
      .filter((item) => !['wanxiang:confirmed-work-brief', 'wanxiang:work-description'].includes(item.name));
    sections.push({
      name: making ? 'wanxiang:making-policy' : 'wanxiang:discovery-policy',
      text: making ? `${makingPolicy}\n\n${evaluationPolicy}` : discoveryPolicy,
    });
    contexts.push({
      name: 'wanxiang:work-description',
      text: renderPromptWorkDescription(state, deriveProjectState(state), making),
    });
    return { ...assembled, sections, contexts };
  }));

  ctx.effect(() => ctx.on('session/created', async (session) => {
    if (session?.header?.origin === 'subagent') return;
    await reconcileSessionPermission(ctx, service, session, authorization).catch(() => {});
  }));
  for (const session of ctx.sessions.list()) {
    if (session?.header?.origin !== 'subagent') {
      void reconcileSessionPermission(ctx, service, session, authorization).catch(() => {});
    }
  }

  ctx.effect(() => ctx.webServer.tapIndex((html) => html
    .replace(/<title>.*?<\/title>/iu, '<title>万象</title>')
    .replace(/<meta name="theme-color" content="[^"]*"\s*\/?>/iu, '<meta name="theme-color" content="#2f6656">')));

  registerApi(ctx, '/api/wanxiang/projects', async (request) => {
    requireMethod(request, 'POST');
    const payload = requireObject(await readJson(request));
    if (payload.workspaceId !== undefined) {
      const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
      const { workspace, state } = await service.importProject(workspaceId);
      return [200, createProjectResponse(state, { workspaceId: String(workspace.id), imported: true })];
    }
    const projectName = requiredText(payload.projectName, 'Agent 名称', 200);
    const { workspace, state } = await service.createProject(projectName);
    return [201, createProjectResponse(state, { workspaceId: String(workspace.id) })];
  });

  registerApi(ctx, '/api/wanxiang/project', async (request) => {
    if (request.method === 'GET') {
      const workspaceId = queryText(request, 'workspaceId', 200);
      const snapshot = await service.getProjectEvidence(workspaceId);
      return [200, createProjectResponse(snapshot.state, { evaluation: snapshot.evaluation })];
    }
    requireMethod(request, 'PUT');
    const payload = requireObject(await readJson(request));
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    const baseVersion = nonNegativeInteger(payload.baseVersion, '基础版本', 1);
    const patch = validateProjectPatch(payload.patch ?? legacyProjectPatch(payload));
    const state = await service.updateProject(workspaceId, baseVersion, patch);
    return [200, createProjectResponse(state)];
  });

  registerApi(ctx, '/api/wanxiang/project/confirm', async (request) => {
    requireMethod(request, 'POST');
    const payload = requireObject(await readJson(request));
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    const baseVersion = nonNegativeInteger(payload.baseVersion, '基础版本', 1);
    const briefRevision = nonNegativeInteger(payload.briefRevision, '工作简报修订号');
    const current = await service.getProject(workspaceId);
    if (current.stateVersion !== baseVersion) {
      throw serviceError(409, 'revision_conflict', '项目状态已经变化，请刷新后重试。', { current });
    }
    if (current.work?.activeRevision !== null) {
      throw serviceError(409, 'activation_required', '已开始制作的项目必须通过“同步并开始制作”确认新版工作说明。', { current });
    }
    const state = await service.confirmProject(workspaceId, baseVersion, briefRevision);
    return [200, createProjectResponse(state)];
  });

  registerApi(ctx, '/api/wanxiang/activation', createActivationApiHandler(ctx, service, authorization));
  registerApi(ctx, '/api/wanxiang/evaluation/rerun', createEvaluationApiHandler(ctx, service, evaluationTool));
  registerApi(ctx, '/api/wanxiang/work-run', createRealWorkRunApiHandler(ctx, service, workRun));
  registerApi(ctx, '/api/wanxiang/run-feedback', createRunFeedbackApiHandler(ctx, service));
  registerApi(ctx, '/api/wanxiang/feedback-change', createRunFeedbackChangeDecisionApiHandler(ctx, service));

  // v0.2 clients may still finish an already-reserved operation while upgrading.
  registerApi(ctx, '/api/wanxiang/dispatch', async (request) => {
    requireOneOfMethods(request, ['POST', 'PUT']);
    throw serviceError(409, 'activation_required', '万象已改为在当前对话中开始制作，请刷新页面后重试。');
  });

  registerApi(ctx, '/api/wanxiang/community-outbox', async (request) => {
    if (request.method === 'GET') {
      return [200, { ok: true, items: await service.listOutbox() }];
    }
    if (request.method === 'POST') {
      const payload = requireObject(await readJson(request));
      const workspaceId = optionalText(payload.workspaceId, '项目 ID', 200);
      const kind = normalizeOutboxKind(payload.kind);
      const message = requiredText(payload.message, '社群草稿', 12_000);
      return [201, { ok: true, item: await service.addOutboxItem({ workspaceId, kind, message }) }];
    }
    requireMethod(request, 'DELETE');
    const id = queryText(request, 'id', 200);
    return [200, { ok: true, item: await service.deleteOutboxItem(id) }];
  });

  registerApi(ctx, '/api/wanxiang/session-context', async (request) => {
    if (request.method === 'GET') {
      const workspaceId = queryText(request, 'workspaceId', 200);
      const sessionId = queryText(request, 'sessionId', 200);
      return [200, { ok: true, context: await service.getSessionContext(workspaceId, sessionId) }];
    }
    requireMethod(request, 'PUT');
    const payload = requireObject(await readJson(request));
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    const sessionId = requiredText(payload.sessionId, '会话 ID', 200);
    const enabled = requiredBoolean(payload.enabled, '简报上下文开关');
    return [200, { ok: true, context: await service.setSessionContext(workspaceId, sessionId, enabled) }];
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/manifest.webmanifest',
    handler: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
      response.end(manifest);
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/favicon.svg',
    handler: (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' });
      response.end(favicon);
    },
  }));
}

export function createWorkAgentGenerationTool(
  service, evaluationStore, evaluationTool, evaluatedExecutions = null, workRun = null,
) {
  return {
    name: 'wanxiang_generate_work_agent',
    description: 'Generate the current project\'s smallest deterministic work Agent from its active confirmed work description. Creates task-specific contracts and one protected smoke case; the Host automatically runs the Eval after generation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workflowSource: {
          type: 'string',
          description: 'Deterministic JavaScript read from stdin and writing one JSON object to stdout. No imports, network, environment, filesystem or external side effects.',
        },
        inputSchema: { type: 'object', additionalProperties: true },
        outputSchema: { type: 'object', additionalProperties: true },
        smokeCase: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            input: { type: 'object', additionalProperties: true },
            expected: { type: 'object', additionalProperties: true },
          },
          required: ['id', 'title', 'input', 'expected'],
        },
      },
      required: ['workflowSource', 'inputSchema', 'outputSchema', 'smokeCase'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          agentVersion: { type: 'string' },
          workBriefRevision: { type: 'integer' },
          workflowVersion: { type: 'string' },
          evalRevision: { type: 'integer' },
          smokeCaseId: { type: 'string' },
          feedbackRerunIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'agentVersion', 'workBriefRevision', 'workflowVersion', 'evalRevision', 'smokeCaseId'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({
        kind: 'wanxiang-work-agent',
        agentVersion: value.agentVersion,
        evalRevision: value.evalRevision,
      }),
    },
    async execute(args, execution) {
      const agent = execution?.agent;
      const sessionId = String(agent?.id || '');
      if (!agent?.session || !sessionId || agent.session.header?.origin === 'subagent') {
        throw serviceError(403, 'agent_generation_session_required', '需要在当前万象根会话中生成工作 Agent。');
      }
      const context = await service.contextForAgent(agent);
      const state = context?.state;
      const revision = state?.brief?.revision;
      const activationReady = state?.work?.activeRevision === revision
        || (state?.work?.activation?.status === 'pending'
          && state.work.activation.briefRevision === revision);
      if (!state || state.work?.sessionId !== sessionId
        || !activationReady
        || state.brief?.confirmedRevision !== state.brief?.revision
        || !state.brief?.confirmedAnswers) {
        throw serviceError(409, 'agent_generation_activation_required', '请先确认当前工作说明并在这个会话开始制作。');
      }
      if (!evaluationStore || !evaluationTool || typeof context.workspacePath !== 'string') {
        throw serviceError(503, 'agent_generation_unavailable', '工作 Agent 生成环境尚未就绪。');
      }
      const answers = state.brief.confirmedAnswers;
      const acceptedContractImprovements = (state.improvements?.order || [])
        .map((improvementId) => state.improvements.byId[improvementId])
        .filter((item) => item.kind === 'contract' && item.status === 'accepted');
      let generated = null;
      let smokeCaseId = null;
      const feedbackRerunIds = [];
      try {
        generated = await evaluationStore.generate({
          workspaceId: String(context.workspaceId),
          workspacePath: context.workspacePath,
        }, {
          ...args,
          projectName: state.projectName,
          workBriefRevision: state.brief.confirmedRevision,
          brief: Object.fromEntries(BRIEF_FIELDS.map(([key]) => [key, answers[key]])),
        });
        evaluatedExecutions?.add(execution);
        smokeCaseId = generated.eval.cases[0].id;
        const smokeRun = await evaluationTool.execute({ caseId: smokeCaseId }, execution);
        if (smokeRun?.status !== 'passed') {
          throw serviceError(409, 'agent_generation_smoke_failed', '工作 Agent 已生成，但冒烟案例未通过；请根据运行证据修正后重试。');
        }
        if (acceptedContractImprovements.length && typeof workRun?.retryFeedback !== 'function') {
          throw serviceError(503, 'feedback_retry_unavailable', '契约更新后的真实案例重跑环境尚未就绪。');
        }
        for (const improvement of acceptedContractImprovements) {
          const rerun = await workRun.retryFeedback(improvement.feedbackId, execution);
          await service.completeRunFeedbackChange(String(context.workspaceId), {
            improvementId: improvement.id,
            afterAgentVersion: generated.agent.agentVersion,
            rerunId: rerun.runId,
            evalRevision: generated.agent.evalRevision,
          });
          feedbackRerunIds.push(rerun.runId);
        }
      } catch (error) {
        await Promise.all(acceptedContractImprovements.map((improvement) => (
          service.failRunFeedbackChange?.(String(context.workspaceId), {
            improvementId: improvement.id,
            ...(generated?.agent?.agentVersion ? { afterAgentVersion: generated.agent.agentVersion } : {}),
            ...(Number.isInteger(generated?.agent?.workBriefRevision)
              ? { workBriefRevision: generated.agent.workBriefRevision } : {}),
            ...(Number.isInteger(generated?.agent?.evalRevision)
              ? { evalRevision: generated.agent.evalRevision } : {}),
            error: {
              code: typeof error?.code === 'string' ? error.code : 'feedback_change_failed',
              message: error instanceof Error ? error.message : '契约反馈修改未能完成。',
            },
          }).catch(() => {})
        )));
        throw error;
      }
      return {
        ok: true,
        agentVersion: generated.agent.agentVersion,
        workBriefRevision: generated.agent.workBriefRevision,
        workflowVersion: generated.agent.workflowVersion,
        evalRevision: generated.agent.evalRevision,
        smokeCaseId,
        ...(feedbackRerunIds.length ? { feedbackRerunIds } : {}),
      };
    },
  };
}

export function createDiscoveryAuthorizationGuard(ctx, authorization) {
  return (execution) => {
    const agent = execution.agent;
    if (!isRootAgent(agent) || !isAgentInRegisteredWorkspace(ctx, agent)) return undefined;
    if (authorization.isBuildAuthorized(String(agent.id))) return undefined;
    if (authorization.isDiscoveryExecutionAllowed(execution)) return undefined;
    return '万象仍在理解工作；此时只允许读取当前项目资料和更新工作说明。';
  };
}

export function createActivationApiHandler(ctx, service, authorization = null) {
  return async (request) => {
    requireOneOfMethods(request, ['POST', 'PUT']);
    const payload = requireObject(await readJson(request));
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    if (request.method === 'POST') {
      const baseVersion = nonNegativeInteger(payload.baseVersion, '基础版本', 1);
      const briefRevision = nonNegativeInteger(payload.briefRevision, '工作简报修订号');
      const sessionId = requiredText(payload.sessionId, '会话 ID', 200);
      const retry = optionalBoolean(payload.retry, '重试标记');
      const agent = await requireActivationAgent(ctx, service, workspaceId, sessionId, { requireIdle: true });
      const result = await service.reserveActivation(workspaceId, {
        baseVersion,
        briefRevision,
        sessionId,
        retry,
      });
      if (result.disposition !== 'reserved') {
        authorization?.update(result.state, result.activation?.sessionId || sessionId);
        return [result.disposition === 'in-progress' ? 202 : 200, activationResponse(ctx, result)];
      }
      try {
        await switchPermission(ctx, agent, 'build');
        authorization?.update(result.state, sessionId);
      } catch (cause) {
        const error = permissionError(cause);
        let state;
        try {
          state = await service.finalizeActivation(workspaceId, {
            activationId: result.activation.id,
            status: 'failed',
            error: structuredErrorValue(error),
          });
        } catch (recoveryCause) {
          authorization?.deny(sessionId);
          await switchPermission(ctx, agent, 'discovery').catch(() => {});
          throw serviceError(503, 'activation_recovery_failed', '万象无法确认制作启动结果，已安全关闭写入工具；请刷新状态后重试。', {
            current: result.state,
            cause: recoveryCause,
          });
        }
        const fallbackMode = isBuildAuthorized(state, sessionId) ? 'build' : 'discovery';
        authorization?.update(state, sessionId);
        await switchPermission(ctx, agent, fallbackMode).catch(() => {});
        throw serviceError(error.statusCode, error.code, error.message, { current: state, cause });
      }
      return [200, activationResponse(ctx, result)];
    }
    const activationId = requiredText(payload.activationId, '启动记录 ID', 200);
    const status = enumValue(payload.status, '启动状态', ['active', 'failed']);
    const current = await service.getProject(workspaceId);
    const activation = current.work?.activation;
    if (!activation || activation.id !== activationId) {
      throw serviceError(404, 'activation_not_found', '找不到这次制作启动记录。');
    }
    const agent = await requireActivationAgent(ctx, service, workspaceId, activation.sessionId, { requireIdle: false });
    if (status === 'active') {
      assertPermission(ctx, agent, 'build');
      const messageId = requiredText(payload.messageId, '消息 ID', 500);
      const state = await service.finalizeActivation(workspaceId, { activationId, status, messageId });
      authorization?.update(state, activation.sessionId);
      return [200, createProjectResponse(state, { activationId, activation: state.work.activation })];
    }
    const error = structuredActivationError(payload.error);
    const state = await service.finalizeActivation(workspaceId, { activationId, status, error });
    const fallbackMode = isBuildAuthorized(state, activation.sessionId) ? 'build' : 'discovery';
    authorization?.update(state, activation.sessionId);
    await switchPermission(ctx, agent, fallbackMode).catch((cause) => {
      throw serviceError(503, 'permission_rollback_failed', '制作未启动，但权限显示暂时无法同步；万象仍按上一个已生效版本限制操作。', {
        current: state,
        cause,
      });
    });
    return [200, createProjectResponse(state, { activationId, activation: state.work.activation })];
  };
}

export function createEvaluationApiHandler(ctx, service, evaluationTool) {
  return async (request, operationSignal) => {
    requireMethod(request, 'POST');
    const payload = requireObject(await readJson(request));
    rejectUnknownKeys(payload, ['workspaceId', 'sessionId'], '评测重跑参数');
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    const sessionId = requiredText(payload.sessionId, '会话 ID', 200);
    const agent = await requireActivationAgent(ctx, service, workspaceId, sessionId, { requireIdle: true });
    const evaluationRun = await evaluationTool.execute({}, { agent, signal: operationSignal });
    const snapshot = await service.getProjectEvidence(workspaceId);
    return [200, createProjectResponse(snapshot.state, { evaluation: snapshot.evaluation, evaluationRun })];
  };
}

export function createRealWorkRunApiHandler(ctx, service, workRun) {
  return async (request, operationSignal) => {
    requireMethod(request, 'POST');
    const payload = requireObject(await readJson(request));
    rejectUnknownKeys(payload, ['workspaceId', 'sessionId', 'caseTitle', 'input'], '影子运行参数');
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    const sessionId = requiredText(payload.sessionId, '会话 ID', 200);
    const caseTitle = requiredText(payload.caseTitle, '案例名称', 200);
    const input = requireObject(payload.input, '真实工作输入必须是 JSON 对象。');
    const agent = await requireActivationAgent(ctx, service, workspaceId, sessionId, { requireIdle: true });
    if (typeof workRun?.execute !== 'function') {
      throw serviceError(503, 'work_run_unavailable', '影子运行环境尚未就绪。');
    }
    const run = await workRun.execute({ caseTitle, input }, { agent, signal: operationSignal });
    const snapshot = await service.getProjectEvidence(workspaceId);
    return [200, createProjectResponse(snapshot.state, { evaluation: snapshot.evaluation, workRun: run })];
  };
}

export function createRunFeedbackApiHandler(ctx, service) {
  return async (request) => {
    requireMethod(request, 'POST');
    const payload = requireObject(await readJson(request));
    rejectUnknownKeys(payload, ['workspaceId', 'sessionId', 'baseVersion', 'runId', 'verdict', 'note'], '运行反馈参数');
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    const sessionId = requiredText(payload.sessionId, '会话 ID', 200);
    const baseVersion = nonNegativeInteger(payload.baseVersion, '基础版本', 1);
    const runId = requiredText(payload.runId, '运行 ID', 200);
    const verdict = enumValue(payload.verdict, '反馈结论', ['correct', 'needs_changes', 'unacceptable']);
    const note = optionalText(payload.note, '反馈说明', 12_000) || '';
    await requireActivationAgent(ctx, service, workspaceId, sessionId, { requireIdle: true });
    const state = await service.recordRunFeedback(
      workspaceId, baseVersion, { runId, verdict, note }, sessionId,
    );
    const snapshot = await service.getProjectEvidence(workspaceId);
    return [200, createProjectResponse(state, {
      evaluation: snapshot.evaluation,
      feedbackId: state.feedback.order.at(-1),
    })];
  };
}

export function createRunFeedbackChangeDecisionApiHandler(ctx, service) {
  return async (request) => {
    requireMethod(request, 'POST');
    const payload = requireObject(await readJson(request));
    rejectUnknownKeys(payload, [
      'workspaceId', 'sessionId', 'baseVersion', 'improvementId', 'decision',
    ], '工作说明提案决定参数');
    const workspaceId = requiredText(payload.workspaceId, '项目 ID', 200);
    const sessionId = requiredText(payload.sessionId, '会话 ID', 200);
    const baseVersion = nonNegativeInteger(payload.baseVersion, '基础版本', 1);
    const improvementId = requiredText(payload.improvementId, '改进记录 ID', 200);
    const decision = enumValue(payload.decision, '提案决定', ['accept', 'reject']);
    await requireActivationAgent(ctx, service, workspaceId, sessionId, { requireIdle: true });
    const state = await service.decideRunFeedbackChange(
      workspaceId, baseVersion, { improvementId, decision }, sessionId,
    );
    const snapshot = await service.getProjectEvidence(workspaceId);
    return [200, createProjectResponse(state, { evaluation: snapshot.evaluation })];
  };
}

export function createRunFeedbackChangeTool(service) {
  return {
    name: 'wanxiang_plan_feedback_change',
    description: 'Classify one persisted member feedback before changing the work Agent. Use implementation only when the confirmed work description remains unchanged; otherwise submit a contract patch and wait for explicit member confirmation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseStateVersion: { type: 'integer' },
        feedbackId: { type: 'string' },
        kind: { type: 'string', enum: ['implementation', 'contract'] },
        contractPatch: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...Object.fromEntries(BRIEF_FIELDS.map(([key]) => [key, { type: 'string' }])),
            permissions: {
              type: 'string',
              description: 'Requested permission change. Confirmation records the request but never bypasses the Host safety ceiling.',
            },
          },
        },
      },
      required: ['baseStateVersion', 'feedbackId', 'kind'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          ok: { type: 'boolean' }, improvementId: { type: 'string' },
          kind: { type: 'string' }, status: { type: 'string' }, diff: { type: 'array' }, nextAction: { type: 'string' },
        },
        required: ['ok', 'improvementId', 'kind', 'status', 'diff', 'nextAction'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, execution) {
      const input = requireObject(args, '反馈修改计划参数无效。');
      rejectUnknownKeys(input, ['baseStateVersion', 'feedbackId', 'kind', 'contractPatch'], '反馈修改计划参数');
      const baseVersion = nonNegativeInteger(input.baseStateVersion, '基础版本', 1);
      const feedbackId = requiredText(input.feedbackId, '反馈 ID', 200);
      const kind = enumValue(input.kind, '修改范围', ['implementation', 'contract']);
      const context = await service.contextForAgent(execution?.agent);
      const sessionId = String(execution?.agent?.id || '');
      if (!context?.state || !sessionId || context.state.work?.sessionId !== sessionId) {
        throw serviceError(403, 'feedback_change_session_required', '需要在原制作会话中处理反馈。');
      }
      const contractPatch = kind === 'contract'
        ? validateFeedbackContractPatch(input.contractPatch)
        : undefined;
      const state = await service.planRunFeedbackChange(
        String(context.workspaceId), baseVersion,
        { feedbackId, kind, ...(contractPatch ? { contractPatch } : {}) }, sessionId,
      );
      const improvement = [...state.improvements.order].reverse()
        .map((improvementId) => state.improvements.byId[improvementId])
        .find((item) => item.feedbackId === feedbackId
          && ['planned', 'awaiting_confirmation'].includes(item.status));
      if (!improvement) throw serviceError(500, 'feedback_change_not_recorded', '反馈修改计划未能保存。');
      return {
        ok: true,
        improvementId: improvement.id,
        kind: improvement.kind,
        status: improvement.status,
        diff: improvement.diff,
        nextAction: improvement.nextAction,
      };
    },
  };
}

export function createAutomaticEvaluationHooks({
  projectService, evaluationStore = null, evaluationTool, workRun = null, evaluatedExecutions = null,
}) {
  const snapshots = new WeakMap();
  return {
    before: async (execution, next) => {
      const decision = await next();
      if (!execution?.agent || execution.signal?.aborted || decision.kind === 'deny') return decision;
      try {
        const context = await projectService.contextForAgent(execution.agent);
        if (context?.state && context.state.work?.sessionId === String(execution.agent.id)
          && context.state.work?.activeRevision === context.state.brief?.revision
          && typeof context.workspacePath === 'string') {
          snapshots.set(execution, {
            context,
            files: await workflowFileSnapshot(context.workspacePath),
            improvement: plannedImplementationImprovement(context.state),
          });
        }
      } catch (error) {
        snapshots.set(execution, { error });
      }
      return decision;
    },
    after: async (execution, result, next) => {
      const decision = await next();
      const alreadyEvaluated = evaluatedExecutions?.has(execution) ?? false;
      evaluatedExecutions?.delete(execution);
      const before = snapshots.get(execution);
      snapshots.delete(execution);
      if (!before) return decision;
      if (before.error) {
        return addAutomaticEvaluationNotice(
          decision,
          `万象无法确认 Workflow 修改前的版本，因此没有自动评测：${before.error instanceof Error ? before.error.message : '版本读取失败'}。请手动重跑当前修订。`,
        );
      }
      let after;
      try {
        after = await workflowFileSnapshot(before.context.workspacePath);
      } catch (error) {
        return addAutomaticEvaluationNotice(
          decision,
          `Workflow 工具已完成，但万象无法确认修改后的版本：${error instanceof Error ? error.message : '版本读取失败'}。请手动重跑当前修订。`,
        );
      }
      if (JSON.stringify(after) === JSON.stringify(before.files)) return decision;
      if (alreadyEvaluated) return decision;
      let revised = null;
      let feedbackRerun = null;
      try {
        if (before.files.agent !== null && before.files.agent === after.agent) {
          revised = await evaluationStore?.reviseGeneratedAgent({
            workspaceId: String(before.context.workspaceId),
            workspacePath: before.context.workspacePath,
          });
        }
        const evaluationExecution = execution.signal?.aborted
          ? { ...execution, signal: new AbortController().signal }
          : execution;
        const evaluationRun = await evaluationTool.execute({}, evaluationExecution);
        if (before.improvement) {
          if (!revised?.agent?.agentVersion || !Number.isInteger(revised?.eval?.revision)) {
            throw serviceError(500, 'feedback_agent_revision_missing', '无法确认反馈修改后的 Agent 版本。');
          }
          if (evaluationRun?.status !== 'passed') {
            throw serviceError(409, 'feedback_evaluation_failed', '受保护评测未全部通过，已停止真实案例重跑。');
          }
          if (revised.eval.revision !== before.improvement.before.evalRevision) {
            throw serviceError(409, 'feedback_eval_revision_changed', '反馈修改改变了受保护验收标准，已停止重跑。');
          }
          if (typeof workRun?.retryFeedback !== 'function') {
            throw serviceError(503, 'feedback_retry_unavailable', '真实案例重跑环境尚未就绪。');
          }
          feedbackRerun = await workRun.retryFeedback(before.improvement.feedbackId, evaluationExecution);
          await projectService.completeRunFeedbackChange(String(before.context.workspaceId), {
            improvementId: before.improvement.id,
            afterAgentVersion: revised.agent.agentVersion,
            rerunId: feedbackRerun.runId,
            evalRevision: revised.eval.revision,
          });
        }
        return addAutomaticEvaluationNotice(
          decision,
          before.improvement
            ? `万象已自动运行当前 Eval：${evaluationRun.summary || evaluationRun.status}；原真实案例已自动重跑（${feedbackRerun.status}）。请核对新结果。`
            : `万象已自动运行当前 Eval：${evaluationRun.summary || evaluationRun.status}。请检查逐案例证据后再继续修改。`,
        );
      } catch (error) {
        if (before.improvement && typeof projectService.failRunFeedbackChange === 'function') {
          await projectService.failRunFeedbackChange(String(before.context.workspaceId), {
            improvementId: before.improvement.id,
            ...(revised?.agent?.agentVersion ? { afterAgentVersion: revised.agent.agentVersion } : {}),
            ...(Number.isInteger(revised?.eval?.revision) ? { evalRevision: revised.eval.revision } : {}),
            ...(feedbackRerun?.runId || error?.evidence?.runId ? { rerunId: feedbackRerun?.runId || error.evidence.runId } : {}),
            error: {
              code: typeof error?.code === 'string' ? error.code : 'feedback_change_failed',
              message: error instanceof Error ? error.message : '反馈修改未能完成。',
            },
          }).catch(() => {});
        }
        return addAutomaticEvaluationNotice(
          decision,
          `Workflow 已修改，但自动评测未完成：${error instanceof Error ? error.message : '评测服务暂时不可用'}。请先重跑当前修订再继续修改。`,
        );
      }
    },
  };
}

function plannedImplementationImprovement(state) {
  return [...(state?.improvements?.order || [])].reverse()
    .map((improvementId) => state.improvements.byId[improvementId])
    .find((item) => item?.kind === 'implementation' && item.status === 'planned') || null;
}

function addAutomaticEvaluationNotice(decision, text) {
  const notice = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Workflow 修改后自动评测' },
  };
  return { ...decision, additionalContexts: [notice, ...(decision.additionalContexts || [])] };
}

async function workflowFileSnapshot(workspacePath) {
  const read = (filename) => readFile(path.join(workspacePath, '.wanxiang', filename), 'utf8')
    .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  const [entrypoint, manifest, agent] = await Promise.all([
    read(WORKFLOW_ENTRYPOINT), read(WORKFLOW_MANIFEST), read('agent.json'),
  ]);
  return { entrypoint, manifest, agent };
}

export function createWorkBriefTool(service) {
  return {
    name: 'wanxiang_update_work_brief',
    description: 'Update Wanxiang\'s canonical work description from facts learned in the current conversation. Use a sparse patch and the latest baseStateVersion shown in the work-description context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseStateVersion: {
          type: 'integer',
          description: 'The current Wanxiang state version from the system context.',
        },
        patch: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(BRIEF_FIELDS.map(([key, label]) => [key, {
            type: 'string',
            description: label,
          }])),
          description: 'Only fields whose meaning changed. Do not repeat unchanged fields.',
        },
        confirmedFields: {
          type: 'array',
          items: { type: 'string', enum: BRIEF_FIELDS.map(([key]) => key) },
          uniqueItems: true,
          description: 'Fields in patch whose content the user stated explicitly. Every other patched field remains an Agent inference.',
        },
        unresolvedFields: {
          type: 'array',
          items: { type: 'string', enum: BRIEF_FIELDS.map(([key]) => key) },
          uniqueItems: true,
          description: 'Fields the user explicitly does not know or wants to provide later. Do not put “unknown” or “later” in patch.',
        },
        investigatedFields: {
          type: 'array',
          items: { type: 'string', enum: BRIEF_FIELDS.map(([key]) => key) },
          uniqueItems: true,
          description: 'Fields for which the requested read-only project or environment investigation has completed, whether or not it found an answer.',
        },
        reason: {
          type: 'string',
          description: 'A short explanation of what new conversation evidence changed the description.',
        },
      },
      required: ['baseStateVersion', 'patch'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({
        kind: 'wanxiang-work-brief',
        ok: value.ok,
        updatedFields: value.updatedFields || [],
      }),
    },
    async execute(args, execution) {
      const input = requireObject(args, '工作说明工具参数无效。');
      rejectUnknownKeys(input, [
        'baseStateVersion', 'patch', 'confirmedFields', 'unresolvedFields', 'investigatedFields', 'reason',
      ], '工作说明工具参数');
      const baseVersion = nonNegativeInteger(input.baseStateVersion, '基础版本', 1);
      const rawAnswers = validateAnswerPatch(input.patch);
      const confirmedFields = validateFieldKeyArray(input.confirmedFields || [], '用户确认字段');
      const unresolvedFields = validateFieldKeyArray(input.unresolvedFields || [], '暂不确定字段');
      const investigatedFields = validateFieldKeyArray(input.investigatedFields || [], '已调查字段');
      const deferredFromPatch = Object.entries(rawAnswers)
        .filter(([, value]) => /^(?:不知道|暂时不知道|稍后补充|之后补充)$/u.test(value))
        .map(([key]) => key);
      const deferred = [...new Set([...unresolvedFields, ...deferredFromPatch])];
      const requestedAnswers = Object.fromEntries(Object.entries(rawAnswers)
        .filter(([key]) => !deferred.includes(key)));
      if (confirmedFields.some((key) => !Object.hasOwn(requestedAnswers, key))) {
        throw serviceError(400, 'invalid_request', '用户确认字段必须同时出现在工作说明补丁中。');
      }
      if (deferred.some((key) => Object.hasOwn(requestedAnswers, key))) {
        throw serviceError(400, 'invalid_request', '暂不确定字段不能同时保存为确定答案。');
      }
      if (!Object.keys(requestedAnswers).length && !deferred.length && !investigatedFields.length) {
        throw serviceError(400, 'empty_patch', '至少更新一项工作说明、暂不确定状态或调查状态。');
      }
      if (input.reason !== undefined) optionalText(input.reason, '更新原因', 1_000);
      const before = await service.contextForAgent(execution.agent);
      if (!before?.state) {
        throw serviceError(403, 'agent_workspace_unavailable', '当前对话不能更新这个项目的工作说明。');
      }
      const desiredSources = Object.fromEntries(Object.keys(requestedAnswers).map((key) => [key, {
        status: confirmedFields.includes(key) ? 'user_confirmed' : 'inferred',
        sourceMessageIds: [],
      }]));
      const answers = Object.fromEntries(Object.entries(requestedAnswers).filter(([key, value]) => (
        before.state.brief.answers[key] !== value
      )));
      const fieldSources = Object.fromEntries(Object.entries(desiredSources).filter(([key, value]) => (
        before.state.brief.answers[key] !== requestedAnswers[key]
          || sourceRank(value.status) > sourceRank(before.state.brief.fieldSources[key]?.status)
      )));
      const deferredChanges = deferred.filter((key) => (
        !(before.state.brief.deferredFields || []).includes(key)
          || before.state.brief.answers[key]
          || before.state.brief.fieldSources[key]?.status !== 'unresolved'
      ));
      const investigationChanges = investigatedFields.filter((key) => (
        !(before.state.brief.investigatedFields || []).includes(key)
      ));
      const unchangedRound = !Object.keys(answers).length && !Object.keys(fieldSources).length
        && !deferredChanges.length && !investigationChanges.length
        && before.state.stateVersion === baseVersion;
      const hasPreviousChanges = Object.values(before.state.brief.lastChanges || {})
        .some((fields) => Array.isArray(fields) && fields.length > 0);
      if (unchangedRound && !hasPreviousChanges) {
        const projection = deriveProjectState(before.state);
        return {
          ok: true,
          workspaceId: before.workspaceId,
          stateVersion: before.state.stateVersion,
          briefRevision: before.state.brief.revision,
          phase: projection.phase,
          readiness: projection.readiness,
          guidance: projection.guidance,
          updatedFields: [],
        };
      }
      try {
        const { workspaceId, state } = await service.updateProjectForAgent(
          execution.agent,
          baseVersion,
          {
            answers,
            fieldSources,
            ...(deferredChanges.length ? { deferredFields: deferredChanges } : {}),
            ...(investigationChanges.length ? { investigatedFields: investigationChanges } : {}),
            ...(unchangedRound ? { consumeGuidanceChanges: true } : {}),
          },
        );
        const projection = deriveProjectState(state);
        return {
          ok: true,
          workspaceId,
          stateVersion: state.stateVersion,
          briefRevision: state.brief.revision,
          phase: projection.phase,
          readiness: projection.readiness,
          guidance: projection.guidance,
          updatedFields: [...new Set([...Object.keys(answers), ...Object.keys(fieldSources), ...deferredChanges])],
        };
      } catch (error) {
        if (error?.statusCode === 409 && error?.current) {
          const projection = deriveProjectState(error.current);
          return {
            ok: false,
            code: typeof error.code === 'string' ? error.code : 'revision_conflict',
            message: error.message,
            guidance: projection.guidance,
            current: {
              stateVersion: error.current.stateVersion,
              briefRevision: error.current.brief.revision,
              answers: error.current.brief.answers,
              fieldSources: error.current.brief.fieldSources,
              phase: projection.phase,
              readiness: projection.readiness,
              guidance: projection.guidance,
            },
          };
        }
        throw error;
      }
    },
  };
}

export function createPublicWebFetchTool(web) {
  return {
    name: 'web_fetch',
    description: 'Read one public HTTP(S) page without login state or side effects. Private-network URLs, credential-bearing URLs, and unsafe redirects are blocked by the Wanxiang web provider.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Absolute public HTTP(S) URL.' },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string' },
          statusCode: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: ['url', 'statusCode', 'truncated'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.url}\nHTTP ${value.statusCode}\n\n${String(value.body?.content || '').slice(0, 40_000)}${value.truncated ? '\n\n[内容已截断]' : ''}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const input = requireObject(args, '网页读取参数无效。');
      rejectUnknownKeys(input, ['url'], '网页读取参数');
      const url = requiredText(input.url, '网页地址', 2_048);
      return web.fetch({ url }, execution.signal);
    },
  };
}

export function createProjectResponse(state, extra = {}) {
  const projection = deriveProjectState(state, extra.evaluation);
  return { ok: true, ...extra, state, projection, guidance: projection.guidance };
}

export function terminalRunMatchesEvidence(state, evidence) {
  const run = state?.runs?.byId?.[evidence?.runId];
  if (!run || run.status === 'running') return false;
  for (const key of [
    'runId', 'sessionId', 'caseId', 'kind', 'agentVersion', 'workflowVersion', 'evalRevision',
    'workBriefRevision', 'retryOf', 'status', 'startedAt', 'completedAt',
  ]) {
    if ((run[key] ?? null) !== (evidence[key] ?? null)) return false;
  }
  return JSON.stringify(run.evidence) === JSON.stringify(eventEvidenceForRun(evidence));
}

function activationResponse(ctx, result) {
  const sessionId = result.activation?.sessionId || result.state.work?.sessionId;
  const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  const mode = session && effectivePreset(ctx, 'build') === ctx.permissionPresets.current(session)
    ? 'build'
    : 'discovery';
  return createProjectResponse(result.state, {
    result: result.disposition,
    activationId: result.activation?.id || null,
    activation: result.activation || null,
    permission: {
      mode,
      preset: session ? ctx.permissionPresets.current(session) : null,
    },
  });
}

async function requireActivationAgent(ctx, service, workspaceId, sessionId, { requireIdle }) {
  const agent = ctx.agents.get(sessionId);
  if (!agent) throw serviceError(409, 'session_not_live', '当前对话尚未就绪，请重新打开后再试。');
  if (!isRootAgent(agent)) throw serviceError(403, 'subagent_forbidden', '子任务对话不能成为万象制作对话。');
  const context = await service.contextForAgent(agent);
  if (!context || String(context.workspaceId) !== workspaceId) {
    throw serviceError(403, 'session_workspace_mismatch', '这个对话不属于当前项目。');
  }
  if (requireIdle && agent.status !== 'idle') {
    throw serviceError(409, 'session_busy', '当前对话仍在运行，请等待本轮结束后再开始制作。');
  }
  return agent;
}

async function switchPermission(ctx, agent, mode) {
  await switchSessionPermission(ctx, agent.session, mode);
}

async function switchSessionPermission(ctx, session, mode) {
  const preset = effectivePreset(ctx, mode);
  try {
    ctx.permissionPresets.set(session, preset);
    await ctx.sessions.flush(session);
  } catch (cause) {
    throw permissionError(cause);
  }
  if (ctx.permissionPresets.current(session) !== preset) {
    throw serviceError(503, 'permission_transition_failed', '万象无法确认新的项目权限，已停止启动。');
  }
  return preset;
}

function assertPermission(ctx, agent, mode) {
  const preset = effectivePreset(ctx, mode);
  if (ctx.permissionPresets.current(agent.session) !== preset) {
    throw serviceError(409, 'permission_changed', '当前项目权限已经变化，请重新开始制作。');
  }
}

function effectivePreset(ctx, mode) {
  const candidates = mode === 'build' ? BUILD_PRESET_CANDIDATES : DISCOVERY_PRESET_CANDIDATES;
  const preset = candidates.find((candidate) => ctx.permissionPresets.names.includes(candidate));
  if (!preset) {
    throw serviceError(503, 'permission_unavailable', `万象缺少${mode === 'build' ? '项目写入' : '只读'}权限预设。`);
  }
  return preset;
}

async function reconcileSessionPermission(ctx, service, session, authorization = null) {
  const workspace = await workspaceForSession(ctx, session);
  if (!workspace) return;
  await service.resolveWorkspace(String(workspace.id));
  const state = await service.getProject(String(workspace.id));
  const mode = isBuildAuthorized(state, String(session.id)) ? 'build' : 'discovery';
  await switchSessionPermission(ctx, session, mode);
  authorization?.update(state, String(session.id));
}

async function workspaceForSession(ctx, session) {
  const sessionId = String(session?.id || '');
  let workspace = ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds?.includes(sessionId));
  const cwd = session?.header?.cwd;
  if (!workspace && typeof cwd === 'string' && cwd) {
    workspace = await ctx.workspaceRegistry.resolveByPath(cwd).catch(() => undefined);
  }
  return workspace;
}

function isAgentInRegisteredWorkspace(ctx, agent) {
  const sessionId = String(agent?.id || '');
  if (!sessionId) return false;
  const workspaces = ctx.workspaceRegistry.list();
  if (workspaces.some((workspace) => workspace.sessionIds?.includes(sessionId))) return true;
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  return workspaces.some((workspace) => {
    if (typeof workspace.path !== 'string' || !path.isAbsolute(workspace.path)) return false;
    const relative = path.relative(path.resolve(workspace.path), path.resolve(cwd));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
}

function isRootAgent(agent) {
  return Boolean(agent && agent.session?.header?.origin !== 'subagent');
}

function isBuildAuthorized(state, sessionId) {
  if (!state || state.work?.sessionId !== sessionId) return false;
  if (state.work.activeRevision !== null) return true;
  return state.work.activation?.status === 'pending';
}

function createAuthorizationTracker() {
  const buildSessions = new Set();
  const allowedDiscoveryExecutions = new WeakSet();
  return {
    update(state, observedSessionId) {
      const observed = String(observedSessionId || '');
      if (observed) buildSessions.delete(observed);
      const canonical = String(state?.work?.sessionId || '');
      if (!canonical) return;
      if (isBuildAuthorized(state, canonical)) buildSessions.add(canonical);
      else buildSessions.delete(canonical);
    },
    isBuildAuthorized(sessionId) {
      return buildSessions.has(String(sessionId));
    },
    deny(sessionId) {
      buildSessions.delete(String(sessionId));
    },
    allowDiscoveryExecution(execution) {
      allowedDiscoveryExecutions.add(execution);
    },
    isDiscoveryExecutionAllowed(execution) {
      return allowedDiscoveryExecutions.has(execution);
    },
  };
}

export async function discoveryToolAllowed(ctx, context, execution) {
  if (!DISCOVERY_TOOLS.has(execution.name)) return false;
  if (execution.name === 'ask_user_question') {
    const next = deriveProjectState(context.state).guidance.next;
    const questions = execution.arguments?.questions;

    return (
      next.kind === 'ask_field' &&
      next.audience === 'member' &&
      Array.isArray(questions) &&
      questions.length === 1 &&
      typeof questions[0]?.question === 'string' &&
      questions[0].question.trim() === next.prompt
    );
  }
  if (execution.name !== 'read' && execution.name !== 'read_image') return true;
  const filePath = execution.arguments?.file_path;
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  const workspace = ctx.workspaceRegistry.get(context.workspaceId);
  if (!workspace?.path) return false;
  try {
    const root = await realpath(workspace.path);
    const candidate = await realpath(path.resolve(execution.agent?.session?.header?.cwd || root, filePath));
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

export function renderPromptWorkDescription(state, projection, making) {
  const sourceLabels = {
    user_confirmed: '用户确认',
    inferred: '根据对话推断',
    unresolved: '待确认',
  };
  const answers = making && state.brief.confirmedAnswers
    ? state.brief.confirmedAnswers
    : state.brief.answers;
  const fieldSources = making && state.brief.confirmedFieldSources
    ? state.brief.confirmedFieldSources
    : state.brief.fieldSources;
  const fields = BRIEF_FIELDS.map(([key, label]) => {
    const answer = answers[key]?.trim() || '待确认';
    const source = sourceLabels[fieldSources[key]?.status] || '待确认';
    return `- ${label} [${source}]：${answer}`;
  }).join('\n');
  const contractRevision = state.work.activation?.status === 'pending'
    ? state.work.activation.briefRevision
    : state.work.activeRevision;
  const contract = making
    ? `当前制作契约版本：v${contractRevision}`
    : '尚未开始制作；项目文件保持只读。';
  const guide = projection.guidance;
  const progress = guide.progress;
  const deferred = guide.deferredFields.length
    ? guide.deferredFields.map((key) => BRIEF_FIELDS.find(([field]) => field === key)?.[1] || key).join('、')
    : '无';
  const nextField = guide.next.field
    ? BRIEF_FIELDS.find(([key]) => key === guide.next.field)?.[1] || guide.next.field
    : '无';
  const nextAudience = guide.next.audience === 'agent' ? '万象'
    : guide.next.audience === 'member' ? '社群成员' : '无';
  const changed = (keys) => keys.length
    ? keys.map((key) => BRIEF_FIELDS.find(([field]) => field === key)?.[1] || key).join('、')
    : '无';
  return `万象工作说明（stateVersion=${state.stateVersion}, briefRevision=${state.brief.revision}, phase=${projection.phase}）
${contract}

显性对话引导
- 进度：关键项已明确 ${progress.requiredKnown}/${progress.requiredTotal}，用户已确认 ${progress.requiredConfirmed}/${progress.requiredTotal}；七项工作说明已明确 ${progress.allKnown}/${progress.allTotal}
- 当前阶段：${guide.stage}
- 唯一下一步：${guide.next.kind}
- 对应字段：${nextField}
- 执行对象：${nextAudience}
- 唯一引导语：${guide.next.prompt}
- 本轮新增已确认：${changed(guide.changes.confirmed)}
- 本轮新增已推断：${changed(guide.changes.inferred)}
- 本轮仍待确认：${changed(guide.changes.unresolved)}
- 制作中验证：${deferred}
- 回复约束：先更新工作说明，再用 1–2 句复述当前理解；只有 ask_field 可以向用户提问，并且只能询问上面的唯一问题。

${fields}`;
}

function permissionError(cause) {
  if (Number.isInteger(cause?.statusCode)) return cause;
  return serviceError(503, 'permission_transition_failed', '万象无法安全切换项目权限，请稍后重试。', { cause });
}

function structuredErrorValue(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'activation_failed',
    message: error instanceof Error ? error.message : '制作启动失败。',
    recoverable: true,
  };
}

export function registerApi(ctx, routePath, handler) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: async (request, response) => {
      if (!sameOrigin(request)) {
        return respondJson(response, 403, { ok: false, code: 'invalid_origin', message: '请求来源不受信任。' });
      }
      const operation = new AbortController();
      const abortOnDisconnect = () => {
        if (!response.writableFinished) operation.abort();
      };
      response.once('close', abortOnDisconnect);
      try {
        const [status, body] = await handler(request, operation.signal);
        return respondJson(response, status, body);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        const exposed = Number.isInteger(error?.statusCode);
        const body = {
          ok: false,
          code: exposed && typeof error?.code === 'string' ? error.code : 'internal_error',
          message: exposed && error instanceof Error ? error.message : '万象本地状态暂时无法处理，请稍后重试。',
        };
        if (error?.current) body.current = error.current;
        return respondJson(response, status, body);
      } finally {
        response.off('close', abortOnDisconnect);
      }
    },
  }));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 128 * 1024) throw serviceError(413, 'payload_too_large', '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const raw = Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('utf8');
    return JSON.parse(raw || '{}');
  } catch {
    throw serviceError(400, 'invalid_json', '请求格式无效。');
  }
}

function legacyProjectPatch(payload) {
  const patch = {};
  if (payload.projectName !== undefined) patch.projectName = payload.projectName;
  if (payload.answers !== undefined) patch.answers = payload.answers;
  if (payload.fieldSources !== undefined) patch.fieldSources = payload.fieldSources;
  return patch;
}

function validateProjectPatch(value) {
  const raw = requireObject(value, '项目更新格式无效。');
  rejectUnknownKeys(raw, ['projectName', 'answers', 'fieldSources'], '项目更新');
  const patch = {};
  if (raw.projectName !== undefined) patch.projectName = requiredText(raw.projectName, '项目名称', 200);
  if (raw.answers !== undefined) patch.answers = validateAnswerPatch(raw.answers);
  if (raw.fieldSources !== undefined) patch.fieldSources = validateFieldSourcePatch(raw.fieldSources);
  if (!Object.keys(patch).length) throw serviceError(400, 'empty_patch', '没有需要保存的项目修改。');
  return patch;
}

function validateAnswerPatch(value, { requireNonEmpty = false } = {}) {
  const raw = requireObject(value, '工作说明格式无效。');
  const labels = new Map(BRIEF_FIELDS);
  rejectUnknownKeys(raw, [...labels.keys()], '工作说明');
  const answers = Object.fromEntries(Object.entries(raw)
    .map(([key, answer]) => [key, draftText(answer, labels.get(key), 12_000)]));
  if (requireNonEmpty && !Object.keys(answers).length) {
    throw serviceError(400, 'empty_patch', '至少更新一项工作说明。');
  }
  return answers;
}

function validateFeedbackContractPatch(value) {
  const raw = requireObject(value, '请提供工作说明差异。');
  const labels = new Map([...BRIEF_FIELDS, ['permissions', '权限']]);
  rejectUnknownKeys(raw, [...labels.keys()], '工作说明差异');
  const patch = Object.fromEntries(Object.entries(raw)
    .map(([key, answer]) => [key, draftText(answer, labels.get(key), 12_000)]));
  if (!Object.keys(patch).length) {
    throw serviceError(400, 'empty_patch', '工作说明提案不能为空。');
  }
  return patch;
}

function validateFieldSourcePatch(value) {
  const raw = requireObject(value, '字段来源格式无效。');
  const labels = new Map(BRIEF_FIELDS);
  rejectUnknownKeys(raw, [...labels.keys()], '字段来源');
  return Object.fromEntries(Object.entries(raw).map(([key, source]) => {
    const item = requireObject(source, `${labels.get(key)}来源格式无效。`);
    rejectUnknownKeys(item, ['status', 'sourceMessageIds'], `${labels.get(key)}来源`);
    const status = enumValue(item.status, `${labels.get(key)}来源状态`, FIELD_SOURCE_STATUSES);
    const messageIds = item.sourceMessageIds === undefined ? [] : item.sourceMessageIds;
    if (!Array.isArray(messageIds) || messageIds.length > 100) {
      throw serviceError(400, 'invalid_request', `${labels.get(key)}来源消息格式无效。`);
    }
    return [key, {
      status,
      sourceMessageIds: messageIds.map((messageId) => requiredText(messageId, '来源消息 ID', 500)),
    }];
  }));
}

function validateFieldKeyArray(value, label) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) {
    throw serviceError(400, 'invalid_request', `${label}格式无效。`);
  }
  const known = new Set(BRIEF_FIELDS.map(([key]) => key));
  if (value.some((key) => typeof key !== 'string' || !known.has(key))) {
    throw serviceError(400, 'invalid_request', `${label}包含未知字段。`);
  }
  return value;
}

function sourceRank(status) {
  return { unresolved: 0, inferred: 1, user_confirmed: 2 }[status] ?? -1;
}

function rejectUnknownKeys(value, allowed, label) {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) throw serviceError(400, 'invalid_request', `${label}包含未知字段：${unknown}。`);
}

function requireObject(value, message = '请求格式无效。') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(400, 'invalid_request', message);
  }
  return value;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw serviceError(400, 'invalid_request', `${label}不能为空。`);
  return limitedText(value.trim(), label, maxLength);
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maxLength);
}

function draftText(value, label, maxLength) {
  if (typeof value !== 'string') throw serviceError(400, 'invalid_request', `${label}格式无效。`);
  return limitedText(value.trim(), label, maxLength);
}

function limitedText(value, label, maxLength) {
  if (value.length > maxLength) throw serviceError(413, 'payload_too_large', `${label}内容过长。`);
  return value;
}

function nonNegativeInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw serviceError(400, 'invalid_request', `${label}格式无效。`);
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw serviceError(400, 'invalid_request', `${label}格式无效。`);
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw serviceError(400, 'invalid_request', `${label}格式无效。`);
  return value;
}

function enumValue(value, label, allowed) {
  if (!allowed.includes(value)) throw serviceError(400, 'invalid_request', `${label}格式无效。`);
  return value;
}

function normalizeOutboxKind(value) {
  if (value === 'question' || value === 'consultation' || value === '咨询') return 'question';
  if (value === 'feedback' || value === '反馈') return 'feedback';
  throw serviceError(400, 'invalid_request', '社群草稿类型格式无效。');
}

function structuredActivationError(value) {
  if (typeof value === 'string') {
    return { code: 'activation_failed', message: limitedText(value.trim() || '制作启动失败', '失败原因', 4_000), recoverable: true };
  }
  const raw = requireObject(value, '失败原因格式无效。');
  rejectUnknownKeys(raw, ['code', 'message', 'recoverable'], '失败原因');
  return {
    code: requiredText(raw.code, '错误代码', 120),
    message: requiredText(raw.message, '失败原因', 4_000),
    recoverable: optionalBoolean(raw.recoverable, '可恢复标记'),
  };
}

function queryText(request, key, maxLength) {
  const value = new URL(request.url || '/', 'http://localhost').searchParams.get(key);
  return requiredText(value, key, maxLength);
}

function requireMethod(request, method) {
  if (request.method !== method) throw serviceError(405, 'method_not_allowed', '请求方法不受支持。');
}

function requireOneOfMethods(request, methods) {
  if (!methods.includes(request.method)) throw serviceError(405, 'method_not_allowed', '请求方法不受支持。');
}

function respondJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function absoluteRoot(value) {
  return typeof value === 'string' && path.isAbsolute(value) ? path.normalize(value) : null;
}

function dataRootFromEnvironment() {
  const configured = absoluteRoot(process.env.WANXIANG_DATA_ROOT);
  if (configured) return configured;
  const dshHome = absoluteRoot(process.env.DSH_HOME);
  return dshHome ? path.dirname(dshHome) : null;
}
