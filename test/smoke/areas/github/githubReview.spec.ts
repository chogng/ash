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
