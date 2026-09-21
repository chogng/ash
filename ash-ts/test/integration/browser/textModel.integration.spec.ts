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

test('switching a Workbench file keeps keyboard input on the new editor and releases the old one', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.locator('.stanza-editor-input').focus();
	const switched = await page.evaluate(() => window.ashTextModelIntegration.switchToOther());

	expect(switched).toEqual({
		paneOwnsEditor: true,
		oldEditorDisposed: true,
		oldModelDisposed: true,
		oldDomConnected: false,
		editorCount: 1,
		value: 'fn other() {\n  answer();\n}\n',
	});
	await expect(page.locator('.stanza-editor')).toHaveCount(1);
	await expect(page.locator('.stanza-editor')).toHaveAttribute('aria-label', 'other.ts');
	await expect(page.locator('.stanza-editor-input')).toBeFocused();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('!');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('fn other() {\n  answer();\n}\n!');
});

test('Code bundle activates text editor contributions and releases their UI', async ({ page }) => {
	await page.goto('/textModel.html');
	const ids = await page.evaluate(() => window.ashTextModelIntegration.getBundleIds());
	expect(ids).toContain('editor.contrib.clipboard');
	expect(await page.evaluate(() => window.ashTextModelIntegration.hasClipboardContribution())).toBe(true);
	expect(ids).toContain('editor.contrib.findController');
	expect(ids).not.toContain('editor.contrib.documentFormatting');
	expect(ids).not.toContain('editor.contrib.collaboration');
	expect(await page.evaluate(() => window.ashTextModelIntegration.hasPlaceholderContribution())).toBe(true);
	await expect(page.locator('.stanza-editor')).toBeVisible();
	await expect(page.locator('.stanza-structured-format-toolbar')).toHaveCount(0);
	const find = page.locator('.stanza-editor-find-widget');
	await expect(find).toHaveAttribute('role', 'dialog');
	await page.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+f');
	await expect(find).toBeVisible();
	await find.locator('input[aria-label="Find"]').fill('fn');
	await page.keyboard.press('Escape');
	await expect(find).toBeHidden();

	await page.evaluate(() => window.ashTextModelIntegration.dispose());
	await expect(page.locator('.stanza-editor')).toHaveCount(0);
	await expect(find).toHaveCount(0);
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
	const lineHeight = await editor.locator('.view-line').first().evaluate(element => element.getBoundingClientRect().height);

	const stableMove = await page.evaluate(() => {
		window.ashTextModelIntegration.setCursors([{ lineIndex: 1, columnIndex: 2 }]);
		const caret = document.querySelector<HTMLElement>('.stanza-editor-caret[data-selection-index="0"]');
		if (!caret) throw new Error("Moved cursor is missing");
		return { top: caret.style.top, transitionProperty: caret.style.transitionProperty };
	});
	expect(stableMove).toEqual({ top: `${lineHeight}px`, transitionProperty: "" });
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
	await expect(page.locator(".cdr.squiggly-error")).toHaveCount(1);
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
		const minimap = editor.querySelector<HTMLElement>(".minimap");
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
	const minimap = page.locator('.minimap');
	const slider = page.locator('.stanza-editor-minimap-slider');
	await page.locator('.stanza-editor').evaluate(element => {
		element.style.setProperty('--ash-scrollbar-slider-background', '#010203');
		element.style.setProperty('--ash-scrollbar-slider-hover-background', '#040506');
		element.style.setProperty('--ash-scrollbar-slider-active-background', '#070809');
	});
	await expect(slider).toHaveCSS('opacity', '0');
	await expect(slider).toHaveCSS('background-color', 'rgb(1, 2, 3)');
	await minimap.hover();
	await expect(slider).toHaveCSS('opacity', '1');
	await expect(slider).toHaveCSS('background-color', 'rgb(4, 5, 6)');

	await page.evaluate(() => window.ashTextModelIntegration.setValue(`fn main() {\n  answer();\n}\n${Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')}`));
	const editor = page.locator('.stanza-editor');
	await expect.poll(() => editor.evaluate(element => element.scrollHeight)).toBeGreaterThan(geometry.clientHeight);
	const sliderBox = await slider.boundingBox();
	const minimapBox = await minimap.boundingBox();
	assertBox(sliderBox, 'minimap slider');
	assertBox(minimapBox, 'minimap');
	await page.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2);
	await page.mouse.down();
	await expect(minimap).toHaveClass(/stanza-editor-minimap-dragging/u);
	await expect(slider).toHaveCSS('background-color', 'rgb(7, 8, 9)');
	await page.mouse.move(sliderBox.x + sliderBox.width / 2, minimapBox.y + minimapBox.height / 2, { steps: 5 });
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect.poll(() => slider.evaluate(element => Number.parseFloat(getComputedStyle(element).top))).toBeGreaterThan(0);
	await page.mouse.move(sliderBox.x + sliderBox.width / 2, minimapBox.y + minimapBox.height - 1, { steps: 5 });
	await expect.poll(() => editor.evaluate(element => element.scrollTop === element.scrollHeight - element.clientHeight)).toBe(true);
	await page.mouse.up();
	await expect(minimap).not.toHaveClass(/stanza-editor-minimap-dragging/u);
});

