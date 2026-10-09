import { expect, test } from '@playwright/test';

test('branch PRs share state across composer and sidebar, retain focus, and open with Enter', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
	page.on('console', message => { if (message.type() === 'error') { console.error(message.text()); } });
	await page.goto('/sessionGitHub.html');
	const pills = page.locator('.ash-session-chat-input-pr');
	const first = pills.filter({ hasText: 'one #7' });
	const sidebar = page.locator('.ash-sessions-list-item');
	await expect(pills).toHaveCount(2);
	await expect(first).toHaveAccessibleName(/Changes in one · Open/);
	await expect(sidebar.locator('svg[data-ash-icon-id="git-pull-request"]')).toHaveCount(1);
	expect(await pills.locator('svg').evaluateAll(elements => elements.every(element => element.getAttribute('aria-hidden') === 'true'))).toBe(true);
	await first.focus();
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.opened)).toEqual(['https://github.com/team/one/pull/7']);
	await page.evaluate(() => window.ashSessionGitHub.setAttention('comments'));
	await expect(first).toHaveAccessibleName(/Unresolved review comments/);
	await expect(sidebar.locator('svg[data-ash-icon-id="git-pull-request-comment"]')).toHaveCount(1);
	await expect(first).toBeFocused();
	await page.evaluate(() => window.ashSessionGitHub.setAttention('checks'));
	await expect(first).toHaveAccessibleName(/Checks failed/);
	await expect(sidebar.locator('svg[data-ash-icon-id="git-pull-request-error"]')).toHaveCount(1);
	await expect(first).toBeFocused();
	await page.evaluate(() => window.ashSessionGitHub.setAttention('conflicts'));
	await expect(first).toHaveAccessibleName(/Merge conflicts/);
	await expect(first).toBeFocused();
	await page.evaluate(() => window.ashSessionGitHub.setState('merged'));
	await expect(first).toHaveAccessibleName(/Merged$/);
	await expect(first.locator('svg[data-ash-icon-id="git-pull-request-done"]')).toHaveCount(1);
	await expect(sidebar.locator('svg[data-ash-icon-id="git-pull-request-draft"]')).toHaveCount(1);
	await expect(first).toBeFocused();
	await page.evaluate(() => window.ashSessionGitHub.theme('light'));
	await expect(first.locator('span').first()).toHaveCSS('color', 'rgb(101, 45, 144)');
	await page.evaluate(() => window.ashSessionGitHub.theme('hc'));
	await expect(first).toHaveCSS('outline-style', 'solid');
	await expect(first).toHaveCSS('min-height', '28px');
	expect(await first.evaluate(element => element.getBoundingClientRect().right <= element.parentElement!.getBoundingClientRect().right)).toBe(true);
	await page.evaluate(() => window.ashSessionGitHub.changeBranch());
	await expect(pills).toHaveCount(0);
	await expect(sidebar.locator('.ash-sessions-list-pr')).toBeHidden();
	await page.evaluate(() => window.ashSessionGitHub.dispose());
	await expect(page.locator('.ash-session-chat-input-prs')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('signing out clears private PR labels in both surfaces', async ({ page }) => {
	await page.goto('/sessionGitHub.html');
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
	await page.evaluate(() => window.ashSessionGitHub.signOut());
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(0);
	await expect(page.locator('.ash-sessions-list-item')).not.toHaveAccessibleName(/Changes in/);
});

test('Chinese attention labels reach the composer and session list', async ({ page }) => {
	await page.goto('/sessionGitHub.html?locale=zh-CN');
	await expect(page.getByRole('group', { name: '会话 GitHub 关联' })).toBeVisible();
	const pr = page.locator('.ash-session-chat-input-pr').filter({ hasText: 'one #7' });
	for (const [attention, label] of [['comments', '未解决的审查评论'], ['checks', '检查未通过'], ['conflicts', '合并冲突']] as const) {
		await page.evaluate(attention => window.ashSessionGitHub.setAttention(attention), attention);
		await expect(pr).toHaveAccessibleName(new RegExp(label));
		await expect(page.locator('.ash-sessions-list-item')).toHaveAccessibleName(new RegExp(label));
	}
});

test('manual attachments deduplicate, survive reopening and branch changes, and can be removed with the keyboard', async ({ page }) => {
	await page.goto('/sessionGitHub.html');
	const attach = page.getByRole('button', { name: 'Attach PR', exact: true });
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
	await attach.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Attach a pull request to this session' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox').fill('https://github.com/TEAM/one/pull/7#discussion');
	await page.keyboard.press('Enter');
	const remove = page.getByRole('button', { name: 'Remove attached pull request team/one #7' });
	await expect(remove).toBeVisible();
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
	await expect(attach).toBeFocused();
	await page.reload();
	await expect(remove).toBeVisible();
	await page.evaluate(() => window.ashSessionGitHub.changeBranch());
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(1);
	await expect(remove).toBeVisible();
	await page.goto('/sessionGitHub.html?noWorkspace');
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(1);
	await expect(remove).toBeVisible();
	await remove.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(0);
	await expect(attach).toBeFocused();
	await page.reload();
	await expect(remove).toHaveCount(0);
});

