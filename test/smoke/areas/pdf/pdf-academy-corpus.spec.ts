import { Workbench } from '../../../automation/workbench.js';
import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test as base } from '../../../automation/test.js';
import { academyPdfCorpus, downloadAcademyPdfCorpus } from '../../../automation/academyPdfCorpus.js';
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from '../../../automation/testWorkspace.js';

const test = base.extend({
	backendFixture: async ({ testWorkspace }, use) => {
		const distribution = process.env.ASH_PDF_VIEWER_DISTRIBUTION;
		const trustedRoot = process.env.ASH_PDF_VIEWER_TRUSTED_ROOT;
		if (!distribution || !trustedRoot)
			throw new Error(
				'The optional PDF corpus requires ASH_PDF_VIEWER_DISTRIBUTION and ASH_PDF_VIEWER_TRUSTED_ROOT from a signed PDF Viewer package for this host. See extensions/pdf-viewer/README.md.',
			);
		const registry = await SignedExtensionRegistry.createEditor(
			join(testWorkspace.directory, 'pdf-registry'),
			distribution,
			trustedRoot,
			'ash.pdf-viewer@ash',
		);
		try {
			await use(registry);
		} finally {
			await registry.close();
		}
	},
});

const corpusTest = test.extend<{ readonly testWorkspace: TestWorkspace }>({
	testWorkspace: async ({ target }, use) => {
		const workspace = await createTestWorkspace();
		try {
			if (target.kind === 'electron' && target.appServerMode === 'required') {
				await downloadAcademyPdfCorpus(workspace.directory);
			}
			await use(workspace);
		} finally {
			await disposeTestWorkspace(workspace);
		}
	},
});

test.setTimeout(420_000);

corpusTest(
	'Agents Window optional PDF Viewer renders and annotates the open-access academy PDF corpus',
	{ tag: ['@electron-app-server'] },
	async ({ application, backendFixture, testWorkspace, workbench, target }) => {
		const agents = new Workbench(await workbench.openAgentsWindow(target.kind));
		await installViewer(backendFixture, agents);
		for (const document of academyPdfCorpus) {
			await openPdf(application, agents, join(testWorkspace.directory, document.fileName));
			const reader = agents.page.locator('.ash-pdf-editor:visible');
			await expect(reader).toBeVisible();
			const canvases = reader.locator('.ash-pdf-page-canvas');
			await expect
				.poll(() => canvases.count(), {
					timeout: 240_000,
					message: `${document.title} renders every page through PDF.js`,
				})
				.toBe(document.pageCount);
			await expect(
				reader.locator(`.ash-pdf-page[data-page-number='${document.pageCount}'] .ash-pdf-page-canvas`),
			).toBeAttached();

			await reader.locator("[data-action-id='ash.pdf.annotations.note'] button").click();
			const layer = reader.locator('.ash-pdf-annotation-layer').first();
			await layer.evaluate(layer => {
				const bounds = layer.getBoundingClientRect();
				layer.dispatchEvent(
					new PointerEvent('pointerdown', {
						bubbles: true,
						button: 0,
						clientX: bounds.left + 48,
						clientY: bounds.top + 48,
						pointerId: 1,
					}),
				);
			});

			await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
			await reader.locator("[data-action-id='ash.pdf.annotations.save'] button").click();
			const annotationFile = join(testWorkspace.directory, `${document.fileName}.ash-annotations.json`);
			await expect
				.poll(
					async () => {
						try {
							const annotationDocument = JSON.parse(await readFile(annotationFile, 'utf8')) as {
								annotations: unknown[];
							};
							return annotationDocument.annotations.length;
						} catch {
							return 0;
						}
					},
					{
						timeout: 15_000,
						message: `${document.fileName} annotation sidecar is saved through the App Server`,
					},
				)
				.toBe(1);
		}
	},
);