test('editor auto scrollbars reveal on hover, focus and scrolling and remain draggable', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n')));
	const editor = page.locator('.stanza-editor');
	const horizontal = editor.getByRole('scrollbar', { name: 'Horizontal scrollbar' });
	const vertical = editor.getByRole('scrollbar', { name: 'Vertical scrollbar' });
	await page.mouse.move(0, 0);
	await expect(vertical).toHaveCSS('opacity', '0');
	await editor.hover();
	for (const track of [horizontal, vertical]) {
		await expect(track).toHaveCSS('opacity', '1');
		await expect(track).toHaveCSS('pointer-events', 'auto');
	}
	await page.mouse.move(0, 0);
	await expect(vertical).toHaveCSS('opacity', '0');
	await vertical.focus();
	await expect(vertical).toHaveCSS('opacity', '1');
	await vertical.press('ArrowDown');
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(40);
	await expect(vertical).toHaveAttribute('aria-valuenow', '40');
	await vertical.evaluate(element => element.blur());
	await expect(vertical).toHaveCSS('opacity', '0');
	await page.evaluate(() => window.ashTextModelIntegration.setScrollLeft(160));
	await expect(horizontal).toHaveCSS('opacity', '1');
	await expect(horizontal).toHaveAttribute('aria-valuenow', '160');
	await editor.hover();
	const thumb = vertical.locator('.ash-scrollbar-thumb');
	const box = await thumb.boundingBox();
	assertBox(box, 'vertical scrollbar thumb');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 5 });
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(40);
	await expect.poll(() => editor.evaluate(element => element.scrollLeft)).toBe(160);
	await page.mouse.up();
	const remainingTracks = await editor.evaluate(element => {
		window.ashTextModelIntegration.setScrollLeft(200);
		window.ashTextModelIntegration.dispose();
		return element.querySelectorAll('[role="scrollbar"]').length;
	});
	expect(remainingTracks).toBe(0);
});

