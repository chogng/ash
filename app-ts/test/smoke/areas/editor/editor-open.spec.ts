import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test("Show All Editors searches recent editors and restores editor focus", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const fileRow = page.locator(".ash-explorer .ash-tree-row").filter({ hasText: "main.ts" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000 }).toBe(1);
	await fileRow.dblclick();
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs).toHaveCount(1);
	const breadcrumbs = group.title.getByRole("navigation", { name: "Editor breadcrumbs" });
	await expect(breadcrumbs).toBeVisible();
	const currentBreadcrumb = breadcrumbs.locator('[aria-current="page"]');
	await expect(currentBreadcrumb).toHaveText("main.ts");
	await expect(currentBreadcrumb).toHaveClass(/current/u);
	await expect(currentBreadcrumb).toHaveAttribute("title", "main.ts");
	const breadcrumbStyle = await breadcrumbs.evaluate(element => ({
		display: getComputedStyle(element).display,
		gap: getComputedStyle(element).gap,
		color: getComputedStyle(element.querySelector('.current')!).color,
	}));
	expect(breadcrumbStyle.display).toBe("flex");
	expect(breadcrumbStyle.gap).toBe("4px");
	expect(breadcrumbStyle.color).not.toBe("rgba(0, 0, 0, 0)");
	await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.rs' }).click();
	await expect(group.tabs).toHaveCount(2);

	await page.keyboard.press("F1");
	const picker = page.locator(".ash-quick-pick");
	await picker.getByRole("combobox").fill("Show All Editors");
	await expect(picker.locator(".ash-quick-pick-row-label", { hasText: "Show All Editors" })).toBeVisible();
	await page.keyboard.press("Enter");

	const search = picker.getByRole("combobox");
	await expect(search).toHaveValue("edt mru ");
	await search.fill("edt mru main");
	const otherEditor = picker.locator('.ash-quick-pick-row-content').filter({ hasText: 'main.rs' });
	await otherEditor.getByRole('button', { name: 'Close Editor' }).click();
	await expect(otherEditor).toHaveCount(0);
	await expect(picker).toBeVisible();
	await expect(group.tabs).toHaveCount(1);
	await expect(picker.locator(".ash-quick-pick-row-label", { hasText: "main.ts" })).toBeVisible();
	await search.press("Enter");
	await expect(picker).toHaveCount(0);
	await expect(group.content.locator(".stanza-editor-input")).toBeFocused();
});

test("Editor tabs support modifier selection and close the selected set", async ({ target, workbench }) => {
	test.skip(target.appServerMode !== "required" || target.workbenchMode !== "code", "This scenario requires the Code App Server product");
	const page = workbench.page;
	const explorer = page.locator(".ash-explorer .ash-tree-row");
	await explorer.filter({ hasText: "main.ts" }).dblclick();
	await explorer.filter({ hasText: "main.rs" }).dblclick();
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs).toHaveCount(2);
	const first = group.tabs.filter({ hasText: "main.ts" });
	const second = group.tabs.filter({ hasText: "main.rs" });
	await first.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
	await expect(first).toHaveAttribute("aria-selected", "true");
	await expect(second).toHaveAttribute("aria-selected", "true");
	await expect(group.content.getByRole("textbox", { name: "main.rs" })).toBeAttached();
	await page.keyboard.press("F1");
	const picker = page.locator(".ash-quick-pick");
	const search = picker.getByRole("combobox");
	await search.fill("Close Editor");
	await expect(picker.locator(".ash-quick-pick-row-label", { hasText: "Close Editor" })).toBeVisible();
	await search.press("Enter");
	await expect(group.tabs).toHaveCount(0);
});

