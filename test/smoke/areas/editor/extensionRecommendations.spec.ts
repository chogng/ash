import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';
import { expect, test as base } from '../../../automation/test.js';

const distribution = process.env.ASH_RECOMMENDATIONS_DISTRIBUTION;
const trustedRoot = process.env.ASH_RECOMMENDATIONS_TRUSTED_ROOT;
const test = base.extend<{ recommendationScenario: 'file' | 'language' | 'workspace' }>({
	recommendationScenario: ['file', { option: true }],
	useDefaultLanguageServer: false,
	backendFixture: async ({ testWorkspace, recommendationScenario }, use) => {
		if (!distribution || !trustedRoot) {
			throw new Error(
				'Provide a signed distribution containing ash.fixture-language@ash for Python, Rust and .fixture-yaml.',
			);
		}
		if (recommendationScenario !== 'workspace') {
			await rm(join(testWorkspace.directory, 'Cargo.toml'));
		}
		await writeFile(join(testWorkspace.directory, 'settings.fixture-yaml'), 'value: true\n');
		await mkdir(join(testWorkspace.directory, '.ash'));
		await writeFile(
			join(testWorkspace.directory, '.ash/extensions.json'),
			JSON.stringify({ recommendations: [], unwantedRecommendations: ['ash.academy@ash'] }),
		);
		const registry = await SignedExtensionRegistry.createEditor(
			join(testWorkspace.directory, 'recommendations-registry'),
			distribution,
			trustedRoot,
			'ash.fixture-language@ash',
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
	'Optional real catalog acceptance; supply ASH_RECOMMENDATIONS_DISTRIBUTION and ASH_RECOMMENDATIONS_TRUSTED_ROOT.',
);

test(
	'Opening an unregistered file type discovers language metadata and opens the shared marketplace',
	{ tag: ['@electron-app-server'] },
	async ({ workbench, backendFixture }, testInfo) => {
		const page = workbench.page;
		await page
			.locator('.ash-explorer')
			.getByRole('treeitem', { name: 'settings.fixture-yaml', exact: true })
			.dblclick();
		await workbench.editors.groupAt(0).editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('notifications.showList');
		const notification = page
			.locator('.ash-notifications-row')
			.filter({ hasText: 'Recommended for .fixture-yaml: Fixture Language Support' });
		await expect(notification).toBeVisible();
		await notification.getByRole('button', { name: 'Show recommendations', exact: true }).click();
		await expect(
			page.locator(`[data-package-id="${(backendFixture as SignedExtensionRegistry).packageId}"]`),
		).toBeVisible();
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		const extensions = page.locator('.ash-extensions-view-container');
		await extensions.getByRole('searchbox').fill('@recommended');
		await extensions.getByRole('searchbox').press('Enter');
		const recent = extensions
			.locator('[data-view-id="ash.extensions.recommended"]')
			.getByRole('option')
			.filter({ hasText: 'Fixture Language Support' });
		await expect(recent).toContainText('Recommended because of recently opened files');
		await workbench.quickaccess.runCommand('ash.extensions.ignoreRecommendation');
		await workbench.quickaccess.search('ash.fixture-language@ash');
		await workbench.quickaccess.select('ash.fixture-language@ash');
		await expect(recent).toHaveCount(0);
		await workbench.quickaccess.runCommand('ash.extensions.undoIgnoreRecommendation');
		await workbench.quickaccess.search('ash.fixture-language');
		await workbench.quickaccess.select('ash.fixture-language');
		await expect(recent).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('file-recommendation.png') });
	},
);

test.describe('Language recommendations', () => {
	test.use({ recommendationScenario: 'language' });
	test(
		'Changing an untitled editor language triggers the common recommendation notification',
		{ tag: ['@electron-app-server'] },
		async ({ workbench }, testInfo) => {
			await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
			await workbench.editors.groupAt(0).editor.waitForEditorFocus();
			await workbench.quickaccess.runCommand('workbench.action.editor.changeLanguageMode');
			await workbench.quickaccess.search('Python');
			await workbench.quickaccess.select('Python');
			await workbench.quickaccess.runCommand('notifications.showList');
			const notification = workbench.page
				.locator('.ash-notifications-row')
				.filter({ hasText: 'Recommended for Python: Fixture Language Support' });
			await expect(notification).toBeVisible();
			await notification.getByRole('button', { name: 'Show recommendations', exact: true }).click();
			await expect(workbench.page.locator('[data-package-id="ash.fixture-language@ash"]')).toBeVisible();
			await workbench.page.screenshot({ path: testInfo.outputPath('language-recommendation.png') });
		},
	);
});

test.describe('Project recommendations', () => {
	test.use({ recommendationScenario: 'workspace' });
	test(
		'Project files recommend support and workspace exclusions remove the same suggestion',
		{ tag: ['@electron-app-server'] },
		async ({ workbench, testWorkspace }, testInfo) => {
			const page = workbench.page;
			await workbench.quickaccess.runCommand('notifications.showList');
			const notification = page
				.locator('.ash-notifications-row')
				.filter({ hasText: 'Recommended for this workspace: Fixture Language Support' });
			await expect(notification).toBeVisible();
			await writeFile(
				join(testWorkspace.directory, '.ash/extensions.json'),
				JSON.stringify({ unwantedRecommendations: ['ASH.FIXTURE-LANGUAGE'] }),
			);
			await expect(notification).toHaveCount(0);
			await workbench.quickaccess.runCommand('ash.extensions.open');
			const extensions = page.locator('.ash-extensions-view-container');
			await extensions.getByRole('searchbox').fill('@recommended');
			await extensions.getByRole('searchbox').press('Enter');
			await expect(
				extensions.locator('[data-view-id="ash.extensions.recommended"]').getByRole('option'),
			).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath('workspace-exclusion.png') });
		},
	);
});
