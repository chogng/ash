import { expect, test, type Page } from '@playwright/test';

const pageErrors = new WeakMap<object, string[]>();

interface GpuEditorState {
	readonly valueRestored: boolean;
	readonly lineNumber: string | null;
	readonly canvasVisible: boolean;
	readonly allRowsUseGpu: boolean;
	readonly longLineWrapped: boolean;
	readonly rowsHaveCanonicalSpacing: boolean;
	readonly hiddenCanvasUsesDisplayNone: boolean;
	readonly glyphMarginTouchesLineNumber: boolean;
	readonly lineNumberTouchesFolding: boolean;
	readonly foldingPrecedesText: boolean;
}

interface ClearedGpuEditorState {
	readonly value: string;
	readonly lineNumber: string | null;
	readonly renderedRowCount: number;
	readonly gpuRowCount: number;
	readonly text: string | null;
}

interface GpuFrameLayeringState {
	readonly hasFrame: boolean;
	readonly everyFrameIsLayered: boolean;
}

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.ashGpuTextIntegration?.dispose()).catch(() => undefined);
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

test('GPU text keeps wrapped rows disjoint and the gutter in VS Code order', async ({ page }) => {
	await page.goto('/gpuText.html');
	await expect(page.locator('.stanza-editor-gpu-canvas')).toBeVisible();
	await expect(page.locator('.margin-view-overlays .view-overlay-line[data-line-index="0"] .ash-icon-folding-expanded')).toBeVisible();
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	await expectGpuAdvanceMatchesDom(page);

	const input = page.locator('.stanza-editor-input');
	await input.focus();
	await page.evaluate(() => window.ashGpuTextIntegration.resetGpuFrameTrace());
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect.poll(() => clearedGpuEditorState(page)).toEqual({
		value: '',
		lineNumber: '1',
		renderedRowCount: 1,
		gpuRowCount: 1,
		text: '',
	});
	await expect.poll(() => gpuFrameLayeringState(page)).toEqual({ hasFrame: true, everyFrameIsLayered: true });

	await page.evaluate(() => window.ashGpuTextIntegration.resetGpuFrameTrace());
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('.margin-view-overlays .view-overlay-line[data-line-index="0"] .ash-icon-folding-expanded')).toBeVisible();
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	await expect.poll(() => gpuFrameLayeringState(page)).toEqual({ hasFrame: true, everyFrameIsLayered: true });
	await expectGpuAdvanceMatchesDom(page);
});

test('GPU caret uses the same text origin as DOM rendering', async ({ page }) => {
	await page.goto('/gpuText.html');
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	await page.locator('.stanza-editor-input').focus();
	await page.keyboard.press('Control+Home');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.evaluate(() => window.ashGpuTextIntegration.setFontLigatures(true));
	await expect(page.locator('.view-line.gpu-rendered')).toHaveCount(0);
	const caret = page.locator('.stanza-editor-caret.primary');
	const domBounds = await caret.boundingBox();
	expect(domBounds).not.toBeNull();
	await page.evaluate(() => window.ashGpuTextIntegration.setFontLigatures(false));
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	await expect.poll(async () => {
		const gpuBounds = await caret.boundingBox();
		return gpuBounds ? Math.abs(gpuBounds.x - domBounds!.x) : Number.POSITIVE_INFINITY;
	}).toBeLessThan(2);
});

test('GPU text clicks retain the rendered insertion position through pointer capture', async ({ page }) => {
	await page.goto('/gpuText.html');
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	const text = await page.evaluate(() => window.ashGpuTextIntegration.initialText.split('\n')[0]!);
	for (const offset of [text.length, 17]) {
		const point = await page.evaluate(({ text, offset }) => {
			const row = document.querySelector<HTMLElement>('.view-line')!;
			const bounds = row.getBoundingClientRect();
			return { x: bounds.left + window.ashGpuTextIntegration.measureGpuAdvance(text.slice(0, offset)) - 0.25, y: bounds.top + bounds.height / 2 };
		}, { text, offset });
		await page.mouse.move(point.x, point.y);
		await page.mouse.down();
		await page.mouse.move(point.x - 0.5, point.y + 0.25);
		await page.mouse.up();
		await expect.poll(async () => {
			const caret = await page.locator('.stanza-editor-caret.primary').boundingBox();
			return caret ? Math.abs(caret.x - point.x) : Number.POSITIVE_INFINITY;
		}).toBeLessThan(2);
		await page.keyboard.insertText('!');
		await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.getValue().split('\n')[0])).toBe(`${text.slice(0, offset)}!${text.slice(offset)}`);
		await page.keyboard.press('Backspace');
		await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.getValue().split('\n')[0])).toBe(text);
	}
});

