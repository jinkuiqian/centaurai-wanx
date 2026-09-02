import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WanxiangRuntimeError } from './runtime-error.mjs';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(serviceRoot, '..');
const defaultDataRoot = path.join(projectRoot, '.wanxiang-runtime');
const require = createRequire(import.meta.url);
const runtimePackageRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
const maxOutputBytes = 256 * 1024;
const agentsBlockStart = '<!-- WANXIANG:MANAGED:START version=2 -->';
const agentsBlockEnd = '<!-- WANXIANG:MANAGED:END -->';
const appearanceMigrationVersion = 1;
const safeEnvironmentNames = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TMP', 'TEMP',
  'SHELL', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'NO_COLOR', 'FORCE_COLOR',
]);

export class WanxiangRuntimeManager {
  constructor(options = {}) {
    this.dataRoot = path.resolve(options.dataRoot || process.env.WANXIANG_DATA_ROOT || defaultDataRoot);
    this.cliPath = path.resolve(options.cliPath || process.env.WANXIANG_RUNTIME_CLI || path.join(runtimePackageRoot, 'lib', 'bin.js'));
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.env.WANXIANG_WORKSPACE_ROOT || path.join(this.dataRoot, 'workspaces'));
    this.runtimeHome = path.resolve(options.runtimeHome || process.env.WANXIANG_RUNTIME_HOME || path.join(this.dataRoot, 'engine'));
    this.shellRoot = path.join(this.dataRoot, 'shell');
    this.bundlePatch = path.resolve(options.bundlePatch || process.env.WANXIANG_WORKBENCH_PATCH || path.join(projectRoot, 'wanxiang-workbench', 'cordis.patch.yml'));
    this.bundleEntry = path.resolve(options.bundleEntry || process.env.WANXIANG_WORKBENCH_ENTRY || path.join(projectRoot, 'wanxiang-workbench', 'src', 'policy.mjs'));
    this.runtimePatch = path.join(this.dataRoot, 'wanxiang.patch.yml');
    this.productStatePath = path.join(this.dataRoot, 'product-state.json');
    this.port = Number(options.port ?? process.env.WANXIANG_PORT ?? 3000);
    this.environment = runtimeEnvironment(options.environment || process.env, {
      DSH_HOME: this.runtimeHome,
      DSH_CLIENT_TITLE: '万象',
      DSH_TELEMETRY_DISABLED: '1',
      WANXIANG_DATA_ROOT: this.dataRoot,
      WANXIANG_WORKSPACE_ROOT: this.workspaceRoot,
    });
    this.startTimeoutMs = Number(options.startTimeoutMs ?? process.env.WANXIANG_START_TIMEOUT_MS ?? 90_000);
    this.stopTimeoutMs = Number(options.stopTimeoutMs ?? process.env.WANXIANG_STOP_TIMEOUT_MS ?? 5_000);
    this.killTimeoutMs = Number(options.killTimeoutMs ?? process.env.WANXIANG_KILL_TIMEOUT_MS ?? 5_000);
    this.running = null;
    this.starting = null;
    this.startingChild = null;
    this.stopping = null;
    this.lifecycleVersion = 0;
    this.terminations = new WeakMap();
  }

  async launch(options = {}) {
    if (this.stopping) await this.stopping;
    const lifecycleVersion = this.lifecycleVersion;
    if (options.projectId !== undefined) await this.prepareProject(options);
    if (lifecycleVersion !== this.lifecycleVersion) {
      throw new WanxiangRuntimeError('WANXIANG_RUNTIME_STOPPED', '万象工作台启动已取消');
    }

    if (this.running?.child.exitCode === null) {
      return { url: this.running.url, port: this.running.port, reused: true };
    }
    if (this.starting) return this.starting;

    const starting = this.start(lifecycleVersion);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async prepareProject({ projectId, projectName, task, discovery } = {}) {
    validateProjectId(projectId);
    const workspace = workspaceFor(this.workspaceRoot, projectId);
    const artifactRoot = path.join(workspace, '.wanxiang');
    await mkdir(artifactRoot, { recursive: true });

    const draft = discovery && typeof discovery === 'object' && !Array.isArray(discovery) ? discovery : {};
    const answers = {
      goal: draftValue(draft.goal || task),
      inputs: draftValue(draft.inputs),
      examples: draftValue(draft.examples),
      rules: draftValue(draft.rules),
      output: draftValue(draft.output),
      boundaries: draftValue(draft.boundaries),
      success: draftValue(draft.success),
    };
    const timestamp = new Date().toISOString();
    const project = {
      schemaVersion: 2,
      stateVersion: 1,
      projectName: String(projectName || '未命名项目'),
      brief: {
        answers,
        fieldSources: Object.fromEntries(Object.keys(answers).map((key) => [key, {
          status: answers[key] ? 'inferred' : 'unresolved',
          sourceMessageIds: [],
        }])),
        revision: Object.values(answers).some(Boolean) ? 1 : 0,
        confirmedRevision: null,
        confirmedAnswers: null,
        confirmedFieldSources: null,
      },
      work: { sessionId: null, activeRevision: null, activation: null },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const dataContract = {
      schemaVersion: 1,
      stateVersion: 1,
      managedBy: 'wanxiang',
      status: 'awaiting-confirmed-work-brief',
      connected: false,
      sources: [],
      restrictions: ['no external writes', 'no messages', 'no credential access'],
    };

    await Promise.all([
      writeIfMissing(path.join(artifactRoot, 'project.json'), `${JSON.stringify(project, null, 2)}\n`),
      writeIfMissing(path.join(artifactRoot, 'data-contract.json'), `${JSON.stringify(dataContract, null, 2)}\n`),
      writeManagedAgentsBlock(path.join(workspace, 'AGENTS.md')),
    ]);
    return workspace;
  }

  async prepareWorkspace(options) {
    return this.prepareProject(options);
  }

  async start(lifecycleVersion = this.lifecycleVersion) {
    await Promise.all([access(this.cliPath), access(this.bundlePatch), access(this.bundleEntry)]).catch((error) => {
      throw new WanxiangRuntimeError('WANXIANG_RUNTIME_MISSING', '找不到万象运行时或工作台 Bundle', String(error));
    });
    await Promise.all([
      this.prepareRuntimePatch(),
      this.prepareRuntimePreferences(),
      mkdir(this.shellRoot, { recursive: true }),
    ]);
    if (lifecycleVersion !== this.lifecycleVersion) {
      throw new WanxiangRuntimeError('WANXIANG_RUNTIME_STOPPED', '万象工作台启动已取消');
    }

    const args = [
      this.cliPath,
      '--profile', 'web',
      '--patch', this.runtimePatch,
      '--no-open',
      '--port', String(this.port),
      '--trusted-host', `localhost:${String(this.port)}`,
    ];
    const child = spawn(process.execPath, args, {
      cwd: this.shellRoot,
      env: this.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.startingChild = child;

    let output = '';
    const append = (chunk) => {
      output = `${output}${String(chunk)}`;
      if (output.length > maxOutputBytes) output = output.slice(-maxOutputBytes);
    };

    try {
      const url = await waitForRuntimeUrl(child, append, () => output, this.startTimeoutMs);
      if (lifecycleVersion !== this.lifecycleVersion || this.startingChild !== child) {
        throw new WanxiangRuntimeError('WANXIANG_RUNTIME_STOPPED', '万象工作台启动已取消');
      }

      const browserUrl = new URL(url);
      const effectivePort = Number(browserUrl.port || (browserUrl.protocol === 'https:' ? 443 : 80));
      this.startingChild = null;
      this.running = { child, url: browserUrl.href, port: effectivePort, output: () => output };
      child.once('exit', () => {
        if (this.running?.child === child) this.running = null;
      });
      return { url: browserUrl.href, port: effectivePort, reused: false };
    } catch (error) {
      if (this.startingChild === child) this.startingChild = null;
      try {
        await this.terminateChild(child);
      } catch (terminationError) {
        if (error instanceof WanxiangRuntimeError) {
          error.details = [error.details, String(terminationError)].filter(Boolean).join('\n');
        }
      }
      throw error;
    }
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.lifecycleVersion += 1;
    const stopping = this.stopActiveChildren();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }

  async stopActiveChildren() {
    const starting = this.starting;
    const children = [...new Set([this.startingChild, this.running?.child].filter(Boolean))];
    this.startingChild = null;
    this.running = null;
    const results = await Promise.allSettled(children.map((child) => this.terminateChild(child)));
    if (starting) await starting.catch(() => {});
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  terminateChild(child) {
    const current = this.terminations.get(child);
    if (current) return current;
    const termination = terminateChild(child, this.stopTimeoutMs, this.killTimeoutMs);
    this.terminations.set(child, termination);
    return termination;
  }

  async prepareRuntimePatch() {
    await mkdir(this.dataRoot, { recursive: true });
    const template = await readFile(this.bundlePatch, 'utf8');
    const rendered = template.replace('__WANXIANG_POLICY_PATH__', quoteYaml(this.bundleEntry));
    if (rendered === template) {
      throw new WanxiangRuntimeError('WANXIANG_PATCH_INVALID', '万象工作台配置缺少运行时入口占位符');
    }
    await writeFile(this.runtimePatch, rendered, 'utf8');
  }

  async prepareRuntimePreferences() {
    await mkdir(this.dataRoot, { recursive: true });
    let productState = {};
    try {
      productState = JSON.parse(await readFile(this.productStatePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (Number(productState.appearanceMigrationVersion) >= appearanceMigrationVersion) return;

    await mkdir(this.runtimeHome, { recursive: true });
    const settingsPath = path.join(this.runtimeHome, 'settings.yaml');
    let settings = '';
    try {
      settings = await readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const preferencePattern = /(^ui-theme:\s*\n(?:^[ \t]+[^\n]*\n)*?^[ \t]+preference:\s*)([^\s#]+)/mu;
    const preference = preferencePattern.exec(settings)?.[2];
    if (!preference) {
      settings = `${settings.trimEnd()}${settings.trim() ? '\n' : ''}ui-theme:\n  preference: light\n`;
      await writeFile(settingsPath, settings, 'utf8');
    } else if (preference === 'system') {
      await writeFile(settingsPath, settings.replace(preferencePattern, '$1light'), 'utf8');
    }

    await writeFile(this.productStatePath, `${JSON.stringify({
      ...productState,
      appearanceMigrationVersion,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  }
}

function workspaceFor(root, projectId) {
  const workspace = path.resolve(root, projectId);
  if (!workspace.startsWith(`${root}${path.sep}`)) throw new WanxiangRuntimeError('INVALID_PROJECT', '项目工作区越界');
  return workspace;
}

function validateProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) {
    throw new WanxiangRuntimeError('INVALID_PROJECT', '项目 ID 只能包含字母、数字、下划线和连字符');
  }
}

function renderWorkspaceInstructions() {
  return `${agentsBlockStart}\n## 万象项目规则\n\n- \`.wanxiang/project.json\` 是供审查和迁移的状态镜像，不得直接修改；工作台以项目外的受保护状态为准。\n- 只有用户确认后生成的 \`.wanxiang/work-brief.md\` 才是当前工作契约。\n- 阅读版本化的 \`.wanxiang/data-contract.json\`，不得声称示例数据源已连接。\n- 制作与验证是同一个循环：每次实现后立即运行代表性案例和边界案例，再根据证据修正。\n- 只在当前工作区内读写；外部副作用和高风险动作必须获得用户明确批准。\n${agentsBlockEnd}`;
}

function draftValue(value) {
  return Array.isArray(value) ? value.map(String).join('、') : String(value || '');
}

function runtimeEnvironment(source, required) {
  const environment = {};
  for (const [name, value] of Object.entries(source || {})) {
    if ((safeEnvironmentNames.has(name) || name.startsWith('LC_')) && typeof value === 'string') {
      environment[name] = value;
    }
  }
  return { ...environment, ...required };
}

function waitForRuntimeUrl(child, append, output, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const inspect = (chunk) => {
      append(chunk);
      const match = /dsh web: (https?:\/\/[^\s]+)/u.exec(output());
      if (match?.[1]) finish(resolve, match[1]);
    };
    const onError = (error) => {
      finish(reject, new WanxiangRuntimeError('WANXIANG_RUNTIME_FAILED', '万象工作台无法启动', String(error)));
    };
    const onExit = (code) => {
      finish(reject, new WanxiangRuntimeError('WANXIANG_RUNTIME_FAILED', `万象工作台启动失败（${String(code)}）`, redact(output())));
    };
    const timer = setTimeout(() => {
      finish(reject, new WanxiangRuntimeError('WANXIANG_RUNTIME_TIMEOUT', '万象工作台启动超时', redact(output())));
    }, timeoutMs);
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function terminateChild(child, stopTimeoutMs, killTimeoutMs) {
  if (hasExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, stopTimeoutMs)) return;
  child.kill('SIGKILL');
  if (await waitForExit(child, killTimeoutMs)) return;
  throw new WanxiangRuntimeError('WANXIANG_RUNTIME_STOP_TIMEOUT', '万象工作台无法在停止时限内退出');
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('exit', onExit);
    if (hasExited(child)) finish(true);
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function writeManagedAgentsBlock(file) {
  const managed = renderWorkspaceInstructions();
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const start = current.indexOf('<!-- WANXIANG:MANAGED:START');
  const end = current.indexOf(agentsBlockEnd);
  let updated;
  if (start >= 0 && end >= start) {
    updated = `${current.slice(0, start)}${managed}${current.slice(end + agentsBlockEnd.length)}`;
  } else {
    const prefix = current.trimEnd();
    updated = prefix ? `${prefix}\n\n${managed}\n` : `${managed}\n`;
  }
  if (updated !== current) await writeFile(file, updated, 'utf8');
}

function redact(output) {
  return String(output || '').replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>').slice(-8_000);
}

async function writeIfMissing(file, contents) {
  await writeFile(file, contents, { encoding: 'utf8', flag: 'wx' }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
}

function quoteYaml(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
