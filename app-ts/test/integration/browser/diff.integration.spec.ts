import { expect, test, type Page } from '@playwright/test';

async function openDiffPage(page: Page): Promise<void> {
	await page.goto('/diff.html');
	await page.waitForFunction(() => !!window.ashDiffIntegration);
}

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.ashDiffIntegration?.dispose());
});

test('diff feature revert buttons support keyboard, undo, read-only and live options', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const button = page.locator('#single .ash-diff-revert').getByRole('button', { name: 'Revert change', exact: true });
	await expect(button).toBeVisible();
	await button.focus();
	await page.keyboard.press('Space');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 😀 after\nlast');
	await page.evaluate(() => window.ashDiffIntegration.undo());
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(button).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: true }));
	await expect(button).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: false, renderMarginRevertIcon: false, renderOverviewRuler: false }));
	await expect(button).toHaveCount(0);
	await expect(page.locator('#single .stanza-diff-overview')).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderMarginRevertIcon: true, renderOverviewRuler: true }));
	await expect(button).toBeVisible();
	await button.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(0);
	await expect(button).toHaveCount(0);
});

test('diff feature selection reverts only the selected character change', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first OLD middle OLD last', 'first NEW middle NEW last'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.evaluate(() => window.ashDiffIntegration.selectModified([1, 7, 1, 10]));
	const button = page.locator('#single').getByRole('button', { name: 'Revert selected changes', exact: true });
	await expect(button).toBeVisible();
	await button.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('first OLD middle NEW last');
});

test('diff feature gutter menus receive hunk and selection edits and follow scroll', async ({ page }) => {
	await openDiffPage(page);
	const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	await page.evaluate(([original, modified]) => {
		window.ashDiffIntegration.setComparisonText(original!, modified!);
		window.ashDiffIntegration.registerHunkAction();
		window.ashDiffIntegration.registerHunkAction(true);
	}, [lines.join('\n'), [...lines.slice(0, 2), 'changed', 'extra', ...lines.slice(3)].join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const action = page.locator('#single .ash-diff-gutter').getByRole('button', { name: 'Apply change', exact: true });
	await expect(action).toBeVisible();
	await action.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lastHunkAction?.text)).toBe([...lines.slice(0, 2), 'changed', 'extra', ...lines.slice(3)].join('\n'));
	await page.evaluate(() => window.ashDiffIntegration.scrollModified(400));
	await expect(action).toBeHidden();
	await page.evaluate(() => {
		window.ashDiffIntegration.scrollModified(0);
		window.ashDiffIntegration.selectModified([3, 1, 3, 8]);
	});
	const selection = page.locator('#single .ash-diff-gutter').getByRole('button', { name: 'Apply selected change', exact: true });
	await expect(selection).toBeVisible();
	await selection.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lastHunkAction?.text)).toBe([...lines.slice(0, 2), 'changed', ...lines.slice(3)].join('\n'));
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderGutterMenu: false }));
	await expect(page.locator('#single .ash-diff-gutter')).toBeHidden();
	await expect(page.locator('#single .ash-diff-revert')).toHaveCount(1);
});

test('diff feature moved links follow editor geometry, options, locale and disposal', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(async () => {
		window.ashDiffIntegration.setComparisonText('head\nmove A\nmove B\nkeep A\nkeep B\nkeep C\ntail', 'head\nkeep A\nkeep B\nkeep C\nmove A\nmove B\ntail');
		await window.ashDiffIntegration.setMoves(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
	const links = page.locator('#single .ash-diff-moved-links');
	await expect(links).toBeVisible();
	await expect(links.locator(':scope > svg > path')).toHaveCount(1);
	const button = links.getByRole('button');
	await expect(button).toHaveAccessibleName('Moved original lines 2–3 to modified lines 5–6');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent.includes('Moved original lines 2–3'))).toBe(true);
	const geometry = await links.locator(':scope > svg > path').getAttribute('d');
	await page.evaluate(() => window.ashDiffIntegration.setHiddenRegions(true));
	await expect(links.locator(':scope > svg > path')).toHaveAttribute('d', geometry!);
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-description-foreground', 'rgb(90, 110, 130)');
		document.documentElement.style.setProperty('--ash-stroke-thickness', '1px');
		window.ashDiffIntegration.setChineseLocale();
	});
	await expect(button).toHaveAccessibleName('原始第 2–3 行已移动到修改后的第 5–6 行');
	await expect(links.locator(':scope > svg')).toHaveCSS('stroke', 'rgb(90, 110, 130)');
	await button.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('#single .modified .stanza-editor-accessibility-status')).toContainText('原始第 2–3 行');
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await expect(links).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await expect(links).toBeVisible();
	await page.evaluate(async () => { await window.ashDiffIntegration.setMoves(false); });
	await expect(links).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.dispose());
	await expect(page.locator('.stanza-diff-editor')).toHaveCount(0);
});