test('Chinese attach input supports cancellation and restores focus', async ({ page }) => {
	await page.goto('/sessionGitHub.html?locale=zh-CN');
	const attach = page.getByRole('button', { name: '附加 PR', exact: true });
	await attach.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: '将拉取请求附加到此会话' });
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(attach).toBeFocused();
	expect(await page.evaluate(() => window.ashSessionGitHub.requests.filter(request => request.method === 'github/session/pullRequest/attach'))).toHaveLength(0);
});

test('removing a manual attachment retains its current branch association', async ({ page }) => {
	await page.goto('/sessionGitHub.html');
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
	await page.getByRole('button', { name: 'Attach PR', exact: true }).click();
	await page.getByRole('dialog').getByRole('textbox').fill('https://github.com/team/one/pull/7');
	await page.keyboard.press('Enter');
	const remove = page.getByRole('button', { name: 'Remove attached pull request team/one #7' });
	await expect(remove).toBeVisible();
	await remove.click();
	await expect(remove).toHaveCount(0);
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
	await expect(page.locator('.ash-session-chat-input-pr').filter({ hasText: 'one #7' })).toHaveAccessibleName(/Open$/);
	await page.reload();
	await expect(remove).toHaveCount(0);
	await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
});

test('Session PR review opens the shared editor without posting a review', async ({ page }) => {
	await page.goto('/sessionGitHub.html');
	const review = page.getByRole('button', { name: 'Review pull request team/one #7 in Ash', exact: true });
	await expect(review).toBeVisible(); await review.click();
	expect(await page.evaluate(() => window.ashSessionGitHub.opened)).toContain('ash-github://github.com/team/one/pull/7');
	expect(await page.evaluate(() => window.ashSessionGitHub.requests.some(request => request.method === 'github/comment/create'))).toBe(false);
});

