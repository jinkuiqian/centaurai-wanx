import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PROXY_RUN_CASE_ID = 'customer-follow-up-normal-v1';
export const PROXY_RUN_CASE_IDS = Object.freeze([
  DEFAULT_PROXY_RUN_CASE_ID,
  'customer-follow-up-overdue-v1',
  'customer-follow-up-no-communication-v1',
  'customer-follow-up-high-intent-no-next-step-v1',
  'customer-follow-up-missing-owner-v1',
]);
export const WORKFLOW_MANIFEST = 'workflow.json';
export const WORKFLOW_ENTRYPOINT = 'workflow.mjs';
export const AGENT_MANIFEST = 'agent.json';
export const DATA_CONTRACT = 'data-contract.json';
export const WORKFLOW_INPUT_INTERFACE = 'wanxiang.proxy-input/v1';
export const WORKFLOW_OUTPUT_INTERFACE = 'wanxiang.proxy-output/v1';
const AGENT_CONTRACT_FIELDS = ['goal', 'inputs', 'examples', 'rules', 'output', 'boundaries', 'success'];
const REQUIRED_AGENT_CONTRACT_FIELDS = ['goal', 'inputs', 'output', 'success'];

const DEFAULT_WORKFLOW = {
  schemaVersion: 1,
  workflowVersion: '2.0.0',
  entrypoint: WORKFLOW_ENTRYPOINT,
  interface: {
    input: WORKFLOW_INPUT_INTERFACE,
    output: WORKFLOW_OUTPUT_INTERFACE,
  },
};

const LEGACY_WORKFLOW = { ...DEFAULT_WORKFLOW, workflowVersion: '1.0.0' };
const LEGACY_WORKFLOW_SOURCE = `let body = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
const output = {
  title: input.title,
  itemCount: input.items.length,
  labels: input.items.map((item) => item.label).sort(),
};
process.stdout.write(JSON.stringify(output));
`;

const DEFAULT_WORKFLOW_SOURCE = `const parseCsv = (source) => {
  const [header, ...rows] = source.trim().split(/\\r?\\n/u).map((line) => line.split(','));
  return rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] || ''])));
};
const daysBetween = (earlier, later) => Math.floor((Date.parse(later + 'T00:00:00Z') - Date.parse(earlier + 'T00:00:00Z')) / 86400000);
let body = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
const customers = parseCsv(input.customersCsv);
const communications = JSON.parse(input.communicationsJson);
const missingFollowUps = customers.map((customer) => {
  const latest = communications
    .filter((item) => item.customerId === customer.customer_id)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] || null;
  const daysSinceLastCommunication = latest ? daysBetween(latest.occurredAt, input.asOf) : null;
  const reasonCodes = [];
  if (!latest) reasonCodes.push('NO_COMMUNICATION');
  else if (daysSinceLastCommunication > 14) reasonCodes.push('OVERDUE_FOLLOW_UP');
  if (customer.intent === 'high' && !customer.next_step) reasonCodes.push('HIGH_INTENT_NO_NEXT_STEP');
  if (!customer.owner) reasonCodes.push('MISSING_OWNER');
  if (reasonCodes.length === 0) return null;
  return {
    customerId: customer.customer_id,
    customerName: customer.name,
    reasonCodes,
    evidence: {
      asOf: input.asOf,
      lastCommunicationAt: latest?.occurredAt || null,
      daysSinceLastCommunication,
      intent: customer.intent,
      nextStep: customer.next_step || null,
      owner: customer.owner || null,
    },
  };
}).filter(Boolean).sort((left, right) => left.customerId.localeCompare(right.customerId));
const missingIds = new Set(missingFollowUps.map((item) => item.customerId));
const lines = [
  '# 客户跟进代理周报',
  '',
  '截至 ' + input.asOf,
  '',
  '## 本周概览',
  '',
  '共检查 ' + customers.length + ' 位客户，发现 ' + missingFollowUps.length + ' 位需要跟进。',
  '',
  '## 漏跟进客户',
  '',
  ...(missingFollowUps.length === 0 ? ['- 无'] : missingFollowUps.map((item) => '- ' + item.customerName + ' (' + item.customerId + ') — 原因：' + item.reasonCodes.join('、') + '；最近沟通：' + (item.evidence.lastCommunicationAt || '无沟通记录') + '；距今：' + (item.evidence.daysSinceLastCommunication ?? '不适用') + ' 天；负责人：' + (item.evidence.owner || '缺失'))),
  '',
  '## 正常跟进客户',
  '',
  ...customers.filter((customer) => !missingIds.has(customer.customer_id)).map((customer) => {
    const latest = communications.filter((item) => item.customerId === customer.customer_id).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
    return '- ' + customer.name + ' (' + customer.customer_id + ') — 最近沟通：' + (latest?.occurredAt || '无沟通记录') + '；负责人：' + (customer.owner || '缺失');
  }),
];
const output = { reportMarkdown: lines.join('\\n'), missingFollowUps };
process.stdout.write(JSON.stringify(output));
`;

