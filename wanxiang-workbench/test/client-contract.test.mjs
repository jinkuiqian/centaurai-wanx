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
  assert.match(client, /function RunEvidencePanel\(\{ project,/u);
  assert.match(client, /project\.evaluation\.agentVersion/u);
  assert.match(client, /project\.evaluation\.workflowVersion/u);
  assert.match(client, /project\.evaluation\.evalRevision/u);
  assert.match(client, /project\.runs\.order/u);
  for (const label of ['Agent 版本', 'Workflow 版本', 'Eval 修订', '逐案例结果', '前次运行', '运行时重启']) {
    assert.match(client, new RegExp(label, 'u'));
  }
  assert.match(client, /h\(RunEvidencePanel, \{/u);
  assert.match(client, /"aria-live": "polite"/u);
  assert.match(client, /wx-run-history[\s\S]*run\.evidence\?\.error\?\.message/u);
  assert.match(client, /输入快照[\s\S]*JSON\.stringify\(run\.evidence\.input/u);
  assert.match(client, /断言 \$\{passedAssertions\}\/\$\{assertions\.length\}/u);
});

test('v0.3.6 manually reruns the current Eval from the accessible evidence panel', () => {
  assert.match(client, /apiJson\("\/api\/wanxiang\/evaluation\/rerun"/u);
  assert.match(client, /手动重跑当前修订/u);
  assert.match(client, /本次会按当前 Workflow 版本运行全部代表案例/u);
  assert.match(client, /function RunEvidencePanel\(\{ project, onRerun, rerunning, canRerun \}\)/u);
  assert.match(client, /"aria-live": "polite"/u);
  assert.match(client, /disabled: rerunning \|\| !canRerun/u);
  assert.match(client, /rootContext\.sessions\.list\.subscribe\(refresh\)/u);
  assert.match(client, /if \(refreshing \|\| record\.busy\) return/u);
});

test('v0.3.7 runs a real case, shows reviewable evidence and records three member verdicts', () => {
  assert.match(client, /apiJson\("\/api\/wanxiang\/work-run"/u);
  assert.match(client, /apiJson\("\/api\/wanxiang\/run-feedback"/u);
  assert.match(client, /function RealWorkPanel\(\{ project, onRun, onFeedback,[^}]*busy, canRun \}\)/u);
  for (const copy of ['真实案例名称', '真实工作输入（JSON）', '开始影子运行', '正确', '需要修改', '不可接受']) {
    assert.match(client, new RegExp(copy, 'u'));
  }
  assert.match(client, /run\.evidence\?\.output[\s\S]*工作结果/u);
  assert.match(client, /run\.evidence\?\.taskSteps[\s\S]*关键步骤/u);
  assert.match(client, /运行事实/u);
  assert.match(client, /run\.status !== "running"[\s\S]*wx-feedback-form/u);
  assert.match(client, /project\.feedback\.order/u);
  assert.match(client, /工作说明 v\$\{run\.workBriefRevision\}[\s\S]*Agent v\$\{run\.agentVersion\}/u);
  assert.match(client, /project\.maturity\.stage === "can_try"[\s\S]*可以试用/u);
  assert.match(client, /run && run\.kind !== "real"/u);
  assert.match(client, /h\(RealWorkPanel, \{/u);
});

test('v0.3.8 turns corrective feedback into a same-session revision loop and keeps contract decisions visible', () => {
  assert.match(client, /function feedbackChangePrompt\(project, feedbackId\)/u);
  assert.match(client, /wanxiang_plan_feedback_change/u);
  assert.match(client, /session\.prompt\(\[\{ type: "text", text: feedbackChangePrompt\(project, feedbackId\) \}\][\s\S]*feedbackId/u);
  assert.match(client, /apiJson\("\/api\/wanxiang\/feedback-change"/u);
  assert.match(client, /function normalizeImprovements\(value\)/u);
  assert.match(client, /project\.improvements\.order/u);
  for (const copy of ['工作说明变更待确认', '变更前', '变更后', '确认这项变更', '拒绝并沿用当前版本', '原案例重跑']) {
    assert.match(client, new RegExp(copy, 'u'));
  }
  assert.match(client, /improvement\.before\.agentVersion[\s\S]*improvement\.after\?\.agentVersion/u);
  assert.match(client, /improvement\.sourceRunId[\s\S]*improvement\.rerunId/u);
  assert.match(client, /feedback\.verdict !== "correct"[\s\S]*继续处理这条反馈/u);
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

test('v0.3.1 consumes the complete authoritative guidance snapshot with a legacy-only fallback', () => {
  assert.match(client, /const authoritativeGuidance = normalizeGuidance\(value\?\.guidance \|\| projection\?\.guidance\)/u);
  assert.match(client, /raw\?\.schemaVersion !== 2/u);
  assert.match(client, /Array\.isArray\(raw\.investigatedFields\)/u);
  assert.match(client, /Array\.isArray\(raw\.changes\?\.confirmed\)/u);
  assert.match(client, /\["member", "agent"\]\.includes\(raw\.next\?\.audience\)/u);
  assert.match(client, /const understanding = authoritativeGuidance\?\.understanding \|\| source/u);
  assert.match(client, /const derived = authoritativeGuidance \? null : deriveProjection\(project\)/u);
  assert.match(client, /guidance: authoritativeGuidance \|\| derived\.guidance/u);
  assert.doesNotMatch(client, /normalizeGuidance\([^\n]+derived\.guidance/u);
  assert.match(client, /guidanceReturnsToCanonical\(guidance, project, id\)/u);
  assert.match(client, /function deriveGuidance\(project\)/u);
  for (const kind of ['ask_field', 'review_and_confirm', 'start_making', 'activation_pending', 'continue_making', 'sync_changes', 'retry_activation']) {
    assert.match(client, new RegExp(`"${kind}"`, 'u'));
  }
});

test('v0.3.1 renders this round\'s confirmed, inferred and unresolved understanding from Host guidance', () => {
  const componentSource = client.match(/function GuidanceChanges\(\{ guidance \}\) \{([\s\S]*?)\n    \}\n    function GuidanceDock/u)?.[0]
    ?.replace(/\n    function GuidanceDock$/u, '');
  assert.ok(componentSource, 'GuidanceChanges component must be callable at the public Client seam');
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const fieldByKey = {
    goal: { label: '目标' },
    inputs: { label: '真实输入' },
    success: { label: '验收标准' },
  };
  const GuidanceChanges = new Function('h', 'fieldByKey', `return (${componentSource})`)(h, fieldByKey);
  const view = GuidanceChanges({
    guidance: {
      changes: { confirmed: ['goal'], inferred: ['inputs'], unresolved: ['success'] },
      understanding: { answers: { goal: '生成周报', inputs: 'CRM 导出', success: '' } },
    },
  });
  const visibleText = (node) => typeof node === 'string' ? node : (node?.children || []).map(visibleText).join('');

  assert.equal(view.type, 'section');
  assert.equal(view.props['aria-live'], 'polite');
  assert.equal(visibleText(view), '本轮新增已确认目标生成周报本轮新增已推断真实输入CRM 导出本轮仍待确认验收标准仍待补充');
  assert.match(client, /h\(GuidanceChanges, \{ guidance \}\)/u);
  assert.match(client, /guidance\.next\.audience === "agent"/u);
  assert.match(client, /万象正在只读检查/u);
  assert.match(client, /不知道\|暂时不知道\|稍后补充\|之后补充/u);
});

test('v0.3.1 atomically confirms four complete essentials and reports brief tool progress', () => {
  const allowsBody = client.match(/function guidanceAllowsActivation\(guidance\) \{([\s\S]*?)\n    \}/u)?.[1] || '';
  const guidanceAllowsActivation = new Function('guidance', allowsBody);
  assert.equal(guidanceAllowsActivation({ next: { kind: 'ask_field' } }), false);
  assert.equal(guidanceAllowsActivation({ next: { kind: 'start_making' } }), true);
  assert.equal(guidanceAllowsActivation({ next: { kind: 'sync_changes' } }), true);
  assert.match(client, /if \(!guidanceAllowsActivation\(record\.project\.guidance\)\)/u);
  assert.doesNotMatch(client, /\bactivationReady\b/u);
  const actionLabelBody = client.match(/function actionLabel\(project, sessionId\) \{([\s\S]*?)\n    \}/u)?.[1] || '';
  assert.doesNotMatch(actionLabelBody, /project\.phase|project\.answers/u);
  assert.match(client, /原子确认当前工作说明/u);
  assert.match(client, /fieldByKey\[key\]\?\.label/u);
  assert.match(client, /工作说明 \$\{count\}\/7/u);
  assert.match(client, /"aria-live": "polite"/u);
});

test('v0.3 never activates a stale work description while visible edits are unsaved', () => {
  const helperSource = client.match(/function hasUnsavedBriefChanges\(project, draft\) \{([\s\S]*?)\n    \}/u)?.[0];
  assert.ok(helperSource, 'unsaved-change detection must be callable at the Client seam');
  const fields = [{ key: 'goal' }, { key: 'inputs' }];
  const hasUnsavedBriefChanges = new Function('fields', `return (${helperSource})`)(fields);
  const project = { projectName: '客户周报', answers: { goal: '生成周报', inputs: 'CRM 导出' } };

  assert.equal(hasUnsavedBriefChanges(project, { answers: {} }), false);
  assert.equal(hasUnsavedBriefChanges(project, { projectName: '新名称', answers: {} }), true);
  assert.equal(hasUnsavedBriefChanges(project, { answers: { goal: '生成风险周报' } }), true);
  assert.equal(hasUnsavedBriefChanges(project, { answers: { goal: '生成周报' } }), false);
  assert.match(client, /disabled: record\.busy \|\| \(!canReturn && \(hasUnsavedChanges \|\| !canActivate\)\)/u);
  assert.match(client, /请先保存工作说明中的修改/u);
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
