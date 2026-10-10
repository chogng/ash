import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/issueReporter.html'); await page.evaluate(() => window.ashIssueReporterIntegration.open()); });
test.afterEach(async ({ page }) => { await page.evaluate(() => window.ashIssueReporterIntegration.dispose()); });

test('the report command opens an editable draft, previews selected diagnostics, searches and submits through the protocol', async ({ page }) => {
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Editor loses focus');
	const title = page.getByRole('textbox', { name: 'Title', exact: true });
	await title.press('Home'); await title.press('ArrowRight'); await page.keyboard.insertText('x'); await page.keyboard.insertText('y');
	await expect(title).toHaveValue('Exyditor loses focus');
	await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Open the editor and press Tab.');
	await page.getByText('Preview the report that will be submitted', { exact: true }).click();
	const preview = page.locator('.ash-issue-reporter pre');
	await expect(preview).toContainText('0.1.0-test'); await expect(preview).toContainText('example.syntax 1.2.3');
	await expect(preview).toContainText('App Server\nAsh: 0.1.0-test\nOS: windows (x86_64)');
	await expect(preview).toContainText('Browser: Mozilla/');
	await page.getByRole('checkbox', { name: 'Include installed extensions' }).uncheck();
	await expect(preview).not.toContainText('example.syntax');
	await page.getByRole('button', { name: 'Search similar issues' }).click();
	await expect(page.getByRole('link', { name: 'Existing editor bug (open)' })).toBeVisible();
	await page.getByRole('button', { name: 'Submit to GitHub' }).click();
	await expect(page.getByRole('status')).toContainText('Sign in to GitHub');
	await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
	await expect(page.getByText('Submitting as Test account')).toBeVisible();
	await page.getByRole('button', { name: 'Submit to GitHub' }).click();
	await expect(page.getByRole('link', { name: 'Open issue #8' })).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeDisabled();
	const submitted = await page.evaluate(() => window.ashIssueReporterIntegration.requests.filter(request => request.method === 'issueReporter/submit'));
	expect(submitted).toHaveLength(2); expect(submitted[1]!.params.body).toContain('Open the editor and press Tab.'); expect(submitted[1]!.params.body).not.toContain('example.syntax');
	await page.getByRole('link', { name: 'Open issue #8' }).click();
	expect(await page.evaluate(() => window.ashIssueReporterIntegration.opened)).toEqual(['https://github.com/chogng/ash/issues/8']);
	await page.getByRole('button', { name: 'New report' }).click();
	await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('');
});

test('closing the tab preserves the draft and search cancellation reaches a terminal response', async ({ page }) => {
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Preserved draft');
	await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Steps remain after closing.');
	await page.evaluate(() => window.ashIssueReporterIntegration.holdSearch());
	await page.getByRole('button', { name: 'Search similar issues' }).click();
	await expect(page.getByRole('status')).toContainText('Searching');
	await page.getByRole('button', { name: 'Cancel search' }).click();
	await expect(page.getByRole('button', { name: 'Search similar issues' })).toBeEnabled();
	expect(await page.evaluate(() => window.ashIssueReporterIntegration.requests.filter(request => request.method === 'issueReporter/search/cancel').length)).toBe(1);
	await page.evaluate(() => window.ashIssueReporterIntegration.close()); await page.evaluate(() => window.ashIssueReporterIntegration.open());
	await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Preserved draft');
	await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Steps remain after closing.');
});

