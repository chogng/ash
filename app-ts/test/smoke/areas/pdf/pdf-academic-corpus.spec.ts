import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test as base } from "../../../automation/test.js";
import { academicPdfCorpus, downloadAcademicPdfCorpus } from "../../../automation/academicPdfCorpus.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "../../../automation/testWorkspace.js";

const test = base.extend<{ readonly testWorkspace: TestWorkspace }>({
	testWorkspace: async ({ target }, use) => {
		const workspace = await createTestWorkspace();
		try {
			if (target.kind === "electron" && target.appServerMode === "required" && target.workbenchMode === "code") {
				await downloadAcademicPdfCorpus(workspace.directory);
			}
			await use(workspace);
		} finally {
			await disposeTestWorkspace(workspace);
		}
	},
});

test.setTimeout(420_000);

test("Code renders and annotates the open-access academic PDF corpus", async ({ target, testWorkspace, workbench }) => {
	test.skip(
		target.kind !== "electron" || target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code Electron App Server product",
	);
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
					const annotationDocument = JSON.parse(await readFile(annotationFile, "utf8")) as { annotations: unknown[] };
					return annotationDocument.annotations.length;
				} catch {
					return 0;
				}
			},
			{ timeout: 15_000, message: `${document.fileName} annotation sidecar is saved through the App Server` },
		).toBe(1);
	}
});