test('edited moved code compares only block changes and stays aligned through edits and undo', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(async () => {
		const block = ['function load(input) {', '  const value = parse(input);', '  return value;', '}'];
		const edited = ['function load(input) {', '  const value = parse(updated);', '  log(value);', '  return value;', '}'];
		const stay = Array.from({ length: 6 }, (_, index) => `stay ${index}`);
		window.ashDiffIntegration.setComparisonText(['head', ...block, ...stay, 'tail'].join('\n'), ['head', ...stay, ...edited, 'tail'].join('\n'));
		await window.ashDiffIntegration.setMoves(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
	const editor = page.locator('#single .stanza-diff-editor');
	await editor.locator('.ash-diff-moved-links').getByRole('button').click();
	const toolbar = editor.getByRole('toolbar', { name: 'Moved code comparison' });
	await expect(toolbar).toContainText('Comparing original lines 2–5 with modified lines 8–12');
	await expect(editor.locator('.ash-diff-revert')).toHaveCount(0);
	await expect(editor.locator('.modified .stanza-diff-line-added')).toHaveCount(2);
	await expect(editor.locator('.original .stanza-diff-line-removed')).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(2, 8);
		return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
	})).toBe(0);
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(5, 12);
		return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
	})).toBe(0);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).toContain('Original line 3:');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).not.toContain('Original line 2:');
	await page.evaluate(() => window.ashDiffIntegration.editModified([1, 1, 1, 1], 'prefix\n'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(toolbar).toContainText('modified lines 9–13');
	await page.evaluate(() => window.ashDiffIntegration.editModified([10, 23, 10, 30], 'changed'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toContain('parse(changed)');
	await expect(toolbar).toContainText('modified lines 9–13');
	await page.evaluate(() => window.ashDiffIntegration.undo());
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toContain('parse(updated)');
	await expect(toolbar).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await expect(editor.getByRole('toolbar', { name: '移动代码比较' })).toContainText('正在比较原始第 2–5 行与修改后第 9–13 行');
	const stop = editor.getByRole('button', { name: '停止比较移动代码', exact: true });
	await stop.focus();
	await stop.press('Space');
	await expect(toolbar).toBeHidden();
	await expect(editor.locator('.modified .stanza-editor-input')).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).toContain('原始文件第 2 行');
});

test('moved comparison supports keyboard exit, read-only views, wrapping and disappearing moves', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(async () => {
		const longLine = '  return compute(input, configuration); '.repeat(12);
		const block = ['function load(input) {', longLine, '}'];
		const stay = Array.from({ length: 12 }, (_, index) => `stay ${index}`);
		window.ashDiffIntegration.setComparisonText(['head', ...block, ...stay, 'tail'].join('\n'), ['head', ...stay, ...block, 'tail'].join('\n'));
		await window.ashDiffIntegration.setMoves(true);
		window.ashDiffIntegration.setEditorFeatures({ readOnly: true });
		window.ashDiffIntegration.toggleWordWrap();
	});
	const editor = page.locator('#single .stanza-diff-editor');
	const move = editor.locator('.ash-diff-moved-links').getByRole('button');
	const revealMove = async () => {
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
		await page.evaluate(() => window.ashDiffIntegration.scrollModified(window.ashDiffIntegration.linePositions(2, 14).modifiedTop));
		await expect(move).toBeVisible();
	};
	await revealMove();
	await expect(move).toBeVisible();
	await move.focus();
	await move.press('Enter');
	const toolbar = editor.getByRole('toolbar', { name: 'Moved code comparison' });
	await expect(toolbar).toBeVisible();
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(3, 15);
		return position.originalBottom - position.originalTop - position.modifiedBottom + position.modifiedTop;
	})).toBe(0);
	await editor.getByRole('separator').press('ArrowLeft');
	await editor.getByRole('separator').press('ArrowLeft');
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(4, 16);
		return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
	})).toBe(0);
	await page.locator('#single .modified .stanza-editor-input').press('Escape');
	await expect(toolbar).toBeHidden();
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await expect(toolbar).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await editor.getByRole('button', { name: 'Stop comparing moved code', exact: true }).focus();
	await page.evaluate(() => window.ashDiffIntegration.setMoves(false));
	await expect(toolbar).toBeHidden();
	await expect(editor.locator('.modified .stanza-editor-input')).toBeFocused();
	await page.evaluate(() => window.ashDiffIntegration.setMoves(true));
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\nnew\ntail', 'head\nnew\ntail'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(toolbar).toBeHidden();
	await expect(move).toHaveCount(0);
});

test('diff feature overview delegates pointer and wheel input to editor scrolling', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => {
		const lines = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n');
		window.ashDiffIntegration.setComparisonText(lines, `${lines}\nadded`);
	});
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const ruler = page.locator('#single .stanza-diff-overview');
	await ruler.click({ position: { x: 10, y: 150 } });
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop)).toBeGreaterThan(0);
	await page.evaluate(() => window.ashDiffIntegration.scrollModified(0));
	await ruler.hover();
	await page.mouse.wheel(0, 200);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop)).toBeGreaterThan(0);
});

test('diff feature geometry follows wrapping and collapse, and selecting hidden lines reveals both sides', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(async () => {
		const header = Array.from({ length: 25 }, (_, index) => `header ${index}`);
		const keep = Array.from({ length: 35 }, (_, index) => `keep ${index}`);
		const moved = ['move A '.repeat(80), 'move B '.repeat(80)];
		window.ashDiffIntegration.setComparisonText([...header, ...moved, ...keep, 'tail'].join('\n'), [...header, ...keep, ...moved, 'tail'].join('\n'));
		await window.ashDiffIntegration.setMoves(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
	const path = page.locator('#single .ash-diff-moved-links > svg > path');
	await page.evaluate(() => window.ashDiffIntegration.toggleWordWrap());
	await expect.poll(async () => {
		const positions = await page.evaluate(() => window.ashDiffIntegration.linePositions(26, 61));
		return await path.getAttribute('d') === `M 0 ${positions.originalTop - positions.originalScrollTop + 10} C 12 ${positions.originalTop - positions.originalScrollTop + 10} 12 ${positions.modifiedTop - positions.modifiedScrollTop + 10} 24 ${positions.modifiedTop - positions.modifiedScrollTop + 10}`;
	}).toBe(true);
	const before = await path.getAttribute('d');
	await expect.poll(() => page.evaluate(() => {
		const first = window.ashDiffIntegration.linePositions(26, 61);
		const last = window.ashDiffIntegration.linePositions(27, 62);
		const originalMarker = document.querySelector<HTMLElement>('#single .stanza-diff-overview-lane.original .stanza-diff-overview-marker')!;
		const modifiedMarker = document.querySelector<HTMLElement>('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker')!;
		return Math.abs(parseFloat(originalMarker.style.height) - (last.originalBottom - first.originalTop) / last.originalContentHeight * 100) < 0.001
			&& Math.abs(parseFloat(modifiedMarker.style.height) - (last.modifiedBottom - first.modifiedTop) / last.modifiedContentHeight * 100) < 0.001;
	})).toBe(true);
	await page.evaluate(() => window.ashDiffIntegration.setHiddenRegions(true));
	await expect.poll(() => path.getAttribute('d')).not.toBe(before);
	const contains = (ranges: number[][]) => ranges.some(([start, end]) => start! <= 5 && end! >= 5);
	expect(contains((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).original)).toBe(false);
	await page.evaluate(() => window.ashDiffIntegration.selectModified([5, 1, 6, 2]));
	await expect.poll(async () => {
		const ranges = await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges());
		return contains(ranges.original) && contains(ranges.modified);
	}).toBe(true);
	await page.evaluate(() => {
		document.documentElement.dataset.colorScheme = 'high-contrast-dark';
		document.documentElement.style.setProperty('--ash-contrast-border', 'rgb(10, 20, 30)');
		document.documentElement.style.setProperty('--ash-stroke-thickness', '1px');
		window.ashDiffIntegration.scrollModified(window.ashDiffIntegration.linePositions(26, 61).originalTop);
	});
	await expect(page.locator('#single .ash-diff-moved-block').first()).toHaveCSS('outline-color', 'rgb(10, 20, 30)');
});

test('diff editors preserve source indentation on both sides', async ({ page }) => {
	await openDiffPage(page);
	const lines = ['xxxxxxxxxx', '    xxxxxx', '\txxxxxx', '\t\txx'];
	await page.evaluate(value => window.ashDiffIntegration.setComparisonText(value, `${value}\nchanged`), lines.join('\n'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	for (const side of ['original', 'modified']) {
		const renderedLines = page.locator(`#single .stanza-diff-editor-side.${side} .view-line .stanza-editor-line-text`);
		await expect.poll(async () => (await renderedLines.allTextContents()).slice(0, 4)).toEqual(lines);
		const widths = await renderedLines.evaluateAll(elements => elements.slice(0, 4).map(element => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return range.getBoundingClientRect().width;
		}));
		expect(widths[0]).toBeGreaterThan(0);
		for (const width of widths) {
			expect(Math.abs(width - widths[0]!)).toBeLessThan(1);
		}
	}
});

test('both diff scroll viewports start after their fixed line-number gutter', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('long line '.repeat(100), `${'long line '.repeat(100)}changed`));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	for (const side of ['original', 'modified']) {
		const editor = page.locator(`#single .stanza-diff-editor-side.${side} .stanza-editor`);
		await expect.poll(() => editor.evaluate(root => {
			const margin = root.querySelector('.margin')!.getBoundingClientRect();
			const viewport = root.querySelector('.ash-smooth-scrollable')!.getBoundingClientRect();
			const track = root.querySelector('.ash-scrollbar-track-horizontal')!.getBoundingClientRect();
			return { gutterWidth: margin.width > 0, viewportDelta: viewport.left - margin.right, trackDelta: track.left - viewport.left };
		})).toEqual({ gutterWidth: true, viewportDelta: 0, trackDelta: 0 });
	}
});

