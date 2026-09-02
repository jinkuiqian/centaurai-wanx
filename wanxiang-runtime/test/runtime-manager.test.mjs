import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WanxiangRuntimeManager } from '../src/runtime-manager.mjs';

test('prepares a draft project without manufacturing a confirmed brief', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'wanxiang-workbench-'));
  try {
    const manager = new WanxiangRuntimeManager({ workspaceRoot });
    const root = path.join(workspaceRoot, 'weekly-followup');
    await writeFileAfterMkdir(path.join(root, 'AGENTS.md'), '# 团队自己的规则\n');
    await manager.prepareProject({
      projectId: 'weekly-followup',
      projectName: '客户跟进简报',
      task: '整理本周客户清单',
      discovery: {
        goal: '减少漏跟进',
        inputs: ['客户表', '沟通记录'],
        boundaries: '不发送消息',
      },
    });

    const project = JSON.parse(await readFile(path.join(root, '.wanxiang', 'project.json'), 'utf8'));
    const contract = JSON.parse(await readFile(path.join(root, '.wanxiang', 'data-contract.json'), 'utf8'));
    const instructions = await readFile(path.join(root, 'AGENTS.md'), 'utf8');

    assert.equal(project.schemaVersion, 2);
    assert.equal(project.stateVersion, 1);
    assert.equal(project.brief.confirmedRevision, null);
    assert.equal(project.brief.answers.goal, '减少漏跟进');
    assert.equal(project.brief.answers.inputs, '客户表、沟通记录');
    assert.equal(project.brief.answers.examples, '');
    assert.equal(project.brief.fieldSources.goal.status, 'inferred');
    assert.equal(project.brief.fieldSources.examples.status, 'unresolved');
    assert.equal(project.work.sessionId, null);
    assert.equal(contract.schemaVersion, 1);
    assert.equal(contract.stateVersion, 1);
    assert.equal(contract.managedBy, 'wanxiang');
    assert.equal(contract.connected, false);
    assert.match(instructions, /团队自己的规则/);
    assert.match(instructions, /WANXIANG:MANAGED:START version=2/);
    assert.match(instructions, /制作与验证是同一个循环/);
    await assert.rejects(access(path.join(root, '.wanxiang', 'work-brief.md')), { code: 'ENOENT' });

    await writeFile(path.join(root, '.wanxiang', 'project.json'), '{"status":"confirmed"}\n', 'utf8');
    await manager.prepareWorkspace({
      projectId: 'weekly-followup',
      projectName: '不应覆盖',
      task: '不应覆盖',
      discovery: {},
    });
    assert.equal(await readFile(path.join(root, '.wanxiang', 'project.json'), 'utf8'), '{"status":"confirmed"}\n');
    const updatedInstructions = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    assert.equal(updatedInstructions.match(/WANXIANG:MANAGED:START/gu)?.length, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('isolates the runtime home, filters inherited credentials, and renders the product patch', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'wanxiang-runtime-'));
  try {
    const manager = new WanxiangRuntimeManager({
      dataRoot,
      environment: {
        PATH: '/safe/bin',
        LANG: 'zh_CN.UTF-8',
        LC_MESSAGES: 'zh_CN.UTF-8',
        TMPDIR: '/safe/tmp',
        SHELL: '/bin/zsh',
        TERM: 'xterm-256color',
        OPENAI_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        DSH_HOME: '/tmp/foreign-profile',
        WANXIANG_DATA_ROOT: '/tmp/foreign-data',
      },
    });

    assert.equal(manager.environment.PATH, '/safe/bin');
    assert.equal(manager.environment.LC_MESSAGES, 'zh_CN.UTF-8');
    assert.equal(manager.environment.DSH_HOME, path.join(dataRoot, 'engine'));
    assert.equal(manager.environment.WANXIANG_DATA_ROOT, dataRoot);
    assert.equal(manager.environment.WANXIANG_WORKSPACE_ROOT, path.join(dataRoot, 'workspaces'));
    assert.equal(manager.environment.OPENAI_API_KEY, undefined);
    assert.equal(manager.environment.GITHUB_TOKEN, undefined);
    assert.equal(manager.environment.AWS_SECRET_ACCESS_KEY, undefined);
    await manager.prepareRuntimePatch();
    const patch = await readFile(path.join(dataRoot, 'wanxiang.patch.yml'), 'utf8');
    assert.match(patch, /includeHarnessIdentity: false/);
    assert.match(patch, /ui-agent-preset/);
    assert.match(patch, /defaultPreset: wanxiang-discovery/);
    assert.match(patch, /wanxiang-build/);
    assert.match(patch, /wanxiang-workbench\/src\/policy\.mjs/);
    assert.doesNotMatch(patch, /__WANXIANG_POLICY_PATH__/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('boots the real web profile with the Wanxiang workbench plugin activated', async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'wanxiang-real-runtime-'));
  const manager = new WanxiangRuntimeManager({ dataRoot, port: 0, startTimeoutMs: 20_000 });
  t.after(async () => {
    try {
      await manager.stop();
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
  const result = await manager.launch();

  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/u);
  assert.ok(result.port > 0);
  assert.equal(manager.running?.child.exitCode, null);
  const endpoint = new URL(result.url);
  endpoint.pathname = '/api/wanxiang/projects';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectName: '启动验收' }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).state.projectName, '启动验收');
});

