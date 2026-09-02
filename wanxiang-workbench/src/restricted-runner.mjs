import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WORKFLOW_ENTRYPOINT } from './evaluation-state.mjs';

const DENIED_SOURCE_PATTERNS = [
  [/\bfetch\s*\(/u, 'network'],
  [/\b(?:WebSocket|XMLHttpRequest)\b/u, 'network'],
  [/\bimport\s*\(/u, 'module'],
  [/\brequire\s*\(/u, 'module'],
  [/\bfrom\s+["']/u, 'module'],
  [/\bprocess\s*\.\s*env\b/u, 'environment'],
  [/\bprocess\s*\.\s*(?:binding|dlopen|mainModule)\b/u, 'process'],
  [/\b(?:Bun|Deno)\b/u, 'runtime'],
  [/\b(?:eval|Function)\s*\(/u, 'dynamic-code'],
  [/\bglobalThis\b/u, 'global'],
];

export class RestrictedWorkflowRunner {
  constructor({ timeoutMs = 2_000, maxOutputBytes = 256 * 1024, executable = process.execPath } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.executable = executable;
  }

  async run(request) {
    if (request?.entrypoint !== WORKFLOW_ENTRYPOINT || typeof request.workspacePath !== 'string'
      || !path.isAbsolute(request.workspacePath) || typeof request.source !== 'string') {
      throw runnerError('workflow_entrypoint_invalid', 'Workflow 入口无效。');
    }
    const capability = DENIED_SOURCE_PATTERNS.find(([pattern]) => pattern.test(request.source));
    if (capability) {
      throw runnerError('workflow_capability_denied', `Workflow 请求了被禁止的 ${capability[1]} 能力。`, 403);
    }
    const artifactRoot = path.join(request.workspacePath, '.wanxiang');
    const entrypoint = path.join(artifactRoot, request.entrypoint);
    const [realRoot, realEntry, stat] = await Promise.all([realpath(artifactRoot), realpath(entrypoint), lstat(entrypoint)]);
    if (stat.isSymbolicLink() || path.dirname(realEntry) !== realRoot) {
      throw runnerError('workflow_entrypoint_invalid', 'Workflow 入口必须是项目内的普通文件。', 403);
    }
    return this.#spawn(realEntry, realRoot, request.input);
  }

  #spawn(entrypoint, cwd, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [
        '--permission',
        `--allow-fs-read=${entrypoint}`,
        '--disable-proto=throw',
        entrypoint,
      ], {
        cwd,
        env: { LANG: 'C', LC_ALL: 'C', PATH: path.dirname(this.executable) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let oversized = false;
      const finish = (operation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation();
      };
      const append = (current, chunk) => {
        const next = Buffer.concat([current, chunk]);
        if (next.length <= this.maxOutputBytes) return next;
        oversized = true;
        child.kill('SIGKILL');
        return next.subarray(0, this.maxOutputBytes);
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      child.once('error', (cause) => finish(() => reject(runnerError('workflow_start_failed', 'Workflow 无法启动。', 500, cause))));
      child.once('close', (code, signal) => finish(() => {
        if (oversized) return reject(runnerError('workflow_output_too_large', 'Workflow 输出超过限制。'));
        if (code !== 0) {
          return reject(runnerError('workflow_nonzero_exit', `Workflow 以非零状态退出（${code ?? signal}）。`, 400, undefined, stderr));
        }
        try {
          const value = JSON.parse(stdout.toString('utf8'));
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('output must be an object');
          return resolve(value);
        } catch (cause) {
          return reject(runnerError('workflow_output_malformed', 'Workflow 输出不是有效的 JSON 对象。', 400, cause));
        }
      }));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(runnerError('workflow_timeout', `Workflow 超过 ${this.timeoutMs}ms 时间限制。`, 408)));
      }, this.timeoutMs);
      timer.unref();
      child.stdin.end(`${JSON.stringify(input)}\n`);
    });
  }
}

function runnerError(code, message, statusCode = 400, cause, stderr = Buffer.alloc(0)) {
  const error = Object.assign(new Error(message, cause ? { cause } : undefined), { code, statusCode });
  const detail = stderr.toString('utf8').trim();
  if (detail) error.detail = detail.slice(0, 2_000);
  return error;
}
