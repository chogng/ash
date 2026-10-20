import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test as base } from "../../../automation/test.js";
import { academicPdfCorpus, downloadAcademicPdfCorpus } from "../../../automation/academicPdfCorpus.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "../../../automation/testWorkspace.js";

const test = base.extend<{ readonly testWorkspace: TestWorkspace; }>({
	backendFixture: async ({ testWorkspace }, use) => {
		const distribution = process.env.ASH_PDF_VIEWER_DISTRIBUTION;
		const trustedRoot = process.env.ASH_PDF_VIEWER_TRUSTED_ROOT;
		if (!distribution || !trustedRoot) throw new Error('The optional PDF corpus requires ASH_PDF_VIEWER_DISTRIBUTION and ASH_PDF_VIEWER_TRUSTED_ROOT from a signed PDF Viewer package for this host. See extensions/pdf-viewer/README.md.');
		const registry = await SignedExtensionRegistry.createEditor(join(testWorkspace.directory, 'pdf-registry'), distribution, trustedRoot, 'ash.pdf-viewer@ash');
		try { await use(registry); } finally { await registry.close(); }
	},
	testWorkspace: async ({ target }, use) => {
		const workspace = await createTestWorkspace();
		try {
			if (target.kind === "electron" && target.appServerMode === "required") {
				await downloadAcademicPdfCorpus(workspace.directory);
			}
			await use(workspace);
		} finally {
			await disposeTestWorkspace(workspace);
		}
	},
});

test.setTimeout(420_000);

test("Installed optional PDF Viewer renders and annotates the open-access academic PDF corpus", { tag: ['@electron-app-server'] }, async ({ application, backendFixture, testWorkspace, workbench }) => {
	const registry = backendFixture as SignedExtensionRegistry;
	await workbench.quickaccess.runCommand('ash.extensions.open');
	const extensions = workbench.page.locator('.ash-extensions');
	await extensions.getByRole('searchbox').fill('pdf-viewer');
	await extensions.getByRole('searchbox').press('Enter');
	const row = extensions.locator(`[data-package-id="${registry.packageId}"]`);
	await workbench.dialogs.confirm(application, 'Install', 'Install', () => row.getByRole('button', { name: 'Install', exact: true }).click());
	await expect.poll(() => registry.installations()).toMatchObject([{ package: { id: registry.packageId }, state: 'installed' }]);
	const installation = (await registry.installations())[0];
	await workbench.quickaccess.runCommand('ash.extensions.installed');
	await extensions.locator(`[data-installation-id="${installation.installationId}"]`).click();
	const editor = workbench.page.locator('.ash-extension-editor');
	const enable = editor.getByRole('button', { name: 'Enable', exact: true });
	if (await enable.count()) await enable.click();
	await workbench.dialogs.confirm(application, registry.packageId, 'Authorize execution', () => editor.getByRole('button', { name: 'Authorize execution', exact: true }).click());
	await expect(editor.getByRole('button', { name: 'Revoke execution authorization', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.view.explorer');
	const explorer = workbench.page.locator(".ash-explorer");
	const group = workbench.editors.groupAt(0);
	for (const document of academicPdfCorpus) {
		const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: document.fileName });
		await expect.poll(() => fileRow.count(), { timeout: 15_000, message: `${document.fileName} appears in Explorer` }).toBe(1);
		await fileRow.click();

		const reader = group.content.locator(".ash-pdf-editor:visible");
		await expect(reader).toBeVisible();
		const canvases = reader.locator(".ash-pdf-page-canvas");
		await expect.poll(
			() => canvases.count(),
			{ timeout: 240_000, message: `${document.title} renders every page through PDF.js` },
		).toBe(document.pageCount);
		await expect(reader.locator(`.ash-pdf-page[data-page-number='${document.pageCount}'] .ash-pdf-page-canvas`)).toBeAttached();

		await reader.locator("[data-action-id='ash.pdf.annotations.note'] button").click();
		const layer = reader.locator(".ash-pdf-annotation-layer").first();
		await layer.evaluate(layer => {
			const bounds = layer.getBoundingClientRect();
			layer.dispatchEvent(new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				clientX: bounds.left + 48,
				clientY: bounds.top + 48,
				pointerId: 1,
			}));
		});

		await expect(reader.locator(".ash-pdf-annotation-note")).toHaveCount(1);
		await reader.locator("[data-action-id='ash.pdf.annotations.save'] button").click();
		const annotationFile = join(testWorkspace.directory, `${document.fileName}.ash-annotations.json`);
		await expect.poll(
			async () => {
				try {
					const annotationDocument = JSON.parse(await readFile(annotationFile, "utf8")) as { annotations: unknown[]; };
					return annotationDocument.annotations.length;
				} catch {
					return 0;
				}
			},
			{ timeout: 15_000, message: `${document.fileName} annotation sidecar is saved through the App Server` },
		).toBe(1);
	}
});