test('GPU dragging keeps the highlight and active caret on the selected glyphs', async ({ page }) => {
	await page.goto('/gpuText.html');
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	const text = await page.evaluate(() => window.ashGpuTextIntegration.initialText.split('\n')[0]!);
	for (const backward of [false, true]) {
		const points = await page.evaluate(text => {
			const row = document.querySelector<HTMLElement>('.view-line')!.getBoundingClientRect();
			return [4, 17].map(offset => ({ x: row.left + window.ashGpuTextIntegration.measureGpuAdvance(text.slice(0, offset)), y: row.top + row.height / 2, top: row.top, height: row.height }));
		}, text);
		const anchor = backward ? 1 : 0;
		const active = 1 - anchor;
		await page.mouse.move(points[anchor]!.x - 0.25, points[anchor]!.y);
		await page.mouse.down();
		await page.mouse.move(points[active]!.x - 0.25, points[active]!.y, { steps: 8 });
		await page.mouse.up();
		await expect(page.locator('.stanza-editor-selection')).toHaveCount(1);
		await expect.poll(async () => {
			const selection = await page.locator('.stanza-editor-selection').boundingBox();
			const caret = await page.locator('.stanza-editor-caret.primary').boundingBox();
			if (!selection || !caret) return Number.POSITIVE_INFINITY;
			return Math.max(
				Math.abs(selection.x - points[0]!.x),
				Math.abs(selection.width - (points[1]!.x - points[0]!.x)),
				Math.abs(selection.y - points[0]!.top),
				Math.abs(selection.height - points[0]!.height),
				Math.abs(caret.x - points[active]!.x),
				Math.abs(caret.y - points[active]!.top),
			);
		}).toBeLessThan(2);
		await page.keyboard.insertText('!');
		await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.getValue().split('\n')[0])).toBe(`${text.slice(0, 4)}!${text.slice(17)}`);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	}
});

async function expectGpuAdvanceMatchesDom(page: Page): Promise<void> {
	// Ligatures select the DOM renderer; GPU rows need not retain hidden DOM text.
	await page.evaluate(() => window.ashGpuTextIntegration.setFontLigatures(true));
	await expect(page.locator('.view-line.gpu-rendered')).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => {
		const line = [...document.querySelectorAll<HTMLElement>('.view-line')].find(row => row.textContent === 'console.log(describe(sample));');
		const text = line?.querySelector<HTMLElement>('.stanza-editor-line-text');
		if (!text) return Number.POSITIVE_INFINITY;
		const range = document.createRange();
		range.selectNodeContents(text);
		return Math.abs(window.ashGpuTextIntegration.measureGpuAdvance(text.textContent ?? '') - range.getBoundingClientRect().width);
	})).toBeLessThan(0.1);
	await page.evaluate(() => window.ashGpuTextIntegration.setFontLigatures(false));
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
}

function healthyGpuEditorState(): GpuEditorState {
	return {
		valueRestored: true,
		lineNumber: '1',
		canvasVisible: true,
		allRowsUseGpu: true,
		longLineWrapped: true,
		rowsHaveCanonicalSpacing: true,
		hiddenCanvasUsesDisplayNone: true,
		glyphMarginTouchesLineNumber: true,
		lineNumberTouchesFolding: true,
		foldingPrecedesText: true,
	};
}