test("Editor breadcrumbs open sibling and nested files", async ({ target, testWorkspace, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const explorer = page.locator(".ash-explorer .ash-tree-row");
	await explorer.filter({ hasText: "main.ts" }).click();
	const group = workbench.editors.groupAt(0);
	const breadcrumbs = group.title.getByRole("navigation", { name: "Editor breadcrumbs" });
	const pathItems = breadcrumbs.getByRole("button");
	await expect(pathItems.last()).toHaveText("main.ts");
	await pathItems.nth(-2).focus();
	await page.keyboard.press("Enter");

	const picker = page.locator(".ash-quick-pick");
	await expect(picker.getByRole("combobox")).toBeFocused();
	await picker.getByRole("combobox").fill("main.rs");
	await expect(picker.locator(".ash-quick-pick-row-label", { hasText: "main.rs" })).toBeVisible();
	await page.keyboard.press("Enter");

	await expect(picker).toHaveCount(0);
	await expect(group.tabs.filter({ hasText: "main.rs" })).toHaveCount(1);
	await expect(group.content.getByRole("textbox", { name: "main.rs" })).toBeFocused();
	await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText("main.rs");

	const nestedDirectory = join(testWorkspace.directory, "breadcrumb-folder");
	await mkdir(nestedDirectory);
	await writeFile(join(nestedDirectory, "nested.ts"), "export const nested = true;\n");
	await breadcrumbs.getByRole("button").nth(-2).click();
	await picker.getByRole("combobox").fill("breadcrumb-folder");
	await page.keyboard.press("Enter");
	await picker.getByRole("combobox").fill("nested.ts");
	await expect(picker.locator(".ash-quick-pick-row-label", { hasText: "nested.ts" })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(group.tabs.filter({ hasText: "nested.ts" })).toHaveCount(1);
});

test("Sticky and ordinary editors occupy separate tab rows", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const explorer = workbench.page.locator(".ash-explorer .ash-tree-row");
	await explorer.filter({ hasText: "main.ts" }).dblclick();
	await explorer.filter({ hasText: "main.rs" }).dblclick();
	const group = workbench.editors.groupAt(0);
	const ordinary = group.title.locator(".ash-ordinary-editor-tabs-row");
	const sticky = group.title.locator(".ash-sticky-editor-tabs-row");
	await expect(ordinary.locator(".ash-tab")).toHaveCount(2);
	await ordinary.locator('.ash-tab').filter({ hasText: "main.ts" })
		.locator('[data-action-id="workbench.editor.toggleSticky"] button').click();
	await expect(sticky.locator(".ash-tab")).toHaveCount(1);
	await expect(ordinary.locator(".ash-tab")).toHaveCount(1);
	await expect(sticky.getByRole("tab", { name: "main.ts" })).toBeFocused();
	const stickyBox = await sticky.boundingBox();
	const ordinaryBox = await ordinary.boundingBox();
	expect(stickyBox).not.toBeNull();
	expect(ordinaryBox).not.toBeNull();
	expect(ordinaryBox!.y).toBeGreaterThanOrEqual(stickyBox!.y + stickyBox!.height);
	await sticky.locator('[data-action-id="workbench.editor.toggleSticky"] button').click();
	await expect(sticky.locator(".ash-tab")).toHaveCount(0);
	await expect(ordinary.locator(".ash-tab")).toHaveCount(2);
});

test("Connected editor tab follows horizontal tab scrolling", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const explorer = page.locator(".ash-explorer .ash-tree-row");
	for (const name of ["main.ts", "main.rs", "Cargo.toml"]) {
		await explorer.filter({ hasText: name }).dblclick();
	}
	await page.setViewportSize({ width: 600, height: 720 });
	const group = workbench.editors.groupAt(0);
	const selected = group.title.locator(".ash-ordinary-editor-tabs-row .ash-tab.checked");
	const viewport = group.title.locator(".ash-ordinary-editor-tabs-row .ash-scrollbar-viewport");
	await expect(selected).toHaveCount(1);
	await viewport.evaluate(element => { element.scrollLeft = 0; });
	await expect.poll(() => selected.evaluate(tab => {
		const edge = tab.closest(".ash-scrollbar-viewport")!.getBoundingClientRect().right;
		return tab.getBoundingClientRect().right > edge && tab.classList.contains("connected-tab-right-clipped");
	})).toBe(true);
	await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth; });
	await expect(selected).not.toHaveClass(/connected-tab-right-clipped/u);
	await expect.poll(() => selected.evaluate(tab => getComputedStyle(tab).borderBottomWidth)).toBe("2px");
});

test("Single editor tab uses the available title width", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const mainFile = page.locator(".ash-explorer .ash-tree-row").filter({ hasText: "main.ts" });
	await mainFile.click();
	await page.getByRole("button", { name: "Ash Settings" }).click();
	const settings = page.locator(".ash-settings-editor");
	await expect(settings).toBeVisible();
	await settings.locator('[data-settings-category-id="editor"]').click();
	await settings.getByRole("searchbox", { name: "Search settings" }).fill("workbench.editor.showTabs");
	const mode = settings.locator('[data-configuration-key="workbench.editor.showTabs"]');
	await expect(mode).toBeVisible();
	await mode.getByRole("combobox").click();
	await page.getByRole("option", { name: "Single" }).click();
	await page.locator(".ash-modal-editor-close").click();
	await mainFile.click();

	const control = workbench.editors.groupAt(0).title.locator(".ash-single-editor-tabs-control");
	await expect(control.getByRole("tab", { name: "main.ts" })).toBeVisible();
	const widths = await control.evaluate(element => ({
		available: element.getBoundingClientRect().width,
		tab: element.querySelector(".ash-tab")!.getBoundingClientRect().width,
	}));
	expect(widths.tab).toBeGreaterThan(widths.available * 0.8);
});

