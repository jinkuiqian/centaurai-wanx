import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PROXY_RUN_CASE_ID = 'preset-proxy-run-v1';
export const WORKFLOW_MANIFEST = 'workflow.json';
export const WORKFLOW_ENTRYPOINT = 'workflow.mjs';
export const WORKFLOW_INPUT_INTERFACE = 'wanxiang.proxy-input/v1';
export const WORKFLOW_OUTPUT_INTERFACE = 'wanxiang.proxy-output/v1';

const DEFAULT_WORKFLOW = {
  schemaVersion: 1,
  workflowVersion: '1.0.0',
  entrypoint: WORKFLOW_ENTRYPOINT,
  interface: {
    input: WORKFLOW_INPUT_INTERFACE,
    output: WORKFLOW_OUTPUT_INTERFACE,
  },
};

const DEFAULT_WORKFLOW_SOURCE = `let body = '';
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

const DEFAULT_EVAL_STATE = {
  schemaVersion: 1,
  currentRevision: 1,
  revisions: [{
    revision: 1,
    status: 'confirmed',
    cases: [{
      id: PROXY_RUN_CASE_ID,
      kind: 'normal',
      input: {
        title: '客户跟进清单',
        items: [{ label: '待回复' }, { label: '已安排' }],
      },
      expected: {
        title: '客户跟进清单',
        itemCount: 2,
        labels: ['已安排', '待回复'],
      },
    }],
  }],
};

export class EvaluationProjectStore {
  constructor({ dataRoot, createPendingId = randomUUID }) {
    this.dataRoot = dataRoot;
    this.createPendingId = createPendingId;
  }

  async load(project) {
    const paths = await this.#ensure(project);
    const [workflowValue, source, evalState] = await Promise.all([
      readJson(paths.workflow, 'workflow_manifest_invalid', 'Workflow 清单格式无效。'),
      readFile(paths.entrypoint, 'utf8'),
      readJson(paths.canonical, 'eval_state_corrupt', '受保护的验收数据已损坏。'),
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
    return {
      workflow,
      source,
      eval: structuredClone(evalRevision),
      evalState: structuredClone(validatedEvalState),
      workspacePath: paths.workspacePath,
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
    return paths;
  }
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
    workflow: path.join(artifactRoot, WORKFLOW_MANIFEST),
    entrypoint: path.join(artifactRoot, WORKFLOW_ENTRYPOINT),
    mirror: path.join(artifactRoot, 'evals.json'),
    canonical: path.join(dataRoot, 'evaluations', `${digest(project.workspaceId)}.json`),
  };
}

function validateWorkflow(value) {
  const valid = isPlainObject(value)
    && Object.keys(value).every((key) => ['schemaVersion', 'workflowVersion', 'entrypoint', 'interface'].includes(key))
    && value.schemaVersion === 1
    && typeof value.workflowVersion === 'string'
    && /^[1-9]\d*\.\d+\.\d+$/u.test(value.workflowVersion)
    && value.entrypoint === WORKFLOW_ENTRYPOINT
    && isPlainObject(value.interface)
    && Object.keys(value.interface).length === 2
    && value.interface.input === WORKFLOW_INPUT_INTERFACE
    && value.interface.output === WORKFLOW_OUTPUT_INTERFACE;
  if (!valid) throw evaluationError('workflow_manifest_invalid', 'Workflow 必须使用固定入口和确定性输入输出接口。', 400);
  return structuredClone(value);
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
