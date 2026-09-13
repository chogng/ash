import { expect, test } from "@playwright/test";
import { getAxeResults, injectAxe } from "axe-playwright";

const pageErrors = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", error => errors.push(error.stack ?? error.message));
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => {
		window.ashTextModelIntegration?.dispose();
	}).catch(() => undefined);
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

test("text-model editor public API, pane, undo, save, and browser worker", async ({ page }) => {
	const workers: string[] = [];
	page.on("worker", worker => workers.push(worker.url()));
	await page.goto("/textModel.html");
	await expect(page.locator(".stanza-editor")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.apiText)).toBe("editor-api");

	const input = page.locator(".stanza-editor-input");
	await input.focus();
	await page.keyboard.press("Control+Home");
	const caret = page.locator('.stanza-editor-caret.primary');
	await expect(caret).toHaveClass(/cursor-style-line/u);
	await page.keyboard.press('Insert');
	await expect(caret).toHaveClass(/cursor-style-block/u);
	await expect(caret).toHaveClass(/token-keyword/u);
	await expect(caret).toHaveText('f');
	await page.keyboard.press('Insert');
	await expect(caret).toHaveClass(/cursor-style-line/u);
	await page.keyboard.type("integrated");
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe("integratedfn main() {\n  answer();\n}\n");

	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe("fn main() {\n  answer();\n}\n");
	await page.evaluate(() => window.ashTextModelIntegration.save());
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSavedText())).toBe("fn main() {\n  answer();\n}\n");
	await expect.poll(() => workers.length).toBeGreaterThan(0);
});

test('textarea fallback routes type and composition through the standard input pipeline', async ({ page }) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, 'EditContext');
	});
	await page.goto('/textModel.html');
	const editor = page.locator('.stanza-editor');
	const input = page.locator('textarea.stanza-editor-input');
	await input.focus();
	await page.evaluate(() => window.ashTextModelIntegration.setCursors([{ lineIndex: 0, columnIndex: 0 }]));
	await page.keyboard.type('x');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^xfn main/u);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^fn main/u);

	await input.evaluate(element => {
		element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
	});
	await expect(editor).toHaveClass(/\bcomposing\b/u);
	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.value = 'xy';
		textArea.setSelectionRange(1, 1);
		textArea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'xy' }));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^xyfn main/u);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 1,
	});
	await input.evaluate(element => {
		element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'xy' }));
	});
	await expect(editor).not.toHaveClass(/\bcomposing\b/u);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^fn main/u);
});

test("cursor layer retains nodes, animates stable moves, and resolves multi-cursor colors", async ({ page }) => {
	await page.goto("/textModel.html");
	await expect(page.locator(".stanza-editor")).toBeVisible();
	await expect(page.locator(".stanza-editor-token.token-keyword")).toHaveText("fn");
	const editor = page.locator(".stanza-editor");
	const layer = editor.locator(".stanza-editor-cursors-layer");
	const retainedCaret = layer.locator('.stanza-editor-caret[data-selection-index="0"]');
	await expect(layer).toHaveClass(/cursor-smooth-caret-animation/u);
	await retainedCaret.evaluate(element => { element.dataset.retainedIdentity = "true"; });

	const stableMove = await page.evaluate(() => {
		window.ashTextModelIntegration.setCursors([{ lineIndex: 1, columnIndex: 2 }]);
		const caret = document.querySelector<HTMLElement>('.stanza-editor-caret[data-selection-index="0"]');
		if (!caret) throw new Error("Moved cursor is missing");
		return { top: caret.style.top, transitionProperty: caret.style.transitionProperty };
	});
	expect(stableMove).toEqual({ top: "20px", transitionProperty: "" });
	await expect(retainedCaret).toHaveAttribute("data-retained-identity", "true");

	await editor.evaluate(element => {
		element.style.setProperty("--ash-editor-multi-cursor-primary-foreground", "#010203");
		element.style.setProperty("--ash-editor-multi-cursor-secondary-foreground", "#040506");
	});
	const countChangeTransitions = await page.evaluate(() => {
		window.ashTextModelIntegration.setCursors([
			{ lineIndex: 0, columnIndex: 0 },
			{ lineIndex: 1, columnIndex: 2 },
		], 1);
		return [...document.querySelectorAll<HTMLElement>(".stanza-editor-caret")]
			.map(caret => caret.style.transitionProperty);
	});
	expect(countChangeTransitions).toEqual(["none", "none"]);
	const primary = layer.locator(".stanza-editor-caret.cursor-primary");
	const secondary = layer.locator(".stanza-editor-caret.cursor-secondary");
	await expect(primary).toHaveCount(1);
	await expect(secondary).toHaveCount(1);
	await expect(primary).toHaveCSS("background-color", "rgb(1, 2, 3)");
	await expect(secondary).toHaveCSS("background-color", "rgb(4, 5, 6)");

	await page.locator(".stanza-editor-input").focus();
	await page.keyboard.press("Insert");
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue("fn main() {\n  A👩‍🔧B answer();\n}\n");
		window.ashTextModelIntegration.setCursors([{ lineIndex: 1, columnIndex: 4 }]);
	});
	await expect(retainedCaret).toHaveText("👩‍🔧");
	await page.keyboard.press("Insert");

	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 60 }, (_, index) => `fn main() { answer(); } // ${index}`).join("\n"));
		window.ashTextModelIntegration.setCursors([{ lineIndex: 59, columnIndex: 0 }]);
	});
	await expect(retainedCaret).toHaveAttribute("data-retained-identity", "true");
	await expect(retainedCaret).toHaveCSS("display", "none");
	await page.evaluate(() => window.ashTextModelIntegration.revealPosition(59, 0));
	await expect(retainedCaret).toHaveCSS("display", "block");
	await expect(retainedCaret).toHaveAttribute("data-retained-identity", "true");
});