test('editable diff renders Unicode changes and shares models with Multi Diff', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page);
	await expect(page.locator('#single .stanza-diff-inline-removed')).toHaveText('😀');
	await expect(page.locator('#single .stanza-diff-inline-added')).toHaveText('🤖');
	await expect(page.locator('#single .stanza-editor')).toHaveCount(2);
	await expect(page.locator('#multi .stanza-multi-diff-editor-section')).toHaveCount(2);
	await expect(page.locator('#multi .stanza-diff-editor')).toHaveCount(2);
	await expect(page.locator('#multi .stanza-editor')).toHaveCount(4);
	await expect(page.locator('#multi .stanza-diff-inline-removed')).toHaveText('😀');
	await page.locator('#single .stanza-diff-editor').focus();
	await page.keyboard.press('F7');
	await expect(page.locator('#single .stanza-diff-line-active')).toHaveCount(2);
	await expect(page.locator('#single .stanza-diff-editor-accessibility-status')).toContainText('2');
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await page.locator('#multi .stanza-multi-diff-editor').focus();
	await page.keyboard.press('F7');
	await expect(page.locator('#multi .stanza-multi-diff-editor-accessibility-status')).toContainText('第 1 处差异，共 2 处，first.ts');
	await expect(page.locator('#multi .stanza-multi-diff-editor')).toHaveAttribute('aria-label', '多文件差异编辑器，共 2 个文件');
	expect(errors).toEqual([]);
});