async function installViewer(
	backendFixture: import('../../../automation/test.js').BackendFixture | undefined,
	workbench: Workbench,
): Promise<void> {
	const registry = backendFixture as SignedExtensionRegistry;
	await workbench.quickaccess.runCommand('ash.extensions.browse');
	const extensions = workbench.page.locator('.ash-extensions-view-container');
	await extensions.getByRole('searchbox').fill('pdf-viewer');
	await extensions.getByRole('searchbox').press('Enter');
	const row = extensions.locator(`[data-package-id="${registry.packageId}"]`);
	await row.getByRole('button', { name: 'Install', exact: true }).click();
	await workbench.page
		.getByRole('dialog', { name: 'Install', exact: true })
		.getByRole('button', { name: 'Install', exact: true })
		.click();
	await expect
		.poll(() => registry.installations())
		.toMatchObject([{ package: { id: registry.packageId }, state: 'installed' }]);
	const installation = (await registry.installations())[0];
	await workbench.quickaccess.runCommand('ash.extensions.showInstalled');
	await extensions.locator(`[data-installation-id="${installation.installationId}"]`).click();
	const editor = workbench.page.locator('.ash-extension-editor');
	const enable = editor.getByRole('button', { name: 'Enable', exact: true });
	if (await enable.count()) await enable.click();
	await editor.getByRole('button', { name: 'Authorize execution', exact: true }).click();
	await workbench.page
		.getByRole('dialog', { name: registry.packageId, exact: true })
		.getByRole('button', { name: 'Authorize execution', exact: true })
		.click();
	await expect(editor.getByRole('button', { name: 'Revoke execution authorization', exact: true })).toBeVisible();
}

/** Only replace the OS picker; resource routing, files and rendering remain product-owned. */
async function openPdf(
	application: import('../../../automation/playwrightDriver.js').PlaywrightApplication,
	workbench: Workbench,
	filePath: string,
): Promise<void> {
	if (!('windows' in application)) throw new Error('The signed PDF corpus requires Electron');
	const original = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
	try {
		await application.evaluate(({ dialog }, filePath) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
		}, filePath);
		await workbench.quickaccess.runCommand('workbench.action.files.openFile');
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: basename(filePath) })).toHaveAttribute(
			'aria-selected',
			'true',
		);
	} finally {
		await application.evaluate(({ dialog }, original) => {
			dialog.showOpenDialog = original;
		}, original);
		await original.dispose();
	}
}

test(
	'Agents Window PDF Viewer persists annotations without exposing a reader in IDE',
	{ tag: ['@electron-app-server'] },
	async ({ application, backendFixture, testWorkspace, workbench, target }) => {
		const agents = new Workbench(await workbench.openAgentsWindow(target.kind));
		await installViewer(backendFixture, agents);
		await openPdf(application, agents, testWorkspace.pdfFile);
		await agents.page.locator('[data-action-id="ash.sessions.toggleDetails"] button').first().click();
		const reader = agents.page.locator('.ash-pdf-editor:visible');
		await expect(reader).toBeVisible();
		await expect(reader.locator('.ash-pdf-page-canvas')).toBeVisible();

		await reader.locator("[data-action-id='ash.pdf.annotations.highlight'] button").click();
		const layer = reader.locator('.ash-pdf-annotation-layer');
		await expect
			.poll(
				() =>
					layer.evaluate(layer => {
						const pages = layer.closest('.ash-pdf-pages')!;
						return layer.getBoundingClientRect().left - pages.getBoundingClientRect().left;
					}),
				{ message: 'PDF page leading edge remains reachable in the scroll viewport' },
			)
			.toBeGreaterThanOrEqual(0);
		const bounds = await layer.boundingBox();
		const viewport = await reader.locator('.ash-pdf-pages').boundingBox();
		if (!bounds || !viewport) throw new Error('PDF annotation layer has no visual bounds');
		await agents.page.mouse.move(bounds.x + 24, bounds.y + 24);
		await agents.page.mouse.down();
		await agents.page.mouse.move(
			Math.min(bounds.x + 120, viewport.x + viewport.width - 12),
			bounds.y + Math.min(90, bounds.height - 12),
		);
		await agents.page.mouse.up();

		await expect(reader.locator('.ash-pdf-annotation-highlight')).toHaveCount(1);
		await expect(reader.locator('.ash-pdf-annotation-status')).toContainText('Unsaved annotations');
		await reader.locator("[data-action-id='ash.pdf.annotations.save'] button").click();
		await expect
			.poll(
				async () => {
					try {
						const document = JSON.parse(
							await readFile(`${testWorkspace.pdfFile}.ash-annotations.json`, 'utf8'),
						) as { annotations: unknown[] };
						return document.annotations.length;
					} catch {
						return 0;
					}
				},
				{ timeout: 15_000, message: 'PDF annotation sidecar is saved through the App Server workspace' },
			)
			.toBe(1);

		await openPdf(application, workbench, testWorkspace.pdfFile);
		await expect(workbench.page.locator('.ash-pdf-editor')).toHaveCount(0);
		await expect(workbench.page.locator('[data-editor-id="ash.workbench.pdfViewer"]')).toHaveCount(0);
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.element.getByRole('searchbox').fill('accessibility.verbosity.resourceEditor');
		await expect(
			workbench.page.locator('input[data-configuration-key="accessibility.verbosity.resourceEditor"]'),
		).toHaveCount(0);
	},
);