test("text-model editor projects revision-bound Rust syntax, diagnostics, folding, and symbols", async ({ page }) => {
	await page.goto("/textModel.html");
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSyntaxAnalysisCount())).toBeGreaterThan(0);
	await expect(page.locator(".stanza-editor-token.token-keyword")).toHaveText("fn");
	await expect(page.locator(".stanza-editor-diagnostic-marker.error")).toHaveCount(1);
	const symbolIcon = page.locator(".stanza-editor-symbol-icon");
	await expect(symbolIcon).toHaveCount(1);
	await expect(symbolIcon).toHaveAttribute("title", "main");
	await expect(symbolIcon).toHaveClass(/\bcldr\b/u);
	await expect(symbolIcon).toHaveClass(/\bstanza-editor-line-decoration\b/u);

	const input = page.locator(".stanza-editor-input");
	await input.focus();
	await page.keyboard.press("ControlOrMeta+Shift+o");
	await expect(page.locator(".stanza-editor-goto-symbol-item")).toHaveText("main");
});

test("short documents have no false scroll range and use a proportional hover slider", async ({ page }) => {
	await page.goto("/textModel.html");
	await expect(page.locator(".stanza-editor")).toBeVisible();
	const geometry = await page.locator(".stanza-editor").evaluate(editor => {
		const minimap = editor.querySelector<HTMLElement>(".stanza-editor-minimap");
		const slider = editor.querySelector<HTMLElement>(".stanza-editor-minimap-slider");
		if (!minimap || !slider) throw new Error("Missing minimap geometry");
		return {
			clientHeight: editor.clientHeight,
			scrollHeight: editor.scrollHeight,
			scrollTop: editor.scrollTop,
			sliderHidden: slider.hidden,
			sliderHeight: slider.getBoundingClientRect().height,
			minimapHeight: minimap.getBoundingClientRect().height,
		};
	});

	expect(geometry.scrollHeight).toBe(geometry.clientHeight);
	expect(geometry.scrollTop).toBe(0);
	expect(geometry.sliderHidden).toBe(false);
	expect(geometry.sliderHeight).toBeLessThan(geometry.minimapHeight);
	const minimap = page.locator('.stanza-editor-minimap');
	const slider = page.locator('.stanza-editor-minimap-slider');
	await expect(slider).toHaveCSS('opacity', '0');
	await minimap.hover();
	await expect(slider).toHaveCSS('opacity', '1');
});