test('diff decorations render themed lines, gutter signs, and overview markers', async ({ page }) => {
	await openDiffPage(page);
	const editor = page.locator('#single .stanza-diff-editor');
	const removedLine = editor.locator('.stanza-diff-line-removed').first();
	const insertedLine = editor.locator('.stanza-diff-line-added').first();
	const removedGutter = editor.locator('.stanza-diff-gutter-removed').first();
	const insertedGutter = editor.locator('.stanza-diff-gutter-added').first();
	const removedSign = editor.locator('.stanza-diff-remove-sign .ash-icon').first();
	const insertedSign = editor.locator('.stanza-diff-insert-sign .ash-icon').first();
	const removedMarker = editor.locator('.stanza-diff-overview-marker.removed').first();
	const insertedMarker = editor.locator('.stanza-diff-overview-marker.inserted').first();
	await page.evaluate(() => document.documentElement.style.setProperty('--ash-lxicon-font-size-compact', '12px'));
	await expect(removedSign).toHaveAttribute('aria-hidden', 'true');
	await expect(insertedSign).toHaveAttribute('aria-hidden', 'true');
	await expect(removedSign).toHaveCSS('width', '12px');
	await expect(insertedSign).toHaveCSS('width', '12px');
	await page.evaluate(() => {
		const root = document.documentElement;
		root.style.setProperty('--ash-diff-editor-removed-line-background', 'rgb(250, 220, 220)');
		root.style.setProperty('--ash-diff-editor-inserted-line-background', 'rgb(220, 250, 220)');
		root.style.setProperty('--ash-diff-editor-gutter-removed-line-background', 'rgb(240, 180, 180)');
		root.style.setProperty('--ash-diff-editor-gutter-inserted-line-background', 'rgb(180, 240, 180)');
		root.style.setProperty('--ash-diff-editor-overview-removed-foreground', 'rgb(200, 40, 40)');
		root.style.setProperty('--ash-diff-editor-overview-inserted-foreground', 'rgb(40, 160, 40)');
	});
	await expect(removedLine).toHaveCSS('background-color', 'rgb(250, 220, 220)');
	await expect(insertedLine).toHaveCSS('background-color', 'rgb(220, 250, 220)');
	await expect(removedGutter).toHaveCSS('background-color', 'rgb(240, 180, 180)');
	await expect(insertedGutter).toHaveCSS('background-color', 'rgb(180, 240, 180)');
	await expect(removedMarker).toHaveCSS('background-color', 'rgb(200, 40, 40)');
	await expect(insertedMarker).toHaveCSS('background-color', 'rgb(40, 160, 40)');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('same', 'same'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(editor.locator('.stanza-diff-line-removed, .stanza-diff-line-added, .stanza-diff-remove-sign, .stanza-diff-insert-sign')).toHaveCount(0);
});

test('diff separator resizes both columns by pointer and keyboard, resets, and leaves focus in inline view', async ({ page }) => {
	await openDiffPage(page);
	const editor = page.locator('#single .stanza-diff-editor');
	const sash = editor.getByRole('separator', { name: 'Resize diff editor columns' });
	const original = editor.locator('.stanza-diff-editor-side.original');
	const modified = editor.locator('.stanza-diff-editor-side.modified');
	const widths = async () => ({
		original: await original.evaluate(element => element.getBoundingClientRect().width),
		modified: await modified.evaluate(element => element.getBoundingClientRect().width),
	});
	await expect(sash).toHaveAttribute('aria-valuenow', '50');
	await expect(sash).toHaveAttribute('aria-controls', /ash-diff-editor-\d+-original ash-diff-editor-\d+-modified/);
	const initial = await widths();
	await sash.focus();
	await page.keyboard.press('ArrowRight');
	await expect.poll(async () => (await widths()).original).toBe(initial.original + 10);
	await page.keyboard.press('Alt+ArrowLeft');
	await expect.poll(async () => (await widths()).original).toBe(initial.original + 9);
	const bounds = await sash.boundingBox();
	if (!bounds) throw new Error('Diff separator has no bounds');
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2);
	await page.mouse.up();
	await expect.poll(async () => (await widths()).original).toBe(initial.original + 89);
	await expect.poll(async () => (await widths()).modified).toBe(initial.modified - 89);
	await sash.dblclick();
	await expect.poll(async () => (await widths()).original).toBe(initial.original);
	await sash.focus();
	await page.locator('#single').evaluate(element => { element.style.width = '200px'; });
	await expect(sash).toBeHidden();
	await expect.poll(() => modified.evaluate(element => element.contains(document.activeElement))).toBe(true);
	await page.locator('#single').evaluate(element => { element.style.width = '800px'; });
	await expect(sash).toBeVisible();
	await sash.focus();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await expect(sash).toBeHidden();
	await expect.poll(() => modified.evaluate(element => element.contains(document.activeElement))).toBe(true);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await expect.poll(async () => (await widths()).original).toBe(initial.original);
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	const localizedSash = editor.getByRole('separator', { name: '调整差异编辑器的分栏宽度' });
	await expect(localizedSash).toHaveAttribute('aria-valuetext', '原始文件 50%，修改后文件 50%');
	await expect(localizedSash).toHaveAttribute('aria-description', /左右方向键/);
});

test('accessible diff viewer reads changed lines, follows navigation, and restores editor focus', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nold\nlast\nold end', 'first\nnew\nlast\nnew end'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#single .stanza-diff-editor');
	const viewer = editor.locator('.stanza-accessible-diff-viewer');
	await editor.focus();
	await page.keyboard.press('F7');
	await expect(viewer).toBeVisible();
	await expect(viewer).toHaveAttribute('aria-label', 'Accessible Diff Viewer');
	await expect(viewer.locator('textarea')).toBeFocused();
	await expect(viewer.locator('[role="status"]')).toHaveText('Difference 1 of 2');
	await expect(viewer.locator('textarea')).toHaveValue('Original line 2: old\nModified line 2: new');
	await expect(editor.locator('.stanza-diff-editor-side.original')).toHaveAttribute('aria-hidden', 'true');
	await expect(editor.locator('.stanza-diff-editor-side.original')).toHaveAttribute('inert', '');
	await page.keyboard.press('F7');
	await expect(viewer.locator('[role="status"]')).toHaveText('Difference 2 of 2');
	await expect(viewer.locator('textarea')).toHaveValue('Original line 4: old end\nModified line 4: new end');
	await page.keyboard.press('Shift+F7');
	await expect(viewer.locator('[role="status"]')).toHaveText('Difference 1 of 2');
	await viewer.getByRole('button', { name: 'Next difference' }).click();
	await expect(viewer.locator('[role="status"]')).toHaveText('Difference 2 of 2');
	await page.evaluate(() => {
		document.documentElement.dataset.colorScheme = 'high-contrast-dark';
		document.documentElement.style.setProperty('--ash-contrast-border', 'rgb(10, 20, 30)');
		document.documentElement.style.setProperty('--ash-stroke-thickness', '1px');
	});
	await expect(viewer).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
	await expect(viewer.getByRole('button', { name: 'Next difference' })).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await expect(editor.getByRole('region', { name: '无障碍差异查看器' }).locator('[role="status"]')).toHaveText('第 2 处差异，共 2 处');
	await expect(viewer.locator('textarea')).toHaveValue('原始文件第 4 行：old end\n修改后文件第 4 行：new end');
	await page.keyboard.press('Escape');
	await expect(viewer).toBeHidden();
	await expect(editor).toBeFocused();
	await expect(editor.locator('.stanza-diff-editor-side.original')).toHaveAttribute('aria-hidden', 'false');
	await expect(editor.locator('.stanza-diff-editor-side.original')).not.toHaveAttribute('inert');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('same', 'same'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.keyboard.press('F7');
	await expect(viewer).toBeHidden();
	await expect(editor.locator('.stanza-diff-editor-accessibility-status')).toHaveText('没有差异');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\nremoved\ntail', 'head\ntail'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.keyboard.press('F7');
	await expect(viewer.locator('textarea')).toHaveValue('原始文件第 2 行：removed');
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\ntail', 'head\nadded\ntail'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.keyboard.press('F7');
	await expect(viewer.locator('textarea')).toHaveValue('修改后文件第 2 行：added');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\ntail', 'head\nnew addition\ntail'));
	await expect(viewer).toBeHidden();
	await expect(editor.locator('.stanza-diff-editor-side.modified')).not.toHaveAttribute('inert');
});