test('editor scrollbar configuration updates visibility and track dimensions', async ({ page }) => {
	await page.goto('/textModel.html');
	const horizontal = page.locator('.ash-smooth-scrollable > .ash-scrollbar-track-horizontal');
	const vertical = page.locator('.ash-smooth-scrollable > .ash-scrollbar-track-vertical');
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({
		horizontal: 'visible', vertical: 'visible', horizontalScrollbarSize: 18, verticalScrollbarSize: 22,
	}));
	await expect(horizontal).toBeVisible();
	await expect(vertical).toBeVisible();
	await expect(horizontal).toHaveCSS('opacity', '1');
	await expect(vertical).toHaveCSS('opacity', '1');
	await expect(horizontal).toHaveCSS('height', '18px');
	await expect(vertical).toHaveCSS('width', '22px');
	await expect(horizontal).toHaveCSS('right', '22px');
	await expect(vertical).toHaveCSS('bottom', '18px');
	await expect(vertical).toHaveAttribute('aria-disabled', 'true');
	await expect(vertical).toHaveCSS('pointer-events', 'none');
	const minimapBox = await page.locator('.minimap').boundingBox();
	const verticalBox = await vertical.boundingBox();
	assertBox(minimapBox, 'minimap');
	assertBox(verticalBox, 'vertical scrollbar');
	expect(minimapBox.x + minimapBox.width).toBeCloseTo(verticalBox.x, 0);

	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.setScrollbar({ horizontal: 'hidden', vertical: 'hidden' });
	});
	await expect(horizontal).toBeHidden();
	await expect(vertical).toBeHidden();
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ horizontal: 'auto', vertical: 'auto' }));
	await page.locator('.stanza-editor').hover();
	await expect(horizontal).toBeVisible();
	await expect(vertical).toBeVisible();
	await expect(vertical).toHaveCSS('pointer-events', 'auto');
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ horizontalScrollbarSize: 0, verticalScrollbarSize: 0 }));
	await expect(horizontal).toHaveCSS('height', '0px');
	await expect(vertical).toHaveCSS('width', '0px');
	await expect(horizontal).toBeHidden();
	await expect(vertical).toBeHidden();
	await expect(horizontal).toHaveAttribute('tabindex', '-1');
	await expect(vertical).toHaveAttribute('tabindex', '-1');
});

test('editor scrollbar uses wheel policy, slider dimensions and page clicks from configuration', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({
			mouseWheelScrollSensitivity: 2,
			fastScrollSensitivity: 3,
			scrollbar: { vertical: 'visible', horizontal: 'visible', verticalSliderSize: 6, horizontalSliderSize: 4, scrollByPage: true },
		});
	});
	const editor = page.locator('.stanza-editor');
	const horizontal = editor.getByRole('scrollbar', { name: 'Horizontal scrollbar' });
	const vertical = editor.getByRole('scrollbar', { name: 'Vertical scrollbar' });
	await expect(horizontal.locator('.ash-scrollbar-thumb')).toHaveCSS('height', '4px');
	await expect(vertical.locator('.ash-scrollbar-thumb')).toHaveCSS('width', '6px');
	await editor.dispatchEvent('wheel', { deltaY: 20, deltaMode: 0 });
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(40);
	await editor.dispatchEvent('wheel', { deltaY: 10, deltaMode: 0, altKey: true });
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(100);
	await editor.dispatchEvent('wheel', { deltaY: 10, deltaMode: 0, shiftKey: true });
	await expect.poll(() => editor.evaluate(element => element.scrollLeft)).toBe(20);
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ handleMouseWheel: false }));
	await editor.dispatchEvent('wheel', { deltaY: 20, deltaMode: 0 });
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(100);
	const box = await vertical.boundingBox();
	assertBox(box, 'vertical scrollbar');
	await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(520);
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ scrollByPage: false }));
	await page.locator('.decorationsOverviewRuler').dispatchEvent('pointerdown', {
		button: 0, buttons: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height - 3,
	});
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(520);
});

test('smooth scrolling keeps continuous and subpixel wheel input immediate', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({ smoothScrolling: true, inertialScroll: false, scrollPredominantAxis: false });
	});
	const editor = page.locator('.stanza-editor');
	await expect(editor.getByRole('scrollbar', { name: 'Vertical scrollbar' })).toBeVisible();
	await page.clock.install();
	await page.clock.pauseAt(new Date());
	for (const [deltaY, expected] of [[12, 12], [0.2, 13], [-0.2, 12]]) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		expect(await editor.evaluate(element => element.scrollTop)).toBe(expected);
	}
	await editor.dispatchEvent('wheel', { deltaX: 0.2, deltaY: 0.2, deltaMode: 0 });
	expect(await editor.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual({ left: 1, top: 13 });
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ mouseWheelScrollSensitivity: 0.1 }));
	await editor.dispatchEvent('wheel', { deltaY: 1, deltaMode: 0 });
	expect(await editor.evaluate(element => element.scrollTop)).toBe(14);
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ mouseWheelScrollSensitivity: 1 }));
	await editor.dispatchEvent('wheel', { deltaY: 5, deltaMode: 1 });
	expect(await editor.evaluate(element => element.scrollTop)).toBe(14);
	await page.clock.runFor(160);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(94);
});

