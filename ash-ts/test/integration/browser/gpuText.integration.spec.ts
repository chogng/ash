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
	await expect.poll(() => gpuEditorState(page)).toEqual(healthyGpuEditorState());
	await expect.poll(() => gpuFrameLayeringState(page)).toEqual({ hasFrame: true, everyFrameIsLayered: true });
	await expectGpuAdvanceMatchesDom(page);
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
