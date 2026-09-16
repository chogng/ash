import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../automation/test.js";

test.beforeEach(async ({ workbench }) => {
	const showSidebar = workbench.page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) { await showSidebar.click(); }
});

test("App Server workspace files open in Stanza and save through the editor region", async ({ target, testWorkspace, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const explorer = page.locator(".ash-explorer");
	await expect(explorer).toBeVisible();

	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.ts" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "workspace file appears in Explorer" }).toBe(1);
	await fileRow.locator(".ash-icon-label-icon").click();

	const group = workbench.editors.groupAt(0);
	await expect(group.tabs).toHaveCount(1);
	await expect(group.tabs.first()).toContainText("main.ts");
	const tab = group.title.locator('.ash-tab').first();
	await expect(tab).toHaveClass(/preview/);
	await expect(explorer.locator('.ash-explorer-error')).toHaveCount(0);
	await expect(explorer.locator('.ash-tree')).toBeFocused();
	await expect(group.content.locator(".stanza-editor")).toBeVisible();

	await fileRow.dblclick();
	await expect(tab).not.toHaveClass(/preview/);

	const input = group.content.locator(".stanza-editor-input");
	await expect(input).toBeAttached();
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
	await input.type("const value = 2;");
	await input.press(process.platform === "darwin" ? "Meta+S" : "Control+S");

	await expect.poll(
		() => readFile(testWorkspace.file, "utf8"),
		{ timeout: 15_000, message: "Stanza save reaches the App Server workspace" },
	).toBe("const value = 2;");
});

test("Code consumes App Server Rust syntax facts in Stanza", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const explorer = page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	await expect(group.content.locator(".stanza-editor")).toBeVisible();
	await expect(group.content.locator(".stanza-editor-token.token-keyword").filter({ hasText: "fn" }).first()).toBeVisible();

	const input = group.content.locator(".stanza-editor-input");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+Shift+O" : "Control+Shift+O");
	await expect(group.content.locator(".stanza-editor-goto-symbol-item")).toContainText("main");
});

test("Code finds local workspace symbols when the language server has no workspace-symbol provider", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code" || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER,
		"This scenario requires Code with the smoke-test language server",
	);
	test.setTimeout(120_000);

	const page = workbench.page;
	await page.keyboard.press(process.platform === "darwin" ? "Meta+T" : "Control+T");
	const quickPick = page.locator(".ash-quick-pick");
	const query = quickPick.locator(".ash-quick-pick-input input");
	await query.focus();
	await expect(query).toBeFocused();
	await query.fill("main");
	const result = quickPick.locator(".ash-quick-pick-row-content").filter({ has: page.locator(".ash-quick-pick-row-label", { hasText: /^main$/ }) }).filter({ hasText: "main.rs" });
	await expect(result).toBeVisible({ timeout: 60_000 });
	await query.press("Enter");

	await expect(quickPick).toBeHidden();
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.first()).toContainText("main.rs");
	await expect(group.content.locator(".stanza-editor-accessibility-status")).toContainText("4 characters selected");
});

test("Code searches and opens a workspace symbol from unsaved editor content", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);
	test.setTimeout(120_000);

	const page = workbench.page;
	const explorer = page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const input = group.content.locator(".stanza-editor-input");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
	for (let index = 0; index < 3; index += 1) await input.press("ArrowRight");
	for (let index = 0; index < 4; index += 1) await input.press("Shift+ArrowRight");
	await workbench.page.keyboard.insertText("ephemeral_workspace_symbol");
	await expect.poll(() => hasIndexedSymbol(page, "ephemeral_workspace_symbol"), { timeout: 60_000, message: "unsaved declaration reaches the Workspace CodebaseSymbols overlay" }).toBe(true);
	await page.keyboard.press(process.platform === "darwin" ? "Meta+T" : "Control+T");

	const quickPick = page.locator(".ash-quick-pick");
	const query = quickPick.locator(".ash-quick-pick-input input");
	await expect(query).toBeFocused();
	await query.fill("ephemeral_workspace_symbol");
	await expect(quickPick.locator(".ash-quick-pick-row-label", { hasText: /^ephemeral_workspace_symbol$/ })).toBeVisible({ timeout: 60_000 });
	await query.press("Enter");

	await expect(quickPick).toBeHidden();
	await expect(group.content.locator(".stanza-editor-accessibility-status")).toContainText("26 characters selected");
});