test("glyph margin, line numbers, and folding controls keep VS Code gutter order", async ({ page }) => {
	await page.goto("/textModel.html");
	const glyphMargin = page.locator(".stanza-editor-glyph-margin");
	const foldingControl = page.locator('.ash-icon-folding-expanded').first();
	await expect(glyphMargin).toBeVisible();
	await expect(foldingControl).toBeVisible();
	const firstLine = page.locator(".view-line[data-logical-line-index='0']");
	await expect(page.locator('.view-lines')).toHaveCSS('cursor', 'text');
	const firstLineNumber = page.locator(".margin-view-overlays .view-overlay-line[data-line-index='0'] .line-numbers");
	await expect(firstLineNumber).toHaveText("1");
	const foldingBox = await foldingControl.boundingBox();
	const glyphMarginBox = await glyphMargin.boundingBox();
	const lineNumberBox = await firstLineNumber.boundingBox();
	const textBox = await firstLine.locator(".stanza-editor-line-text").boundingBox();
	assertBox(foldingBox, "folding control");
	assertBox(glyphMarginBox, "glyph margin");
	assertBox(lineNumberBox, "line number");
	assertBox(textBox, "line text");

	expect(glyphMarginBox.x + glyphMarginBox.width).toBe(lineNumberBox.x);
	expect(lineNumberBox.x + lineNumberBox.width).toBeLessThanOrEqual(foldingBox.x);
	expect(foldingBox.x + foldingBox.width).toBeLessThanOrEqual(textBox.x);

	const editor = page.locator(".stanza-editor");
	const input = page.locator(".stanza-editor-input");
	await input.focus();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type("x".repeat(200));
	await expect.poll(() => editor.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
	await page.evaluate(() => window.ashTextModelIntegration.setScrollLeft(160));
	const editorBox = await editor.boundingBox();
	const scrolledGlyphMarginBox = await glyphMargin.boundingBox();
	const scrolledFoldingBox = await foldingControl.boundingBox();
	const scrolledLineNumberBox = await firstLineNumber.boundingBox();
	assertBox(editorBox, "editor");
	assertBox(scrolledGlyphMarginBox, "scrolled glyph margin");
	assertBox(scrolledFoldingBox, "scrolled folding control");
	assertBox(scrolledLineNumberBox, "scrolled line number");

	expect(scrolledGlyphMarginBox.x).toBe(editorBox.x);
	expect(scrolledGlyphMarginBox.x + scrolledGlyphMarginBox.width).toBe(scrolledLineNumberBox.x);
	expect(scrolledLineNumberBox.x + scrolledLineNumberBox.width).toBe(scrolledFoldingBox.x);
});

test('view zones use the standard accessor, whitespace geometry, and disposal chain', async ({ page }) => {
	await page.goto('/textModel.html');
	const editor = page.locator('.stanza-editor');
	const baseGeometry = await editor.evaluate(element => {
		const firstLine = element.querySelector<HTMLElement>('.view-line[data-logical-line-index="0"]');
		if (!firstLine) throw new Error('Missing first editor line');
		const positionedLayers = [
			'.stanza-editor-content',
			'.stanza-native-ime-text-area',
			'.stanza-native-edit-context',
			'.minimap',
			'.stanza-editor-overview-ruler',
			'.stanza-editor-scrollbar-track-horizontal',
			'.stanza-editor-scrollbar-track-vertical',
		].map(selector => {
			const layer = element.querySelector<HTMLElement>(selector);
			if (!layer) throw new Error(`Missing editor layer '${selector}'`);
			return getComputedStyle(layer).position;
		});
		return {
			clientWidth: element.clientWidth,
			clientHeight: element.clientHeight,
			lineHeight: firstLine.getBoundingClientRect().height,
			lineCount: element.querySelectorAll('.view-line[data-logical-line-index]').length,
			positionedLayers,
		};
	});
	expect(baseGeometry.clientWidth).toBe(900);
	expect(baseGeometry.clientHeight).toBe(420);
	expect(baseGeometry.positionedLayers).toEqual(Array.from({ length: 7 }, () => 'absolute'));
	await page.evaluate(() => window.ashTextModelIntegration.showViewZone());
	const zone = page.locator('.ash-view-zone-probe');
	await expect(zone).toHaveAttribute('data-visible-view-zone', 'true');
	await expect(zone).toHaveCSS('top', `${baseGeometry.lineHeight}px`);
	await expect(zone).toHaveCSS('height', '500px');
	await expect.poll(() => editor.evaluate(element => ({ scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight }))).toEqual({
		scrollWidth: 1_200,
		scrollHeight: baseGeometry.lineHeight * baseGeometry.lineCount + 500,
	});
	await page.evaluate(() => window.ashTextModelIntegration.removeViewZone());
	await expect(zone).toHaveCount(0);
	await expect.poll(() => editor.evaluate(element => ({ scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight }))).toEqual({
		scrollWidth: baseGeometry.clientWidth,
		scrollHeight: baseGeometry.clientHeight,
	});
});

test('content and glyph margin widgets use the standard editor ports in Chromium', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => window.ashTextModelIntegration.showWidgets());
	const editor = page.locator('.stanza-editor');
	const contentWidget = page.locator('.ash-content-widget-probe');
	const glyphWidget = page.locator('.ash-glyph-widget-probe');
	await expect(contentWidget).toBeVisible();
	await expect(glyphWidget).toBeVisible();
	await expect(page.locator('.ash-model-glyph-lower')).toHaveCount(0);
	await expect(page.locator('.ash-model-glyph-higher')).toBeVisible();
	const initial = await editor.evaluate(element => {
		const line = element.querySelector<HTMLElement>('.view-line[data-logical-line-index="0"]');
		const glyph = element.querySelector<HTMLElement>('.ash-glyph-widget-probe');
		const content = element.querySelector<HTMLElement>('.ash-content-widget-probe');
		if (!line || !glyph || !content) throw new Error('Widget probe geometry is incomplete');
		return {
			lineTop: line.getBoundingClientRect().top,
			lineHeight: line.getBoundingClientRect().height,
			glyphTop: glyph.getBoundingClientRect().top,
			contentWidth: content.getBoundingClientRect().width,
			contentHeight: content.getBoundingClientRect().height,
		};
	});
	expect(initial.glyphTop).toBe(initial.lineTop);
	expect(initial.contentWidth).toBeGreaterThan(0);
	expect(initial.contentHeight).toBeGreaterThan(0);
	await page.evaluate(() => window.ashTextModelIntegration.moveGlyphWidget(2));
	await expect.poll(() => glyphWidget.evaluate(element => element.getBoundingClientRect().top)).toBe(initial.lineTop + initial.lineHeight * 2);
	await page.evaluate(() => window.ashTextModelIntegration.removeWidgets());
	await expect(contentWidget).toHaveCount(0);
	await expect(glyphWidget).toHaveCount(0);
	await expect(page.locator('.ash-model-glyph-higher')).toHaveCount(0);
});

