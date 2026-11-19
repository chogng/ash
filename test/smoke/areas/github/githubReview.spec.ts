import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import type { Page } from '@playwright/test';
import { Menus } from '../../../automation/menus.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { readUserSettings } from '../../../automation/settings.js';

async function accountActions(page: Page, application: PlaywrightApplication): Promise<void> {
	const owner = page.locator('.ash-github-editor').getByRole('textbox', { name: 'Owner', exact: true }); await owner.focus();
	await page.keyboard.press('Alt+F1'); await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true })).toBeVisible();
	await page.keyboard.press('Escape'); await expect(owner).toBeFocused();
	await page.getByRole('combobox', { name: 'Resource type', exact: true }).click();
	await page.getByRole('option', { name: 'Notifications', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Owner', exact: true })).toBeHidden();
	await expect(page.getByRole('combobox', { name: 'Notification filter', exact: true })).toBeVisible();
	const trigger = () => page.getByRole('toolbar', { name: 'Repository actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
	await new Menus(page).select(application, trigger, ['Sign in to GitHub Enterprise']);
	await expect(page.getByRole('dialog').getByPlaceholder('GitHub host')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('Workbench and Sessions open the shared GitHub editor and restore focus after help', async ({ workbench, target, application }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.github.open');
	const editor = page.locator('.ash-github-editor'); await expect(editor).toBeVisible();
	await accountActions(page, application);
	await page.getByRole('button', { name: 'Close GitHub Pull Requests and Issues', exact: true }).click(); await expect(editor).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.github.open'); await expect(editor).toBeVisible();
	const sessions = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(sessions).runCommand('workbench.action.github.open');
	await expect(sessions.locator('.ash-github-editor')).toBeVisible();
	await accountActions(sessions, application);
});


test('Sessions GitHub repository browser prompts for a ref and supports cancellation and reopening', async ({ workbench, target }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('sessions.github.browseRepositoryFiles');
	const repository = page.getByPlaceholder('owner/name or https://github.com/owner/name', { exact: true });
	await expect(repository).toBeVisible();
	await repository.fill('team/repo');
	await repository.press('Enter');
	const reference = page.getByRole('dialog').getByRole('textbox');
	await expect(reference).toHaveValue('HEAD');
	await reference.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await new QuickAccess(page).runCommand('sessions.github.browseRepositoryFiles');
	await expect(repository).toBeVisible();
	await repository.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
});


test('GitHub settings share the Preferences renderer in Workbench and Sessions and restore help focus', async ({ workbench, target }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('extensions');
	await workbench.settingsEditor.selectCategory('github');
	const section = page.locator('.ash-settings-section');
	const connector = section.getByRole('button', { name: 'Manage official Connector', exact: true });
	await expect(connector).toBeVisible();
	await expect(section.getByRole('button', { name: 'Browse pull requests', exact: true })).toBeDisabled();
	await connector.focus(); await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/official Connector authorization are separate/);
	await page.keyboard.press('Escape'); await expect(connector).toBeFocused();
	const style = workbench.settingsEditor.element.getByRole('combobox', { name: 'Review comment style', exact: true });
	await expect(style).toContainText('Inline');
	await style.click();
	await page.getByRole('option', { name: 'Floating', exact: true }).click();
	await expect(style).toContainText('Floating');
	await expect.poll(async () => (await readUserSettings(page)).content).toMatch(/"comments\.thread\.experimental\.style"\s*:\s*"floating"/);
	await style.click();
	await page.getByRole('option', { name: 'Inline', exact: true }).click();
	await expect(style).toContainText('Inline');
	await page.keyboard.press('Escape');
	await expect(workbench.settingsEditor.element).toBeHidden();
	const sessionsPage = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(sessionsPage).runCommand('workbench.action.openSettings');
	const settings = sessionsPage.getByRole('dialog', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Git & PRs', exact: true }).click();
	const sessionsSection = settings.locator('.ash-settings-section');
	const automaticReviews = sessionsSection.getByRole('button', { name: 'Manage automatic reviews', exact: true });
	await expect(automaticReviews).toBeVisible();
	await automaticReviews.focus(); await sessionsPage.keyboard.press('Alt+F1');
	await expect(sessionsPage.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/Request Codex PR cloud review posts @codex review/);
	await sessionsPage.keyboard.press('Escape'); await expect(automaticReviews).toBeFocused();
});

test('Sessions Git and PRs settings switch review comment placement', async ({ workbench, target }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Git & PRs', exact: true }).click();
	const style = settings.getByRole('combobox', { name: 'Review comment style', exact: true });
	await expect(style).toContainText('Inline');
	await style.click();
	await settings.getByRole('option', { name: 'Floating', exact: true }).click();
	await expect(style).toContainText('Floating');
	await expect.poll(async () => (await readUserSettings(workbench.page)).content).toMatch(/"comments\.thread\.experimental\.style"\s*:\s*"floating"/);
});

test('IDE Settings switches GitHub PR review comments inline and floating', { tag: ['@browser-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	const head = 'a'.repeat(40);
	const base = 'b'.repeat(40);
	const pullRequest = {
		number: 7, title: 'Review comment placement', body: '', url: 'https://github.com/fixture/review/pull/7',
		state: 'open', draft: false, mergedAt: null, headCommit: head, headBranch: 'feature',
		headRepository: 'fixture/review', baseBranch: 'main', mergeable: null, autoMerge: false,
	};
	const file = { filename: 'review.ts', previousFilename: null, status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1,2 +1,2 @@\n-old\n+new\n unchanged' };
	const replies = new Map<string, unknown>([
		['github/account/list', { accounts: [{ id: 'review-account', host: 'github.com', login: 'Reviewer', status: 'ready', credentialRevision: '1' }] }],
		['github/repository/read', { fullName: 'fixture/review', defaultBranch: 'main', allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false, allowAutoMerge: false }],
		['github/pullRequest/list', { pullRequests: [pullRequest], nextPage: null }],
		['github/pullRequest/read', pullRequest],
		['github/pullRequest/diff', { baseCommit: base, files: { files: [file], nextPage: null, limitReached: false } }],
		['github/pullRequest/threads', { threads: [], nextCursor: null }],
		['github/pullRequest/reviews', { reviews: [], nextPage: null }],
		['github/pullRequest/reviewers', { users: [], teams: [] }],
		['github/checks', { state: 'success', statuses: [], checks: [], nextPage: null }],
		['github/comment/list', { comments: [], nextPage: null }],
	]);
	await page.routeWebSocket(url => url.pathname === '/ash/app-server', socket => {
		const server = socket.connectToServer();
		socket.onMessage(frame => {
			const request = JSON.parse(frame.toString()) as { id?: number; method: string; params?: { commit?: string; }; };
			if (request.id !== undefined && request.method === 'github/file/read') {
				const text = request.params?.commit === head ? 'new\nunchanged\n' : 'old\nunchanged\n';
				socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'text', text } }));
			} else if (request.id !== undefined && replies.has(request.method)) {
				socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: replies.get(request.method) }));
			} else {
				server.send(frame);
			}
		});
	});
	await workbench.reloadWindow();
	await workbench.waitForReady();
	await workbench.quickaccess.runCommand('workbench.action.github.open');
	const github = page.locator('.ash-github-editor');
	await github.getByRole('textbox', { name: 'Owner', exact: true }).fill('fixture');
	await github.getByRole('textbox', { name: 'Repository', exact: true }).fill('review');
	await github.getByRole('button', { name: 'Load repository', exact: true }).click();
	await github.getByRole('button', { name: '#7 Review comment placement', exact: true }).click();
	const openComment = github.getByRole('button', { name: 'Write comment on selected line', exact: true });
	const inline = github.getByRole('region', { name: 'Comments on line 1', exact: true });
	const floating = github.getByRole('dialog', { name: 'Comments on line 1', exact: true });
	const textbox = { name: 'Comment on selected line', exact: true };
	await openComment.click();
	await inline.getByRole('textbox', textbox).fill('Keep the PR draft');

	const chooseStyle = async (label: 'Inline' | 'Floating') => {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('extensions');
		await workbench.settingsEditor.selectCategory('github');
		const settings = workbench.settingsEditor.element;
		const style = settings.getByRole('combobox', { name: 'Review comment style', exact: true });
		await style.click();
		await page.getByRole('option', { name: label, exact: true }).click();
		await expect(style).toContainText(label);
		await settings.getByRole('toolbar', { name: 'Close Ash Settings' }).getByRole('button', { name: 'Close', exact: true }).click();
		await expect(settings).toBeHidden();
	};
	await chooseStyle('Floating');
	await openComment.click();
	await expect(floating.getByRole('textbox', textbox)).toHaveValue('Keep the PR draft');
	await expect(inline).toHaveCount(0);
	await chooseStyle('Inline');
	await openComment.click();
	await expect(inline.getByRole('textbox', textbox)).toHaveValue('Keep the PR draft');
	await expect(floating).toHaveCount(0);
});

