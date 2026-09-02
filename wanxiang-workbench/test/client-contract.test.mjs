import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

test('v0.3 keeps DSH conversation, composer and tool lifecycle native', () => {
  assert.match(client, /slots\.inject\("conversation\.hero\.brand\.mark"/u);
  assert.match(client, /slots\.inject\("conversation\.input\.dock"[\s\S]*GuidanceDock/u);
  assert.match(client, /slots\.inject\("conversation\.session\.header\.actions"/u);
  assert.doesNotMatch(client, /slots\.inject\("conversation\.input\.left"/u);
  assert.match(client, /"access\.preset\.readOnly": "理解中 · 只读"/u);
  assert.match(client, /"access\.preset\.workspaceWrite": "制作中 · 项目可写"/u);
  assert.match(client, /"header\.action": "导出运行记录"/u);
  assert.match(client, /"view\.trajectory": "运行记录"/u);
  assert.match(client, /ctx\.sessions\.list\.subscribe\(sync\)/u);
  assert.match(client, /document\.title = "万象"/u);
  assert.match(client, /slots\.inject\("tool\.call\.toolview"[\s\S]*wanxiang_update_work_brief/u);
  assert.match(client, /slots\.inject\("tool\.call\.toolview"[\s\S]*wanxiang_run_evaluation[\s\S]*ProxyRunToolView/u);
  assert.match(client, /slots\.inject\("shell\.overlay"/u);
  assert.doesNotMatch(client, /slots\.inject\("conversation\.view"/u);
  assert.doesNotMatch(client, /slots\.inject\("conversation",/u);
  assert.doesNotMatch(client, /slots\.inject\("conversation\.composer\.bar"/u);
  assert.doesNotMatch(client, /__WANXIANG_WORKSPACE__/u);
});

test('v0.3.2 shows the proxy run and pass result in the existing DSH tool view', () => {
  assert.match(client, /function ProxyRunToolView\(\{ block, inspect \}\)/u);
  assert.match(client, /代理运行中/u);
  assert.match(client, /代理运行通过/u);
  assert.match(client, /block\.isError/u);
  assert.match(client, /查看运行证据/u);
  assert.doesNotMatch(client, /slots\.inject\("conversation\.view"[\s\S]*ProxyRun/u);
});

test('v0.3.3 identifies all five proxy-slice cases in the native tool timeline', () => {
  assert.match(client, /function ProxyRunToolView\(\{ block, inspect \}\)[\s\S]*proxyRunCase\(block\)/u);
  for (const title of ['正常客户', '超过 14 天未跟进', '无沟通记录', '高意向但无下一步', '缺少负责人']) {
    assert.match(client, new RegExp(title, 'u'));
  }
  assert.match(client, /代理垂直切片/u);
  assert.match(client, /caseTitle/u);
  assert.match(client, /查看运行证据/u);
});

test('v0.3.4 distinguishes running, pass, partial failure, timeout and cancellation in the native tool view', () => {
  assert.match(client, /function proxyRunConclusion\(block\)/u);
  assert.match(client, /const errorCode = block\.error\?\.code/u);
  for (const conclusion of ['代理运行中', '代理运行通过', '部分失败', '运行超时', '运行已取消']) {
    assert.match(client, new RegExp(conclusion, 'u'));
  }
  assert.match(client, /workflow_timeout/u);
  assert.match(client, /workflow_cancelled/u);
  assert.match(client, /proxy_run_assertion_failed/u);
  assert.match(client, /retryOf/u);
});

test('v0.3.5 restores protected workflow, eval and historical run evidence in the existing drawer', () => {
  assert.match(client, /function RunEvidencePanel\(\{ project \}\)/u);
  assert.match(client, /project\.evaluation\.workflowVersion/u);
  assert.match(client, /project\.evaluation\.evalRevision/u);
  assert.match(client, /project\.runs\.order/u);
  for (const label of ['Workflow 版本', 'Eval 修订', '逐案例结果', '前次运行', '运行时重启']) {
    assert.match(client, new RegExp(label, 'u'));
  }
  assert.match(client, /h\(RunEvidencePanel, \{ project \}\)/u);
  assert.match(client, /"aria-live": "polite"/u);
  assert.match(client, /wx-run-history[\s\S]*run\.evidence\?\.error\?\.message/u);
  assert.match(client, /断言 \$\{passedAssertions\}\/\$\{assertions\.length\}/u);
});

test('v0.3.1 makes guidance persistent without replacing or submitting the native composer', () => {
  assert.match(client, /function GuidanceDock\(\{ session, sessionId, input, inputActions \}\)/u);
  assert.match(client, /inputActions\.setDraft\(example\.draft\)/u);
  assert.match(client, /String\(input\?\.draft \|\| ""\)\.trim\(\)[\s\S]*return/u);
  assert.doesNotMatch(client, /inputActions\.submit/u);
  assert.match(client, /描述真实工作/u);
  assert.match(client, /提供真实材料/u);
  assert.match(client, /确认工作说明/u);
  assert.match(client, /制作并验收/u);
  assert.match(client, /制作条件[^\n]*requiredKnown/u);
  assert.match(client, /工作说明[^\n]*allKnown/u);
  assert.match(client, /guidance\.next\.prompt/u);
  assert.match(client, /打开工作说明/u);
  assert.match(client, /session\.promptAttempted \|\| session\.awaitingFirstTurn/u);
  assert.match(client, /"data-known": !isPlaceholderAnswer\(answers\?\.\[field\.key\]\)/u);
  assert.match(client, /\["idle", "loading"\]\.includes\(record\.status\)/u);
  assert.match(client, /guidanceActionLabel\(guidance, project, id\)/u);
  assert.match(client, /canonicalSessionElsewhere\(project, sessionId\)/u);
  assert.match(client, /rootContext\.sessions\.open\(project\.work\.sessionId\)/u);
  assert.match(client, /制作只在项目的主会话继续/u);
  assert.match(client, /"aria-controls": guidanceContentId/u);
  assert.match(client, /\["making", "activating"\]\.includes\(stage\)\) setCollapsed\(true\)/u);
  assert.match(client, /\["changed", "failed", "reviewing", "ready"\]\.includes\(stage\)[\s\S]*setCollapsed\(false\)/u);
  assert.match(client, /\.wx-guidance-examples\{display:grid/u);
  assert.doesNotMatch(client, /\.wx-guidance-examples\{display:none/u);
});

test('v0.3.1 imports external workspaces from the guidance dock and keeps other load errors retryable', () => {
  const guidanceDock = client.match(/function GuidanceDock\(\{ session, sessionId, input, inputActions \}\) \{([\s\S]*?)\n    \}\n    function statusOf/u)?.[1] || '';
  const importWorkspace = client.match(/async function importWorkspace\(workspaceId\) \{([\s\S]*?)\n    \}\n\n    function workspaceForSession/u)?.[1] || '';
  assert.match(guidanceDock, /record\.errorCode === "workspace_outside_managed_root"/u);
  assert.match(guidanceDock, /这个项目尚未导入万象/u);
  assert.match(guidanceDock, /importWorkspace\(workspace\.workspaceId\)/u);
  assert.match(guidanceDock, /"导入并开始使用"/u);
  assert.match(guidanceDock, /record\.busy \? "正在导入项目并载入工作说明…"/u);
  assert.match(guidanceDock, /disabled: record\.busy/u);
  assert.match(guidanceDock, /loadProject\(workspace\.workspaceId\)[\s\S]*"重新同步"/u);
  assert.match(importWorkspace, /replaceRecord\(workspaceId, \{ busy: true, error: "" \}\)/u);
});

test('v0.3.1 consumes server guidance with a pure client fallback', () => {
  assert.match(client, /guidance: normalizeGuidance\(projection\?\.guidance, derived\.guidance\)/u);
  assert.match(client, /function deriveGuidance\(project\)/u);
  for (const kind of ['ask_field', 'review_and_confirm', 'start_making', 'activation_pending', 'continue_making', 'sync_changes', 'retry_activation']) {
    assert.match(client, new RegExp(`"${kind}"`, 'u'));
  }
});

test('v0.3.1 atomically confirms four complete essentials and reports brief tool progress', () => {
  assert.match(client, /function activationReady\(project\) \{\s*return requiredKeys\.every\(\(key\) => !isPlaceholderAnswer\(project\.answers\[key\]\)\);/u);
  const activationReadyBody = client.match(/function activationReady\(project\) \{([\s\S]*?)\n    \}/u)?.[1] || '';
  assert.doesNotMatch(activationReadyBody, /user_confirmed/u);
  assert.match(client, /原子确认当前工作说明/u);
  assert.match(client, /fieldByKey\[key\]\?\.label/u);
  assert.match(client, /工作说明 \$\{count\}\/7/u);
  assert.match(client, /"aria-live": "polite"/u);
});

test('v0.3 themes the native shell through paired light and dark tokens', () => {
  assert.match(client, /theme\.overrideTokens/u);
  assert.match(client, /"--dsw-alias-bg-base": \{ light: "#F3F0E8", dark: "#151A18" \}/u);
  assert.match(client, /"--dsw-alias-state-business-primary": \{ light: "#1F6B57", dark: "#70B99E" \}/u);
  assert.match(client, /"--dsw-specific-input-major"/u);
  assert.match(client, /"--dsw-specific-sidebar-nav-item-active"/u);
  assert.match(client, /"--dsw-font-markdown-h1"[\s\S]*Songti SC/u);
  assert.doesNotMatch(client, /body\s*,?\s*body\s*\*/u);
  assert.doesNotMatch(client, /span:has\(>\.wx-hero\)/u);
  assert.doesNotMatch(client, /\[data-chat-flow-kind=/u);
  assert.doesNotMatch(client, /!important/u);
  assert.doesNotMatch(client, /MutationObserver/u);
  assert.doesNotMatch(client, /createTreeWalker|NodeFilter|querySelectorAll\("button"/u);
});

test('v0.3 activates exactly once in the same native session', () => {
  assert.match(client, /apiJson\("\/api\/wanxiang\/activation"[\s\S]*method: "POST"/u);
  assert.match(client, /apiJson\("\/api\/wanxiang\/activation"[\s\S]*method: "PUT"/u);
  assert.match(client, /session\.prompt\(\[\{ type: "text", text: activationPrompt\(project\) \}\][\s\S]*activationId/u);
  assert.match(client, /\["already-active", "existing-session"\]/u);
  assert.match(client, /body\.result === "in-progress"/u);
  assert.match(client, /project\.confirmedAnswers \|\| project\.answers/u);
  assert.doesNotMatch(client, /sessions\.create/u);
  assert.doesNotMatch(client, /\/api\/wanxiang\/dispatch/u);
  assert.doesNotMatch(client, /Builder|派发|构建会话/u);
});

test('v0.3 exposes one responsive, accessible brief drawer and honest community outbox', () => {
  assert.match(client, /@media\(min-width:1100px\)/u);
  assert.match(client, /@media\(max-width:719px\)/u);
  assert.match(client, /prefers-reduced-motion:reduce/u);
  assert.match(client, /event\.key === "Escape"/u);
  assert.match(client, /restore\.focus/u);
  assert.match(client, /aria-modal/u);
  assert.match(client, /仅保存在本机，尚未发送/u);
  assert.match(client, /BroadcastChannel/u);
  assert.match(client, /revision_conflict/u);
  assert.match(client, /代表案例/u);
  assert.match(client, /user_confirmed|根据案例推断/u);
  assert.match(client, /开始制作/u);
  assert.match(client, /确认修改并继续制作/u);
});