test('seeds the warm light theme once and preserves later explicit choices', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'wanxiang-appearance-'));
  const explicitRoot = await mkdtemp(path.join(tmpdir(), 'wanxiang-appearance-explicit-'));
  try {
    const manager = new WanxiangRuntimeManager({ dataRoot });
    await manager.prepareRuntimePreferences();
    assert.match(await readFile(path.join(dataRoot, 'engine', 'settings.yaml'), 'utf8'), /preference: light/u);

    await writeFile(path.join(dataRoot, 'engine', 'settings.yaml'), 'ui-theme:\n  preference: system\n', 'utf8');
    await manager.prepareRuntimePreferences();
    assert.match(await readFile(path.join(dataRoot, 'engine', 'settings.yaml'), 'utf8'), /preference: system/u);

    const explicit = new WanxiangRuntimeManager({ dataRoot: explicitRoot });
    await mkdir(path.join(explicitRoot, 'engine'), { recursive: true });
    await writeFile(path.join(explicitRoot, 'engine', 'settings.yaml'), 'ui-theme:\n  preference: dark\n', 'utf8');
    await explicit.prepareRuntimePreferences();
    assert.match(await readFile(path.join(explicitRoot, 'engine', 'settings.yaml'), 'utf8'), /preference: dark/u);
  } finally {
    await Promise.all([
      rm(dataRoot, { recursive: true, force: true }),
      rm(explicitRoot, { recursive: true, force: true }),
    ]);
  }
});

test('launches one shared runtime across projects from the neutral shell directory', async () => {
  const fixture = await createRuntimeFixture(`
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TEST_SNAPSHOT, JSON.stringify({ cwd: process.cwd(), env: process.env }));
console.log('dsh web: http://127.0.0.1:43127/?token=real-local-token');
process.on('SIGTERM', () => setTimeout(() => {
  writeFileSync(process.env.TEST_EXIT_MARKER, 'exited');
  process.exit(0);
}, 40));
setInterval(() => {}, 1000);
`);
  try {
    const snapshot = path.join(fixture.root, 'snapshot.json');
    const exitMarker = path.join(fixture.root, 'exit.txt');
    const manager = fixture.manager({
      environment: { PATH: process.env.PATH, TEST_SNAPSHOT: snapshot, TEST_EXIT_MARKER: exitMarker },
    });
    // Test-only file paths are product inputs here, so add them after verifying the constructor filter separately.
    manager.environment.TEST_SNAPSHOT = snapshot;
    manager.environment.TEST_EXIT_MARKER = exitMarker;

    const first = await manager.launch({ projectId: 'alpha', projectName: 'Alpha' });
    const child = manager.running.child;
    const second = await manager.launch({ projectId: 'beta', projectName: 'Beta' });

    assert.equal(first.url, 'http://127.0.0.1:43127/?token=real-local-token');
    assert.equal(first.port, 43127);
    assert.equal(second.reused, true);
    assert.equal(manager.running.child, child);
    const captured = JSON.parse(await readFile(snapshot, 'utf8'));
    assert.equal(captured.cwd, await realpath(path.join(fixture.root, 'shell')));
    assert.equal(captured.env.WANXIANG_DATA_ROOT, fixture.root);
    assert.equal(captured.env.WANXIANG_WORKSPACE_ROOT, path.join(fixture.root, 'workspaces'));
    assert.equal(captured.env.OPENAI_API_KEY, undefined);
    await access(path.join(fixture.root, 'workspaces', 'alpha', '.wanxiang', 'project.json'));
    await access(path.join(fixture.root, 'workspaces', 'beta', '.wanxiang', 'project.json'));

    const startedAt = Date.now();
    await manager.stop();
    assert.ok(Date.now() - startedAt >= 30, 'stop should wait for the child exit');
    assert.equal(await readFile(exitMarker, 'utf8'), 'exited');
  } finally {
    await fixture.cleanup();
  }
});

test('prepares concurrent project launches independently while sharing startup', async () => {
  const fixture = await createRuntimeFixture(`
setTimeout(() => console.log('dsh web: http://127.0.0.1:43128/?token=shared'), 60);
setInterval(() => {}, 1000);
`);
  try {
    const manager = fixture.manager();
    const alpha = manager.launch({ projectId: 'alpha', projectName: 'Alpha' });
    const beta = manager.launch({ projectId: 'beta', projectName: 'Beta' });
    await assert.rejects(
      manager.launch({ projectId: '../invalid' }),
      (error) => error?.code === 'INVALID_PROJECT',
    );
    const [first, second] = await Promise.all([alpha, beta]);

    assert.equal(first.url, second.url);
    assert.equal(manager.running.child.exitCode, null);
    await access(path.join(fixture.root, 'workspaces', 'alpha', '.wanxiang', 'project.json'));
    await access(path.join(fixture.root, 'workspaces', 'beta', '.wanxiang', 'project.json'));
    await manager.stop();
  } finally {
    await fixture.cleanup();
  }
});