const DEFAULT_EVAL_STATE = {
  schemaVersion: 1,
  currentRevision: 1,
  revisions: [{
    revision: 1,
    status: 'confirmed',
    cases: customerFollowUpCases(),
  }],
};

function customerFollowUpCases() {
  return [
    followUpCase({
      id: PROXY_RUN_CASE_IDS[0], title: '正常客户', kind: 'normal',
      customer: { customerId: 'C001', name: '安行科技', intent: 'medium', nextStep: '确认试用反馈', owner: '林岚' },
      communications: [{ customerId: 'C001', occurredAt: '2026-08-28', summary: '客户确认本周试用。' }],
      missingFollowUps: [],
      evidenceReferences: ['2026-08-28', '林岚'],
    }),
    followUpCase({
      id: PROXY_RUN_CASE_IDS[1], title: '超过 14 天未跟进', kind: 'normal',
      customer: { customerId: 'C002', name: '远航制造', intent: 'medium', nextStep: '发送方案', owner: '周宁' },
      communications: [{ customerId: 'C002', occurredAt: '2026-08-10', summary: '客户等待新版方案。' }],
      reasonCodes: ['OVERDUE_FOLLOW_UP'],
      evidenceReferences: ['2026-08-10', '22 天'],
    }),
    followUpCase({
      id: PROXY_RUN_CASE_IDS[2], title: '无沟通记录', kind: 'boundary',
      customer: { customerId: 'C003', name: '晨星零售', intent: 'low', nextStep: '首次联系', owner: '陈墨' },
      communications: [],
      reasonCodes: ['NO_COMMUNICATION'],
      evidenceReferences: ['无沟通记录', '不适用 天'],
    }),
    followUpCase({
      id: PROXY_RUN_CASE_IDS[3], title: '高意向但无下一步', kind: 'normal',
      customer: { customerId: 'C004', name: '云帆教育', intent: 'high', nextStep: '', owner: '赵青' },
      communications: [{ customerId: 'C004', occurredAt: '2026-08-30', summary: '客户表达强烈采购意向。' }],
      reasonCodes: ['HIGH_INTENT_NO_NEXT_STEP'],
      evidenceReferences: ['2026-08-30', 'HIGH_INTENT_NO_NEXT_STEP'],
    }),
    followUpCase({
      id: PROXY_RUN_CASE_IDS[4], title: '缺少负责人', kind: 'boundary',
      customer: { customerId: 'C005', name: '青屿医疗', intent: 'medium', nextStep: '安排产品演示', owner: '' },
      communications: [{ customerId: 'C005', occurredAt: '2026-08-29', summary: '客户希望安排产品演示。' }],
      reasonCodes: ['MISSING_OWNER'],
      evidenceReferences: ['2026-08-29', '负责人：缺失'],
    }),
  ];
}