async function gpuEditorState(page: Page): Promise<GpuEditorState> {
	return page.evaluate(() => {
		const requireElement = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
			const element = root.querySelector<T>(selector);
			if (!element) throw new Error(`Missing GPU editor element '${selector}'`);
			return element;
		};
		const editor = requireElement(document, '.stanza-editor');
		const canvas = requireElement<HTMLCanvasElement>(document, '.stanza-editor-gpu-canvas');
		const firstLine = requireElement(document, '.view-line[data-logical-line-index="0"]');
		const glyphMargin = requireElement(document, '.glyph-margin');
		const lineNumber = requireElement(document, '.margin-view-overlays .view-overlay-line[data-line-index="0"] .line-numbers');
		const folding = requireElement(document, '.margin-view-overlays .view-overlay-line[data-line-index="0"] .ash-icon-folding-expanded');
		const text = requireElement(firstLine, '.stanza-editor-line-text');
		const rows = [...editor.querySelectorAll<HTMLElement>('.view-line')];
		const rowRectangles = rows.map(row => row.getBoundingClientRect());
		const glyphMarginRectangle = glyphMargin.getBoundingClientRect();
		const lineNumberRectangle = lineNumber.getBoundingClientRect();
		const foldingRectangle = folding.getBoundingClientRect();
		const textRectangle = text.getBoundingClientRect();
		const equal = (left: number, right: number) => Math.abs(left - right) < 0.01;
		const canvasWasHidden = canvas.hidden;
		canvas.hidden = true;
		const hiddenCanvasUsesDisplayNone = getComputedStyle(canvas).display === 'none';
		canvas.hidden = canvasWasHidden;
		return {
			valueRestored: window.ashGpuTextIntegration.getValue() === window.ashGpuTextIntegration.initialText,
			lineNumber: lineNumber.textContent,
			canvasVisible: !canvas.hidden && getComputedStyle(canvas).display !== 'none',
			allRowsUseGpu: rows.length > 0 && rows.every(row => row.classList.contains('gpu-rendered')),
			longLineWrapped: rows.length > window.ashGpuTextIntegration.initialText.split('\n').length,
			rowsHaveCanonicalSpacing: rowRectangles.every((rectangle, index) => index === 0 || equal(rectangle.top, rowRectangles[index - 1]!.bottom)),
			hiddenCanvasUsesDisplayNone,
			glyphMarginTouchesLineNumber: equal(glyphMarginRectangle.right, lineNumberRectangle.left),
			lineNumberTouchesFolding: equal(lineNumberRectangle.right, foldingRectangle.left),
			foldingPrecedesText: foldingRectangle.right <= textRectangle.left,
		};
	});
}

async function clearedGpuEditorState(page: Page): Promise<ClearedGpuEditorState> {
	return page.evaluate(() => ({
		value: window.ashGpuTextIntegration.getValue(),
		lineNumber: document.querySelector('.line-numbers')?.textContent ?? null,
		renderedRowCount: document.querySelectorAll('.view-line').length,
		gpuRowCount: document.querySelectorAll('.view-line.gpu-rendered').length,
		text: document.querySelector('.stanza-editor-line-text')?.textContent ?? null,
	}));
}

async function gpuFrameLayeringState(page: Page): Promise<GpuFrameLayeringState> {
	return page.evaluate(() => {
		const passes = window.ashGpuTextIntegration.readGpuFrameTrace();
		const hasFrame = passes.length >= 2 && passes.length % 2 === 0;
		let everyFrameIsLayered = hasFrame;
		for (let index = 0; everyFrameIsLayered && index < passes.length; index += 2) {
			const rectanglePass = passes[index]!;
			const textPass = passes[index + 1]!;
			everyFrameIsLayered = rectanglePass.label === 'Ash rectangle pass'
				&& rectanglePass.loadOp === 'clear'
				&& textPass.label === 'Stanza ViewLinesGpu pass'
				&& textPass.loadOp === 'load'
				&& textPass.submissionId === rectanglePass.submissionId + 1;
		}
		return {
			hasFrame,
			everyFrameIsLayered,
		};
	});
}