test('editor scrollbar arrows support click, hold, keyboard and runtime removal', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.setScrollbar({
			vertical: 'visible', horizontal: 'visible', verticalHasArrows: true, horizontalHasArrows: true, arrowSize: 18,
		});
	});
	const editor = page.locator('.stanza-editor');
	const down = editor.getByRole('button', { name: 'Scroll down', exact: true });
	const up = editor.getByRole('button', { name: 'Scroll up', exact: true });
	const right = editor.getByRole('button', { name: 'Scroll right', exact: true });
	await expect(down).toHaveCSS('height', '18px');
	await expect(up).toBeDisabled();
	await down.click();
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(40);
	await right.focus();
	await page.keyboard.press('Enter');
	await expect.poll(() => editor.evaluate(element => element.scrollLeft)).toBe(40);
	const thumb = editor.locator('.ash-scrollbar-track-vertical .ash-scrollbar-thumb');
	const upBox = await up.boundingBox();
	const thumbBox = await thumb.boundingBox();
	assertBox(upBox, 'up arrow');
	assertBox(thumbBox, 'vertical thumb');
	expect(thumbBox.y).toBeGreaterThanOrEqual(upBox.y + upBox.height);

	await down.hover();
	await page.mouse.down();
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(80);
	await page.mouse.up();
	const released = await editor.evaluate(element => element.scrollTop);
	await page.waitForTimeout(180);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(released);
	await page.mouse.down();
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ verticalHasArrows: false, horizontalHasArrows: false }));
	await expect(down).toBeHidden();
	const disabled = await editor.evaluate(element => element.scrollTop);
	await page.waitForTimeout(400);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(disabled);
	await page.mouse.up();
	await expect(editor.locator('.ash-scrollbar-track-vertical')).toHaveCSS('top', '0px');
	await page.evaluate(() => {
		window.ashTextModelIntegration.setScrollbar({ verticalHasArrows: true });
		window.ashTextModelIntegration.setTheme('contrast');
	});
	await down.focus();
	await expect(down).toHaveCSS('outline-style', 'solid');
	const vertical = editor.getByRole('scrollbar', { name: 'Vertical scrollbar' });
	await vertical.focus();
	await page.keyboard.press('End');
	await expect(down).toBeDisabled();
	await up.focus();
	await page.keyboard.press('Space');
	await expect(down).toBeEnabled();
	await down.hover();
	await page.mouse.down();
	await page.evaluate(() => window.ashTextModelIntegration.dispose());
	await page.waitForTimeout(400);
	await page.mouse.up();
	await expect(page.locator('.ash-scrollbar-arrow')).toHaveCount(0);
});