test('inline changes mark the empty side of pure insertions and deletions', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('before after', 'before new after'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-stroke-thickness', '1px');
		document.documentElement.style.setProperty('--ash-diff-editor-removed-line-marker', 'rgb(200, 40, 40)');
		document.documentElement.style.setProperty('--ash-diff-editor-removed-text-background', 'rgb(250, 220, 220)');
	});
	const originalAnchor = page.locator('#single .stanza-diff-editor-side.original .stanza-diff-inline-removed-empty');
	await expect(originalAnchor).toBeVisible();
	await expect(originalAnchor).toHaveCSS('border-left-style', 'solid');
	await expect(originalAnchor).toHaveCSS('background-color', 'rgb(250, 220, 220)');
	await expect(page.locator('#single .stanza-diff-editor-side.modified .stanza-diff-inline-added')).toContainText('new ');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('before new after', 'before after'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(page.locator('#single .stanza-diff-editor-side.modified .stanza-diff-inline-added-empty')).toBeVisible();
	await expect(page.locator('#single .stanza-diff-editor-side.original .stanza-diff-inline-removed')).toContainText('new ');
});

test('inline diff keeps removed text readable and restores both sides', async ({ page }) => {
	await openDiffPage(page);
	const editor = page.locator('#single .stanza-diff-editor');
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await expect(editor).toHaveClass(/inline-view/);
	await expect(editor.locator('.stanza-diff-editor-side.original')).toBeHidden();
	await expect(editor.locator('.stanza-diff-editor-side.modified')).toBeVisible();
	await expect(editor.locator('.stanza-diff-inline-original-line')).toContainText('before 😀 after');
	await expect(editor.locator('.stanza-diff-inline-original-line').first()).toHaveAttribute('aria-label', /Removed line/);
	await editor.locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await expect(editor).not.toHaveClass(/inline-view/);
	await expect(editor.locator('.stanza-diff-editor-side.original')).toBeVisible();
	await expect(editor.locator('.stanza-diff-inline-original-line')).toHaveCount(0);
	await expect.poll(() => editor.locator('.stanza-diff-editor-side.modified').evaluate(element => element.contains(document.activeElement))).toBe(true);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, true, 900));
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect(editor).toHaveClass(/inline-view/);
	await page.locator('#single').evaluate(element => { element.style.width = '800px'; });
	await expect(editor).toHaveClass(/inline-view/);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, true, 700));
	await expect(editor).not.toHaveClass(/inline-view/);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, true, 900));
	await expect(editor).toHaveClass(/inline-view/);
	await page.locator('#single').evaluate(element => { element.style.width = '1000px'; });
	await expect(editor).not.toHaveClass(/inline-view/);
});

test('diff view zones replace removed lines after a comparison changes', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nremoved line\nlast', 'first\nlast'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const removedLines = page.locator('#single .stanza-diff-inline-original-line');
	await expect(removedLines).toHaveCount(1);
	await expect(removedLines).toHaveText('removed line');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nnew removed line\nlast', 'first\nlast'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(removedLines).toHaveCount(1);
	await expect(removedLines).toHaveText('new removed line');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nlast', 'first\nlast'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(removedLines).toHaveCount(0);
});

test('unchanged regions collapse on both sides and symbol navigation reveals the target', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page);
	const original = Array.from({ length: 36 }, (_, index) => `shared line ${index + 1}`);
	const modified = [...original];
	modified[35] = 'changed final line';
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setComparisonText(left, right);
		window.ashDiffIntegration.setHiddenRegions(true);
	}, [original.join('\n'), modified.join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const regions = page.locator('#single .ash-diff-hidden-region');
	await expect(regions).toHaveCount(2);
	await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText('33 hidden lines');
	await expect(regions.first()).toBeVisible();
	await expect(regions.first().locator('.ash-diff-hidden-region-content')).toHaveCSS('display', 'flex');
	await expect(regions.first()).toHaveCSS('height', '32px');
	const lineIsVisible = (ranges: number[][]) => ranges.some(([start, end]) => start <= 5 && 5 <= end);
	expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).original)).toBe(false);
	expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).modified)).toBe(false);
	await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveText('Shared section');
	await page.evaluate(() => {
		document.documentElement.dataset.colorScheme = 'high-contrast-dark';
		document.documentElement.style.setProperty('--ash-contrast-border', 'rgb(10, 20, 30)');
		document.documentElement.style.setProperty('--ash-stroke-thickness', '1px');
		document.documentElement.style.setProperty('--ash-focus-border', 'rgb(100, 150, 200)');
	});
	await expect(regions.first().locator('.ash-diff-hidden-region-content')).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
	const showMore = regions.first().getByRole('button', { name: 'Show 2 more lines above' });
	await showMore.focus();
	await page.keyboard.press('Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(showMore).toBeFocused();
	await expect(showMore).toHaveCSS('outline-style', 'solid');
	await page.keyboard.press('Enter');
	await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText('31 hidden lines');
	await regions.last().locator('.ash-diff-hidden-region-symbol').click();
	await expect(regions).toHaveCount(0);
	expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).modified)).toBe(true);
	await page.evaluate(() => {
		window.ashDiffIntegration.setChineseLocale();
		window.ashDiffIntegration.setHiddenRegions(false);
		window.ashDiffIntegration.setHiddenRegions(true);
	});
	await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText('隐藏 33 行');
	await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveText('Shared section');
	await page.evaluate(() => window.ashDiffIntegration.removeSymbolProvider());
	await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveCount(0);
	await expect(regions.first().getByRole('button', { name: '显示全部未修改的行' })).toBeVisible();
	await regions.first().getByRole('button', { name: '显示全部未修改的行' }).click();
	await expect(regions).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('word wrap updates both editable columns and keeps diff navigation available', async ({ page }) => {
	await openDiffPage(page);
	const original = `same\n${'before '.repeat(70)}😀 tail\nold end`;
	const modified = `same\n${'before '.repeat(70)}🤖 tail\nnew end`;
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#single .stanza-diff-editor');
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).toHaveClass(/word-wrapped/);
	await expect(editor.locator('.stanza-diff-editor-side.original .stanza-editor')).toBeVisible();
	await expect(editor.locator('.stanza-diff-editor-side.modified .stanza-editor')).toBeVisible();
	await page.keyboard.press('F7');
	await expect(editor.locator('.stanza-diff-inline-removed')).toContainText(['😀']);
	await expect(editor.locator('.stanza-diff-inline-added')).toContainText(['🤖']);
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => editor.locator('.stanza-diff-editor-side.original').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(200);
	await page.keyboard.press('F7');
	await expect(page.locator('#single .stanza-diff-editor-accessibility-status')).toContainText('Change 2 of 2');
	const marker = page.locator('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker.inserted').first();
	await expect(marker).toBeVisible();
	await page.keyboard.press('Alt+Z');
	await expect(editor).not.toHaveClass(/word-wrapped/);
});