test('startup timeout terminates the starting child and waits for its exit', async () => {
  const fixture = await createRuntimeFixture(`
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => setTimeout(() => {
  writeFileSync(process.env.TEST_EXIT_MARKER, 'timeout-exit');
  process.exit(0);
}, 40));
writeFileSync(process.env.TEST_READY_MARKER, 'ready');
setInterval(() => {}, 1000);
`);
  try {
    const exitMarker = path.join(fixture.root, 'timeout-exit.txt');
    const readyMarker = path.join(fixture.root, 'timeout-ready.txt');
    const manager = fixture.manager({ startTimeoutMs: 300, stopTimeoutMs: 200 });
    manager.environment.TEST_EXIT_MARKER = exitMarker;
    manager.environment.TEST_READY_MARKER = readyMarker;
    const rejected = assert.rejects(
      manager.launch(),
      (error) => error?.code === 'WANXIANG_RUNTIME_TIMEOUT',
    );
    await waitUntil(async () => access(readyMarker).then(() => true, () => false));
    await rejected;

    assert.equal(await readFile(exitMarker, 'utf8'), 'timeout-exit');
    assert.equal(manager.startingChild, null);
    assert.equal(manager.running, null);
  } finally {
    await fixture.cleanup();
  }
});

test('stop cancels an in-flight startup and waits for the starting child', async () => {
  const fixture = await createRuntimeFixture(`
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TEST_READY_MARKER, 'ready');
process.on('SIGTERM', () => setTimeout(() => {
  writeFileSync(process.env.TEST_EXIT_MARKER, 'stopped');
  process.exit(0);
}, 40));
setTimeout(() => console.log('dsh web: http://127.0.0.1:43129/?token=too-late'), 500);
setInterval(() => {}, 1000);
`);
  try {
    const exitMarker = path.join(fixture.root, 'stop-exit.txt');
    const readyMarker = path.join(fixture.root, 'stop-ready.txt');
    const manager = fixture.manager({ startTimeoutMs: 1_000, stopTimeoutMs: 200 });
    manager.environment.TEST_EXIT_MARKER = exitMarker;
    manager.environment.TEST_READY_MARKER = readyMarker;
    const launching = manager.launch();
    await waitUntil(() => manager.startingChild !== null);
    await waitUntil(async () => access(readyMarker).then(() => true, () => false));
    await manager.stop();
    await assert.rejects(launching);

    assert.equal(await readFile(exitMarker, 'utf8'), 'stopped');
    assert.equal(manager.startingChild, null);
    assert.equal(manager.running, null);
  } finally {
    await fixture.cleanup();
  }
});

test('stop cancels a launch that is still preparing its project', async () => {
  const fixture = await createRuntimeFixture(`
console.log('dsh web: http://127.0.0.1:43130/?token=should-not-start');
setInterval(() => {}, 1000);
`);
  try {
    const manager = fixture.manager();
    let releasePreparation;
    let preparationStarted;
    const started = new Promise((resolve) => { preparationStarted = resolve; });
    const released = new Promise((resolve) => { releasePreparation = resolve; });
    manager.prepareProject = async () => {
      preparationStarted();
      await released;
    };

    const launching = manager.launch({ projectId: 'alpha' });
    await started;
    await manager.stop();
    releasePreparation();

    await assert.rejects(launching, (error) => error?.code === 'WANXIANG_RUNTIME_STOPPED');
    assert.equal(manager.startingChild, null);
    assert.equal(manager.running, null);
  } finally {
    await fixture.cleanup();
  }
});

test('rejects a workspace traversal project id', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'wanxiang-traversal-'));
  try {
    const manager = new WanxiangRuntimeManager({ workspaceRoot });
    await assert.rejects(
      manager.prepareWorkspace({ projectId: '../outside', projectName: 'bad', task: 'bad' }),
      /项目 ID/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function createRuntimeFixture(script) {
  const root = await mkdtemp(path.join(tmpdir(), 'wanxiang-runtime-fixture-'));
  const managers = [];
  const cliPath = path.join(root, 'fake-cli.mjs');
  const bundlePatch = path.join(root, 'bundle.patch.yml');
  const bundleEntry = path.join(root, 'policy.mjs');
  await Promise.all([
    writeFile(cliPath, script, 'utf8'),
    writeFile(bundlePatch, "- name: '__WANXIANG_POLICY_PATH__'\n", 'utf8'),
    writeFile(bundleEntry, 'export default {};\n', 'utf8'),
  ]);
  return {
    root,
    manager: (options = {}) => {
      const manager = new WanxiangRuntimeManager({
        dataRoot: root,
        cliPath,
        bundlePatch,
        bundleEntry,
        stopTimeoutMs: 100,
        killTimeoutMs: 100,
        ...options,
      });
      managers.push(manager);
      return manager;
    },
    cleanup: async () => {
      await Promise.allSettled(managers.map((manager) => manager.stop()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeFileAfterMkdir(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
