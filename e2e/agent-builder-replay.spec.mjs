import { expect, test } from '@playwright/test';
import { startWanxiangReplay } from './support/wanxiang-replay.mjs';

test('社群成员可从空白项目完成制作验证闭环并恢复状态', async ({ browser }) => {
  const replay = await startWanxiangReplay();
  test.info().annotations.push({ type: 'model', description: '本机固定响应，不访问在线模型' });
  try {
    const page = await browser.newPage();
    await page.goto(replay.url);

    await expect(page).toHaveTitle('万象');
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/wanxiang/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectName: '客户跟进闭环回放' }),
      });
      return response.json();
    });
    expect(created.state.brief.revision).toBe(0);
    expect(created.state.work.sessionId).toBeNull();
    await replay.bindCreatedWorkspace();

    await page.getByRole('button', { name: /选择项目|Choose project/u }).click();
    await page.getByRole('menuitem', { name: '客户跟进闭环回放' }).click();
    await expect(page.getByRole('region', { name: '万象工作引导' })).toContainText('从真实工作开始');
    await expect(page.getByText('先回答这一问')).toBeVisible();

    await sendMessage(page, '我每周都要把客户沟通记录整理成下一步跟进建议。');
    await expect(page.getByRole('paragraph').filter({ hasText: '目标已经确认，我也完成了只读检查。' })).toBeVisible();
    await expect(page.getByRole('region', { name: '万象工作引导' })).toContainText('制作条件 1/4');

    await sendMessage(page, '输入是沟通逐字记录；输出给负责人；必须保留原意、不得自动发送，并能从 action 看到原文。');
    await expect(page.getByText('工作说明已齐备，请通读并确认后开始制作。')).toBeVisible();
    const guidance = page.getByRole('region', { name: '万象工作引导' });
    await expect(guidance).toContainText('制作条件 4/4');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const guidanceAction = guidance.getByRole('button', { name: '确认并开始制作' });
    await guidanceAction.focus();
    await guidanceAction.press('Enter');
    const brief = page.getByRole('dialog', { name: '工作说明' });
    await expect(brief).toBeVisible();
    expect(await brief.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await brief.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    expect((await brief.boundingBox()).width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(brief).toBeHidden();
    await expect(guidanceAction).toBeFocused();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await guidanceAction.click();
    await brief.getByRole('button', { name: '开始制作', exact: true }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: '工作 Agent 已生成' })).toBeVisible();

    await page.getByTitle('打开工作说明').click();
    await expect(brief).toBeVisible();
    await runRealCase(brief, '首次真实回访', '客户希望周五前收到回访建议');
    const firstRun = brief.locator('.wx-real-result').first();
    await expect(firstRun).toContainText('跟进：客户希望周五前收到回访建议');
    await firstRun.getByLabel('补充说明').fill('结果与客户原意一致。');
    await firstRun.getByRole('button', { name: '正确', exact: true }).click();
    await expect(brief.getByText('可以试用', { exact: true }).first()).toBeVisible();

    await runRealCase(brief, '需要澄清的回访', '客户提到下周再联系，但没有说明具体日期');
    const needsChangesRun = brief.locator('.wx-real-result').first();
    await needsChangesRun.getByLabel('补充说明').fill('请把建议说明得更清楚，但不要改变工作边界。');
    await needsChangesRun.getByRole('button', { name: '需要修改', exact: true }).click();
    const implementationChange = brief.locator('.wx-feedback-change').first();
    await expect(implementationChange).toContainText('实现修改与原案例重跑已完成', { timeout: 30_000 });
    await expect(implementationChange).toContainText('原案例重跑');
    const rerun = brief.locator('.wx-real-result').first();
    await expect(rerun).toContainText('需要澄清的回访');
    await rerun.getByLabel('补充说明').fill('修改后的结果可以接受。');
    await rerun.getByRole('button', { name: '正确', exact: true }).click();
    await expect(brief.getByText('可以试用', { exact: true }).first()).toBeVisible();

    await runRealCase(brief, '越界发送请求', '客户要求今天回复');
    const unacceptableRun = brief.locator('.wx-real-result').first();
    await unacceptableRun.getByLabel('补充说明').fill('我要求自动发送客户消息，这会改变当前边界。');
    await unacceptableRun.getByRole('button', { name: '不可接受', exact: true }).click();
    const contractChange = brief.locator('.wx-feedback-change').first();
    await expect(contractChange).toContainText('工作说明变更待确认', { timeout: 30_000 });
    await contractChange.getByRole('button', { name: '拒绝并沿用当前版本' }).click();
    await expect(contractChange).toContainText('已拒绝，沿用当前版本');

    await page.reload();
    await expect(page).toHaveTitle('万象');
    await page.getByTitle('打开工作说明').click();
    await expect(brief).toContainText('已拒绝，沿用当前版本');
    await expect(brief.getByText('可以试用', { exact: true }).first()).toBeVisible();

    const restartedUrl = await replay.restart();
    await page.goto(restartedUrl);
    await expect(page).toHaveTitle('万象');
    await page.getByRole('region', { name: '万象工作引导' })
      .getByRole('button', { name: '返回制作会话' }).click();
    await page.getByTitle('打开工作说明').click();
    await expect(brief).toContainText('已拒绝，沿用当前版本');
    await expect(brief).toContainText('原案例重跑');
    await expect(brief.getByText('可以试用', { exact: true }).first()).toBeVisible();
  } finally {
    await replay.stop();
  }
});

async function sendMessage(page, text) {
  const composer = page.getByRole('textbox').last();
  await composer.fill(text);
  await page.getByRole('button', { name: /发送消息|Send message/u }).click();
}

async function runRealCase(brief, title, transcript) {
  await brief.getByLabel('真实案例名称').fill(title);
  await brief.getByLabel('真实工作输入（JSON）').fill(JSON.stringify({ transcript }));
  await brief.getByRole('button', { name: '开始影子运行' }).click();
  await expect(brief.locator('.wx-real-result').first()).toContainText(title);
}