test("Code expands and shrinks Smart Select through semantic editor state", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);
	test.setTimeout(120_000);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const input = group.content.locator(".stanza-editor-input");
	const status = group.content.locator(".stanza-editor-accessibility-status");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
	await input.press("ArrowDown");
	await input.press("Home");
	for (let index = 0; index < 10; index += 1) await input.press("ArrowRight");

	await input.press(process.platform === "darwin" ? "Meta+Shift+ArrowRight" : "Control+Shift+ArrowRight");
	await expect(status).toContainText("7 characters selected");
	await input.press(process.platform === "darwin" ? "Meta+Shift+ArrowRight" : "Control+Shift+ArrowRight");
	await expect.poll(async () => selectedCharacterCount(await status.textContent()), { timeout: 60_000, message: "Smart Select expands beyond the identifier" }).toBeGreaterThan(7);
	await input.press(process.platform === "darwin" ? "Meta+Shift+ArrowLeft" : "Control+Shift+ArrowLeft");
	await expect(status).toContainText("7 characters selected");
});

test("Code shows App Server LSP completions in Stanza", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code" || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER,
		"This scenario requires Code with the smoke-test language server",
	);
	test.setTimeout(120_000);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const input = group.content.locator(".stanza-editor-input");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
	await input.press("ArrowUp");
	await input.press("ArrowUp");
	await input.press("End");
	await input.press(process.platform === "darwin" ? "Meta+Space" : "Control+Space");

	const options = group.content.locator(".stanza-editor-completion-option");
	await expect.poll(() => options.count(), { timeout: 60_000, message: "LSP completion candidates appear" }).toBeGreaterThan(0);
	await expect(options.filter({ hasText: "len" }).first()).toBeVisible();
});

test("Code streams current App Server LSP diagnostics into Stanza", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code" || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER,
		"This scenario requires Code with the smoke-test language server",
	);
	test.setTimeout(120_000);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const marker = group.content.locator(".stanza-editor-diagnostic-marker.error[title*='fixture diagnostic']");
	await expect(group.content.locator(".stanza-editor-diagnostic-marker.error[title*='fixture diagnostic v1']")).toBeVisible({ timeout: 60_000 });

	const input = group.content.locator(".stanza-editor-input");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
	await input.type(" ");
	await expect(group.content.locator(".stanza-editor-diagnostic-marker.error[title*='fixture diagnostic v2']")).toBeVisible({ timeout: 60_000 });
	await expect(marker).toHaveCount(1);
});

test("Code applies and undoes App Server LSP document formatting in Stanza", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code" || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER,
		"This scenario requires Code with the smoke-test language server",
	);
	test.setTimeout(120_000);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const secondLine = group.content.locator(".stanza-editor-line-text").nth(1);
	await expect(secondLine).toHaveText(/^ {4}let /);
	const input = group.content.locator(".stanza-editor-input");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+Shift+I" : "Control+Shift+I");
	await expect(secondLine).toHaveText(/^ {2}let /, { timeout: 60_000 });
	await input.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
	await expect(secondLine).toHaveText(/^ {4}let /);
});

test("Code shows App Server LSP parameter hints in Stanza", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code" || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER,
		"This scenario requires Code with the smoke-test language server",
	);
	test.setTimeout(120_000);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const input = group.content.locator(".stanza-editor-input");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+Shift+Space" : "Control+Shift+Space");
	await expect(group.content.locator(".stanza-editor-parameter-hints")).toContainText("String::from(value: &str)", { timeout: 60_000 });
	await expect(group.content.locator(".stanza-editor-parameter-hints-parameter.active")).toHaveText("value: &str");
	await input.press("Escape");
	await input.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
	await input.type("(");
	await expect(group.content.locator(".stanza-editor-parameter-hints")).toContainText("String::from(value: &str)", { timeout: 60_000 });
});

test("Code shows App Server LSP inlay hints in Stanza", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code" || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER,
		"This scenario requires Code with the smoke-test language server",
	);
	test.setTimeout(120_000);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const hint = workbench.editors.groupAt(0).content.locator(".stanza-editor-inlay-hint").filter({ hasText: ": String" });
	await expect(hint).toBeVisible({ timeout: 60_000 });
	await expect(hint).toHaveAttribute("title", "inferred type");
});