function followUpCase({ id, title, kind, customer, communications, missingFollowUps, reasonCodes, evidenceReferences }) {
  const { customerId, name: customerName, intent, nextStep, owner } = customer;
  const latest = communications[0] ?? null;
  const daysSinceLastCommunication = latest ? Math.floor(
    (Date.parse('2026-09-01T00:00:00Z') - Date.parse(`${latest.occurredAt}T00:00:00Z`)) / 86_400_000,
  ) : null;
  return {
    id,
    title,
    kind,
    input: {
      asOf: '2026-09-01',
      customersCsv: customerCsv(customer),
      communicationsJson: JSON.stringify(communications),
    },
    expected: {
      missingFollowUps: missingFollowUps ?? [{
        customerId,
        customerName,
        reasonCodes,
        evidence: {
          asOf: '2026-09-01',
          lastCommunicationAt: latest?.occurredAt ?? null,
          daysSinceLastCommunication,
          intent,
          nextStep: nextStep || null,
          owner: owner || null,
        },
      }],
      markdown: {
        requiredSections: ['# 客户跟进代理周报', '## 本周概览', '## 漏跟进客户'],
        customerReferences: [customerName],
        evidenceReferences,
      },
    },
  };
}

function customerCsv({ customerId, name, intent, nextStep, owner }) {
  return `customer_id,name,intent,next_step,owner\n${[customerId, name, intent, nextStep, owner].join(',')}`;
}

export class EvaluationProjectStore {
  constructor({ dataRoot, createPendingId = randomUUID }) {
    this.dataRoot = dataRoot;
    this.createPendingId = createPendingId;
  }

  async load(project) {
    const paths = await this.#ensure(project);
    const [workflowValue, source, evalState, agentValue, dataContractValue] = await Promise.all([
      readJson(paths.workflow, 'workflow_manifest_invalid', 'Workflow 清单格式无效。'),
      readFile(paths.entrypoint, 'utf8'),
      readJson(paths.canonical, 'eval_state_corrupt', '受保护的验收数据已损坏。'),
      readOptionalJson(paths.agent, 'agent_manifest_invalid', '工作 Agent 清单格式无效。'),
      readOptionalJson(paths.dataContract, 'data_contract_invalid', '数据契约格式无效。'),
    ]);
    const workflow = validateWorkflow(workflowValue);
    if (Buffer.byteLength(source) > 64 * 1024) {
      throw evaluationError('workflow_source_too_large', 'Workflow 源文件超过 64 KiB 限制。', 413);
    }
    const validatedEvalState = validateEvalState(evalState);
    await atomicWrite(paths.mirror, `${JSON.stringify(validatedEvalState, null, 2)}\n`, this.createPendingId);
    const evalRevision = validatedEvalState.revisions.find(
      (candidate) => candidate.revision === validatedEvalState.currentRevision && candidate.status === 'confirmed',
    );
    const generated = validateGeneratedArtifacts(agentValue, dataContractValue, workflow, evalRevision);
    return {
      workflow,
      source,
      eval: structuredClone(evalRevision),
      evalState: structuredClone(validatedEvalState),
      agent: generated?.agent ?? null,
      dataContract: generated?.dataContract ?? null,
      workspacePath: paths.workspacePath,
    };
  }