test("Binary content shows an editor error with a working alternative", async ({ target, testWorkspace, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	await writeFile(testWorkspace.file, new Uint8Array([0x48, 0x69, 0x00, 0xff]));
	const fileRow = workbench.page.locator(".ash-explorer .ash-tree-row").filter({ hasText: "main.ts" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000 }).toBe(1);
	await fileRow.click();

	const content = workbench.editors.groupAt(0).content;
	const error = content.getByRole("alert");
	await expect(error).toContainText("Unable to open main.ts");
	await expect(error).toContainText("binary");
	await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();
	const alternative = error.getByRole("button", { name: "Open as Binary" });
	await expect(alternative).toBeVisible();
	const styles = await error.evaluate(element => ({
		display: getComputedStyle(element).display,
		gap: getComputedStyle(element).gap,
		actionGap: getComputedStyle(element.querySelector(".ash-editor-open-error-actions")!).gap,
		color: getComputedStyle(element.querySelector(".ash-editor-open-error-detail")!).color,
	}));
	expect(styles.display).toBe("flex");
	expect(styles.gap).toBe("12px");
	expect(styles.actionGap).toBe("8px");
	expect(styles.color).not.toBe("rgba(0, 0, 0, 0)");
	await alternative.click();
	await expect(content.locator(".ash-binary-editor-content")).toContainText("48 69 00 ff");
	await expect(error).toHaveCount(0);
	await content.getByRole('button', { name: 'Open as Read-Only Text' }).click();
	await expect(content.locator('.stanza-editor-input')).toBeAttached();
	await expect(content.locator('.stanza-editor-input')).toHaveAttribute('aria-readonly', 'true');
	await expect(content.locator('.ash-binary-editor-content')).toHaveCount(0);
});

test("Compare open files as binary shows both byte views", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);
	const page = workbench.page;
	const explorer = page.locator(".ash-explorer .ash-tree-row");
	await explorer.filter({ hasText: "main.ts" }).dblclick();
	await explorer.filter({ hasText: "main.rs" }).dblclick();
	await page.keyboard.press("F1");
	const picker = page.locator(".ash-quick-pick");
	const search = picker.getByRole("combobox");
	await search.fill("Compare Active File as Binary With");
	await expect(picker.locator(".ash-quick-pick-row-label", { hasText: "Compare Active File as Binary With" })).toBeVisible();
	await search.press("Enter");
	const candidateSearch = picker.getByRole("combobox");
	await expect(candidateSearch).toHaveAttribute("placeholder", "Select the original file to compare");
	await candidateSearch.fill("main.ts");
	await candidateSearch.press("Enter");
	const sides = workbench.editors.groupAt(0).content.locator(".ash-side-by-side-editor > section");
	await expect(sides).toHaveCount(2);
	await expect(sides.first().locator(".ash-binary-editor-content")).toContainText("00000000");
	await expect(sides.last().locator(".ash-binary-editor-content")).toContainText("00000000");
	const boxes = await sides.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
	expect(boxes[1].left).toBeGreaterThanOrEqual(boxes[0].right);
});

test("Reopen Editor With switches the active file to Binary Editor", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const fileRow = page.locator(".ash-explorer .ash-tree-row").filter({ hasText: "main.ts" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000 }).toBe(1);
	await fileRow.click();
	const content = workbench.editors.groupAt(0).content;
	await expect(content.locator(".stanza-editor-input")).toBeAttached();

	await page.keyboard.press("F1");
	const picker = page.locator(".ash-quick-pick");
	await picker.getByRole("combobox").fill("Reopen Editor With");
	await expect(picker.locator(".ash-quick-pick-row-label", { hasText: "Reopen Editor With..." })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(picker.getByRole("combobox")).toHaveAttribute("placeholder", "Select an editor");
	await picker.locator(".ash-quick-pick-row-label", { hasText: "Binary Editor" }).click();

	await expect(picker).toHaveCount(0);
	await expect(content.locator(".ash-binary-editor-content")).toContainText("63 6f 6e 73 74");
});

test("Close Editor command closes the active tab", async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== "required" || target.workbenchMode !== "code",
		"This scenario requires the Code App Server product",
	);

	const page = workbench.page;
	const fileRow = page.locator(".ash-explorer .ash-tree-row").filter({ hasText: "main.ts" });
	await expect.poll(() => fileRow.count(), { timeout: 15_000 }).toBe(1);
	await fileRow.click();
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs).toHaveCount(1);

	await page.keyboard.press("F1");
	const picker = page.locator(".ash-quick-pick");
	await picker.getByRole("combobox").fill("Close Editor");
	await picker.locator(".ash-quick-pick-row-label", { hasText: /^Close Editor$/u }).click();
	await expect(group.tabs).toHaveCount(0);
});

