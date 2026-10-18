import { test, expect } from '@playwright/test';

for (const [locale, theme] of [['en', 'light'], ['zh-CN', 'dark'], ['zh-CN', 'hcDark'], ['en', 'hcLight']] as const) {
	test(`Automations uses cards, a commit-aware dialog and host dispatch (${locale}, ${theme})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/automations.html?locale=${locale}&theme=${theme}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		expect(await page.evaluate(() => ({ sessions: window.ashAutomations.registered, workbench: window.ashAutomations.workbenchRegistered }))).toEqual({ sessions: true, workbench: false });
		const zh = locale === 'zh-CN';
		await expect(page.locator('[data-part="customview"]')).toBeVisible();
		await expect(page.getByRole('heading', { name: zh ? '自动化' : 'Automations', exact: true })).toBeVisible();
		const existing = page.getByRole('article', { name: 'Scheduled review' });
		await expect(existing).toContainText('Review changes');
		await expect(existing).toContainText(zh ? '每 60 分钟' : 'Every 60 minutes');
		await expect(existing).toContainText(zh ? '运行目录：/saved' : 'Runs in /saved');
		await expect(page.locator('.ash-automation-summary')).toContainText(zh ? '1 项需要输入' : '1 need input');
		await expect(page.locator('.ash-automation-run[data-status="needsInput"]')).toContainText(zh ? '需要输入' : 'Needs input');
		await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automations-overview.png') });
		await page.getByRole('button', { name: zh ? '新建自动化' : 'New automation', exact: true }).press('Enter');
		const dialog = page.getByRole('dialog');
		const name = dialog.getByLabel(zh ? '名称' : 'Name', { exact: true });
		await expect(name).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(dialog.getByLabel(zh ? '指令' : 'Instructions', { exact: true })).toBeFocused();
		await name.fill('Keyboard review');
		await dialog.getByLabel(zh ? '指令' : 'Instructions', { exact: true }).fill('Review changes');
		await page.evaluate(() => window.ashAutomations.selectDirectory('/other'));
		await expect(dialog.getByLabel(zh ? '执行目录' : 'Directory', { exact: true })).toHaveValue('/captured');
		await name.focus();
		const style = await name.evaluate(element => {
			const style = getComputedStyle(element);
			return { outline: style.outlineStyle, border: style.borderTopStyle, color: style.color, width: element.getBoundingClientRect().width };
		});
		expect(style.outline).toBe('solid');
		expect(style.border).toBe('solid');
		expect(style.color).not.toBe('rgba(0, 0, 0, 0)');
		expect(style.width).toBeGreaterThan(0);
		await dialog.screenshot({ path: test.info().outputPath('automation-dialog.png') });
		await dialog.getByRole('button', { name: zh ? '保存自动化' : 'Save automation', exact: true }).press('Enter');
		await expect(dialog).toHaveCount(0);
		expect(await page.evaluate(() => window.ashAutomations.saved[0]?.directory)).toBe('/captured');
		await expect(page.getByRole('button', { name: 'Keyboard review', exact: true })).toBeVisible();
		await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'Keyboard review');
		const content = await page.evaluate(() => window.ashAutomations.help());
		expect(content.help).toContain('Tab');
		expect(content.view).toContain(zh ? '需要输入' : 'Needs input');
		await page.getByRole('button', { name: zh ? '停止运行' : 'Stop run', exact: true }).press('Enter');
		const card = page.getByRole('article', { name: 'Scheduled review' });
		const runNow = card.getByRole('button', { name: zh ? '立即运行' : 'Run now', exact: true });
		await expect(runNow).toBeEnabled();
		await runNow.press('Enter');
		await expect(page.locator('.ash-automation-history')).toContainText(zh ? '运行中' : 'Running');
		await page.setViewportSize({ width: 360, height: 640 });
		await page.getByRole('button', { name: zh ? '新建自动化' : 'New automation', exact: true }).press('Enter');
		await dialog.getByLabel(zh ? '计划' : 'Schedule', { exact: true }).selectOption('weekly');
		const cancel = dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true });
		await cancel.scrollIntoViewIfNeeded();
		const geometry = await dialog.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			return { top: bounds.top, bottom: bounds.bottom, fits: element.scrollWidth <= element.clientWidth };
		});
		expect(geometry.top).toBeGreaterThanOrEqual(0);
		expect(geometry.bottom).toBeLessThanOrEqual(640);
		expect(geometry.fits).toBe(true);
		await expect(cancel).toBeInViewport();
		await dialog.screenshot({ path: test.info().outputPath('automation-dialog-narrow.png') });
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		expect(await page.locator('.ash-custom-view-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automations-cards.png') });
		await page.getByRole('button', { name: zh ? '打开对话' : 'Open conversation', exact: true }).press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashAutomations.opened)).toEqual([['background-session', 'background-thread']]);
		await expect(page.locator('[data-part="customview"]')).toBeHidden();
		expect(await page.evaluate(() => window.ashAutomations.stops())).toBe(1);
		await page.evaluate(() => window.ashAutomations.reopen());
		await expect(page.locator('.ash-automation-history')).toContainText(zh ? '运行中' : 'Running');
		await page.evaluate(() => window.ashAutomations.finish());
		expect(await page.evaluate(() => window.ashAutomations.errors)).toEqual([]);
		expect(errors).toEqual([]);
	});
}

test('Automation edit preserves the draft on commit failure and a remote revision conflict', async ({ page }) => {
	await page.goto('/automations.html?locale=zh-CN&theme=dark');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.getByRole('button', { name: 'Scheduled review', exact: true }).press('Enter');
	const edit = page.getByRole('button', { name: '编辑自动化', exact: true });
	await edit.press('Enter');
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('名称', { exact: true }).fill('Unsaved edit');
	await page.evaluate(() => window.ashAutomations.rejectSave());
	await dialog.getByRole('button', { name: '保存自动化', exact: true }).press('Enter');
	await expect(dialog.getByRole('status', { name: '保存状态' })).toContainText('Rejected test write');
	await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('Unsaved edit');
	await page.evaluate(() => window.ashAutomations.remoteEdit());
	await dialog.getByRole('button', { name: '保存自动化', exact: true }).press('Enter');
	await expect(dialog.getByRole('status', { name: '保存状态' })).toContainText('已发生更改');
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(edit).toBeFocused();
	expect(await page.evaluate(() => window.ashAutomations.saved)).toEqual([]);
});

test('Automations retains saved cards but disables mutations when its host disconnects', async ({ page }) => {
	await page.goto('/automations.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.ashAutomations.disconnect());
	await expect(page.getByRole('button', { name: 'Scheduled review', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'New automation', exact: true })).toBeDisabled();
	await expect(page.locator('.ash-automations').getByRole('status')).toContainText('unavailable');
});

test('Sessions hides the automation entry without a provider capability', async ({ page }) => {
	await page.goto('/automations.html?available=0');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.ashAutomations.registered)).toBe(false);
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	await expect(page.getByRole('button', { name: 'New automation', exact: true })).toHaveCount(0);
});

test('A committed automation closes its dialog even when history refresh fails', async ({ page }) => {
	await page.goto('/automations.html?locale=zh-CN');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.getByRole('button', { name: '新建自动化', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('名称', { exact: true }).fill('Saved once');
	await dialog.getByLabel('指令', { exact: true }).fill('Review changes');
	await page.evaluate(() => window.ashAutomations.failHistory());
	await dialog.getByRole('button', { name: '保存自动化', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Saved once', exact: true })).toBeEnabled();
	await expect(page.getByText('无法刷新运行历史。当前显示上次可用的历史，可使用“刷新”重试。', { exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.ashAutomations.saved.length)).toBe(1);
	await page.evaluate(() => window.ashAutomations.retryHistory());
	await expect(page.getByText('无法刷新运行历史。当前显示上次可用的历史，可使用“刷新”重试。', { exact: true })).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.saved.length)).toBe(1);
});

test('Sessions navigation hides Automations and Back/Forward restores each destination', async ({ page }) => {
	await page.goto('/automations.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.ashAutomations.openDraft());
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.selectedTitle())).toBe('New draft');
	await page.evaluate(() => window.ashAutomations.back());
	await expect(page.locator('[data-part="customview"]')).toBeVisible();
	await page.evaluate(() => window.ashAutomations.back());
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.selectedTitle())).toBe('Draft');
	await page.evaluate(() => window.ashAutomations.forward());
	await expect(page.locator('[data-part="customview"]')).toBeVisible();
	await page.evaluate(() => window.ashAutomations.forward());
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.selectedTitle())).toBe('New draft');
	expect(await page.evaluate(() => window.ashAutomations.stops())).toBe(0);
});

test('A run that fails before creating a conversation reports the host failure', async ({ page }) => {
	await page.goto('/automations.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.getByRole('button', { name: 'Stop run', exact: true }).click();
	await page.evaluate(() => window.ashAutomations.deferRun());
	await page.getByRole('button', { name: 'Run now', exact: true }).click();
	await expect(page.locator('.ash-automation-history')).toContainText('Pending');
	await page.evaluate(() => window.ashAutomations.failRun());
	await expect.poll(() => page.evaluate(() => window.ashAutomations.errors)).toEqual(['Automation Scheduled review: Could not create session']);
	await expect(page.locator('.ash-automation-history')).toContainText('Failed');
});

test('Automation overview follows pause, resume and removal without losing keyboard focus', async ({ page }) => {
	await page.goto('/automations.html?locale=zh-CN');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const card = page.getByRole('article', { name: 'Scheduled review' });
	const toggle = card.getByRole('button', { name: '暂停', exact: true });
	await toggle.press('Enter');
	await expect(card.locator('.ash-automation-state')).toHaveText('已暂停');
	await expect(page.locator('.ash-automation-summary')).toHaveText('0 项已启用 · 1 项已暂停 · 1 项需要输入');
	const resume = card.getByRole('button', { name: '启用', exact: true });
	await expect(resume).toBeFocused();
	await resume.press('Enter');
	await expect(card.locator('.ash-automation-state')).toHaveText('已启用');
	await expect(page.locator('.ash-automation-summary')).toHaveText('1 项已启用 · 0 项已暂停 · 1 项需要输入');
	await expect(card.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: '停止运行', exact: true }).press('Enter');
	await expect(card.getByRole('button', { name: '删除', exact: true })).toBeEnabled();
	await card.getByRole('button', { name: '删除', exact: true }).press('Enter');
	await expect(card).toHaveCount(0);
	await expect(page.getByRole('heading', { name: '创建第一项自动化' })).toBeVisible();
	await expect(page.getByRole('button', { name: '新建自动化', exact: true })).toBeEnabled();
});

test('Automations searches and filters retained cards, with a keyboard path out of empty results', async ({ page }) => {
	await page.goto('/automations.html?locale=zh-CN&catalogue=1');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const cards = page.locator('.ash-automation-card:visible');
	await expect(cards).toHaveCount(2);
	const filters = page.getByRole('group', { name: '筛选自动化' });
	await filters.getByRole('button', { name: '已暂停', exact: true }).press('Enter');
	await expect(cards).toHaveCount(1);
	await expect(cards).toHaveAttribute('aria-label', 'Daily briefing');
	await expect(filters.getByRole('button', { name: '已暂停', exact: true })).toHaveAttribute('aria-pressed', 'true');
	const search = page.getByRole('searchbox', { name: '搜索自动化' });
	await search.fill('missing');
	await expect(cards).toHaveCount(0);
	await expect(page.getByText('没有符合筛选条件的自动化。')).toBeVisible();
	await page.getByRole('button', { name: '清除筛选' }).press('Enter');
	await expect(search).toBeFocused();
	await expect(search).toHaveValue('');
	await expect(cards).toHaveCount(2);
	await search.fill('/saved');
	await expect(cards).toHaveCount(1);
	await expect(cards).toHaveAttribute('aria-label', 'Scheduled review');
	await search.fill('');
	await expect(cards).toHaveCount(2);
	const focusStyle = await search.evaluate(element => ({
		input: getComputedStyle(element).outlineStyle,
		container: getComputedStyle(element.closest('.ash-automation-search')!).outlineStyle
	}));
	expect(focusStyle).toEqual({ input: 'none', container: 'solid' });
	await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automations-designed-page.png') });
	await page.setViewportSize({ width: 360, height: 740 });
	await expect.poll(() => page.locator('.ash-custom-view-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	const bounds = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	expect(bounds[0]).toBe(bounds[1]);
	await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automations-designed-narrow.png') });
	await filters.getByRole('button', { name: '已启用', exact: true }).press('Enter');
	await cards.getByRole('button', { name: '暂停', exact: true }).press('Enter');
	await expect(cards).toHaveCount(0);
	await expect(search).toBeFocused();
	await expect(page.getByText('没有符合筛选条件的自动化。')).toBeVisible();
});

test('Automation templates open editable localized drafts and only save on explicit submission', async ({ page }) => {
	await page.goto('/automations.html?locale=zh-CN&empty=1');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('heading', { name: '创建第一项自动化' })).toBeVisible();
	const template = page.getByRole('button', { name: '每日简报', exact: true });
	await expect(template).toBeFocused();
	await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automations-designed-empty.png') });
	await template.press('Enter');
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('每日简报');
	await expect(dialog.getByLabel('指令', { exact: true })).toHaveValue('查看此项目的近期活动，总结进展、指出阻碍，并建议接下来的优先事项。');
	await expect(dialog.getByLabel('计划', { exact: true })).toHaveValue('daily');
	await expect(dialog.getByLabel('时间', { exact: true })).toHaveValue('09:00');
	expect(await page.evaluate(() => window.ashAutomations.saved)).toEqual([]);
	await page.keyboard.press('Escape');
	await expect(template).toBeFocused();
	await page.getByRole('button', { name: '每周回顾', exact: true }).press('Enter');
	await dialog.getByRole('button', { name: '保存自动化', exact: true }).press('Enter');
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('article', { name: '每周回顾' })).toBeVisible();
	const saved = await page.evaluate(() => window.ashAutomations.saved);
	expect(saved).toHaveLength(1);
	expect(saved[0]?.schedule).toMatchObject({ type: 'weekly', weekdays: [5], hour: 17, minute: 0 });
});

test('Automation details preserve the executed version and keep results inside the independent page', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/automations.html?locale=zh-CN&theme=dark');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.ashAutomations.rename());
	const title = page.getByRole('button', { name: 'Updated review', exact: true });
	await title.press('Enter');
	const details = page.getByRole('region', { name: '自动化详情' });
	await expect(details).toContainText('Updated instructions');
	await expect(details.locator('dd').nth(2)).toHaveText('2');
	await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automation-task-details.png') });
	await details.locator('.ash-automation-detail-history button').press('Enter');
	await expect(details.getByRole('heading', { name: 'Scheduled review', exact: true })).toBeFocused();
	await expect(details).toContainText('Review changes');
	await expect(details).not.toContainText('Updated instructions');
	await expect(details.locator('dd').nth(2)).toHaveText('1');
	await expect(details.locator('.ash-automation-result')).toContainText('Added regression coverage');
	await expect(details.getByRole('list')).toContainText('src/scheduler.test.ts · +24 −0');
	expect(await page.evaluate(() => window.ashAutomations.opened)).toEqual([]);
	expect((await page.evaluate(() => window.ashAutomations.help())).view).toContain('Added regression coverage');
	await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automation-run-result.png') });
	await page.setViewportSize({ width: 360, height: 740 });
	expect(await page.locator('.ash-custom-view-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await details.locator('.ash-automation-result').scrollIntoViewIfNeeded();
	await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automation-run-narrow.png') });
	await details.getByRole('button', { name: '返回任务详情', exact: true }).press('Enter');
	await details.getByRole('button', { name: '返回自动化列表', exact: true }).press('Enter');
	await expect(title).toBeFocused();
});

test('Automation previews show the saved timezone before submission and duplicates start paused', async ({ page }) => {
	await page.goto('/automations.html?catalogue=1');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.getByRole('button', { name: 'Daily briefing', exact: true }).click();
	await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Daily briefing copy');
	await expect(dialog.getByLabel('Enabled', { exact: true })).not.toBeChecked();
	await expect(dialog.getByRole('heading', { name: 'Upcoming runs (America/Los_Angeles)' })).toBeVisible();
	await expect(dialog.locator('.ash-automation-schedule-preview li')).toHaveCount(3);
	await dialog.getByRole('button', { name: 'Save automation', exact: true }).scrollIntoViewIfNeeded();
	await expect(dialog.getByRole('button', { name: 'Save automation', exact: true })).toBeInViewport();
	await dialog.locator('.ash-automation-schedule-preview').scrollIntoViewIfNeeded();
	await dialog.screenshot({ path: test.info().outputPath('automation-schedule-preview.png') });
	await dialog.getByLabel('Time zone', { exact: true }).fill('Invalid/Zone');
	await expect(dialog.locator('.ash-automation-schedule-preview li')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashAutomations.saved)).toEqual([]);
});

test('Automation notifications ignore initial history, deduplicate changes and open their result without Chat', async ({ page }) => {
	await page.goto('/automations.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.ashAutomations.notifications())).toEqual([]);
	await page.evaluate(() => window.ashAutomations.finish());
	expect(await page.evaluate(() => window.ashAutomations.notifications())).toEqual([]);
	await page.getByLabel('Notify when an automation completes').check();
	await page.evaluate(() => window.ashAutomations.failRun());
	await expect.poll(() => page.evaluate(() => window.ashAutomations.notifications().length)).toBe(1);
	await page.evaluate(() => window.ashAutomations.refresh());
	expect(await page.evaluate(() => window.ashAutomations.notifications().length)).toBe(1);
	await page.evaluate(() => window.ashAutomations.openDraft());
	await page.evaluate(() => window.ashAutomations.openNotification());
	const details = page.getByRole('region', { name: 'Automation details' });
	await expect(details.getByRole('heading', { name: 'Scheduled review', exact: true })).toBeVisible();
	await expect(details).toContainText('Could not create session');
	expect(await page.evaluate(() => window.ashAutomations.opened)).toEqual([]);
	await page.evaluate(() => window.ashAutomations.finish());
	await expect.poll(() => page.evaluate(() => window.ashAutomations.notifications())).toEqual([
		{ message: 'Automation Scheduled review: Could not create session', closed: true },
		{ message: 'Automation Scheduled review: Completed', closed: false },
	]);
});

for (const [locale, theme] of [['en', 'hcLight'], ['zh-CN', 'dark']] as const) {
	test(`Agents connects two hosts with equal automation IDs and disconnects one through the keyboard (${locale}, ${theme})`, async ({ page }) => {
		await page.goto(`/automations.html?hosts=1&locale=${locale}&theme=${theme}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const chinese = locale === 'zh-CN';
		const prompt = chinese ? '连接宿主，或选择已连接宿主以断开连接' : 'Connect a host, or select a connected host to disconnect';
		const targetPrompt = chinese ? '选择要在此 Agents 窗口中连接的已保存 SSH 宿主' : 'Select a saved SSH host to connect in this Agents window';
		await page.getByRole('button', { name: chinese ? '新建自动化' : 'New automation', exact: true }).click();
		const initialForm = page.getByRole('dialog');
		// An unowned destination is unsafe even when only one Automation provider is available.
		await expect(initialForm.locator('select option', { hasText: 'Unknown host conversation' })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(initialForm).toHaveCount(0);
		for (const name of ['build-a', 'build-b']) {
			await page.evaluate(() => { void window.ashAutomations.manageHosts(); });
			const picker = page.getByRole('dialog', { name: prompt, exact: true });
			await expect(picker.getByRole('combobox')).toBeFocused();
			await picker.getByRole('combobox').fill(chinese ? '连接已保存' : 'Connect a Saved');
			await picker.getByRole('combobox').press('Enter');
			const targets = page.getByRole('dialog', { name: targetPrompt, exact: true });
			await expect(targets.getByRole('combobox')).toBeFocused();
			await targets.getByRole('combobox').fill(name);
			await targets.getByRole('combobox').press('Enter');
			await expect(targets).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashAutomations.connectedHosts())).toContain(name);
			await expect(page.getByRole('article', { name: `Shared review · ${name}`, exact: true })).toBeVisible();
			await expect(page.getByRole('article', { name: `Shared review · ${name}`, exact: true })).toContainText(name);
		}
		await expect(page.getByRole('article', { name: 'Scheduled review · Local host', exact: true })).toBeVisible();
		const accessible = await page.evaluate(() => window.ashAutomations.help());
		expect(accessible.help).toContain(chinese ? '切换宿主' : 'Changing hosts');
		expect(accessible.view).toContain('Shared review · build-b');
		await page.getByRole('button', { name: chinese ? '新建自动化' : 'New automation', exact: true }).click();
		const form = page.getByRole('dialog');
		const provider = form.getByLabel(chinese ? '运行于' : 'Run on', { exact: true });
		const directory = form.getByLabel(chinese ? '执行目录' : 'Directory', { exact: true });
		const conversation = form.locator('select').filter({ has: page.locator('option[value="new"]') });
		await expect(conversation.locator('option')).toHaveCount(2);
		await provider.selectOption({ label: 'build-b' });
		await expect(directory).toHaveValue('');
		await expect(conversation.locator('option')).toHaveCount(1);
		await expect(conversation).toHaveValue('new');
		await page.keyboard.press('Escape');
		await expect(form).toHaveCount(0);
		await page.evaluate(() => { void window.ashAutomations.manageHosts(); });
		let input = page.getByRole('dialog', { name: prompt, exact: true }).getByRole('combobox');
		await input.fill('build-a');
		await input.press('Enter');
		await expect(page.getByRole('article', { name: 'Shared review · build-a', exact: true })).toHaveCount(0);
		await expect(page.getByRole('article', { name: 'Shared review · build-b', exact: true })).toBeVisible();
		expect(await page.evaluate(() => window.ashAutomations.hostChanges)).toEqual(['open:build-a', 'open:build-b', 'close:build-a']);
		await page.evaluate(() => { void window.ashAutomations.manageHosts(); });
		input = page.getByRole('dialog', { name: prompt, exact: true }).getByRole('combobox');
		await input.press('Escape');
		await expect(page.getByRole('dialog', { name: prompt, exact: true })).toHaveCount(0);
		expect(await page.evaluate(() => window.ashAutomations.errors)).toEqual([]);
	});
}