  async generate(project, request) {
    const current = await this.load(project);
    const definition = validateGenerationRequest(request);
    const agentVersion = nextAgentVersion(current.agent?.agentVersion);
    const workflowVersion = agentVersion;
    const evalRevision = Math.max(...current.evalState.revisions.map((item) => item.revision)) + 1;
    const versionTrace = { agentVersion, workBriefRevision: definition.workBriefRevision, workflowVersion };
    const contract = { ...definition.brief };
    const capabilities = {
      workspace: 'current-project',
      network: false,
      externalSideEffects: false,
    };
    const workflow = {
      schemaVersion: 1,
      ...versionTrace,
      entrypoint: WORKFLOW_ENTRYPOINT,
      interface: {
        input: WORKFLOW_INPUT_INTERFACE,
        output: WORKFLOW_OUTPUT_INTERFACE,
      },
      capabilities,
    };
    const dataContract = {
      schemaVersion: 1,
      ...versionTrace,
      evalRevision,
      input: { description: definition.brief.inputs, schema: definition.inputSchema },
      output: { description: definition.brief.output, schema: definition.outputSchema },
    };
    const evaluation = {
      revision: evalRevision,
      status: 'confirmed',
      ...versionTrace,
      contract,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      capabilities,
      cases: [{ ...definition.smokeCase, kind: 'normal' }],
    };
    const agent = {
      schemaVersion: 1,
      name: definition.projectName,
      ...versionTrace,
      evalRevision,
      contract,
      capabilities,
      artifacts: {
        workBrief: 'work-brief.md',
        agent: AGENT_MANIFEST,
        dataContract: DATA_CONTRACT,
        workflow: WORKFLOW_MANIFEST,
        entrypoint: WORKFLOW_ENTRYPOINT,
        evaluations: 'evals.json',
      },
    };
    const evalState = validateEvalState({
      ...current.evalState,
      currentRevision: evalRevision,
      revisions: [...current.evalState.revisions, evaluation],
    });
    const paths = evaluationPaths(this.dataRoot, project);
    await Promise.all([
      atomicWrite(paths.entrypoint, definition.workflowSource, this.createPendingId),
      atomicWrite(paths.workflow, `${JSON.stringify(workflow, null, 2)}\n`, this.createPendingId),
      atomicWrite(paths.dataContract, `${JSON.stringify(dataContract, null, 2)}\n`, this.createPendingId),
    ]);
    await this.#saveState(project, evalState);
    await atomicWrite(paths.agent, `${JSON.stringify(agent, null, 2)}\n`, this.createPendingId);
    return {
      agent: structuredClone(agent),
      dataContract: structuredClone(dataContract),
      workflow: structuredClone(workflow),
      eval: structuredClone(evaluation),
    };
  }

  async reviseGeneratedAgent(project) {
    const paths = await this.#ensure(project);
    const [agentValue, dataContractValue, workflowValue, evalStateValue] = await Promise.all([
      readOptionalJson(paths.agent, 'agent_manifest_invalid', '工作 Agent 清单格式无效。'),
      readOptionalJson(paths.dataContract, 'data_contract_invalid', '数据契约格式无效。'),
      readJson(paths.workflow, 'workflow_manifest_invalid', 'Workflow 清单格式无效。'),
      readJson(paths.canonical, 'eval_state_corrupt', '受保护的验收数据已损坏。'),
    ]);
    if (agentValue === null) return null;
    const workflow = validateWorkflow(workflowValue);
    const evalState = validateEvalState(evalStateValue);
    const evaluation = evalState.revisions.find((item) => item.revision === evalState.currentRevision);
    validateGeneratedArtifacts(agentValue, dataContractValue, {
      ...workflow,
      agentVersion: agentValue.agentVersion,
      workflowVersion: agentValue.workflowVersion,
    }, evaluation);
    const agentVersion = nextAgentVersion(agentValue.agentVersion);
    const versionTrace = { agentVersion, workflowVersion: agentVersion };
    const nextAgent = { ...agentValue, ...versionTrace };
    const nextDataContract = { ...dataContractValue, ...versionTrace };
    const nextWorkflow = { ...workflow, ...versionTrace };
    const nextEvaluation = { ...evaluation, ...versionTrace };
    const nextEvalState = {
      ...evalState,
      revisions: evalState.revisions.map((item) => item.revision === nextEvaluation.revision ? nextEvaluation : item),
    };
    await Promise.all([
      atomicWrite(paths.workflow, `${JSON.stringify(nextWorkflow, null, 2)}\n`, this.createPendingId),
      atomicWrite(paths.dataContract, `${JSON.stringify(nextDataContract, null, 2)}\n`, this.createPendingId),
    ]);
    await this.#saveState(project, nextEvalState);
    await atomicWrite(paths.agent, `${JSON.stringify(nextAgent, null, 2)}\n`, this.createPendingId);
    return {
      agent: structuredClone(nextAgent),
      dataContract: structuredClone(nextDataContract),
      workflow: structuredClone(nextWorkflow),
      eval: structuredClone(nextEvaluation),
    };
  }

