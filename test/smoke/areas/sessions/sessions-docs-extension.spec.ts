import { join } from 'node:path';
import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';
import { expect, test as base } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

const distribution = process.env.ASH_ACADEMY_DISTRIBUTION;
const trustedRoot = process.env.ASH_ACADEMY_TRUSTED_ROOT;
const test = base.extend({
	backendFixture: async ({ testWorkspace }, use) => {
		if (!distribution || !trustedRoot)
			throw new Error('Provide a signed Academy editor distribution and its trusted root.');
		const registry = await SignedExtensionRegistry.createEditor(
			join(testWorkspace.directory, 'docs-registry'),
			distribution,
			trustedRoot,
			'ash.academy@ash',
		);
		try {
			await use(registry);
		} finally {
			await registry.close();
		}
	},
});
test.skip(
	!distribution || !trustedRoot,
	'Optional real editor package acceptance; supply ASH_ACADEMY_DISTRIBUTION and ASH_ACADEMY_TRUSTED_ROOT.',
);

test(
	'Artifacts recommends the optional Docs editor and switches real rich and Markdown copies',
	{ tag: ['@electron-app-server'] },
	async ({ target, workbench, backendFixture }, testInfo) => {
		const registry = backendFixture as SignedExtensionRegistry;
		const page = await workbench.openAgentsWindow(target.kind);
		const quick = new QuickAccess(page);
		const artifacts = page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Artifacts', exact: true });
		await artifacts.click();
		await page.locator('.ash-creator-home').getByRole('button', { name: 'Docs', exact: true }).click();
		const markdown = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
		await markdown.waitForEditorFocus();
		await markdown.waitForTypeInEditor('# Original Markdown draft');
		await quick.runCommand('notifications.showList');
		const notification = page.locator('.ash-notifications-row').filter({ hasText: /Recommended for Docs:/u });
		await expect(notification).toBeVisible({ timeout: 20_000 });
		await notification.getByRole('button', { name: 'Show recommendations', exact: true }).click();
		const extensions = page.locator('.ash-extensions-view-container');
		const row = extensions.locator(`[data-package-id="${registry.packageId}"]`);
		await row.getByRole('button', { name: 'Install', exact: true }).click();
		await page
			.getByRole('dialog', { name: 'Install', exact: true })
			.getByRole('button', { name: 'Install', exact: true })
			.click();
		await expect
			.poll(() => registry.installations())
			.toMatchObject([{ package: { id: registry.packageId }, state: 'installed' }]);
		const installation = (await registry.installations())[0];
		await quick.runCommand('ash.extensions.showInstalled');
		await extensions.locator(`[data-installation-id="${installation.installationId}"]`).click();
		const details = page.locator('.ash-extension-editor');
		const enable = details.getByRole('button', { name: 'Enable', exact: true });
		if (await enable.count()) await enable.click();
		await details.getByRole('button', { name: 'Authorize execution', exact: true }).click();
		await page
			.getByRole('dialog', { name: registry.packageId, exact: true })
			.getByRole('button', { name: 'Authorize execution', exact: true })
			.click();
		await expect(
			details.getByRole('button', { name: 'Revoke execution authorization', exact: true }),
		).toBeVisible();
		await page
			.locator('.ash-window-mode-control')
			.getByRole('button', { name: 'Chat / Agents', exact: true })
			.click();
		await artifacts.click();
		await page.locator('.ash-creator-home').getByRole('button', { name: 'Docs', exact: true }).click();
		const rich = page.locator('.stanza-structured-editor-pane:visible textarea.stanza-document-text-input').first();
		await expect(rich).toBeVisible({ timeout: 20_000 });
		await rich.fill('Rich Docs round trip');
		await quick.runCommand('sessions.creator.switchDocsEditor');
		await markdown.waitForEditorContents(text => text.includes('Rich Docs round trip'));
		await quick.runCommand('sessions.creator.switchDocsEditor');
		await expect(rich).toHaveValue('Rich Docs round trip');
		await page.screenshot({ path: testInfo.outputPath('docs-rich-round-trip.png') });
		await artifacts.click();
		await expect(page.locator('.ash-artifacts-card.docs')).toHaveCount(4);
	},
);
