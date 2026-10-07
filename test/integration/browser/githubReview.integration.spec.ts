import { expect, test, type Page } from '@playwright/test';

async function load(page: Page): Promise<void> {
	page.on('pageerror', error => console.error(error.stack));
	await page.goto('/githubReview.html');
	await page.getByRole('textbox', { name: 'Owner', exact: true }).fill('team');
	await page.getByRole('textbox', { name: 'Repository', exact: true }).fill('repo');
	await page.getByRole('button', { name: 'Load repository', exact: true }).click();
	await expect(page.getByRole('button', { name: '#7 <img src=x onerror=alert(1)> Review change', exact: true })).toBeVisible();
}
async function openReview(page: Page): Promise<void> {
	await load(page); await page.getByRole('button', { name: '#7 <img src=x onerror=alert(1)> Review change', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Review summary', exact: true })).toBeEnabled();
	await expect(page.getByRole('textbox', { name: 'Modified file', exact: true })).toBeVisible();
}

test('PR review uses pinned renamed-file models, paginated checks and discussions, and confirms merge', async ({ page }) => {
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
	await openReview(page);
	await expect(page.locator('.github-metadata img')).toHaveCount(0);
	const title = page.locator('.github-list-item .ash-button-label').first();
	expect(await title.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	const original = page.getByRole('textbox', { name: 'Original file', exact: true });
	await original.focus(); await original.press('ControlOrMeta+Home');
	await page.getByRole('textbox', { name: 'Comment on selected line', exact: true }).fill('Keep this deletion explained');
	await page.getByRole('button', { name: 'Add line comment to review', exact: true }).click();
	await page.getByRole('textbox', { name: 'Review summary', exact: true }).fill('Reviewed the exact commit');
	await page.evaluate(() => { window.ashGitHubReview.close(); }); await page.evaluate(() => window.ashGitHubReview.open());
	await expect(page.getByRole('textbox', { name: 'Review summary', exact: true })).toHaveValue('Reviewed the exact commit');
	await expect(page.locator('.github-draft-comments')).toContainText('Keep this deletion explained');
	await page.getByRole('button', { name: 'Submit review', exact: true }).click();
	await expect(page.locator('.github-draft-comments')).toBeEmpty();
	const requests = await page.evaluate(() => window.ashGitHubReview.requests);
	const review = requests.find(request => request.method === 'github/pullRequest/review')!;
	expect(review.params.commit).toBe('a'.repeat(40)); expect(review.params.comments).toEqual([{ path: 'new.rs', line: 1, side: 'LEFT', body: 'Keep this deletion explained' }]);
	expect(requests.filter(request => request.method === 'github/file/read').map(request => [request.params.commit, request.params.path])).toContainEqual(['b'.repeat(40), 'old.rs']);
	await page.getByRole('button', { name: 'Load more checks', exact: true }).click(); await expect(page.locator('.github-checks')).toContainText('integration tests: success');
	await page.getByRole('button', { name: 'Load more replies', exact: true }).click(); await expect(page.locator('.github-discussions')).toContainText('More discussion');
	await page.getByRole('textbox', { name: 'Reply to discussion', exact: true }).fill('Explanation here'); await page.getByRole('button', { name: 'Send reply', exact: true }).click();
	await expect(page.locator('.github-discussions')).toContainText('Explanation here'); await expect(page.getByRole('textbox', { name: 'Reply to discussion', exact: true })).toHaveValue('');
	await page.getByRole('button', { name: 'Resolve discussion', exact: true }).click(); await expect(page.getByRole('button', { name: 'Reopen discussion', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Load more discussions', exact: true }).click();
	await page.getByRole('button', { name: 'Load more files', exact: true }).click();
	await page.getByRole('combobox', { name: 'Changed files', exact: true }).click(); await page.getByRole('option', { name: /binary.bin/ }).click();
	await expect(page.locator('.github-review')).toContainText('Binary file. View it on GitHub.');
	await expect(page.getByRole('button', { name: 'Add line comment to review', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Merge pull request', exact: true }).click();
	const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('a'.repeat(40)); await dialog.getByRole('button', { name: 'Merge pull request', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Merge pull request', exact: true })).toBeDisabled();
	expect(await page.evaluate(() => window.ashGitHubReview.requests.find(request => request.method === 'github/pullRequest/merge')!.params)).toMatchObject({ commit: 'a'.repeat(40), method: 'squash' });
	expect(errors).toEqual([]);
});

test('a merge confirmation cannot authorize a write after the GitHub account changes', async ({ page }) => {
	await openReview(page); await page.getByRole('button', { name: 'Merge pull request', exact: true }).click();
	const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('a'.repeat(40));
	await page.evaluate(() => window.ashGitHubReview.replaceAccount());
	await dialog.getByRole('button', { name: 'Merge pull request', exact: true }).click();
	await expect(page.locator('.github-status')).toContainText('Refresh the PR');
	expect(await page.evaluate(() => window.ashGitHubReview.requests.filter(request => request.method === 'github/pullRequest/merge'))).toEqual([]);
});

test('a changed head preserves the draft and an uncertain review cannot be repeated', async ({ page }) => {
	await openReview(page); await page.getByRole('textbox', { name: 'Review summary', exact: true }).fill('Old draft');
	await page.evaluate(() => window.ashGitHubReview.changeHead()); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.locator('.github-status')).toContainText('draft belongs to an earlier commit'); await expect(page.getByRole('button', { name: 'Submit review', exact: true })).toBeDisabled();
	await expect(page.getByRole('textbox', { name: 'Review summary', exact: true })).toHaveValue('Old draft');
	await page.getByRole('toolbar', { name: 'Review actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Discard review draft', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
	await page.getByRole('textbox', { name: 'Review summary', exact: true }).fill('New draft'); await page.evaluate(() => window.ashGitHubReview.fail());
	await page.getByRole('button', { name: 'Submit review', exact: true }).click(); await expect(page.locator('.github-status')).toContainText('may have accepted');
	await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Submit review', exact: true })).toBeDisabled();
	expect(await page.evaluate(() => window.ashGitHubReview.requests.filter(request => request.method === 'github/pullRequest/review').length)).toBe(1);
});

test('account changes cancel pending protocol reads and clear private content', async ({ page }) => {
	await openReview(page); await page.getByRole('textbox', { name: 'Review summary', exact: true }).fill('Private review draft');
	await page.evaluate(() => window.ashGitHubReview.hold('github/checks')); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.locator('.github-status')).toContainText('Loading GitHub'); await page.evaluate(() => window.ashGitHubReview.replaceAccount());
	await expect(page.locator('.github-metadata')).not.toContainText('PR description'); await expect(page.locator('.github-diff')).toBeEmpty();
	await page.evaluate(() => window.ashGitHubReview.release());
	await expect(page.locator('[data-github-focus="reviewSummary"]')).toHaveValue('');
	await expect(page.locator('.github-review')).toBeHidden();
	expect(await page.evaluate(() => window.ashGitHubReview.requests.some(request => request.method === 'github/cancel'))).toBe(true);
});

test('issues support create, labels, assignees, edits and comments through the protocol', async ({ page }) => {
	await load(page);
	await page.getByRole('combobox', { name: 'Resource type', exact: true }).click(); await page.getByRole('option', { name: 'Issues', exact: true }).click(); await page.getByRole('button', { name: 'Load repository', exact: true }).click();
	await page.getByRole('button', { name: '#9 Fix issue', exact: true }).click(); await expect(page.locator('.github-metadata')).toContainText('Issue description');
	await page.getByRole('textbox', { name: 'Issue comment', exact: true }).fill('Reproduction steps'); await page.getByRole('button', { name: 'Send comment', exact: true }).click(); await expect(page.locator('.github-issue-comments')).toContainText('Reproduction steps');
	await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Updated issue'); await page.getByRole('textbox', { name: 'Labels, separated by commas', exact: true }).fill('bug, urgent'); await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.locator('.github-metadata')).toContainText('Updated issue');
	await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByRole('textbox', { name: 'Title', exact: true }).fill('New issue'); await page.getByRole('textbox', { name: 'Description', exact: true }).fill('New description'); await page.getByRole('textbox', { name: 'Assignees, separated by commas', exact: true }).fill('alice'); await page.getByRole('button', { name: 'Save', exact: true }).click();
	const requests = await page.evaluate(() => window.ashGitHubReview.requests);
	expect(requests.find(request => request.method === 'github/issue/update')!.params).toMatchObject({ title: 'Updated issue', labels: ['bug', 'urgent'] });
	expect(requests.find(request => request.method === 'github/issue/create')!.params).toMatchObject({ title: 'New issue', assignees: ['alice'] });
});

test('PR creation uses the repository branch and preserves fork source and draft intent', async ({ page }) => {
	await load(page);
	await page.getByRole('button', { name: 'Load more', exact: true }).click(); await expect(page.getByRole('button', { name: '#8 Another pull request', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Target branch', exact: true })).toHaveValue('main');
	await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Review fork change');
	await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Pull request body');
	await page.getByRole('textbox', { name: 'Source branch (owner:branch for a fork)', exact: true }).fill('contributor:feature');
	await page.getByRole('checkbox', { name: 'Draft pull request', exact: true }).check();
	await page.evaluate(() => window.ashGitHubReview.close()); await page.evaluate(() => window.ashGitHubReview.open());
	await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Review fork change');
	await expect(page.getByRole('checkbox', { name: 'Draft pull request', exact: true })).toBeChecked();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: '#10 Review fork change', exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.ashGitHubReview.requests.find(request => request.method === 'github/pullRequest/create')!.params)).toMatchObject({ head: 'contributor:feature', base: 'main', draft: true });
});

test('editing retains its original PR target when selection changes before saving', async ({ page }) => {
	await openReview(page); await page.getByRole('button', { name: 'Load more', exact: true }).click();
	await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Edit PR seven');
	await page.getByRole('button', { name: '#8 Another pull request', exact: true }).click(); await expect(page.locator('.github-metadata')).toContainText('#8');
	await expect(page.locator('.github-form')).toContainText('Editing #7'); await page.getByRole('button', { name: 'Save', exact: true }).click();
	expect(await page.evaluate(() => window.ashGitHubReview.requests.find(request => request.method === 'github/pullRequest/update')!.params)).toMatchObject({ number: 7, title: 'Edit PR seven' });
	await expect(page.locator('.github-metadata')).toContainText('#8');
});

test('Chinese localization and high contrast keep review controls and accessible content usable', async ({ page }) => {
	await page.goto('/githubReview.html?zh'); await page.getByRole('textbox', { name: '所有者', exact: true }).fill('team'); await page.getByRole('textbox', { name: '仓库', exact: true }).fill('repo'); await page.getByRole('button', { name: '加载仓库', exact: true }).click();
	await page.getByRole('button', { name: '#7 <img src=x onerror=alert(1)> Review change', exact: true }).click();
	const summary = page.getByRole('textbox', { name: '评审摘要', exact: true }); await expect(summary).toBeEnabled(); await summary.focus();
	await page.evaluate(() => window.ashGitHubReview.theme('highContrast')); await expect(summary).toBeFocused(); expect(await summary.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
	expect(await page.evaluate(() => window.ashGitHubReview.accessibleContent('view' as import('../../../src/ash/platform/accessibility/browser/accessibleView.js').AccessibleViewType))).toContain('Please explain');
	expect(await page.evaluate(() => window.ashGitHubReview.accessibleContent('help' as import('../../../src/ash/platform/accessibility/browser/accessibleView.js').AccessibleViewType))).toContain('草稿仍保留');
});

test('account selection binds Enterprise requests and clears the previous account draft', async ({ page }) => {
	await openReview(page); await page.getByRole('textbox', { name: 'Review summary', exact: true }).fill('Private cloud draft');
	await page.getByRole('combobox', { name: 'GitHub account', exact: true }).click(); await page.getByRole('option', { name: 'EnterpriseAlice@ghe.example', exact: true }).click();
	await expect(page.locator('.github-review')).toBeHidden();
	await page.getByRole('button', { name: 'Load repository', exact: true }).click();
	await page.getByRole('button', { name: '#7 <img src=x onerror=alert(1)> Review change', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Review summary', exact: true })).toHaveValue('');
	const requests = await page.evaluate(() => window.ashGitHubReview.requests.filter(request => request.method === 'github/repository/read'));
	expect(requests.map(request => [request.params.accountId, request.params.repository])).toEqual([
		['alice', { host: 'github.com', owner: 'team', name: 'repo' }], ['ghe.example/42', { host: 'ghe.example', owner: 'team', name: 'repo' }],
	]);
});

test('reviewers and the current user review comments support changes through the protocol', async ({ page }) => {
	await openReview(page);
	await page.getByRole('button', { name: 'Request reviewers', exact: true }).click();
	await page.getByPlaceholder('User logins, separated by commas', { exact: true }).fill('bob');
	await page.getByPlaceholder('Team slugs, separated by commas', { exact: true }).fill('core');
	await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.locator('.github-review')).toContainText('reviewer, bob, @core');
	await page.getByRole('button', { name: 'Remove reviewers', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.locator('.github-review')).not.toContainText('reviewer, bob, @core');
	await page.getByRole('button', { name: 'Edit review comment', exact: true }).click();
	await page.getByRole('dialog').getByRole('textbox').fill('Updated explanation');
	await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.locator('.github-discussions')).toContainText('Updated explanation');
	await page.getByRole('button', { name: 'Delete review comment', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
	await expect(page.locator('.github-discussions')).not.toContainText('Updated explanation');
	const requests = await page.evaluate(() => window.ashGitHubReview.requests);
	expect(requests.find(request => request.method === 'github/pullRequest/reviewers/change')!.params).toMatchObject({ accountId: 'alice', number: 7, change: 'request', users: ['bob'], teams: ['core'] });
	expect(requests.find(request => request.method === 'github/pullRequest/comment/update')!.params).toMatchObject({ accountId: 'alice', number: 7, commentId: 'comment-1', body: 'Updated explanation' });
	expect(requests.find(request => request.method === 'github/pullRequest/comment/delete')!.params).toMatchObject({ accountId: 'alice', number: 7, commentId: 'comment-1' });
});

async function chooseLocal(page: Page, name: string, remote = 'origin'): Promise<void> {
	await page.getByRole('button', { name, exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Local repo — /workspace', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: remote, exact: true }).click();
}

test('local checkout and push capture the repository, reviewed commit and destination branch', async ({ page }) => {
	await openReview(page); await chooseLocal(page, 'Check out pull request');
	await page.getByRole('dialog').getByRole('button', { name: 'Check out pull request', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashGitHubReview.gitRequests.length)).toBe(1);
	await chooseLocal(page, 'Push local commits to pull request', 'fork');
	await expect(page.getByRole('dialog')).toContainText('d'.repeat(40));
	await page.getByRole('dialog').getByRole('button', { name: 'Push local commits to pull request', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashGitHubReview.gitRequests.length)).toBe(2);
	expect(await page.evaluate(() => window.ashGitHubReview.gitRequests.map(request => request.params))).toEqual([
		{ repositoryId: 'local-repo', command: { kind: 'fetchAndCheckout', remote: 'origin', remoteIdentity: 'github.com/team/repo', reference: 'refs/pull/7/head', objectId: 'a'.repeat(40), name: 'pr/7' } },
		{ repositoryId: 'local-repo', command: { kind: 'pushBranch', remote: 'fork', remoteIdentity: 'github.com/contributor/fork', branch: 'pr/7', name: 'feature', expectedHead: 'd'.repeat(40) } },
	]);
});

test('local checkout rejects unsaved working copies and dialogs cannot target another account', async ({ page }) => {
	await openReview(page); await page.evaluate(() => window.ashGitHubReview.dirty());
	await chooseLocal(page, 'Check out pull request'); await page.getByRole('dialog').getByRole('button', { name: 'Check out pull request', exact: true }).click();
	await expect(page.getByRole('dialog')).toContainText('Save or close unsaved files'); await page.keyboard.press('Escape');
	expect(await page.evaluate(() => window.ashGitHubReview.gitRequests)).toEqual([]);
	await page.getByRole('button', { name: 'Edit review comment', exact: true }).click();
	await page.evaluate(() => window.ashGitHubReview.replaceAccount());
	await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
	expect(await page.evaluate(() => window.ashGitHubReview.requests.filter(request => request.method === 'github/pullRequest/comment/update'))).toEqual([]);
});

test('a token connection selects its host account and signing out keeps other accounts connected', async ({ page }) => {
	await page.goto('/githubReview.html');
	await page.getByRole('toolbar', { name: 'Repository actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Connect with token', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByPlaceholder('GitHub host', { exact: true }).fill('ghe.other.example');
	const token = dialog.getByPlaceholder('Personal access token', { exact: true }); await token.fill('fixture-only-token');
	await expect(token).toHaveAttribute('type', 'password');
	await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(page.getByRole('combobox', { name: 'GitHub account', exact: true })).toContainText('TokenUser@ghe.other.example');
	expect(await page.evaluate(() => window.ashGitHubReview.requests.find(request => request.method === 'github/account/connect')?.params)).toMatchObject({ host: 'ghe.other.example', token: 'fixture-only-token' });
	await page.getByRole('toolbar', { name: 'Repository actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sign out selected account', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashGitHubReview.loggedOut)).toEqual([{ provider: 'github', accountId: 'ghe.other.example/99' }]);
	await page.getByRole('combobox', { name: 'GitHub account', exact: true }).click();
	await expect(page.getByRole('option', { name: 'Alice@github.com', exact: true })).toBeVisible();
	await expect(page.getByRole('option', { name: 'EnterpriseAlice@ghe.example', exact: true })).toBeVisible();
});


test('notifications use the selected account, paginate, and mark individual and all threads read', async ({ page }) => {
	await page.goto('/githubReview.html');
	const mode = page.getByRole('combobox', { name: 'Resource type', exact: true });
	await mode.click(); await page.getByRole('option', { name: 'Notifications', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Owner', exact: true })).toBeHidden();
	await page.getByRole('button', { name: 'Load repository', exact: true }).click();
	await page.getByRole('button', { name: 'Unread · team/repo · Review requested', exact: true }).click();
	await page.getByRole('button', { name: 'Mark notification read', exact: true }).click();
	await expect(page.getByRole('button', { name: 'team/repo · Review requested', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Load more', exact: true }).click();
	await expect(page.getByRole('button', { name: 'team/repo · Issue mentioned', exact: true })).toBeVisible();
	await page.getByRole('toolbar', { name: 'List actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Mark all notifications read', exact: true }).click();
	await expect(page.locator('.github-metadata')).toContainText('accepted the request');
	expect(await page.evaluate(() => window.ashGitHubReview.requests.filter(request => request.method.startsWith('github/notifications/')).map(request => ({ method: request.method, accountId: request.params.accountId, page: request.params.page })))).toEqual([
		{ method: 'github/notifications/list', accountId: 'alice', page: 1 }, { method: 'github/notifications/read', accountId: 'alice', page: undefined }, { method: 'github/notifications/list', accountId: 'alice', page: 2 }, { method: 'github/notifications/readAll', accountId: 'alice', page: undefined }, { method: 'github/notifications/list', accountId: 'alice', page: 1 },
	]);
	const account = page.getByRole('combobox', { name: 'GitHub account', exact: true }); await account.click(); await page.getByRole('option', { name: 'EnterpriseAlice@ghe.example', exact: true }).click();
	await expect(page.locator('.github-list')).toBeEmpty();
	await page.getByRole('button', { name: 'Refresh notifications', exact: true }).click();
	expect(await page.evaluate(() => window.ashGitHubReview.requests.filter(request => request.method === 'github/notifications/list').at(-1)!.params.accountId)).toBe('ghe.example/42');
});

test('fork creation uses the selected account and displays asynchronous acceptance', async ({ page }) => {
	await openReview(page);
	await page.getByRole('toolbar', { name: 'Repository actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Create fork', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByPlaceholder('Organization (optional)').fill('my-team');
	await dialog.getByPlaceholder('Fork repository name').fill('my-fork');
	await dialog.getByRole('checkbox', { name: 'Copy only the default branch', exact: true }).check();
	await dialog.getByRole('button', { name: 'Create fork', exact: true }).click();
	await expect(page.locator('.github-metadata')).toContainText('Fork creation accepted: my-team/my-fork');
	await expect(page.getByRole('link', { name: 'Open fork on GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/my-team/my-fork');
	expect(await page.evaluate(() => window.ashGitHubReview.requests.find(request => request.method === 'github/repository/fork')!.params)).toMatchObject({ accountId: 'alice', repository: { host: 'github.com', owner: 'team', name: 'repo' }, organization: 'my-team', name: 'my-fork', branches: 'default' });
});

test('Enterprise sign-in passes the host to the shared browser authorization service', async ({ page }) => {
	await page.goto('/githubReview.html');
	await page.getByRole('toolbar', { name: 'Repository actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Sign in to GitHub Enterprise', exact: true }).click();
	const dialog = page.getByRole('dialog'); await dialog.getByPlaceholder('GitHub host').fill('GHE.EXAMPLE');
	await dialog.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
	expect(await page.evaluate(() => window.ashGitHubReview.browserHosts)).toEqual(['ghe.example']);
});

test('Chinese notification and fork controls use the localized catalog', async ({ page }) => {
	await page.goto('/githubReview.html?zh');
	await page.getByRole('combobox', { name: '资源类型', exact: true }).click(); await page.getByRole('option', { name: '通知', exact: true }).click();
	await page.getByRole('button', { name: '加载仓库', exact: true }).click();
	await expect(page.getByRole('button', { name: '未读 · team/repo · Review requested', exact: true })).toBeVisible();
	await expect(page.locator('.github-status')).toContainText('经典令牌');
	await page.getByRole('toolbar', { name: '仓库操作', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click(); await expect(page.getByRole('menuitem', { name: '登录 GitHub Enterprise', exact: true })).toBeVisible();
});

test('Codex review requests and resulting PR comments use the GitHub protocol', async ({ page }) => {
	await openReview(page);
	await expect(page.locator('.github-pr-comment')).toContainText('Codex Review Summary');
	await page.getByRole('button', { name: 'Request Codex review', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Request Codex review', exact: true })).toBeDisabled();
	await expect(page.locator('.github-review')).toContainText('Posted @codex review');
	const comments = await page.evaluate(() => window.ashGitHubReview.requests.filter(request => request.method === 'github/comment/create'));
	expect(comments.map(request => request.params)).toEqual([expect.objectContaining({ number: 7, body: '@codex review', accountId: 'alice', repository: { host: 'github.com', owner: 'team', name: 'repo' } })]);
	await page.getByRole('button', { name: 'Load more PR comments', exact: true }).click();
	await expect(page.locator('.github-discussions')).toContainText('Follow-up review result');
	await page.getByRole('button', { name: 'Codex review settings', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Manage official Connector', exact: true })).toBeVisible();
});

test('Preferences renders GitHub settings data, verifies repository access and leaves official authorization unconfirmed', async ({ page }) => {
	await page.goto('/githubReview.html?settings');
	await expect(page.locator('.ash-settings-section')).toContainText('Existing Codex login available');
	await page.getByRole('textbox', { name: 'Repository (owner/name)', exact: true }).fill('team/repo');
	await page.getByRole('button', { name: 'Check repository access', exact: true }).click();
	await expect(page.locator('.ash-settings-section')).toContainText('Ash can access team/repo');
	await expect(page.locator('.ash-settings-section')).toContainText('automatic reviews are unconfirmed');
	await expect(page.getByRole('button', { name: 'Browse pull requests', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Manage official Connector', exact: true }).click();
	await page.getByRole('button', { name: 'Manage automatic reviews', exact: true }).click();
	expect(await page.evaluate(() => window.ashGitHubReview.external)).toEqual(['https://github.com/apps/chatgpt-codex-connector', 'https://app.chatgpt.com/settings/code-review']);
	await page.getByRole('button', { name: 'Browse pull requests', exact: true }).click();
	await expect(page.getByRole('button', { name: '#7 <img src=x onerror=alert(1)> Review change', exact: true })).toBeVisible();
});

test('account changes cancel pending repository checks and retire their results', async ({ page }) => {
	await page.goto('/githubReview.html?settings');
	await expect(page.getByRole('button', { name: 'Check repository access', exact: true })).toBeEnabled();
	await page.getByRole('textbox', { name: 'Repository (owner/name)', exact: true }).fill('team/repo');
	await page.evaluate(() => window.ashGitHubReview.hold('github/repository/read'));
	await page.getByRole('button', { name: 'Check repository access', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Refresh accounts', exact: true })).toBeDisabled();
	await page.evaluate(() => window.ashGitHubReview.replaceAccount());
	await page.evaluate(() => window.ashGitHubReview.release());
	await expect(page.getByRole('button', { name: 'Browse pull requests', exact: true })).toBeDisabled();
	await expect(page.locator('.ash-settings-section')).not.toContainText('Ash can access');
});

test('Chinese GitHub settings and PR review actions are translated', async ({ page }) => {
	await page.goto('/githubReview.html?settings&zh');
	await expect(page.getByRole('button', { name: '管理自动审查', exact: true })).toBeVisible();
	await expect(page.getByRole('textbox', { name: '仓库（所有者/名称）', exact: true })).toBeVisible();
	await expect(page.locator('.ash-settings-section')).toContainText('已有 Codex 登录可用于模型访问');
});