for (const length of [16, 240]) {
	test(`GPU selection foreground updates glyph colors for ${length}-column text`, async ({ page }) => {
		await page.goto('/gpuText.html');
		await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
		await page.evaluate(length => window.ashGpuTextIntegration.prepareBracketText(length), length);
		await page.evaluate(() => window.ashGpuTextIntegration.setSelectionColor('#1387c9'));
		await expect(page.locator('.view-line.gpu-rendered')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(19, 135, 201))).toBeGreaterThan(0);
		await page.evaluate(() => window.ashGpuTextIntegration.setSelectionColor('#46ac72'));
		await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(70, 172, 114))).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(19, 135, 201))).toBe(0);
		expect(await page.evaluate(() => window.ashGpuTextIntegration.getValue())).toBe(`(${'x'.repeat(length)})`);
	});

	test(`GPU bracket glyphs refresh for ${length}-column text when only decoration colors change`, async ({ page }) => {
		await page.goto('/gpuText.html');
		await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
		await page.evaluate(length => window.ashGpuTextIntegration.prepareBracketText(length), length);
		await expect(page.locator('.view-line.gpu-rendered')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(19, 135, 201))).toBe(0);
		await page.evaluate(() => window.ashGpuTextIntegration.setBracketColor('#1387c9'));
		await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(19, 135, 201))).toBeGreaterThan(0);
		const baseColor = await page.locator('.stanza-editor').evaluate(element => getComputedStyle(element).color);
		await page.evaluate(() => {
			window.ashGpuTextIntegration.resetGpuFrameTrace();
			window.ashGpuTextIntegration.setBracketColor('#46ac72');
		});
		await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(70, 172, 114))).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(19, 135, 201))).toBe(0);
		await expect(page.locator('.stanza-editor')).toHaveCSS('color', baseColor);
		await expect(page.locator('.view-line.gpu-rendered')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashGpuTextIntegration.getValue())).toBe(`(${'x'.repeat(length)})`);
		await expect.poll(() => gpuFrameLayeringState(page)).toEqual({ hasFrame: true, everyFrameIsLayered: true });
	});
}

test('GPU rejection markers follow renderer capability changes and use the active theme', async ({ page }) => {
	await page.goto('/gpuText.html');
	await expect(page.locator('.stanza-editor-gpu-canvas')).toBeVisible();
	await page.evaluate(() => window.ashGpuTextIntegration.setFontLigatures(true));
	const marker = page.locator('.margin-view-overlays .gpu-mark').first();
	await expect(marker).toBeVisible();
	await expect(marker).toHaveAttribute('title', /font ligatures/);
	await expect(marker).toHaveAttribute('aria-hidden', 'true');
	const themed = await marker.evaluate(element => {
		const expected = document.createElement('span');
		expected.style.color = 'var(--ash-warning-foreground)';
		element.append(expected);
		const matches = getComputedStyle(element).backgroundColor === getComputedStyle(expected).color;
		expected.remove();
		return matches;
	});
	expect(themed).toBe(true);
	await page.evaluate(() => window.ashGpuTextIntegration.setFontLigatures(false));
	await expect(page.locator('.gpu-mark[title*="font ligatures"]')).toHaveCount(0);
});

test('GPU text uses semantic token colors from the active theme', async ({ page }) => {
	await page.goto('/gpuText.html');
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	await page.evaluate(() => window.ashGpuTextIntegration.prepareSemanticText());
	await expect(page.locator('.view-line.gpu-rendered')).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.countGlyphPixels(225, 55, 171))).toBeGreaterThan(0);
	await expect.poll(() => page.evaluate(() => window.ashGpuTextIntegration.getValue())).toBe('sample');
});

test('DOM semantic styles update with the theme and explicit false clears font styles', async ({ page }) => {
	await page.goto('/gpuText.html');
	await page.evaluate(() => window.ashGpuTextIntegration.mountDomSemanticEditor());
	const token = page.locator('#dom-semantic-editor .stanza-editor-token').filter({ hasText: 'sample' });
	await expect(token).toHaveCSS('color', 'rgb(225, 55, 171)');
	await expect(token).toHaveCSS('font-style', 'italic');
	await expect(token).toHaveCSS('text-decoration-line', 'underline');
	await page.evaluate(() => window.ashGpuTextIntegration.clearSemanticFontStyles());
	await expect(token).toHaveCSS('color', 'rgb(70, 172, 114)');
	await expect(token).toHaveCSS('font-style', 'normal');
	await expect(token).toHaveCSS('font-weight', '400');
	await expect(token).toHaveCSS('text-decoration-line', 'none');
});
