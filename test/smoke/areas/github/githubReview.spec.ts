import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import type { Page } from '@playwright/test';
import { Menus } from '../../../automation/menus.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

async function accountActions(page: Page, application: PlaywrightApplication): Promise<void> {
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

test('GitHub editor opens from the product command palette and restores keyboard focus after help', async ({ workbench, application }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.github.open');
	const editor = page.locator('.ash-github-editor'); await expect(editor).toBeVisible();
	const owner = editor.getByRole('textbox', { name: 'Owner', exact: true }); await owner.focus();
	await page.keyboard.press('Alt+F1'); await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true })).toBeVisible();
	await page.keyboard.press('Escape'); await expect(owner).toBeFocused();
	await accountActions(page, application);
	await page.getByRole('button', { name: 'Close GitHub Pull Requests and Issues', exact: true }).click(); await expect(editor).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.github.open'); await expect(editor).toBeVisible();
});

test('Sessions opens the shared GitHub editor and its accessibility help', async ({ workbench, target, application }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.github.open');
	const editor = page.locator('.ash-github-editor'); await expect(editor).toBeVisible();
	const owner = editor.getByRole('textbox', { name: 'Owner', exact: true }); await owner.focus();
	await page.keyboard.press('Alt+F1'); await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true })).toBeVisible();
	await page.keyboard.press('Escape'); await expect(owner).toBeFocused();
	await accountActions(page, application);
});

test('GitHub settings share the Preferences renderer in Workbench and Sessions and restore help focus', async ({ workbench, target, application }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('github');
	const section = page.locator('.ash-settings-section');
	await expect(section).toContainText('Confirm official Connector authorization');
	const refresh = section.getByRole('button', { name: 'Refresh accounts', exact: true });
	await expect(refresh).toBeEnabled();
	await expect(section.getByRole('button', { name: 'Browse pull requests', exact: true })).toBeDisabled();
	await refresh.focus(); await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/official Connector authorization are separate/);
	await page.keyboard.press('Escape'); await expect(refresh).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(workbench.settingsEditor.element).toBeHidden();
	const sessionsPage = await workbench.openAgentsWindow(target.kind);
	await new Menus(sessionsPage).select(application, () => sessionsPage.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last().click(), ['Settings']);
	const settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings', exact: true });
	await settings.getByRole('button', { name: 'Git & PRs', exact: true }).click();
	const sessionsSection = settings.locator('.ash-settings-section');
	await expect(sessionsSection.getByRole('button', { name: 'Manage automatic reviews', exact: true })).toBeVisible();
	const sessionsRefresh = sessionsSection.getByRole('button', { name: 'Refresh accounts', exact: true });
	await expect(sessionsRefresh).toBeEnabled();
	await sessionsRefresh.focus(); await sessionsPage.keyboard.press('Alt+F1');
	await expect(sessionsPage.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/Request Codex review posts @codex review/);
	await sessionsPage.keyboard.press('Escape'); await expect(sessionsRefresh).toBeFocused();
});

test('Session Issue associations persist through reopen and expose keyboard actions and accessible state', async ({ workbench, target, application, webAppServer, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the real profile App Server.');
	// Keep the fixture transport alive while the product's Web page navigates and reloads.
	const source = webAppServer ? await workbench.page.context().newPage() : workbench.page;
	if (webAppServer) { await source.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' }); }
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, source);
	try {
		const created = await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'issue-session', title: 'Issue associations', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		for (const number of [11, 12, 11]) {
			await connection.client.request(APP_SERVER_METHODS['github/session/issue/attach'], { sessionId, reference: { repository: { host: 'github.com', owner: 'ash-fixture', name: 'issues' }, number } });
		}
		let page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
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