async function attachIssue(page: import('@playwright/test').Page, number: number): Promise<void> {
	await page.getByRole('button', { name: 'Attach issue', exact: true }).click();
	await page.getByRole('dialog', { name: 'Attach an issue to this session' }).getByRole('textbox').fill(`https://github.com/TEAM/one/issues/${number}`);
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('multiple issues restore, deduplicate, aggregate live states and retain keyboard focus', async ({ page }) => {
	await page.goto('/sessionGitHub.html?noWorkspace');
	await attachIssue(page, 11);
	await attachIssue(page, 12);
	await attachIssue(page, 11);
	const summary = page.locator('.ash-session-chat-input-issue-summary');
	await expect(summary).toHaveAccessibleName('2 issues · 1 open · 1 closed · 0 unavailable');
	await expect(summary.locator('svg[data-ash-icon-id="issue-opened"]')).toHaveCount(1);
	await page.reload();
	await expect(summary).toHaveAccessibleName('2 issues · 1 open · 1 closed · 0 unavailable');
	await summary.focus(); await page.keyboard.press('Enter');
	await expect(summary).toHaveAttribute('aria-expanded', 'true');
	const issue = page.locator('.ash-session-chat-input-issue[href$="/11"]');
	await issue.focus(); await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.opened)).toContain('https://github.com/team/one/issues/11');
	await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'closed', 'completed'));
	await expect(summary).toHaveAccessibleName('2 issues · 0 open · 2 closed · 0 unavailable');
	await expect(summary.locator('svg[data-ash-icon-id="issue-closed"]')).toHaveCount(1);
	await expect(issue).toBeFocused();
	await expect(issue).toHaveAccessibleName(/Completed$/);
	await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'closed', 'not_planned'));
	await page.evaluate(() => window.ashSessionGitHub.setIssueState(12, 'closed', 'duplicate'));
	await expect(summary.locator('span').first()).toHaveCSS('color', 'rgb(184, 184, 184)');
	await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'future'));
	await expect(summary).toHaveAccessibleName('2 issues · 0 open · 1 closed · 1 unavailable');
	await expect(issue.locator('svg[data-ash-icon-id="issue-opened"]')).toHaveCount(1);
	await expect(issue).toHaveAccessibleName(/Status unavailable$/);
	await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'unavailable'));
	await expect(summary).toHaveAccessibleName('2 issues · 0 open · 1 closed · 1 unavailable');
	await expect(summary.locator('svg[data-ash-icon-id="issue-opened"]')).toHaveCount(1);
	await expect(issue).toHaveAccessibleName(/Status unavailable$/);
	await expect(issue).toBeFocused();
	await page.keyboard.press('Escape'); await expect(summary).toBeFocused();
	await expect(summary).toHaveAttribute('aria-expanded', 'false');
	await page.keyboard.press('Space');
	const remove = page.getByRole('button', { name: 'Remove attached issue github.com/team/one #11', exact: true });
	await remove.focus(); await page.keyboard.press('Enter');
	await expect(summary).toHaveAccessibleName('1 issues · 0 open · 1 closed · 0 unavailable');
	await expect(page.getByRole('button', { name: 'Attach issue', exact: true })).toBeFocused();
	await page.reload();
	await expect(summary).toHaveAccessibleName('1 issues · 0 open · 1 closed · 0 unavailable');
	expect(await page.evaluate(() => window.ashSessionGitHub.requests.some(request => request.method === 'github/issue/update'))).toBe(false);
});

test('Issue labels translate and survive narrow layout, theme changes and account invalidation', async ({ page }) => {
	await page.goto('/sessionGitHub.html?noWorkspace');
	await attachIssue(page, 11);
	await page.goto('/sessionGitHub.html?noWorkspace&locale=zh-CN');
	const summary = page.locator('.ash-session-chat-input-issue-summary');
	await expect(summary).toHaveAccessibleName('1 个 Issue · 1 个开放 · 0 个关闭 · 0 个状态不可用');
	await summary.click();
	const issue = page.locator('.ash-session-chat-input-issue');
	await expect(issue).toHaveAccessibleName(/打开$/);
	await page.evaluate(() => window.ashSessionGitHub.theme('light'));
	await expect(summary.locator('span').first()).toHaveCSS('color', 'rgb(16, 124, 16)');
	await page.evaluate(() => window.ashSessionGitHub.theme('hc'));
	await summary.focus(); await page.keyboard.press('Tab');
	await expect(issue).toBeFocused(); await expect(issue).toHaveCSS('outline-style', 'solid');
	expect(await issue.evaluate(element => element.getBoundingClientRect().right <= element.parentElement!.getBoundingClientRect().right)).toBe(true);
	await page.evaluate(() => window.ashSessionGitHub.signOut());
	await expect(issue).toHaveAccessibleName(/状态不可用$/);
	await expect(issue).not.toHaveAccessibleName(/long title/);
	const attach = page.getByRole('button', { name: '附加 Issue', exact: true });
	await attach.focus(); await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: '将 Issue 附加到此会话' })).toBeVisible();
	await page.keyboard.press('Escape'); await expect(attach).toBeFocused();
	await page.evaluate(() => window.ashSessionGitHub.dispose());
	await expect(page.locator('.ash-session-chat-input-issues')).toHaveCount(0);
});