test('modified side accepts text input and original side remains read-only', async ({ page }) => {
	await openDiffPage(page);
	const original = page.locator('#single .stanza-diff-editor-side.original .stanza-editor');
	const modified = page.locator('#single .stanza-diff-editor-side.modified .stanza-editor');
	await original.focus();
	await page.keyboard.type('blocked');
	expect((await page.evaluate(() => window.ashDiffIntegration.read())).originalText).toBe('same\nbefore 😀 after\nlast');
	await modified.focus();
	await page.evaluate(() => window.ashDiffIntegration.selectModifiedAll());
	await page.keyboard.type('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'unchanged', 'unchanged']);
});

test('multi diff edits the shared modified model while its original column stays read-only', async ({ page }) => {
	await openDiffPage(page);
	const first = page.locator('#multi .stanza-multi-diff-editor-section').first();
	await first.locator('.stanza-diff-editor-side.original .stanza-editor').focus();
	await page.keyboard.type('blocked');
	expect((await page.evaluate(() => window.ashDiffIntegration.read())).originalText).toBe('same\nbefore 😀 after\nlast');
	await first.locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' added');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 🤖 after\nlast added');
	await expect(page.locator('#single .stanza-diff-inline-added').last()).toContainText('added');
});

test('wrapped and inserted lines stay aligned while the two editors scroll', async ({ page }) => {
	await openDiffPage(page);
	const tail = Array.from({ length: 100 }, (_, index) => `tail ${index}`).join('\n');
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [
		`head\n${'long '.repeat(100)}\nshared\n${tail}`,
		`head\nshort\ninserted\nshared\n${tail}`,
	]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.locator('#single .stanza-diff-editor').focus();
	await page.keyboard.press('Alt+Z');
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 4);
		return Math.abs(lines.originalTop - lines.modifiedTop);
	})).toBeLessThan(1);
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 4);
		return Math.abs(lines.originalTop - lines.modifiedTop);
	})).toBeLessThan(1);
	await page.locator('#single .stanza-diff-editor-side.original').hover();
	await page.mouse.wheel(0, 320);
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 4);
		return { moved: lines.originalScrollTop > 0, gap: Math.abs(lines.originalScrollTop - lines.modifiedScrollTop) };
	})).toEqual({ moved: true, gap: 0 });
});

test('multi diff wraps editable columns and repositions sections through resize and collapse', async ({ page }) => {
	await openDiffPage(page);
	const original = `same\n${'before '.repeat(70)}😀 tail\nsame end`;
	const modified = `same\n${'before '.repeat(70)}🤖 tail\nsame end`;
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).toHaveClass(/word-wrapped/);
	const sections = editor.locator('.stanza-multi-diff-editor-section');
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveClass(/word-wrapped/);
	const firstHeight = await sections.first().evaluate(element => element.getBoundingClientRect().height);
	expect(firstHeight).toBeGreaterThan(34 + 3 * 20);
	const firstScrollHeight = await editor.evaluate(element => element.scrollHeight);
	expect(firstScrollHeight).toBeGreaterThan(firstHeight);
	await page.locator('#multi').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => sections.first().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(firstHeight);
	expect(await editor.evaluate(element => element.scrollHeight)).toBeGreaterThan(firstScrollHeight);
	await sections.first().locator('.stanza-multi-diff-editor-header-toggle').click();
	await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
	const collapsedGap = await sections.evaluateAll(elements => elements[1]!.getBoundingClientRect().top - elements[0]!.getBoundingClientRect().bottom);
	expect(collapsedGap).toBe(8);
	await editor.focus();
	await page.keyboard.press('F7');
	await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('F7');
	await expect(editor.locator('.stanza-multi-diff-editor-accessibility-status')).toContainText('Change 2 of 2');
	await expect(sections.nth(1).locator('.stanza-diff-line-active')).toHaveCount(1);
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).not.toHaveClass(/word-wrapped/);
	await expect(sections.first().locator('.stanza-diff-editor')).not.toHaveClass(/word-wrapped/);
});

test('multi diff keeps one outer scroll and remounts only visible file editors', async ({ page }) => {
	await openDiffPage(page);
	const lines = Array.from({ length: 180 }, (_, index) => `line ${index}`);
	const changed = [...lines];
	changed[90] = 'changed line 90';
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [lines.join('\n'), changed.join('\n')]);
	await page.evaluate(text => window.ashDiffIntegration.setSecondComparisonText(text, text), lines.join('\n'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	const sections = editor.locator('.stanza-multi-diff-editor-section');
	await expect(sections).toHaveCount(1);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('first.ts');
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveCount(1);
	await sections.first().locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.press('ArrowDown');
	await editor.evaluate(element => { element.scrollTop = 600; });
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(600);
	const stickyGap = await sections.first().evaluate(section => {
		const header = section.querySelector('.stanza-multi-diff-editor-header')!;
		const body = section.querySelector('.stanza-multi-diff-editor-item-editor')!;
		return Math.abs(body.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
	});
	expect(stickyGap).toBeLessThan(2);
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections).toHaveCount(1);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('second.ts');
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveCount(1);
	await editor.evaluate(element => { element.scrollTop = 0; });
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveCount(1);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('first.ts');
	await sections.first().locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.keyboard.type('X');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText.split('\n')[1])).toBe('Xline 1');
});

