import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WanxiangRuntimeManager } from '../../wanxiang-runtime/src/runtime-manager.mjs';

const FIXED_API_KEY = 'sk-wanxiang-local-replay';

export async function startWanxiangReplay() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'wanxiang-browser-replay-'));
  const script = { callId: 0, discoveryTurn: 0 };
  const model = await startFixedModel(script);
  const runtimeHome = path.join(dataRoot, 'engine');
  await mkdir(runtimeHome, { recursive: true });
  const credentialsPath = path.join(runtimeHome, '.credentials.yaml');
  await writeFile(credentialsPath, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXED_API_KEY}\n`, 'utf8');
  await chmod(credentialsPath, 0o600);
  await writeFile(path.join(runtimeHome, 'settings.yaml'), [
    'locale:',
    '  preference: zh-x-wanxiang',
    'llm-deepseek:',
    `  baseURL: ${model.baseURL}`,
    '  apiKeyEnv: DEEPSEEK_API_KEY',
    '  thinking: disabled',
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-chat',
    '',
  ].join('\n'), 'utf8');

  let manager = new WanxiangRuntimeManager({ dataRoot, port: 0, startTimeoutMs: 30_000 });
  try {
    const runtime = await manager.launch();
    return {
      dataRoot,
      url: runtime.url,
      async bindCreatedWorkspace() {
        const entries = await readdir(path.join(dataRoot, 'workspaces'), { withFileTypes: true });
        const workspace = entries.find((entry) => entry.isDirectory());
        if (!workspace) throw new Error('固定回放没有找到刚创建的工作区。');
        const workspacePath = path.join(dataRoot, 'workspaces', workspace.name);
        return workspacePath;
      },
      async restart() {
        await manager.stop();
        manager = new WanxiangRuntimeManager({ dataRoot, port: 0, startTimeoutMs: 30_000 });
        return (await manager.launch()).url;
      },
      async stop() {
        await Promise.allSettled([manager.stop(), model.stop()]);
        await rm(dataRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled([manager.stop(), model.stop()]);
    await rm(dataRoot, { recursive: true, force: true });
    throw error;
  }
}

async function startFixedModel(script) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const chunk = fixedModelReply(body, script);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fixedModelReply(body, script) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return textReply('客户跟进闭环回放');
  const last = currentInputMessage(body.messages);
  if (last?.role === 'tool') {
    const call = toolCallForResult(body.messages, last.tool_call_id);
    const args = parseArguments(call);
    if (call?.function?.name === 'wanxiang_update_work_brief') {
      if (Object.hasOwn(args.patch || {}, 'goal')) {
        const result = parseToolResult(last);
        return toolReply(script, 'wanxiang_update_work_brief', {
          baseStateVersion: result.stateVersion,
          patch: {},
          investigatedFields: ['inputs'],
          reason: '固定回放已完成当前项目资料的只读检查',
        });
      }
      return textReply(args.investigatedFields?.length
        ? '目标已经确认，我也完成了只读检查。请说明会提供哪些输入、需要什么交付，以及怎样判断结果合格。'
        : '工作说明已齐备，请通读并确认后开始制作。');
    }
    if (call?.function?.name === 'wanxiang_generate_work_agent') {
      return textReply('工作 Agent 已生成，固定代表案例已经通过。');
    }
    if (call?.function?.name === 'wanxiang_plan_feedback_change') {
      if (args.kind === 'contract') return textReply('这条反馈会改变工作边界，已提交工作说明差异等待确认。');
      return toolReply(script, 'bash', bashEditArguments(body));
    }
    if (call?.function?.name === 'bash') {
      return textReply('实现已按反馈修改，受保护评测和原案例重跑均已完成。');
    }
    return textReply('固定工具步骤已完成。');
  }

  const userText = typeof last?.content === 'string' ? last.content : '';
  if (userText.startsWith('开始制作工作说明')) {
    return toolReply(script, 'wanxiang_generate_work_agent', generatedAgent());
  }
  if (userText.startsWith('处理已保存的真实案例反馈')) {
    const feedbackId = /反馈 ([^。]+)。/u.exec(userText)?.[1];
    const baseStateVersion = /baseStateVersion=(\d+)/u.exec(userText)?.[1];
    if (!feedbackId || !baseStateVersion) throw new Error('固定回放无法识别反馈处理指令。');
    const contract = userText.includes('自动发送');
    return toolReply(script, 'wanxiang_plan_feedback_change', {
      baseStateVersion: Number(baseStateVersion),
      feedbackId,
      kind: contract ? 'contract' : 'implementation',
      ...(contract ? { contractPatch: { boundaries: '允许自动发送客户消息' } } : {}),
    });
  }
  if (script.discoveryTurn++ === 0) {
    return toolReply(script, 'wanxiang_update_work_brief', {
      baseStateVersion: currentStateVersion(body),
      patch: { goal: '把每周客户沟通记录整理成可执行的跟进建议' },
      confirmedFields: ['goal'],
      reason: '社群成员描述了最近重复发生的真实工作',
    });
  }
  return toolReply(script, 'wanxiang_update_work_brief', {
    baseStateVersion: currentStateVersion(body),
    patch: {
      inputs: '客户沟通逐字记录 JSON，字段 transcript 为本次沟通内容',
      examples: '客户明确要求下周回访',
      rules: '保留原始沟通意图，不虚构承诺',
      output: '给负责人的一条可执行跟进建议 JSON',
      boundaries: '不发送消息，不修改 CRM，只生成建议',
      success: '输出 action 必须准确包含原始 transcript，且没有外部副作用',
    },
    confirmedFields: ['inputs', 'examples', 'rules', 'output', 'boundaries', 'success'],
    reason: '社群成员补充了输入、交付、规则、边界和可观察验收标准',
  });
}

function bashEditArguments(body) {
  const tool = body.tools.find((candidate) => candidate.function?.name === 'bash');
  if (!tool) throw new Error('固定回放需要制作模式提供 bash 工具。');
  const required = tool.function.parameters?.required || [];
  return {
    command: "perl -0pi -e 's{// replay revision 1}{// replay revision 2: clarify accepted result}' .wanxiang/workflow.mjs",
    ...(required.includes('description') ? { description: '更新固定回放 Workflow 修订标记' } : {}),
  };
}

function currentInputMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'tool') return message;
    if (message.role === 'user' && !isInjectedContext(message.content)) return message;
  }
  return null;
}

function isInjectedContext(content) {
  return typeof content === 'string' && (
    content.startsWith('<system-reminder>')
    || content.startsWith('Current runtime context.')
  );
}

function generatedAgent() {
  return {
    workflowSource: `// replay revision 1