test('editor inertial scrolling decays and stops on reversal, direct input and configuration changes', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({ inertialScroll: true, smoothScrolling: false });
	});
	const editor = page.locator('.stanza-editor');
	await page.clock.install();
	await page.clock.pauseAt(new Date());
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(160);
	const forward = await editor.evaluate(element => element.scrollTop);
	expect(forward).toBeGreaterThan(12);
	await editor.dispatchEvent('wheel', { deltaY: -8, deltaMode: 0 });
	await page.clock.runFor(80);
	expect(await editor.evaluate(element => element.scrollTop)).toBeLessThan(forward - 8);
	await editor.dispatchEvent('keydown', { key: 'Escape' });
	const interrupted = await editor.evaluate(element => element.scrollTop);
	await page.clock.runFor(200);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(interrupted);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ inertialScroll: false }));
	const disabled = await editor.evaluate(element => element.scrollTop);
	await page.clock.runFor(500);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(disabled);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(500);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(disabled + 12);
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ inertialScroll: true }));
	await editor.dispatchEvent('wheel', { deltaY: 3, deltaMode: 1 });
	const discrete = await editor.evaluate(element => element.scrollTop);
	await page.clock.runFor(500);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(discrete);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(1500);
	const settled = await editor.evaluate(element => element.scrollTop);
	await page.clock.runFor(500);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(settled);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.evaluate(() => window.ashTextModelIntegration.setValue('short\nshort\nshort'));
	await page.clock.runFor(500);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(0);
	await page.evaluate(() => window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'line').join('\n')));
	await page.clock.runFor(32);
	await editor.getByRole('scrollbar', { name: 'Vertical scrollbar' }).dispatchEvent('keydown', { key: 'End' });
	await page.clock.runFor(32);
	const bottom = await editor.evaluate(element => element.scrollTop);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(1500);
	expect(await editor.evaluate(element => element.scrollTop)).toBe(bottom);
	await editor.dispatchEvent('wheel', { deltaY: -12, deltaMode: 0 });
	await page.evaluate(() => window.ashTextModelIntegration.dispose());
	await page.clock.runFor(1500);
	await expect(page.locator('.ash-smooth-scrollable')).toHaveCount(0);
});

test('editor distinguishes accelerating pixel input from fixed wheel steps before applying sensitivity', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 1000 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({ inertialScroll: true, smoothScrolling: false, mouseWheelScrollSensitivity: 2 });
	});
	await page.clock.install();
	await page.clock.pauseAt(new Date());
	const editor = page.locator('.stanza-editor');
	// At the top edge the same unconsumed event reaches both wheel listeners.
	await editor.dispatchEvent('wheel', { deltaY: -60, deltaMode: 0 });
	await editor.dispatchEvent('wheel', { deltaY: 120, deltaMode: 0 });
	const edgeInput = await editor.evaluate(element => element.scrollTop);
	await page.clock.runFor(32);
	expect(await editor.evaluate(element => element.scrollTop)).toBeGreaterThan(edgeInput);
	// Large integer pixel deltas remain continuous when their step varies.
	for (const deltaY of [134, 83, 62, 72, 101]) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		const immediate = await editor.evaluate(element => element.scrollTop);
		await page.clock.runFor(32);
		expect(await editor.evaluate(element => element.scrollTop)).toBeGreaterThan(immediate);
	}
	await editor.dispatchEvent('keydown', { key: 'Escape' });
	await page.clock.runFor(150);
	for (const deltaY of [40, 80, 160, 40]) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		const immediate = await editor.evaluate(element => element.scrollTop);
		await page.clock.runFor(80);
		expect(await editor.evaluate(element => element.scrollTop)).toBe(immediate);
	}
	// Fractional notch sizes become discrete after the repeated step is observed.
	for (const [index, deltaY] of [60, 60, 120, 120, 60].entries()) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		const immediate = await editor.evaluate(element => element.scrollTop);
		await page.clock.runFor(32);
		if (index > 0) {
			expect(await editor.evaluate(element => element.scrollTop)).toBe(immediate);
		}
	}
	await editor.dispatchEvent('wheel', { deltaY: 47, deltaX: 9, deltaMode: 0 });
	const switched = await editor.evaluate(element => element.scrollTop);
	await page.clock.runFor(32);
	expect(await editor.evaluate(element => element.scrollTop)).toBeGreaterThan(switched);
});