test("Code keeps App Server LSP linked edits in one undo step", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code" || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER,
		"This scenario requires Code with the smoke-test language server",
	);
	test.setTimeout(120_000);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.rs" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "Rust workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const editor = group.content.locator(".stanza-editor");
	const input = editor.locator(".stanza-editor-input");
	await input.focus();
	await input.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
	await input.press("ArrowDown");
	await input.press("Home");
	for (let index = 0; index < 9; index += 1) await input.press("ArrowRight");
	await expect(editor).toHaveClass(/linked-editing-active/, { timeout: 60_000 });

	await input.type("X");
	await expect(group.content.locator(".stanza-editor-line-text").nth(1)).toContainText("mXessage");
	await expect(group.content.locator(".stanza-editor-line-text").nth(2)).toContainText("mXessage");
	await input.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
	await expect(group.content.locator(".stanza-editor-line-text").nth(1)).toContainText("let message");
	await expect(group.content.locator(".stanza-editor-line-text").nth(2)).toContainText("message.");
});

test("Code renders workspace PDFs and persists review annotations", async ({ target, testWorkspace, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const explorer = workbench.page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "paper.pdf" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "PDF appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	await expect(group.tabs).toHaveCount(1);
	await expect(group.tabs.first()).toContainText("paper.pdf");
	const reader = group.content.locator(".ash-pdf-editor");
	await expect(reader).toBeVisible();
	await expect(reader.locator(".ash-pdf-page-canvas")).toBeVisible();

	await reader.locator("[data-action-id='ash.pdf.annotations.highlight'] button").click();
	const layer = reader.locator(".ash-pdf-annotation-layer");
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
				const document = JSON.parse(await readFile(`${testWorkspace.pdfFile}.ash-annotations.json`, "utf8")) as { annotations: unknown[] };
				return document.annotations.length;
			} catch {
				return 0;
			}
		},
		{ timeout: 15_000, message: "PDF annotation sidecar is saved through the App Server workspace" },
	).toBe(1);
});

test.describe("large files", () => {
	test.use({ includeLargeTestFile: true });

	test("Code keeps a 300,001-line file editable and saveable without background tokenization", async ({ target, testWorkspace, workbench }) => {
		test.skip(
			target.appServerMode !== "required" || target.workbenchMode !== "code",
			"This scenario requires the Code App Server product",
		);
		test.setTimeout(120_000);

		const explorer = workbench.page.locator(".ash-explorer");
		const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "large.ts" });
		await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "large file appears in Explorer" }).toBe(1);
		await fileRow.click();

		const group = workbench.editors.groupAt(0);
		const editor = group.content.locator(".stanza-editor");
		await expect(editor).toBeVisible({ timeout: 60_000 });
		await expect(editor.locator(".stanza-editor-token")).toHaveCount(0);

		const input = editor.locator(".stanza-editor-input");
		await input.focus();
		await input.press("ControlOrMeta+Home");
		await input.type("// edited\n");
		await input.press("ControlOrMeta+S");

		await expect.poll(
			async () => (await readFile(testWorkspace.largeFile, "utf8")).startsWith("// edited\nlet value = 1;"),
			{ timeout: 60_000, message: "large-file edit reaches the App Server workspace" },
		).toBe(true);
	});
});

function selectedCharacterCount(status: string | null): number {
	const match = status?.match(/(\d+) characters selected/u);
	return match ? Number(match[1]) : 0;
}

async function hasIndexedSymbol(page: Page, name: string): Promise<boolean> {
	return page.evaluate(async query => {
		const host = (globalThis as { ashWebWorkbenchHost?: { api: { codebaseSymbols: { search(request: { query: string; maxResults: number }): Promise<{ hits: readonly { name: string }[] }> } } } }).ashWebWorkbenchHost;
		if (!host) return false;
		return host.api.codebaseSymbols.search({ query, maxResults: 20 }).then(result => result.hits.some(hit => hit.name === query), () => false);
	}, name);
}