test('multi diff keeps the visible file in place when an earlier comparison changes height', async ({ page }) => {
	await openDiffPage(page);
	const longText = Array.from({ length: 180 }, (_, index) => `line ${index}`).join('\n');
	await page.evaluate(text => {
		window.ashDiffIntegration.setComparisonText(text, text);
		window.ashDiffIntegration.setSecondComparisonText(text, text);
	}, longText);
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	await expect.poll(() => editor.evaluate(element => element.scrollHeight)).toBeGreaterThan(7000);
	const first = editor.locator('.stanza-multi-diff-editor-section').first();
	const secondTop = await first.evaluate(element => parseFloat(element.style.top) + parseFloat(element.style.height) + 8);
	await editor.evaluate((element, top) => { element.scrollTop = top + 500; }, secondTop);
	const second = editor.locator('.stanza-multi-diff-editor-section').filter({ hasText: 'second.ts' });
	await expect(second).toBeVisible();
	const positionBefore = await second.evaluate(element => element.getBoundingClientRect().top);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('old', 'new'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect.poll(() => second.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(positionBefore, 0);
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeLessThan(secondTop - 1000);
});

test('multi diff mounts only nearby file headers and restores collapsed state after scrolling away', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-stroke-thickness', '1px');
		document.documentElement.style.setProperty('--ash-multi-diff-editor-background', 'rgb(18, 27, 36)');
		document.documentElement.style.setProperty('--ash-multi-diff-editor-header-background', 'rgb(37, 46, 55)');
		document.documentElement.style.setProperty('--ash-multi-diff-editor-border', 'rgb(56, 65, 74)');
	});
	await page.evaluate(() => window.ashDiffIntegration.showManyComparisons(120));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const sections = editor.locator('.stanza-multi-diff-editor-section');
	await expect(editor).toHaveCSS('background-color', 'rgb(18, 27, 36)');
	await expect(sections.first()).toHaveCSS('border-top-color', 'rgb(56, 65, 74)');
	await expect(sections.first().locator('.stanza-multi-diff-editor-header')).toHaveCSS('background-color', 'rgb(37, 46, 55)');
	await expect.poll(() => sections.count()).toBeLessThan(5);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('file-0.ts');
	await sections.first().locator('.stanza-multi-diff-editor-header-toggle').focus();
	await page.keyboard.press('ArrowDown');
	await expect(sections.locator('.stanza-multi-diff-editor-header-toggle:focus')).toHaveAttribute('aria-label', 'Collapse file-1.ts');
	await page.keyboard.press('End');
	await expect(sections.locator('.stanza-multi-diff-editor-header-toggle:focus')).toHaveAttribute('aria-label', 'Collapse file-119.ts');
	await page.keyboard.press('Home');
	await expect(sections.locator('.stanza-multi-diff-editor-header-toggle:focus')).toHaveAttribute('aria-label', 'Collapse file-0.ts');
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections.last().locator('.stanza-multi-diff-editor-title')).toHaveText('file-119.ts');
	expect(await sections.count()).toBeLessThan(5);
	expect(await page.evaluate(() => window.ashDiffIntegration.activeManyActions)).toBe(await sections.count());
	await editor.evaluate(element => { element.scrollTop -= 150; });
	const visibleIds = await sections.locator('.stanza-multi-diff-editor-title').allTextContents();
	expect(visibleIds.map(label => Number(label.match(/\d+/)?.[0]))).toEqual([...visibleIds.map(label => Number(label.match(/\d+/)?.[0]))].sort((a, b) => a - b));
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await sections.last().locator('.stanza-multi-diff-editor-header-toggle').click();
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections.last().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
	await editor.evaluate(element => { element.scrollTop = 0; });
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('file-0.ts');
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections.last().locator('.stanza-multi-diff-editor-title')).toHaveText('file-119.ts');
	await expect(sections.last().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('multi diff resolves only comparisons near the viewport', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showLazyComparisons(100));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lazyLoads.length)).toBeGreaterThan(0);
	const initialLoads = await page.evaluate(() => window.ashDiffIntegration.lazyLoads);
	expect(initialLoads.length).toBeLessThan(10);
	expect(initialLoads.every(index => index < 10)).toBe(true);
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('lazy-99.ts');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lazyLoads.includes(99))).toBe(true);
	expect((await page.evaluate(() => window.ashDiffIntegration.lazyLoads)).length).toBeLessThan(20);
});

test('reverse navigation resolves the last comparison without loading intermediate files', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showLazyComparisons(100));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	await editor.focus();
	await page.keyboard.press('Shift+F7');
	await expect(editor.locator('.stanza-multi-diff-editor-accessibility-status')).toHaveText('Change in lazy-99.ts');
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('lazy-99.ts');
	const loads = await page.evaluate(() => window.ashDiffIntegration.lazyLoads);
	expect(loads).toContain(99);
	expect(loads.length).toBeLessThan(10);
});

test('multi diff reaches the last file when logical content exceeds the browser scroll height', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showCompressedComparisons(5000));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const physicalHeight = await editor.evaluate(element => element.scrollHeight);
	expect(physicalHeight).toBeGreaterThanOrEqual(8_000_000);
	expect(physicalHeight).toBeLessThan(8_000_010);
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('large-4999.ts');
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(1);
	await expect(editor.locator('.stanza-multi-diff-editor-section').last().getByText('line 99', { exact: true }).first()).toBeVisible();
	expect(await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeGreaterThan(physicalHeight);
	const logicalBeforeWheel = await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	await editor.hover();
	await page.mouse.wheel(0, -120);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeLessThan(logicalBeforeWheel);
	const logicalWheelDistance = logicalBeforeWheel - await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	expect(logicalWheelDistance).toBeGreaterThan(110);
	expect(logicalWheelDistance).toBeLessThan(130);
	const logicalBeforePage = await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	const viewportHeight = await editor.evaluate(element => element.clientHeight);
	await editor.focus();
	await page.keyboard.press('PageUp');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeLessThan(logicalBeforePage);
	const logicalPageDistance = logicalBeforePage - await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	expect(logicalPageDistance).toBeGreaterThan(viewportHeight - 10);
	expect(logicalPageDistance).toBeLessThan(viewportHeight + 10);
	await page.evaluate(() => window.ashDiffIntegration.saveCompressedPosition());
	await editor.evaluate(element => { element.scrollTop = 0; });
	await expect(editor.locator('.stanza-multi-diff-editor-title').first()).toHaveText('large-0.ts');
	await page.evaluate(() => window.ashDiffIntegration.restoreCompressedPosition());
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('large-4999.ts');
});