test('editor surface and diagnostic colors follow the current Ash theme', async ({ page }) => {
	await page.goto('/textModel.html');
	const editor = page.locator('.stanza-editor');
	const diagnostic = page.locator('.cdr.squiggly-error');
	await expect(diagnostic).toHaveCount(1);
	for (const theme of ['dark', 'light', 'contrast'] as const) {
		await page.evaluate(value => window.ashTextModelIntegration.setTheme(value), theme);
		const colors = await editor.evaluate(element => {
			const style = getComputedStyle(element);
			const marker = element.querySelector('.squiggly-error');
			if (!marker) throw new Error('Missing diagnostic');
			const probe = element.ownerDocument.createElement('span');
			probe.style.color = 'var(--ash-editor-foreground)';
			probe.style.backgroundColor = 'var(--ash-editor-background)';
			probe.style.borderColor = 'var(--ash-error-foreground)';
			element.append(probe);
			const expected = getComputedStyle(probe);
			const result = {
				actual: [style.color, style.backgroundColor, getComputedStyle(marker).borderBottomColor],
				expected: [expected.color, expected.backgroundColor, expected.borderColor],
			};
			probe.remove();
			return result;
		});
		expect(colors.actual).toEqual(colors.expected);
	}
});

test('editor-owned colors preserve focused cursors, line borders and rulers in all four themes', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({
		rulers: [12], renderLineHighlight: 'all', cursorBlinking: 'solid',
	}));
	const input = page.locator('.stanza-editor-input');
	await input.focus();
	const cursor = page.locator('.cursors-layer > .cursor').first();
	const line = page.locator('.view-overlays .current-line-exact').first();
	const ruler = page.locator('.stanza-editor-ruler').first();
	const palettes = [
		{ theme: 'dark', cursor: 'rgb(174, 175, 173)', line: 'rgb(40, 40, 40)', ruler: 'rgb(90, 90, 90)', border: '2px' },
		{ theme: 'light', cursor: 'rgb(0, 0, 0)', line: 'rgb(238, 238, 238)', ruler: 'rgb(211, 211, 211)', border: '2px' },
		{ theme: 'contrast', cursor: 'rgb(255, 255, 255)', line: 'rgb(243, 133, 24)', ruler: 'rgb(255, 255, 255)', border: '1px' },
		{ theme: 'contrastLight', cursor: 'rgb(15, 74, 133)', line: 'rgb(15, 74, 133)', ruler: 'rgb(41, 41, 41)', border: '1px' },
	] as const;
	for (const palette of palettes) {
		await page.evaluate(theme => window.ashTextModelIntegration.setTheme(theme), palette.theme);
		await expect(input).toBeFocused();
		await expect(cursor).toHaveCSS('background-color', palette.cursor);
		await expect(line).toHaveCSS('border-top-color', palette.line);
		await expect(line).toHaveCSS('border-top-width', palette.border);
		await expect(ruler).toHaveCSS('background-color', palette.ruler);
	}
});

test("glyph margin, line numbers, and folding controls keep VS Code gutter order", async ({ page }) => {
	await page.goto("/textModel.html");
	const glyphMargin = page.locator(".glyph-margin");
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
			'.decorationsOverviewRuler',
			'.ash-smooth-scrollable > .ash-scrollbar-track-horizontal',
			'.ash-smooth-scrollable > .ash-scrollbar-track-vertical',
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
	const viewportBracket = page.locator('.view-line .stanza-editor-bracket-level-1').first();
	const richBracket = screenReaderContent.locator('.stanza-editor-bracket-level-1').first();
	await expect(richBracket).toHaveCSS('color', await viewportBracket.evaluate(element => getComputedStyle(element).color));
	expect(await richBracket.evaluate(element => getComputedStyle(element).color)).not.toBe(await editor.evaluate(element => getComputedStyle(element).color));
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


test('large multiline keyboard input replaces the selection and keeps the editor responsive', async ({ page }) => {
	await page.goto('/textModel.html');
	const input = page.locator('.stanza-editor-input');
	await input.focus();
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	const content = Array.from({ length: 200 }, (_, index) => `line${index}${'文🙂x'.repeat(60)}`).join('\n');
	await page.keyboard.insertText(content);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(content);
	await page.keyboard.insertText('!');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(content + '!');
	await expect(page.locator('.view-line[data-logical-line-index="199"]')).toBeVisible();
});