test('a pending submission survives tab closure without creating another request', async ({ page }) => {
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill('One report');
	await page.getByRole('textbox', { name: 'Description', exact: true }).fill('One creation request.');
	await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
	await page.evaluate(() => window.ashIssueReporterIntegration.holdSubmit());
	await page.getByRole('button', { name: 'Submit to GitHub' }).click();
	await expect(page.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
	await page.evaluate(() => window.ashIssueReporterIntegration.close()); await page.evaluate(() => window.ashIssueReporterIntegration.open());
	await expect(page.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
	await page.evaluate(() => window.ashIssueReporterIntegration.releaseSubmit());
	await expect(page.getByRole('link', { name: 'Open issue #8' })).toBeVisible();
	expect(await page.evaluate(() => window.ashIssueReporterIntegration.requests.filter(request => request.method === 'issueReporter/submit').length)).toBe(1);
});

test('an uncertain submission keeps the report, warns against duplicate creation and renders theme tokens', async ({ page }) => {
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Uncertain response');
	await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep these steps.');
	await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
	await page.evaluate(() => window.ashIssueReporterIntegration.fail('IssueReporterSubmissionUncertain'));
	await page.getByRole('button', { name: 'Submit to GitHub' }).click();
	await expect(page.getByRole('status')).toContainText('Check the repository before submitting again');
	await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Keep these steps.');
	const background = await page.locator('.ash-issue-reporter').evaluate(element => getComputedStyle(element).backgroundColor);
	await page.evaluate(() => window.ashIssueReporterIntegration.theme('light'));
	expect(await page.locator('.ash-issue-reporter').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(background);
	await page.evaluate(() => window.ashIssueReporterIntegration.theme('highContrast'));
	const description = page.getByRole('textbox', { name: 'Description', exact: true }); await description.focus();
	expect(await description.evaluate(element => getComputedStyle(element).outlineColor)).toBe('rgb(255, 255, 255)');
	expect(await page.locator('.ash-issue-reporter h1').evaluate(element => getComputedStyle(element).fontSize)).toBe('18px');
});

test('the reporter exposes Chinese form labels and submission guidance', async ({ page }) => {
	await page.goto('/issueReporter.html?locale=zh-CN'); await page.evaluate(() => window.ashIssueReporterIntegration.open());
	await expect(page.getByRole('heading', { name: '报告问题' })).toBeVisible();
	await page.getByRole('textbox', { name: '标题', exact: true }).fill('编辑器问题');
	await page.getByRole('textbox', { name: '描述', exact: true }).fill('复现步骤');
	await page.getByText('预览将要提交的报告', { exact: true }).click();
	await expect(page.locator('.ash-issue-reporter pre')).toContainText('类型：缺陷');
	await expect(page.locator('.ash-issue-reporter pre')).toContainText('系统信息');
	await expect(page.locator('.ash-issue-reporter pre')).toContainText('App Server\nAsh：0.1.0-test\n操作系统：windows（x86_64）');
	await expect(page.locator('.ash-issue-reporter pre')).toContainText('浏览器：Mozilla/');
	await page.getByRole('button', { name: '搜索相似问题' }).click();
	await expect(page.getByRole('link', { name: 'Existing editor bug（未关闭）' })).toBeVisible();
	await page.getByRole('button', { name: '提交到 GitHub' }).click();
	await expect(page.getByRole('status')).toContainText('提交此报告前请先登录 GitHub');
});

test('extension discovery diagnostics can be reported with the available system diagnostics', async ({ page }) => {
	await page.goto('/issueReporter.html?extensionsFailed'); await page.evaluate(() => window.ashIssueReporterIntegration.open());
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Cannot load extensions');
	await page.getByRole('textbox', { name: 'Description', exact: true }).fill('The extension catalog fails to load.');
	await page.getByText('Preview the report that will be submitted', { exact: true }).click();
	await expect(page.locator('.ash-issue-reporter pre')).toContainText('sourceUnavailable: Extension source is unavailable.');
	await expect(page.locator('.ash-issue-reporter pre')).toContainText('0.1.0-test');
	await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
	await page.getByRole('button', { name: 'Submit to GitHub' }).click();
	await expect(page.getByRole('link', { name: 'Open issue #8' })).toBeVisible();
});

test('a delayed signed-out snapshot cannot overwrite the completed GitHub login', async ({ page }) => {
	await page.goto('/issueReporter.html?holdAccountRead'); await page.evaluate(() => window.ashIssueReporterIntegration.open());
	await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
	await expect(page.getByText('Submitting as Test account')).toBeVisible();
	await page.evaluate(() => window.ashIssueReporterIntegration.releaseAccountRead());
	await expect(page.getByText('Submitting as Test account')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign in to GitHub', exact: true })).toBeHidden();
});

test('the displayed sender follows the primary GitHub grant rather than the generic account ordering', async ({ page }) => {
	await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
	await page.evaluate(() => window.ashIssueReporterIntegration.setAccounts([{ id: '99', host: 'github.com', login: 'Another cloud account', status: 'ready', credentialRevision: '1' }, { id: '42', host: 'github.com', login: 'Test account', status: 'ready', credentialRevision: '1' }]));
	await expect(page.getByText('Submitting as Another cloud account', { exact: true })).toBeVisible();
	await page.evaluate(() => window.ashIssueReporterIntegration.setAccounts([{ id: 'ghe.example/42', host: 'ghe.example', login: 'Enterprise user', status: 'ready', credentialRevision: '1' }]));
	await expect(page.getByRole('button', { name: 'Sign in to GitHub', exact: true })).toBeVisible();
	await expect(page.getByText('Submitting as Enterprise user', { exact: true })).toHaveCount(0);
});