test('model decorations render through the standard overlay in Chromium', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => window.ashTextModelIntegration.showModelDecorations());
	const inline = page.locator('.ash-model-decoration-inline');
	const wholeLine = page.locator('.ash-model-decoration-whole');
	const collapsed = page.locator('.ash-model-decoration-collapsed');
	const lineDecoration = page.locator('.ash-model-line-decoration');
	const firstLineDecoration = page.locator('.ash-model-first-line-decoration');
	const blockDecoration = page.locator('.ash-model-block-decoration');
	await expect(inline).toHaveCount(1);
	await expect(wholeLine).toHaveCount(1);
	await expect(collapsed).toHaveCount(1);
	await expect(lineDecoration).toHaveCount(2);
	await expect(firstLineDecoration).toHaveCount(1);
	await expect(lineDecoration.first()).toHaveAttribute('title', 'Model line decoration');
	await expect(blockDecoration).toHaveCount(1);
	const geometry = await page.locator('.stanza-editor').evaluate(element => {
		const inlineDecoration = element.querySelector<HTMLElement>('.ash-model-decoration-inline');
		const wholeLineDecoration = element.querySelector<HTMLElement>('.ash-model-decoration-whole');
		const collapsedDecoration = element.querySelector<HTMLElement>('.ash-model-decoration-collapsed');
		if (!inlineDecoration || !wholeLineDecoration || !collapsedDecoration) throw new Error('Model decoration geometry is incomplete');
		return {
			inlineWidth: inlineDecoration.getBoundingClientRect().width,
			wholeLineWidth: wholeLineDecoration.getBoundingClientRect().width,
			collapsedWidth: collapsedDecoration.getBoundingClientRect().width,
		};
	});
	expect(geometry.inlineWidth).toBeGreaterThan(0);
	expect(geometry.wholeLineWidth).toBeGreaterThan(geometry.inlineWidth);
	expect(geometry.collapsedWidth).toBeGreaterThan(0);
	await page.evaluate(() => window.ashTextModelIntegration.removeModelDecorations());
	await expect(inline).toHaveCount(0);
	await expect(wholeLine).toHaveCount(0);
	await expect(collapsed).toHaveCount(0);
	await expect(lineDecoration).toHaveCount(0);
	await expect(firstLineDecoration).toHaveCount(0);
	await expect(blockDecoration).toHaveCount(0);
});