test('Session Issue associations persist through reopen and expose keyboard actions and accessible state', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, target, application, webAppServer, testWorkspace }) => {
	// Keep the fixture transport alive while the product's Web page navigates and reloads.
	const source = webAppServer ? await workbench.page.context().newPage() : workbench.page;
	if (webAppServer) { await source.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' }); }
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, source);
	try {
		const created = await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'issue-session', kind: 'code', title: 'Issue associations', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		for (const number of [11, 12, 11]) {
			await connection.client.request(APP_SERVER_METHODS['github/session/issue/attach'], { sessionId, reference: { repository: { host: 'github.com', owner: 'ash-fixture', name: 'issues' }, number } });
		}
		let page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Issue associations' }).click();
		let summary = page.locator('.ash-session-chat-input-issue-summary');
		await expect(summary).toHaveAccessibleName('2 issues · 0 open · 0 closed · 2 unavailable');
		await summary.focus(); await page.keyboard.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('textbox')).toHaveValue(/Use Attach issue/);
		await page.keyboard.press('Escape'); await expect(summary).toBeFocused();
		await page.keyboard.press('Alt+F2');
		await expect(page.getByRole('dialog', { name: 'Accessible View' }).getByRole('textbox')).toHaveValue(/ash-fixture\/issues #11 · Status unavailable/);
		await page.keyboard.press('Escape'); await expect(summary).toBeFocused();
		page = await workbench.reopenAgentsWindow(application, page);
		summary = page.locator('.ash-session-chat-input-issue-summary');
		await expect(summary).toHaveAccessibleName('2 issues · 0 open · 0 closed · 2 unavailable');
		await summary.focus(); await page.keyboard.press('Enter');
		const remove = page.getByRole('button', { name: 'Remove attached issue github.com/ash-fixture/issues #11', exact: true });
		await remove.focus(); await page.keyboard.press('Enter');
		await expect(summary).toHaveAccessibleName('1 issues · 0 open · 0 closed · 1 unavailable');
		await expect(page.getByRole('button', { name: 'Attach issue', exact: true })).toBeFocused();
		const saved = await connection.client.request(APP_SERVER_METHODS['github/session/issues'], { sessionId });
		expect(saved.references.map(reference => reference.number)).toEqual([12]);
	} finally {
		await connection.close();
		if (webAppServer) { await source.close(); }
	}
});