test("Code restores unsaved editor content after a browser reload", async ({ target, testWorkspace, workbench }) => {
	test.skip(
		target.kind !== "browser" || target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the browser-hosted Code App Server product",
	);

	const page = workbench.page;
	const explorer = page.locator(".ash-explorer");
	const fileRow = explorer.locator(".ash-tree-row").filter({ hasText: "main.ts" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000, message: "workspace file appears in Explorer" }).toBe(1);
	await fileRow.click();

	const group = workbench.editors.groupAt(0);
	const input = group.content.locator(".stanza-editor-input");
	await input.focus();
	await input.press("ControlOrMeta+A");
	await input.type("const recovered = 42;");
	await expect.poll(() => hasWorkingCopyBackup(page, "const recovered = 42;"), { message: "dirty editor content reaches IndexedDB" }).toBe(true);
	expect(await readFile(testWorkspace.file, "utf8")).toBe("const value = 1;\n");

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator(".ash-workbench")).toBeVisible();
	await expect(group.tabs.filter({ hasText: "main.ts" })).toHaveCount(1);
	await expect(group.content.locator(".stanza-editor-line-text").first()).toContainText("const recovered = 42;");
	expect(await readFile(testWorkspace.file, "utf8")).toBe("const value = 1;\n");

	const restoredInput = group.content.locator(".stanza-editor-input");
	await restoredInput.focus();
	await restoredInput.press("ControlOrMeta+S");
	await expect.poll(() => readFile(testWorkspace.file, "utf8"), { message: "restored content can still be saved" }).toBe("const recovered = 42;");
	await expect.poll(() => hasWorkingCopyBackup(page, "const recovered = 42;"), { message: "saving removes the crash backup" }).toBe(false);
});

async function hasWorkingCopyBackup(page: Page, content: string): Promise<boolean> {
	return page.evaluate(async expectedContent => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const opening = indexedDB.open("ash-working-copy-backups", 1);
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error ?? new Error("Could not inspect working-copy backups"));
		});
		try {
			const records = await new Promise<Array<{ readonly content?: string }>>((resolve, reject) => {
				const request = database.transaction("backups", "readonly").objectStore("backups").getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error("Could not read working-copy backups"));
			});
			return records.some(record => record.content === expectedContent);
		} finally {
			database.close();
		}
	}, content);
}


test('Code editor scrollbar follows wheel, keyboard and thumb dragging in the desktop window', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires a Code workspace');
	await writeFile(testWorkspace.file, Array.from({ length: 200 }, (_, index) => `// line ${index} ${'x'.repeat(180)}`).join('\n'));
	const page = workbench.page;
	const fileRow = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
	await expect(fileRow).toHaveCount(1);
	await fileRow.locator('.ash-icon-label-icon').click();
	const editor = workbench.editors.groupAt(0).content.locator('.stanza-editor');
	await expect(editor).toBeVisible();
	const vertical = editor.getByRole('scrollbar', { name: 'Vertical scrollbar' });
	await expect(vertical).toBeVisible();
	await vertical.focus();
	await page.keyboard.press('Home');
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(0);
	await editor.hover();
	await page.mouse.wheel(0, 180);
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await vertical.focus();
	await page.keyboard.press('End');
	await expect.poll(async () => vertical.evaluate(element => element.getAttribute('aria-valuenow') === element.getAttribute('aria-valuemax'))).toBe(true);
	await page.keyboard.press('Home');
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(0);
	const thumb = await vertical.locator('.ash-scrollbar-thumb').boundingBox();
	if (!thumb) {
		throw new Error('Missing scrollbar thumb');
	}
	await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
	await page.mouse.down();
	await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 80, { steps: 5 });
	await page.mouse.up();
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(180);
});

test('Code replaces a selection with multiline text and remains editable', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires a Code workspace');
	const page = workbench.page;
	const fileRow = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
	await expect(fileRow).toHaveCount(1);
	await fileRow.locator('.ash-icon-label-icon').click();
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await expect(input).toBeAttached();
	await input.focus();
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	const content = Array.from({ length: 200 }, (_, index) => `// line ${index} ${'x'.repeat(180)}`).join('\n');
	const started = performance.now();
	await page.keyboard.insertText(content);
	await test.info().attach('input-timing', {
		body: JSON.stringify({ characters: content.length, milliseconds: performance.now() - started }),
		contentType: 'application/json',
	});
	await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe(content);
	await page.keyboard.insertText('!');
	await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe(content + '!');
});