  async propose(project, request) {
    const current = await this.load(project);
    if (request?.baseRevision !== current.evalState.currentRevision) {
      throw evaluationError('eval_revision_conflict', '当前验收标准版本已经变化，请基于最新版重新提交。', 409);
    }
    const cases = validateCases(request.cases);
    const revision = Math.max(...current.evalState.revisions.map((item) => item.revision)) + 1;
    const next = {
      ...current.evalState,
      revisions: [...current.evalState.revisions, { revision, status: 'proposed', cases }],
    };
    await this.#saveState(project, next);
    return structuredClone(next);
  }

  async confirm(project, request) {
    const current = await this.load(project);
    const candidate = current.evalState.revisions.find((item) => item.revision === request?.revision);
    if (!candidate) throw evaluationError('eval_revision_not_found', '找不到指定的验收标准版本。', 404);
    const next = {
      ...current.evalState,
      currentRevision: candidate.revision,
      revisions: current.evalState.revisions.map((item) => ({
        ...item,
        status: item.revision === candidate.revision ? 'confirmed' : item.status,
      })),
    };
    await this.#saveState(project, next);
    return structuredClone(next);
  }

  async #saveState(project, state) {
    const paths = evaluationPaths(this.dataRoot, project);
    const validated = validateEvalState(state);
    await mkdir(path.dirname(paths.canonical), { recursive: true });
    await atomicWrite(paths.canonical, `${JSON.stringify(validated, null, 2)}\n`, this.createPendingId);
    await atomicWrite(paths.mirror, `${JSON.stringify(validated, null, 2)}\n`, this.createPendingId);
  }

  async #ensure(project) {
    const paths = evaluationPaths(this.dataRoot, project);
    await Promise.all([mkdir(path.dirname(paths.workflow), { recursive: true }), mkdir(path.dirname(paths.canonical), { recursive: true })]);
    const artifactRoot = await validateArtifactRoot(paths.workspacePath, path.dirname(paths.workflow));
    await Promise.all([
      writeIfMissing(paths.workflow, `${JSON.stringify(DEFAULT_WORKFLOW, null, 2)}\n`),
      writeIfMissing(paths.entrypoint, DEFAULT_WORKFLOW_SOURCE),
      writeIfMissing(paths.canonical, `${JSON.stringify(DEFAULT_EVAL_STATE, null, 2)}\n`),
    ]);
    await Promise.all([
      validateArtifactFile(artifactRoot, paths.workflow),
      validateArtifactFile(artifactRoot, paths.entrypoint),
    ]);
    await migrateLegacyDefaults(paths, this.createPendingId);
    return paths;
  }
}

async function migrateLegacyDefaults(paths, createPendingId) {
  const [workflow, source, evalState] = await Promise.all([
    readJson(paths.workflow, 'workflow_manifest_invalid', 'Workflow 清单格式无效。'),
    readFile(paths.entrypoint, 'utf8'),
    readJson(paths.canonical, 'eval_state_corrupt', '受保护的验收数据已损坏。'),
  ]);
  const writes = [];
  if (JSON.stringify(workflow) === JSON.stringify(LEGACY_WORKFLOW) && source === LEGACY_WORKFLOW_SOURCE) {
    writes.push(
      atomicWrite(paths.workflow, `${JSON.stringify(DEFAULT_WORKFLOW, null, 2)}\n`, createPendingId),
      atomicWrite(paths.entrypoint, DEFAULT_WORKFLOW_SOURCE, createPendingId),
    );
  }
  if (isLegacyDefaultEvalState(evalState)) {
    writes.push(atomicWrite(paths.canonical, `${JSON.stringify(DEFAULT_EVAL_STATE, null, 2)}\n`, createPendingId));
  }
  await Promise.all(writes);
}

