import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class RunEvidenceStore {
  constructor({ dataRoot, createPendingId = randomUUID }) {
    this.dataRoot = dataRoot;
    this.createPendingId = createPendingId;
    this.recoveryBarrier = Promise.resolve();
  }

  async prepare(evidence) {
    try {
      await this.recoveryBarrier;
    } catch (cause) {
      throw runEvidenceError(
        'run_evidence_recovery_failed', '待恢复的运行证据未能核验，已暂停新的运行。', 503, cause,
      );
    }
    if (!this.dataRoot) throw runEvidenceError('data_root_unavailable', '万象本地数据目录尚未配置。');
    const directory = path.join(this.dataRoot, 'run-evidence', digest(evidence.projectId));
    const filename = path.join(directory, `${digest(evidence.runId)}.json`);
    const pending = path.join(directory, `.${digest(evidence.runId)}.${this.createPendingId()}.pending`);
    await mkdir(directory, { recursive: true });
    await writeFile(pending, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    return { evidence: structuredClone(evidence), filename, pending };
  }

  async publish(prepared) {
    try {
      await link(prepared.pending, prepared.filename);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = JSON.parse(await readFile(prepared.filename, 'utf8'));
        if (JSON.stringify(existing) === JSON.stringify(prepared.evidence)) {
          await unlink(prepared.pending).catch(() => {});
          return prepared.filename;
        }
        await unlink(prepared.pending).catch(() => {});
        throw runEvidenceError('run_id_conflict', '这个运行 ID 已经存在，证据不能被覆盖。', 409);
      }
      throw error;
    }
    await unlink(prepared.pending).catch(() => {});
    return prepared.filename;
  }

  async abort(prepared) {
    await unlink(prepared.pending).catch(() => {});
  }

  async save(evidence) {
    return this.publish(await this.prepare(evidence));
  }

  recover(canPublish) {
    if (typeof canPublish !== 'function') {
      return Promise.reject(runEvidenceError('run_evidence_authority_required', '恢复运行证据需要权威项目状态。'));
    }
    const recovery = this.#recover(canPublish);
    this.recoveryBarrier = recovery;
    return recovery;
  }

  async #recover(canPublish) {
    if (!this.dataRoot) return 0;
    const root = path.join(this.dataRoot, 'run-evidence');
    let directories;
    try {
      directories = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    let recovered = 0;
    const failures = [];
    for (const directory of directories.filter((entry) => entry.isDirectory())) {
      const directoryPath = path.join(root, directory.name);
      const entries = await readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isFile() && /^\.[a-f0-9]{64}\..+\.pending$/u.test(item.name))) {
        const pending = path.join(directoryPath, entry.name);
        const runDigest = entry.name.slice(1, 65);
        try {
          const evidence = JSON.parse(await readFile(pending, 'utf8'));
          if (!await canPublish(evidence)) {
            await unlink(pending);
            continue;
          }
          await this.publish({
            evidence, pending, filename: path.join(directoryPath, `${runDigest}.json`),
          });
          recovered += 1;
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, '部分运行证据未能恢复。');
    return recovered;
  }
}

export async function recordRunResult({
  session, evidenceStore, finishRun, flushSession, evidence, conclusion, stopReason,
}) {
  const prepared = typeof evidenceStore.prepare === 'function'
    ? await evidenceStore.prepare(evidence)
    : null;
  const eventEvidence = eventEvidenceForRun(evidence);
  const terminal = {
    runId: evidence.runId,
    status: evidence.status,
    conclusion,
    completedAt: evidence.completedAt,
    evidence: eventEvidence,
  };
  try {
    await finishRun(evidence.projectId, terminal);
  } catch (error) {
    if (prepared && typeof evidenceStore.abort === 'function') await evidenceStore.abort(prepared);
    throw error;
  }
  let evidenceError = null;
  try {
    if (prepared) await evidenceStore.publish(prepared);
    else await evidenceStore.save(evidence);
  } catch (error) {
    evidenceError = error instanceof Error ? error : new Error('运行证据未能持久化。');
  }
  let sessionError = null;
  try {
    session.append('tool-workflow/run-end', { ...terminal, stopReason });
    await flushSession(session);
  } catch (error) {
    sessionError = error instanceof Error
      ? error
      : runEvidenceError('run_session_persistence_failed', 'DSH 会话未能持久化运行结论。');
  }
  if (evidenceError) {
    throw Object.assign(evidenceError, {
      runTerminalCommitted: true,
      evidencePending: Boolean(prepared),
      ...(sessionError ? { sessionPersistenceError: sessionError } : {}),
    });
  }
  if (sessionError) throw Object.assign(sessionError, { runTerminalCommitted: true });
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function runEvidenceError(code, message, statusCode = 500, cause = undefined) {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

export function eventEvidenceForRun(evidence) {
  return {
    input: evidence.input,
    summary: evidence.summary,
    ...(evidence.kind ? { kind: evidence.kind } : {}),
    ...(evidence.caseTitle ? { caseTitle: evidence.caseTitle } : {}),
    ...(evidence.assertions ? { assertions: evidence.assertions } : {}),
    ...(evidence.steps ? { steps: evidence.steps } : {}),
    ...(evidence.taskSteps ? { taskSteps: evidence.taskSteps } : {}),
    ...(evidence.output ? { output: evidence.output } : {}),
    ...(evidence.error ? { error: evidence.error } : {}),
  };
}
