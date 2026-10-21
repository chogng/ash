import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test as base } from "../../../automation/test.js";
import { academicPdfCorpus, downloadAcademicPdfCorpus } from "../../../automation/academicPdfCorpus.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "../../../automation/testWorkspace.js";

const test = base.extend({
	backendFixture: async ({ testWorkspace }, use) => {
		const distribution = process.env.ASH_PDF_VIEWER_DISTRIBUTION;
		const trustedRoot = process.env.ASH_PDF_VIEWER_TRUSTED_ROOT;
		if (!distribution || !trustedRoot) throw new Error('The optional PDF corpus requires ASH_PDF_VIEWER_DISTRIBUTION and ASH_PDF_VIEWER_TRUSTED_ROOT from a signed PDF Viewer package for this host. See extensions/pdf-viewer/README.md.');
		const registry = await SignedExtensionRegistry.createEditor(join(testWorkspace.directory, 'pdf-registry'), distribution, trustedRoot, 'ash.pdf-viewer@ash');
		try { await use(registry); } finally { await registry.close(); }
	},

});

const corpusTest = test.extend<{ readonly testWorkspace: TestWorkspace; }>({
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

corpusTest("Installed optional PDF Viewer renders and annotates the open-access academic PDF corpus", { tag: ['@electron-app-server'] }, async ({ application, backendFixture, testWorkspace, workbench }) => {
	await installViewer(application, backendFixture, workbench);
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

async function installViewer(application: import('../../../automation/playwrightDriver.js').PlaywrightApplication, backendFixture: import('../../../automation/test.js').BackendFixture | undefined, workbench: import('../../../automation/workbench.js').Workbench): Promise<void> {
	const registry = backendFixture as SignedExtensionRegistry;
	await workbench.quickaccess.runCommand('ash.extensions.open');
	const extensions = workbench.page.locator('.ash-extensions-view-container');
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
	await workbench.openExplorer();
}

test("Installed optional PDF Viewer renders workspace PDFs and persists review annotations", { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, backendFixture, testWorkspace, workbench }) => {
	await installViewer(application, backendFixture, workbench);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "paper.pdf" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "PDF appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.filter({ hasText: "paper.pdf" })).toHaveAttribute("aria-selected", "true");
	const reader = group.content.locator(".ash-pdf-editor");
	await expect(reader).toBeVisible();
	await expect(reader.locator(".ash-pdf-page-canvas")).toBeVisible();

	await reader.locator("[data-action-id='ash.pdf.annotations.highlight'] button").click();
	const layer = reader.locator(".ash-pdf-annotation-layer");
	await expect.poll(() => layer.evaluate(layer => {
		const pages = layer.closest(".ash-pdf-pages")!;
		return layer.getBoundingClientRect().left - pages.getBoundingClientRect().left;
	}), { message: "PDF page leading edge remains reachable in the scroll viewport" }).toBeGreaterThanOrEqual(0);
	const bounds = await layer.boundingBox();
	if (!bounds) throw new Error("PDF annotation layer has no visual bounds");
	await workbench.page.mouse.move(bounds.x + 24, bounds.y + 24);
	await workbench.page.mouse.down();
	await workbench.page.mouse.move(bounds.x + Math.min(180, bounds.width - 12), bounds.y + Math.min(90, bounds.height - 12));
	await workbench.page.mouse.up();

	await expect(reader.locator(".ash-pdf-annotation-highlight")).toHaveCount(1);
	await expect(reader.locator(".ash-pdf-annotation-status")).toContainText("Unsaved annotations");
	await reader.locator("[data-action-id='ash.pdf.annotations.save'] button").click();
	await expect.poll(
		async () => {
			try {
				const document = JSON.parse(await readFile(`${testWorkspace.pdfFile}.ash-annotations.json`, "utf8")) as { annotations: unknown[]; };
				return document.annotations.length;
			} catch {
				return 0;
			}
		},
		{ timeout: 15_000, message: "PDF annotation sidecar is saved through the App Server workspace" },
	).toBe(1);
});