test("text-model editor has the accessibility contract", async ({ page }) => {
	await page.goto("/textModel.html");
	const editor = page.locator(".stanza-editor");
	const input = page.locator(".stanza-editor-input");
	await expect(editor).toHaveAttribute("role", "region");
	await expect(editor).toHaveAttribute("aria-label", /.+/);
	await expect(input).toHaveAttribute("aria-multiline", "true");
	await expect(input).toHaveAttribute("aria-roledescription", "code editor");
	await input.focus();
	const screenReaderContent = input.locator('.stanza-native-screen-reader-content');
	await expect(screenReaderContent).toContainText('fn main()');
	await page.waitForTimeout(110);
	await screenReaderContent.evaluate(element => {
		const text = element.firstChild;
		if (!text) throw new Error('Simple screen-reader content has no text node');
		const selection = element.ownerDocument.getSelection();
		if (!selection) throw new Error('Document selection is unavailable');
		selection.setBaseAndExtent(text, 1, text, 3);
		element.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 3,
	});
	await screenReaderContent.evaluate(element => { element.dataset.contentKind = 'simple'; });

	await page.evaluate(() => window.ashTextModelIntegration.setRenderRichScreenReaderContent(true));
	await expect(input.locator('[data-content-kind="simple"]')).toHaveCount(0);
	await expect(screenReaderContent.locator('span[data-line-index]')).not.toHaveCount(0);
	await page.waitForTimeout(110);
	await screenReaderContent.evaluate(element => {
		const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const text = walker.nextNode();
		if (!text) throw new Error('Rich screen-reader content has no text node');
		const selection = element.ownerDocument.getSelection();
		if (!selection) throw new Error('Document selection is unavailable');
		selection.setBaseAndExtent(text, 0, text, 2);
		element.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 0,
		endLineIndex: 0,
		endColumnIndex: 2,
	});
	await screenReaderContent.evaluate(element => { element.dataset.contentKind = 'rich'; });

	await page.evaluate(() => window.ashTextModelIntegration.setRenderRichScreenReaderContent(false));
	await expect(input.locator('[data-content-kind="rich"]')).toHaveCount(0);
	await expect(screenReaderContent).toContainText('fn main()');
	await expect(screenReaderContent.locator('span[data-line-index]')).toHaveCount(0);

	await injectAxe(page);
	const accessibility = await getAxeResults(page, undefined, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } });
	expect(accessibility.violations.filter(violation => violation.impact === "critical")).toEqual([]);
	const contrast = await getAxeResults(page, undefined, { runOnly: { type: "rule", values: ["color-contrast"] } });
	expect(contrast.violations).toEqual([]);
});

test('textarea system-caret movement updates the editor only while focused', async ({ page }) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, 'EditContext');
	});
	await page.goto('/textModel.html');
	const input = page.locator('textarea.stanza-editor-input');
	await expect(input).toHaveCount(1);
	await input.focus();
	await page.waitForTimeout(110);
	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(1, 3, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 3,
	});

	await input.blur();
	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(0, 1, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 3,
	});
});

test('textarea clipboard events pass through TextAreaInput semantic events', async ({ page }) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, 'EditContext');
	});
	await page.goto('/textModel.html');
	const input = page.locator('textarea.stanza-editor-input');
	await input.focus();
	await page.waitForTimeout(110);
	const copied = await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(1, 3, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
		const clipboardData = new DataTransfer();
		const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
		textArea.dispatchEvent(event);
		return { defaultPrevented: event.defaultPrevented, text: clipboardData.getData('text/plain') };
	});
	expect(copied).toEqual({ defaultPrevented: true, text: 'n ' });

	await input.evaluate(element => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', 'ZZ');
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^fZZmain\(\)/u);
	await expect(input).toHaveValue(/^fZZmain\(\)/u);
	await page.waitForTimeout(110);

	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(0, 3, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
		textArea.dispatchEvent(new ClipboardEvent('cut', {
			bubbles: true,
			cancelable: true,
			clipboardData: new DataTransfer(),
		}));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^main\(\)/u);
});

function assertBox(box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null, name: string): asserts box is { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
	expect(box, `Expected ${name} geometry`).not.toBeNull();
}