function isLegacyDefaultEvalState(value) {
  const evalCase = value?.revisions?.[0]?.cases?.[0];
  return value?.schemaVersion === 1
    && value.currentRevision === 1
    && value.revisions?.length === 1
    && value.revisions[0].revision === 1
    && value.revisions[0].status === 'confirmed'
    && value.revisions[0].cases.length === 1
    && evalCase?.id === 'preset-proxy-run-v1'
    && evalCase.kind === 'normal'
    && JSON.stringify(evalCase.input) === JSON.stringify({
      title: '客户跟进清单',
      items: [{ label: '待回复' }, { label: '已安排' }],
    })
    && JSON.stringify(evalCase.expected) === JSON.stringify({
      title: '客户跟进清单',
      itemCount: 2,
      labels: ['已安排', '待回复'],
    });
}

async function validateArtifactRoot(workspacePath, artifactRoot) {
  const [workspace, root, stat] = await Promise.all([realpath(workspacePath), realpath(artifactRoot), lstat(artifactRoot)]);
  if (stat.isSymbolicLink() || path.dirname(root) !== workspace) {
    throw evaluationError('workflow_entrypoint_invalid', 'Workflow 目录必须位于当前项目内。', 403);
  }
  return root;
}

async function validateArtifactFile(artifactRoot, filename) {
  const [resolved, stat] = await Promise.all([realpath(filename), lstat(filename)]);
  if (stat.isSymbolicLink() || !stat.isFile() || path.dirname(resolved) !== artifactRoot) {
    throw evaluationError('workflow_entrypoint_invalid', 'Workflow 文件必须是当前项目内的普通文件。', 403);
  }
}

function evaluationPaths(dataRoot, project) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw evaluationError('data_root_unavailable', '万象受保护数据目录尚未配置。', 503);
  }
  if (!project?.workspaceId || !project?.workspacePath || !path.isAbsolute(project.workspacePath)) {
    throw evaluationError('evaluation_project_invalid', '当前项目不能用于评测。', 403);
  }
  const artifactRoot = path.join(project.workspacePath, '.wanxiang');
  return {
    workspacePath: project.workspacePath,
    agent: path.join(artifactRoot, AGENT_MANIFEST),
    dataContract: path.join(artifactRoot, DATA_CONTRACT),
    workflow: path.join(artifactRoot, WORKFLOW_MANIFEST),
    entrypoint: path.join(artifactRoot, WORKFLOW_ENTRYPOINT),
    mirror: path.join(artifactRoot, 'evals.json'),
    canonical: path.join(dataRoot, 'evaluations', `${digest(project.workspaceId)}.json`),
  };
}

function validateWorkflow(value) {
  const valid = isPlainObject(value)
    && Object.keys(value).every((key) => [
      'schemaVersion', 'workflowVersion', 'agentVersion', 'workBriefRevision', 'entrypoint', 'interface', 'capabilities',
    ].includes(key))
    && value.schemaVersion === 1
    && typeof value.workflowVersion === 'string'
    && /^[1-9]\d*\.\d+\.\d+$/u.test(value.workflowVersion)
    && value.entrypoint === WORKFLOW_ENTRYPOINT
    && isPlainObject(value.interface)
    && Object.keys(value.interface).length === 2
    && value.interface.input === WORKFLOW_INPUT_INTERFACE
    && value.interface.output === WORKFLOW_OUTPUT_INTERFACE
    && (value.agentVersion === undefined || typeof value.agentVersion === 'string')
    && (value.workBriefRevision === undefined || Number.isSafeInteger(value.workBriefRevision))
    && (value.capabilities === undefined || validCapabilities(value.capabilities));
  if (!valid) throw evaluationError('workflow_manifest_invalid', 'Workflow 必须使用固定入口和确定性输入输出接口。', 400);
  return structuredClone(value);
}