let body = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
process.stdout.write(JSON.stringify({ action: \`跟进：\${input.transcript}\` }));
`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { transcript: { type: 'string' } },
      required: ['transcript'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string' } },
      required: ['action'],
    },
    smokeCase: {
      id: 'follow-up-smoke-v1',
      title: '客户要求下周回访',
      input: { transcript: '客户希望下周二回访' },
      expected: { action: '跟进：客户希望下周二回访' },
    },
  };
}

function currentPrompt(body) {
  return JSON.stringify(body);
}

function currentStateVersion(body) {
  const versions = [...currentPrompt(body).matchAll(/stateVersion=(\d+)/gu)].map((match) => Number(match[1]));
  if (!versions.length) throw new Error('固定回放无法识别当前工作说明版本。');
  return Math.max(...versions);
}

function toolCallForResult(messages, toolCallId) {
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const call = messages[index].tool_calls?.find((candidate) => candidate.id === toolCallId);
    if (call) return call;
  }
  return null;
}

function parseToolResult(message) {
  try {
    return JSON.parse(message?.content || '{}');
  } catch {
    return {};
  }
}

function parseArguments(call) {
  try {
    return JSON.parse(call?.function?.arguments || '{}');
  } catch {
    return {};
  }
}

function toolReply(script, name, args) {
  script.callId += 1;
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: `fixed-call-${script.callId}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function textReply(content) {
  return {
    choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