test('multi diff updates its file list and keeps the retained file collapsed', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showDynamicComparisons());
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const second = editor.locator('.stanza-multi-diff-editor-section').filter({ hasText: 'dynamic-second.ts' });
	await second.locator('.stanza-multi-diff-editor-header-toggle').click();
	await expect(second.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
	await page.evaluate(() => window.ashDiffIntegration.updateDynamicComparisons());
	await expect(editor.locator('.stanza-multi-diff-editor-title')).toHaveText(['dynamic-second.ts', 'dynamic-third.ts']);
	await expect(editor.locator('.stanza-multi-diff-editor-header-toggle').first()).toHaveAttribute('aria-expanded', 'false');
	await expect(editor.locator('.stanza-multi-diff-editor-header-toggle').last()).toHaveAttribute('aria-expanded', 'true');
	await expect(editor).toHaveAttribute('aria-label', 'Multi-file diff editor with 2 files');
});

test('multi diff announces a deferred comparison and mounts it when ready', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showDeferredComparison());
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const status = editor.locator('.stanza-multi-diff-editor-incomplete-status');
	await expect(status).toHaveAttribute('role', 'status');
	await expect(status).toHaveText('Loading comparison');
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.completeDeferredComparison());
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(1);
	await expect(status).toHaveText('');
});

test('multi diff reports a comparison load failure without an unhandled error', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showFailedComparison());
	const editor = page.locator('#many .stanza-multi-diff-editor');
	await expect(editor.locator('.stanza-multi-diff-editor-incomplete-status')).toHaveText('Could not load failed.ts');
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await expect(editor.locator('.stanza-multi-diff-editor-incomplete-status')).toHaveText('无法加载 failed.ts');
	expect(errors).toEqual([]);
});

test('unsaved input updates Diff and Quick Diff locally using the existing baseline', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffReady)).toBe(true);
	const before = await page.evaluate(() => window.ashDiffIntegration.read());
	await page.getByRole('textbox', { name: 'Modified text' }).fill('obsolete');
	await page.getByRole('textbox', { name: 'Modified text' }).fill('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => {
		const state = window.ashDiffIntegration.read();
		return state.state === 'ready' && state.quickDiffReady && state.resultVersion === state.version;
	})).toBe(true);
	const after = await page.evaluate(() => window.ashDiffIntegration.read());
	expect(after.kinds).toEqual(['unchanged', 'unchanged', 'unchanged']);
	expect(after.quickDiffChanges).toBe(0);
	expect(after.baselineRequests).toBe(before.baselineRequests);
	await expect(page.locator('#single .stanza-diff-inline-added')).toHaveCount(0);
	await expect(page.locator('#multi .stanza-diff-inline-added')).toHaveCount(0);
});

test('Quick Diff inherits whitespace settings without reading the baseline again', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffReady)).toBe(true);
	const baselineRequests = await page.evaluate(() => window.ashDiffIntegration.read().baselineRequests);
	await page.getByRole('textbox', { name: 'Modified text' }).fill('same\nbefore 😀 after\nlast ');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	await page.evaluate(() => window.ashDiffIntegration.setQuickDiffWhitespace('inherit'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(0);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespaceForLanguage('typescript', false));
	await page.evaluate(() => window.ashDiffIntegration.setModifiedLanguage('typescript'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespaceForLanguage('typescript', true));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(0);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespace(false));
	await page.evaluate(() => window.ashDiffIntegration.setModifiedLanguage('javascript'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	expect(await page.evaluate(() => window.ashDiffIntegration.read().baselineRequests)).toBe(baselineRequests);
});

test('cancels expensive Worker computation and completes the next comparison', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'modified', 'unchanged']);
	expect(await page.evaluate(() => window.ashDiffIntegration.cancelLargeComparison())).toEqual({ outcome: 'CancellationError', kinds: ['modified'] });
});

test('the browser Worker compares text lines across CRLF and LF models', async ({ page }) => {
	await openDiffPage(page);
	expect(await page.evaluate(() => window.ashDiffIntegration.compareLineEndings())).toEqual({
		identical: false,
		changedLines: [[2, 2]],
		inlineColumns: [[1, 4]],
	});
});

test('a timed Worker result is marked incomplete in Diff and Multi Diff', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-warning-foreground', 'rgb(150, 80, 0)');
		document.documentElement.style.setProperty('--ash-editor-background', 'rgb(255, 255, 255)');
	});
	expect(await page.evaluate(() => window.ashDiffIntegration.showTimedComparison())).toBe(true);
	const warning = page.locator('#timed-single .stanza-diff-editor-incomplete-status');
	const multiWarning = page.locator('#timed-multi .stanza-multi-diff-editor-incomplete-status');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('Results may be incomplete');
	await expect(warning).toHaveAttribute('role', 'status');
	await expect(multiWarning).toBeVisible();
	await expect(multiWarning).toHaveText('Diff may be incomplete');
	await expect(warning).toHaveCSS('color', 'rgb(150, 80, 0)');
	await page.locator('#timed-single .stanza-diff-editor').evaluate(element => { element.scrollTop = 400; element.dispatchEvent(new Event('scroll')); });
	const positions = await page.evaluate(() => ({
		editorTop: document.querySelector('#timed-single .stanza-diff-editor')!.getBoundingClientRect().top,
		warningTop: document.querySelector('#timed-single .stanza-diff-editor-incomplete-status')!.getBoundingClientRect().top,
	}));
	expect(Math.abs(positions.warningTop - positions.editorTop)).toBeLessThan(2);
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-warning-foreground', 'rgb(255, 255, 255)');
		document.documentElement.style.setProperty('--ash-editor-background', 'rgb(0, 0, 0)');
	});
	await expect(warning).toHaveCSS('color', 'rgb(255, 255, 255)');
	await expect(warning).toHaveCSS('background-color', 'rgb(0, 0, 0)');
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await expect(warning).toHaveText('差异计算已达到时间上限，结果可能不完整。');
	await expect(multiWarning).toHaveText('差异结果可能不完整');
	await expect(page.locator('#timed-multi .stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-label', '折叠 timed.ts');
});