function validateGenerationRequest(value) {
  if (!isPlainObject(value) || !isPlainObject(value.brief)
    || typeof value.projectName !== 'string' || !value.projectName.trim() || value.projectName.length > 200
    || !Number.isSafeInteger(value.workBriefRevision) || value.workBriefRevision < 0
    || !REQUIRED_AGENT_CONTRACT_FIELDS.every((key) => (
      typeof value.brief[key] === 'string' && value.brief[key].trim()
    ))
    || !AGENT_CONTRACT_FIELDS.every((key) => typeof value.brief[key] === 'string')
    || typeof value.workflowSource !== 'string' || !value.workflowSource.trim()
    || Buffer.byteLength(value.workflowSource) > 64 * 1024) {
    throw evaluationError('agent_generation_invalid', '工作 Agent 生成参数与已确认工作说明不匹配。', 400);
  }
  const inputSchema = validateObjectSchema(value.inputSchema, '输入');
  const outputSchema = validateObjectSchema(value.outputSchema, '输出');
  const smokeCase = value.smokeCase;
  if (!isPlainObject(smokeCase) || typeof smokeCase.id !== 'string' || !smokeCase.id.trim()
    || typeof smokeCase.title !== 'string' || !smokeCase.title.trim()
    || !isPlainObject(smokeCase.input) || !isPlainObject(smokeCase.expected)) {
    throw evaluationError('agent_generation_invalid', '冒烟案例必须包含稳定 ID、标题、JSON 对象输入和预期输出。', 400);
  }
  validateCases([{ ...smokeCase, kind: 'normal' }]);
  if (!matchesJsonSchema(smokeCase.input, inputSchema)
    || !matchesJsonSchema(smokeCase.expected, outputSchema)) {
    throw evaluationError('agent_generation_invalid', '冒烟案例的输入或预期输出与对应契约不一致。', 400);
  }
  return {
    projectName: value.projectName.trim(),
    workBriefRevision: value.workBriefRevision,
    brief: Object.fromEntries(AGENT_CONTRACT_FIELDS.map((key) => [key, value.brief[key].trim()])),
    workflowSource: value.workflowSource,
    inputSchema,
    outputSchema,
    smokeCase: structuredClone(smokeCase),
  };
}

function validateObjectSchema(value, label) {
  const valid = isPlainObject(value) && value.type === 'object' && isPlainObject(value.properties)
    && isJsonValue(value) && validJsonSchema(value);
  if (!valid) throw evaluationError('agent_generation_invalid', `${label}契约必须是有效的 JSON 对象 Schema。`, 400);
  return structuredClone(value);
}

function validJsonSchema(schema) {
  if (!isPlainObject(schema)
    || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)
    || Object.keys(schema).some((key) => ![
      'type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'description',
    ].includes(key))
    || (schema.description !== undefined && typeof schema.description !== 'string')
    || (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || !isJsonValue(schema.enum)))) {
    return false;
  }
  if (schema.type === 'object') {
    if (!isPlainObject(schema.properties)
      || Object.values(schema.properties).some((property) => !validJsonSchema(property))
      || (schema.required !== undefined && (!Array.isArray(schema.required)
        || new Set(schema.required).size !== schema.required.length
        || schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))))
      || (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')) return false;
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    return false;
  }
  if (schema.type === 'array') return schema.items === undefined || validJsonSchema(schema.items);
  return schema.items === undefined;
}