test('Dragging a tab to a group edge shows the split target and moves the editor', async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== 'required' || target.workbenchMode !== 'code',
		'This scenario requires the Code App Server product',
	);

	const page = workbench.page;
	const explorer = page.locator('.ash-explorer .ash-tree-row');
	for (const filename of ['main.rs', 'main.ts']) {
		const row = explorer.filter({ hasText: filename });
		await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
		if (filename === 'main.rs') await row.dblclick();
		else await row.click();
	}

	const editors = workbench.editors;
	const group = editors.groupAt(0);
	await expect(group.tabs).toHaveCount(2);
	await group.tabs.filter({ hasText: 'main.ts' }).dragTo(
		group.tabs.filter({ hasText: 'main.rs' }),
		{ targetPosition: { x: 8, y: 12 } },
	);
	await expect(group.tabs).toContainText(['main.ts', 'main.rs']);
	const tabBox = await group.tabs.filter({ hasText: 'main.ts' }).boundingBox();
	const groupBox = await group.element.boundingBox();
	if (!tabBox || !groupBox) throw new Error('Editor drag requires visible tab and group bounds');

	await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(tabBox.x + tabBox.width / 2 + 12, tabBox.y + tabBox.height / 2 + 12, { steps: 4 });
	await page.mouse.move(groupBox.x + groupBox.width - 8, groupBox.y + groupBox.height * 0.65, { steps: 12 });
	await expect(group.element).toHaveAttribute('data-editor-drop-direction', 'right');
	const feedback = await group.element.evaluate(element => {
		const style = getComputedStyle(element, '::after');
		return { content: style.content, inset: style.left, width: style.width, border: style.borderTopColor };
	});
	expect(feedback.content).toBe('""');
	expect(feedback.inset).not.toBe('auto');
	expect(feedback.width).not.toBe('0px');
	expect(feedback.border).not.toBe('rgba(0, 0, 0, 0)');
	await page.mouse.up();

	await expect(editors.groups).toHaveCount(2);
	await expect(editors.groupAt(0).tabs).toContainText(['main.rs']);
	await expect(editors.groupAt(1).tabs).toContainText(['main.ts']);
	await expect(editors.element.locator('[data-editor-drop-direction]')).toHaveCount(0);
});

test('minimap slider follows its theme color in the running editor', async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== 'required' || target.workbenchMode !== 'code',
		'This scenario requires the Code App Server product',
	);

	const fileRow = workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
	await expect.poll(() => fileRow.count(), { timeout: 15_000 }).toBe(1);
	await fileRow.click();
	const slider = workbench.editors.groupAt(0).content.locator('.stanza-editor-minimap-slider');
	await expect(slider).toBeVisible();
	const colors = await slider.evaluate(element => {
		const minimap = element.parentElement!;
		const initial = getComputedStyle(element).backgroundColor;
		minimap.style.setProperty('--ash-minimap-slider-background', '#123456');
		const overridden = getComputedStyle(element).backgroundColor;
		minimap.style.removeProperty('--ash-minimap-slider-background');
		return { initial, overridden, restored: getComputedStyle(element).backgroundColor };
	});
	expect(colors.initial).not.toBe('rgba(0, 0, 0, 0)');
	expect(colors.overridden).toBe('rgb(18, 52, 86)');
	expect(colors.restored).toBe(colors.initial);
});

test('Code opens Go to Line from the command palette in the focused editor', async ({ target, workbench }) => {
	test.skip(
		target.appServerMode !== 'required' || target.workbenchMode !== 'code',
		'This scenario requires the Code App Server product',
	);

	const page = workbench.page;
	const fileRow = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
	await expect.poll(() => fileRow.count(), { timeout: 15_000 }).toBe(1);
	await fileRow.click();
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.press('F1');
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('Go to Line/Column');
	await expect(picker.locator('.ash-quick-pick-row-label').filter({ hasText: 'Go to Line/Column...' })).toBeVisible();
	await page.keyboard.press('Enter');

	const dialog = workbench.editors.groupAt(0).content.locator('.stanza-editor-goto-line-widget');
	await expect(dialog).toBeVisible();
	const lineInput = dialog.getByRole('textbox', { name: 'Line number and optional column' });
	await expect(lineInput).toBeFocused();
	await lineInput.fill('2:1');
	await lineInput.press('Enter');
	await expect(dialog).toBeHidden();
	await expect(input).toBeFocused();
});

test("Code highlights Rust locally and obtains document symbols asynchronously", async ({ target, workbench }) => {
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
	await expect(page.locator('.ash-quick-pick-row-label')).toContainText('main');
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