function matchesJsonSchema(value, schema) {
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value)
    && (schema.items === undefined || value.every((item) => matchesJsonSchema(item, schema.items)));
  if (schema.type === 'object') {
    if (!isPlainObject(value) || (schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false
      && Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(schema.properties).every(([key, property]) => (
      !Object.hasOwn(value, key) || matchesJsonSchema(value[key], property)
    ));
  }
  if (schema.type === 'integer') return Number.isSafeInteger(value);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === schema.type;
}

function validateGeneratedArtifacts(agentValue, dataContractValue, workflow, evaluation) {
  if (agentValue === null) return null;
  if (!isPlainObject(agentValue) || !isPlainObject(dataContractValue)
    || agentValue.schemaVersion !== 1 || dataContractValue.schemaVersion !== 1
    || typeof agentValue.agentVersion !== 'string'
    || !Number.isSafeInteger(agentValue.workBriefRevision)
    || agentValue.agentVersion !== workflow.agentVersion
    || agentValue.agentVersion !== evaluation.agentVersion
    || agentValue.agentVersion !== dataContractValue.agentVersion
    || agentValue.workflowVersion !== dataContractValue.workflowVersion
    || agentValue.evalRevision !== dataContractValue.evalRevision
    || agentValue.workBriefRevision !== workflow.workBriefRevision
    || agentValue.workBriefRevision !== evaluation.workBriefRevision
    || agentValue.workBriefRevision !== dataContractValue.workBriefRevision
    || agentValue.workflowVersion !== workflow.workflowVersion
    || agentValue.workflowVersion !== evaluation.workflowVersion
    || agentValue.evalRevision !== evaluation.revision
    || JSON.stringify(agentValue.contract) !== JSON.stringify(evaluation.contract)
    || dataContractValue.input?.description !== agentValue.contract?.inputs
    || dataContractValue.output?.description !== agentValue.contract?.output
    || JSON.stringify(dataContractValue.input?.schema) !== JSON.stringify(evaluation.inputSchema)
    || JSON.stringify(dataContractValue.output?.schema) !== JSON.stringify(evaluation.outputSchema)
    || !validCapabilities(agentValue.capabilities)
    || !validCapabilities(workflow.capabilities)
    || JSON.stringify(agentValue.capabilities) !== JSON.stringify(evaluation.capabilities)) {
    throw evaluationError('agent_artifacts_inconsistent', '工作 Agent 工件的版本追溯关系无效。', 500);
  }
  return { agent: structuredClone(agentValue), dataContract: structuredClone(dataContractValue) };
}

function validCapabilities(value) {
  return isPlainObject(value)
    && value.workspace === 'current-project'
    && value.network === false
    && value.externalSideEffects === false;
}

function nextAgentVersion(current) {
  if (current === undefined || current === null) return '1.0.0';
  const match = String(current).match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) throw evaluationError('agent_manifest_invalid', '工作 Agent 版本无效。', 500);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function validateEvalState(value) {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.currentRevision)
    || !Array.isArray(value.revisions) || value.revisions.length === 0
    || !value.revisions.every((item) => isPlainObject(item)
      && Number.isSafeInteger(item.revision) && item.revision > 0
      && ['confirmed', 'proposed'].includes(item.status))) {
    throw evaluationError('eval_state_corrupt', '受保护的验收数据已损坏。', 500);
  }
  const revisions = value.revisions.map((item) => ({ ...item, cases: validateCases(item.cases) }));
  const ids = revisions.map((item) => item.revision);
  if (new Set(ids).size !== ids.length
    || !revisions.some((item) => item.revision === value.currentRevision && item.status === 'confirmed')) {
    throw evaluationError('eval_state_corrupt', '受保护的验收标准版本关系无效。', 500);
  }
  return { schemaVersion: 1, currentRevision: value.currentRevision, revisions };
}

function validateCases(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw evaluationError('eval_cases_invalid', '每版验收标准必须包含 1–100 个代表案例。', 400);
  }
  const cases = value.map((item) => {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim()
      || !['normal', 'boundary'].includes(item.kind) || !isJsonValue(item.input) || !isJsonValue(item.expected)) {
      throw evaluationError('eval_cases_invalid', '代表案例必须包含稳定 ID、类型、JSON 输入和预期结果。', 400);
    }
    return structuredClone(item);
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw evaluationError('eval_cases_invalid', '代表案例 ID 不能重复。', 400);
  }
  return cases;
}

function isJsonValue(value) {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(filename, code, message) {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (cause) {
    throw evaluationError(code, message, 500, cause);
  }
}

async function readOptionalJson(filename, code, message) {
  try {
    return await readJson(filename, code, message);
  } catch (error) {
    if (error.cause?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeIfMissing(filename, contents) {
  try {
    await writeFile(filename, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function atomicWrite(filename, contents, createPendingId) {
  await mkdir(path.dirname(filename), { recursive: true });
  const pending = `${filename}.${createPendingId()}.pending`;
  await writeFile(pending, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(pending, filename);
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function evaluationError(code, message, statusCode = 500, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, statusCode });
}
