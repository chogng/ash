import { expect, test, type Page, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function glyphPoint(page: Page, lineNumber: number) {
	return page.evaluate(lineNumber => {
		const editor = window.ashDebugIntegration.getControl();
		const root = editor.getDomNode()!.getBoundingClientRect();
		const layout = editor.getLayoutInfo();
		const position = editor.getScrolledVisiblePosition({ lineNumber, column: 1 })!;
		return { x: root.left + layout.glyphMarginLeft + 4, y: root.top + position.top + position.height / 2 };
	}, lineNumber);
}

for (const locale of ['en', 'zh-cn']) test(`glyph margin adds, disables, enables and removes breakpoints without moving the selection (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/debug.html?locale=${locale}`);
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	await page.evaluate(() => {
		const editor = window.ashDebugIntegration.getControl();
		editor.updateOptions({ hover: { delay: 20 } });
		editor.setSelection({ startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 8 });
	});
	const selection = await page.evaluate(() => window.ashDebugIntegration.getControl().getSelection());
	const point = await glyphPoint(page, 1);
	await page.mouse.move(point.x, point.y);
	await expect(page.locator('.ash-debug-breakpoint-gutter.hint')).toBeVisible();
	await expect(page.getByRole('tooltip')).toContainText(locale === 'en' ? 'Click to add a breakpoint' : '单击以添加断点');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		const hint = page.locator('.ash-debug-breakpoint-gutter.hint');
		await expect(hint).toBeVisible();
		expect(await hint.evaluate(node => getComputedStyle(node, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
		await expect(hint).toHaveCSS('opacity', theme.startsWith('hc') ? '1' : '0.4');
	}
	await page.screenshot({ path: testInfo.outputPath(`glyph-margin-${locale}.png`), fullPage: true });
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.ash-debug-breakpoint-gutter:not(.hint)')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashDebugIntegration.getControl().getSelection())).toEqual(selection);
	await page.keyboard.down('Shift');
	await page.mouse.click(point.x, point.y);
	await page.keyboard.up('Shift');
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(1);
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toMatchObject([{ lineNumber: 1, enabled: true }]);
	await page.mouse.click(point.x, point.y, { button: 'right' });
	await page.keyboard.press('Escape');
	await page.mouse.click(point.x, point.y, { button: 'middle' });
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toHaveLength(1);
	await page.mouse.click(point.x, point.y);
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([]);
	await page.mouse.move(1, 1);
	await expect(page.locator('.ash-debug-breakpoint-gutter.hint')).toHaveCount(0);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('glyph margin ignores document padding and foreign markers', async ({ page }) => {
	await page.goto('/debug.html');
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	await page.evaluate(() => {
		const editor = window.ashDebugIntegration.getControl();
		editor.updateOptions({ wordWrap: 'off', smoothScrolling: false });
		editor.createDecorationsCollection([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, options: { description: 'foreign marker', glyphMarginClassName: 'ash-foreign-glyph' } }]);
	});
	const point = await glyphPoint(page, 1);
	await page.mouse.click(point.x, point.y);
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([]);
	await expect(page.locator('.ash-debug-breakpoint-gutter.hint')).toHaveCount(0);
	const padding = await page.locator('#editor').boundingBox();
	await page.mouse.click(point.x, padding!.y + padding!.height - 30);
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([]);
});

test('glyph margin maps wrapped, scrolled rows to source lines', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	await page.goto('/debug.html');
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	await page.evaluate(() => {
		const editor = window.ashDebugIntegration.getControl();
		editor.getModel()!.setValue(Array.from({ length: 60 }, (_, index) => `const value${index} = "${'wrapped content '.repeat(9)}";`).join('\n'));
		editor.updateOptions({ wordWrap: 'wordWrapColumn', wordWrapColumn: 35, smoothScrolling: false });
		editor.revealLineInCenter(25);
	});
	await expect(page.locator('#editor .line-numbers').filter({ hasText: /^25$/ })).toBeVisible();
	const point = await glyphPoint(page, 25);
	await page.mouse.click(point.x, point.y);
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpoints())).toMatchObject([{ lineNumber: 25 }]);
	await page.mouse.click(point.x, point.y);
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([]);
});

for (const locale of ['en', 'zh-cn']) test(`breakpoint widget preserves mode drafts, cancels safely and saves by keyboard (${locale})`, async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 1100 });
	await page.goto(`/debug.html?locale=${locale}`);
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	const zh = locale === 'zh-cn';
	const point = await glyphPoint(page, 1);
	await page.keyboard.down('Alt'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Alt');
	const form = page.getByRole('form', { name: zh ? '断点编辑器' : 'Breakpoint editor', exact: true });
	const field = form.getByRole('textbox');
	await expect(field).toBeFocused();
	await field.fill('answer > 0');
	await form.getByRole('combobox').click();
	await page.getByRole('option', { name: zh ? '命中次数条件' : 'Hit count condition', exact: true }).click();
	await field.fill('>= 3');
	await form.getByRole('combobox').click();
	await page.getByRole('option', { name: zh ? '日志消息' : 'Log message', exact: true }).click();
	await field.fill('answer={answer}');
	await form.getByRole('combobox').click();
	await page.getByRole('option', { name: zh ? '表达式条件' : 'Expression condition', exact: true }).click();
	await expect(field).toHaveValue('answer > 0');
	await field.dispatchEvent('compositionstart');
	await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([]);
	await field.dispatchEvent('compositionend');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		await expect(field).toBeFocused();
		const focusColor = await field.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-focusBorder').trim());
		const color = await field.evaluate((element, color) => {
			const probe = document.createElement('span');
			probe.style.color = color;
			element.parentElement!.append(probe);
			const resolved = getComputedStyle(probe).color;
			probe.remove();
			return resolved;
		}, focusColor);
		await expect(form.locator('.ash-input-box-field')).toHaveCSS('border-top-color', color);
	}
	expect(await page.evaluate(() => window.ashDebugIntegration.showDebugHelp())).toBe(true);
	const help = page.getByRole('textbox', { name: zh ? '无障碍帮助' : 'Accessibility Help', exact: true });
	await expect(help).toHaveValue(zh ? /保留各自的草稿/ : /Each mode keeps its draft/);
	await help.press('Escape');
	await expect(field).toBeFocused();
	await expect(field).toHaveValue('answer > 0');
	await page.screenshot({ path: testInfo.outputPath(`breakpoint-widget-${locale}.png`), fullPage: true });
	await field.press('Enter');
	await expect(form).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpoints())).toMatchObject([
		{ lineNumber: 1, condition: 'answer > 0', hitCondition: '>= 3', logMessage: 'answer={answer}' },
	]);
	await expect(page.locator('#editor .stanza-editor-input')).toBeFocused();
	await page.keyboard.down('Alt'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Alt');
	await expect(field).toHaveValue('answer={answer}');
	await field.fill('discarded');
	await field.press('Escape');
	await expect(form).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toMatchObject([{ logMessage: 'answer={answer}' }]);
});

for (const locale of ['en', 'zh-cn']) test(`debug gutter context menu creates, edits, disables and removes a logpoint (${locale})`, async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 1100 });
	await page.goto(`/debug.html?locale=${locale}`);
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	const zh = locale === 'zh-cn';
	const point = await glyphPoint(page, 1);
	const menu = async () => { await page.mouse.click(point.x, point.y, { button: 'right' }); };
	await menu();
	await page.getByRole('menuitem', { name: zh ? '添加日志点...' : 'Add Logpoint...', exact: true }).click();
	const field = page.locator('.ash-breakpoint-widget').getByRole('textbox');
	await expect(field).toBeFocused();
	await field.fill('value={answer}');
	await field.press('Enter');
	await expect(page.locator('.ash-debug-breakpoint-gutter.logpoint')).toHaveCount(1);
	await menu();
	await page.getByRole('menuitem', { name: zh ? '禁用断点' : 'Disable Breakpoint', exact: true }).click();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(1);
	await menu();
	await page.getByRole('menuitem', { name: zh ? '启用断点' : 'Enable Breakpoint', exact: true }).click();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(0);
	await menu();
	await page.getByRole('menuitem', { name: zh ? '编辑断点...' : 'Edit Breakpoint...', exact: true }).click();
	await expect(field).toHaveValue('value={answer}');
	await field.fill('edited={answer}'); await field.press('Enter');
	await menu();
	await page.getByRole('menuitem', { name: zh ? '移除断点' : 'Remove breakpoint', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([]);
});

test('breakpoint dragging preserves identity and conditions, rejects occupied drops and cancels on Escape', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 1100 });
	await page.goto('/debug.html');
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	await page.evaluate(() => { const editor = window.ashDebugIntegration.getControl(); editor.setPosition({ lineNumber: 2, column: 1 }); editor.focus(); });
	await page.evaluate(() => window.ashDebugIntegration.command('editor.debug.action.conditionalBreakpoint'));
	const field = page.locator('.ash-breakpoint-widget').getByRole('textbox');
	await field.fill('answer > 0'); await field.press('Enter');
	const before = await page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions());
	const start = await glyphPoint(page, 2);
	const end = await glyphPoint(page, 3);
	await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions())).toMatchObject([{ id: before[0].id, lineNumber: 3, condition: 'answer > 0' }]);
	await page.mouse.click(start.x, start.y);
	const definitions = await page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions());
	await page.mouse.move(end.x, end.y); await page.mouse.down(); await page.mouse.move(start.x, start.y, { steps: 8 }); await page.mouse.up();
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions())).toEqual(definitions);
	const first = await glyphPoint(page, 1);
	await page.mouse.move(end.x, end.y); await page.mouse.down(); await page.mouse.move(first.x, first.y, { steps: 8 }); await page.keyboard.press('Escape'); await page.mouse.up();
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions())).toEqual(definitions);
	await page.evaluate(() => { const editor = window.ashDebugIntegration.getControl(); editor.setPosition({ lineNumber: 3, column: 1 }); editor.focus(); void window.ashDebugIntegration.command('editor.debug.action.moveBreakpoint'); });
	const line = page.getByPlaceholder('Enter a source line number');
	await line.fill('0'); await line.press('Enter');
	await expect(page.getByText('Enter a valid line number in this file.', { exact: true })).toBeVisible();
	await line.fill('1'); await line.press('Enter');
	await expect.poll(() => page.evaluate(id => window.ashDebugIntegration.breakpointDefinitions().find(point => point.id === id)?.lineNumber, before[0].id)).toBe(1);
});

test('tracked breakpoint positions update once across split editors and survive undo and redo', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 1100 });
	await page.goto('/debug.html?breakpoints');
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	const before = await page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions());
	await page.evaluate(() => {
		window.ashDebugIntegration.createSplitEditor();
		window.ashDebugIntegration.getControl().executeEdits('breakpoint-test', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'const prepended = 1;\n' }]);
	});
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions().map(point => ({ id: point.id, line: point.lineNumber })))).toEqual(before.map(point => ({ id: point.id, line: point.lineNumber + 1 })));
	await page.evaluate(() => window.ashDebugIntegration.getControl().getModel()!.undo());
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions().map(point => point.lineNumber))).toEqual([2, 3]);
	await page.evaluate(() => window.ashDebugIntegration.getControl().getModel()!.redo());
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions().map(point => point.lineNumber))).toEqual([3, 4]);
	await expect(page.locator('#editor-copy .ash-debug-breakpoint-gutter:not(.hint)')).toHaveCount(2);
});

test('tracked inline breakpoint columns follow same-line edits and retain their condition across split editors', async ({ page }) => {
	await page.goto('/debug.html?inline-breakpoint');
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	await page.evaluate(() => {
		window.ashDebugIntegration.createSplitEditor();
		window.ashDebugIntegration.getControl().executeEdits('inline-breakpoint-test', [{
			range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: '/* */',
		}]);
	});
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions())).toMatchObject([
		{ id: 'inline', lineNumber: 2, columnNumber: 12, condition: 'answer > 0' },
	]);
	await page.evaluate(() => window.ashDebugIntegration.getControl().getModel()!.undo());
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions())).toMatchObject([
		{ id: 'inline', lineNumber: 2, columnNumber: 7, condition: 'answer > 0' },
	]);
	await page.evaluate(() => {
		const editor = window.ashDebugIntegration.getControl();
		editor.setPosition({ lineNumber: 2, column: 7 });
		editor.focus();
	});
	await page.evaluate(() => window.ashDebugIntegration.command('editor.debug.action.editBreakpoint'));
	const field = page.locator('.ash-breakpoint-widget').getByRole('textbox');
	await expect(field).toHaveValue('answer > 0');
	await field.fill('answer > 1');
	await field.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions())).toMatchObject([
		{ id: 'inline', lineNumber: 2, columnNumber: 7, condition: 'answer > 1' },
	]);
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpointDefinitions().length)).toBe(1);
});

test('Debug Console follows a URL assembled from output chunks by keyboard and modifier click', async ({ page }) => {
	await page.goto('/debug.html?console');
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	await page.evaluate(() => window.ashDebugIntegration.consoleLinks());
	const link = page.getByRole('link', { name: 'https://example.test/path?q=one#two', exact: true });
	await expect(link).toBeVisible();
	await link.click();
	expect(await page.evaluate(() => window.ashDebugIntegration.openedLinks())).toEqual([]);
	await link.focus();
	await link.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedLinks())).toEqual(['https://example.test/path?q=one#two']);
	await link.click({ modifiers: ['ControlOrMeta'] });
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedLinks().length)).toBe(2);
	await link.focus();
	await link.press('Tab');
	await expect(page.getByRole('link', { name: '/workspace/main.ts:2:1', exact: true })).toBeFocused();
});

for (const locale of ['en', 'zh-cn']) test(`Debug Console file links keep selection, accessible text and focus across themes (${locale})`, async ({ page }) => {
	await page.goto(`/debug.html?console&locale=${locale}`);
	await page.waitForFunction(() => !!window.ashDebugIntegration);
	await page.evaluate(() => window.ashDebugIntegration.consoleLinks());
	const link = page.getByRole('link', { name: '/workspace/main.ts:2:1', exact: true });
	await expect(link).toBeVisible();
	await expect(page.getByRole('link', { name: '/workspace/missing.ts:9', exact: true })).toHaveCount(0);
	await expect(link).toHaveAttribute('aria-description', locale === 'en' ? 'Ctrl/Cmd+click or Enter to follow link' : '按 Ctrl/Cmd 并单击，或按 Enter 跟随链接');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		await link.focus();
		await expect(link).toBeFocused();
		await expect(link).toHaveCSS('outline-style', 'solid');
		await expect(link).toHaveCSS('text-decoration-line', 'underline');
		const colors = await link.evaluate(element => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--ash-accent-foreground)';
			element.append(probe);
			const expected = getComputedStyle(probe).color;
			probe.remove();
			return { actual: getComputedStyle(element).color, expected };
		});
		expect(colors.actual).toBe(colors.expected);
	}
	await link.press('Shift+Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources().at(-1))).toMatchObject({ resource: 'file:///workspace/main.ts', line: 2, column: 1, target: 'sideGroup' });
	const content = await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility());
	expect(content.view).toContain('See https://example.test/path?q=one#two.');
	expect(content.view).toContain('/workspace/main.ts:2:1');
	expect(content.help).toContain(locale === 'en' ? 'focus a text link' : '聚焦链接后按 Enter');
});


for (const locale of ['en', 'zh-cn']) test(`Debug sidebar help describes the registered panes and restores focus (${locale})`, async ({ page }) => {
	await page.goto(`/debug.html?locale=${locale}`);
	const heading = page.getByRole('button', { name: locale === 'en' ? 'Variables' : '变量', exact: true });
	await heading.focus();
	expect(await page.evaluate(() => window.ashDebugIntegration.showDebugHelp())).toBe(true);
	const help = page.getByRole('textbox', { name: locale === 'en' ? 'Accessibility Help' : '无障碍帮助', exact: true });
	await expect(help).toHaveValue(locale === 'en' ? /Call Stack: select a thread/ : /调用堆栈：选择线程/);
	await help.press('Escape');
	await expect(heading).toBeFocused();
});

test('Debug ANSI output preserves a URL across color changes and projects readable accessible/filter text', async ({ page }) => {
	await page.goto('/debug.html?console');
	await page.evaluate(() => window.ashDebugIntegration.consoleANSI());
	const link = page.getByRole('link', { name: 'https://example.test/path', exact: true });
	await expect(link).toBeVisible();
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		const error = page.locator('.ash-debug-ansi.bold').filter({ hasText: 'error' });
		await expect(error).toHaveCSS('font-weight', '600');
		const expected = await error.evaluate(element => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--ash-terminal-ansiRed)';
			element.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
		await expect(error).toHaveCSS('color', expected);
	}
	await link.focus();
	await link.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedLinks())).toEqual(['https://example.test/path']);
	const content = await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility());
	expect(content.view).toContain('error https://example.test/path');
	expect(content.view).not.toContain('\x1b');
});

test('Debug paused frame decoration follows selection in the real editor and disappears on continue', async ({ page }) => {
	await page.goto('/debug.html');
	const marker = page.locator('#editor .ash-debug-stack-frame');
	await expect(marker).toHaveCount(1);
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		await expect(marker).toBeVisible();
		await expect(marker).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(marker).toHaveCount(0);
});

test('Debug Quick Access distinguishes launch folders and switches to the longest Console prefix', async ({ page }) => {
	await page.goto('/debug.html?launch-controls&console');
	await page.evaluate(() => window.ashDebugIntegration.quickAccess());
	const picker = page.getByRole('dialog');
	const input = picker.getByRole('combobox');
	await input.fill('debug Run');
	const choices = picker.getByRole('option');
	await expect(choices).toHaveCount(3);
	await choices.filter({ hasText: 'Second' }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['second']);
	await page.evaluate(() => window.ashDebugIntegration.command('workbench.action.debug.selectDebugConsole'));
	await input.fill('debug consoles Two');
	await expect(choices).toHaveCount(1);
	await choices.first().click();
	await expect(page.locator('.ash-debug-console-session')).toHaveValue('session-two');
});

async function clickDebugHeaderAction(page: Page, section: 'stack' | 'breakpoints', name: string): Promise<void> {
	const header = page.locator(`[data-pane-view-id="${section === 'stack' ? 'workbench.debug.callStackView' : 'workbench.debug.breakPointsView'}"] > .ash-pane-view-header`);
	await header.hover();
	await header.getByRole('button', { name, exact: true }).click();
}

test('disassembly launch waits for header intent and opens through keyboard focus and pointer hover', async ({ page }) => {
	await page.goto('/debug.html');
	const stack = page.locator('[data-pane-view-id="workbench.debug.callStackView"]');
	const open = stack.locator('[data-action-id="debug.action.openDisassemblyView"] button');
	await expect(open).toBeAttached();
	await expect(open).toBeEnabled();
	await expect(open).toHaveCSS('visibility', 'hidden');
	await expect(page.getByRole('button', { name: 'Open Disassembly View', exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDebugIntegration.disassemblyRequests())).toEqual([]);
	await stack.getByRole('button', { name: 'Call Stack', exact: true }).focus();
	await expect(open).toBeVisible();
	await open.focus();
	await open.press('Enter');
	await expect(page.locator('.ash-disassembly [data-instruction-address="0x1000"]')).toBeVisible();
	await page.reload();
	await expect(open).toHaveCSS('visibility', 'hidden');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	await expect(page.locator('.ash-disassembly [data-instruction-address="0x1000"]')).toBeVisible();
});

test('debug breakpoints pane follows content and fills space only when its peers are collapsed', async ({ page }, testInfo) => {
	await page.goto('/debug.html?launch-controls');
	const section = page.locator('[data-pane-view-id="workbench.debug.breakPointsView"]');
	const body = section.locator(':scope > .ash-pane-view-content');
	const header = section.getByRole('button', { name: 'Breakpoints', exact: true });
	const contentHeight = () => body.evaluate(element => Math.ceil([...element.children].reduce((height, child) => height + child.getBoundingClientRect().height, 0)));
	const bodyHeight = () => body.evaluate(element => element.getBoundingClientRect().height);
	await expect(page.locator('.ash-debug-exceptions > li')).toHaveCount(2);
	await expect.poll(bodyHeight).toBe(await contentHeight());
	await page.evaluate(() => window.ashDebugIntegration.stop());
	await expect(body).toHaveCSS('height', '0px');
	await expect(header).toHaveAttribute('aria-expanded', 'true');
	await page.screenshot({ path: testInfo.outputPath('debug-breakpoints-empty.png'), clip: { x: 0, y: 0, width: 280, height: 640 } });

	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(3));
	await expect(page.locator('.ash-debug-breakpoints > li')).toHaveCount(3);
	await expect.poll(bodyHeight).toBe(await contentHeight());
	const populatedHeight = await bodyHeight();
	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(1));
	await expect.poll(bodyHeight).toBeLessThan(populatedHeight);
	await expect.poll(bodyHeight).toBe(await contentHeight());
	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(0));
	await expect(body).toHaveCSS('height', '0px');

	const peerHeaders = ['Variables', 'Watch', 'Call Stack'].map(name => page.getByRole('button', { name, exact: true }));
	for (const peer of peerHeaders) {
		await peer.focus();
		await peer.press('ArrowLeft');
	}
	await expect.poll(bodyHeight).toBeGreaterThan(300);
	await expect(page.locator('.ash-debug-section.closing')).toHaveCount(0);
	await expect.poll(() => section.evaluate(element => Math.round(element.getBoundingClientRect().bottom - element.closest('.ash-pane-view-container')!.getBoundingClientRect().bottom))).toBe(0);
	await page.screenshot({ path: testInfo.outputPath('debug-breakpoints-fill.png'), clip: { x: 0, y: 0, width: 280, height: 640 } });
	await peerHeaders[0]!.press('ArrowRight');
	await expect(body).toHaveCSS('height', '0px');
	await expect(header).toHaveAttribute('aria-expanded', 'true');

	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(12));
	await expect.poll(bodyHeight).toBeGreaterThanOrEqual(9 * 22);
	await expect.poll(async () => await bodyHeight() <= await contentHeight()).toBe(true);
	await header.focus();
	await header.press('ArrowLeft');
	await page.evaluate(() => window.ashDebugIntegration.setBreakpointCount(0));
	await header.press('ArrowRight');
	await expect(body).toHaveCSS('height', '0px');
	await expect(header).toBeFocused();
});

test('debug launch title navigates its compound controls and dismisses its popup when hidden', async ({ page }) => {
	await page.goto('/debug.html?launch-controls');
	const start = page.getByRole('button', { name: 'Start Debugging', exact: true });
	const dropdown = page.locator('.ash-debug-configuration');
	const gear = page.getByRole('button', { name: 'Open launch.json', exact: true });
	await start.focus();
	await start.press('ArrowRight');
	await expect(dropdown).toBeFocused();
	await dropdown.press('ArrowLeft');
	await expect(start).toBeFocused();
	await start.press('ArrowRight');
	await dropdown.press('ArrowRight');
	await expect(gear).toBeFocused();
	await page.evaluate(() => window.ashDebugIntegration.starting());
	await expect(start).toBeDisabled();
	await gear.press('ArrowLeft');
	await expect(dropdown).toBeFocused();
	await dropdown.press('ArrowDown');
	await expect(page.getByRole('searchbox')).toBeFocused();
	await page.evaluate(() => window.ashDebugIntegration.reopenContainer());
	await expect(dropdown).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.ash-action-widget')).toHaveCount(0);
});

test('debug launch dropdown searches configurations, retains selection, starts compounds and configures the selected folder', async ({ page }) => {
	await page.goto('/debug.html?launch-controls');
	const dropdown = page.locator('.ash-debug-configuration');
	await expect(page.locator('.ash-debug .ash-debug-launch-start')).toHaveCount(0);
	await expect(page.locator('.ash-workbench-part-title .ash-debug-launch-start')).toHaveCount(1);
	await expect(dropdown).toHaveText('Run — First');
	await expect(page.getByRole('button', { name: 'Open launch.json', exact: true }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'debug-configure');
	await dropdown.focus();
	await dropdown.press('ArrowDown');
	const search = page.getByRole('searchbox', { name: 'Debug configuration', exact: true });
	await expect(search).toBeFocused();
	await expect(page.getByRole('menuitemradio', { name: 'Run — First', exact: true })).toHaveAttribute('aria-checked', 'true');
	await search.fill('Run — Second');
	await expect(page.getByRole('menuitemradio')).toHaveCount(1);
	await search.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(dropdown).toHaveText('Run — Second');
	await expect(dropdown).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.selectedConfiguration())).toBe('second');
	await page.evaluate(() => window.ashDebugIntegration.reopenContainer());
	await expect(dropdown).toHaveText('Run — Second');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual([]);
	await page.evaluate(() => window.ashDebugIntegration.refreshConfigurations());
	await expect(dropdown).toHaveText('Run — Second');
	await page.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['second']);
	await page.evaluate(() => window.ashDebugIntegration.stop());
	await page.evaluate(() => window.ashDebugIntegration.startCommand());
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['second', 'second']);
	await page.getByRole('button', { name: 'Open launch.json', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources().at(-1))).toMatchObject({ resource: 'file:///second/.vscode/launch.json' });
	await dropdown.click();
	await page.getByRole('menuitemradio', { name: 'All (compound)', exact: true }).click();
	await page.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['second', 'second', 'all']);
	await dropdown.click();
	await search.press('Escape');
	await expect(dropdown).toBeFocused();
	await expect(dropdown).toHaveAttribute('aria-expanded', 'false');
	await dropdown.click();
	await page.evaluate(() => window.ashDebugIntegration.dispose());
	await expect(page.locator('.ash-action-widget')).toHaveCount(0);
});

test('debug launch pointer hover clears an inherited focus ring and keyboard navigation restores it across themes', async ({ page }) => {
	await page.goto('/debug.html?launch-controls&locale=zh-cn');
	const dropdown = page.locator('.ash-debug-configuration');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		await dropdown.click();
		const search = page.getByRole('searchbox');
		await expect(search).toBeFocused();
		await search.press('R');
		const first = page.getByRole('menuitemradio', { name: 'Run — First', exact: true });
		const second = page.getByRole('menuitemradio', { name: 'Run — Second', exact: true });
		await second.hover();
		await expect(second).toBeFocused();
		await expect(second.locator('..')).toHaveClass(/focused/u);
		await expect(second).toHaveCSS('outline-style', 'none');
		await second.press('Shift');
		await expect(second).toHaveCSS('outline-style', 'none');
		await second.press('ArrowUp');
		await expect(first).toBeFocused();
		await expect(first).toHaveCSS('outline-style', 'solid');
		await expect(first).toHaveCSS('outline-width', '1px');
		await first.hover();
		await expect(first).toHaveCSS('outline-style', 'none');
		await first.press('ControlOrMeta+f');
		await expect(search).toBeFocused();
		await search.press('ArrowDown');
		await expect(first).toBeFocused();
		await expect(first).toHaveCSS('outline-style', 'solid');
		await first.press('Enter');
		await expect(page.locator('.ash-action-widget')).toHaveCount(0);
		await expect(dropdown).toBeFocused();
	}
});

test('debug launch dropdown uses Chinese labels and stays inside a narrow sidebar across themes', async ({ page }, testInfo) => {
	await page.goto('/debug.html?launch-controls&locale=zh-cn');
	const dropdown = page.locator('.ash-debug-configuration');
	await expect(dropdown).toHaveAttribute('aria-label', '调试配置：Run — First');
	await page.evaluate(() => window.ashDebugIntegration.resize(180));
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		const geometry = await page.locator('.ash-workbench-part-title .ash-pane-composite-title-menu-actions').evaluate(element => {
			const controls = element.getBoundingClientRect();
			const dropdown = element.querySelector('.ash-debug-configuration')!.getBoundingClientRect();
			const gear = element.querySelector('[data-action-id="workbench.action.debug.configure"] button')!.getBoundingClientRect();
			const label = element.querySelector('.ash-debug-configuration-label')!;
			return { fits: gear.right <= controls.right && dropdown.right <= gear.left, overflow: element.scrollWidth > element.clientWidth, ellipsis: getComputedStyle(label).textOverflow };
		});
		expect(geometry).toEqual({ fits: true, overflow: false, ellipsis: 'ellipsis' });
		await dropdown.click();
		await expect(page.getByPlaceholder('搜索配置', { exact: true })).toBeFocused();
		expect(await page.getByRole('menuitemradio').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height))).toEqual([22, 22, 22]);
		await expect(page.getByRole('menuitemradio', { name: 'All（复合配置）', exact: true })).toBeVisible();
		await page.getByPlaceholder('搜索配置', { exact: true }).press('Escape');
		await expect(dropdown).toBeFocused();
	}
	await page.evaluate(() => window.ashDebugIntegration.theme('light'));
	await dropdown.click();
	await page.screenshot({ path: testInfo.outputPath('debug-launch-dropdown.png'), clip: { x: 0, y: 0, width: 300, height: 200 } });
});

for (const locale of ['en', 'zh-cn']) test(`debug launch title contains long configurations and preserves icon hit areas (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/debug.html?launch-controls&long-launch-name&locale=${locale}`);
	const title = page.locator('.ash-workbench-part-title');
	const dropdown = title.locator('.ash-debug-configuration');
	await expect(dropdown).toHaveText('Run configuration with a very long name');
	for (const width of [180, 225, 280, 400]) {
		await page.evaluate(width => window.ashDebugIntegration.resize(width), width);
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
			const geometry = await title.evaluate(element => {
				const bounds = element.getBoundingClientRect();
				const buttons = [...element.querySelectorAll('button')];
				const label = element.querySelector<HTMLElement>('.ash-debug-configuration-label')!;
				const actionSize = parseFloat(getComputedStyle(element).getPropertyValue('--ash-toolbar-actionSize'));
				return {
					contained: buttons.every(button => {
						const box = button.getBoundingClientRect();
						return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
					}),
					iconHitAreas: buttons
						.filter(button => !button.classList.contains('ash-debug-configuration'))
						.every(button => button.getBoundingClientRect().width === actionSize),
					overflow: element.scrollWidth > element.clientWidth,
					ellipsis: getComputedStyle(label).textOverflow,
					truncated: label.scrollWidth > label.clientWidth,
				};
			});
			expect(geometry).toMatchObject({ contained: true, iconHitAreas: true, overflow: false, ellipsis: 'ellipsis' });
			if (width === 180) expect(geometry.truncated).toBe(true);
		}
	}
	await page.evaluate(() => window.ashDebugIntegration.resize(225));
	await dropdown.focus();
	await dropdown.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'Run configuration with a very long name', exact: true })).toBeVisible();
	await page.getByRole('searchbox').press('Escape');
	await expect(dropdown).toBeFocused();
	await title.screenshot({ path: testInfo.outputPath(`debug-launch-long-${locale}.png`) });
});

for (const locale of ['en', 'zh-cn']) test(`debug launch split action keeps its divider and compact arrow when its caption collapses (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/debug.html?launch-controls&long-launch-name&locale=${locale}`);
	const launcher = page.locator('.ash-debug-launch-start');
	const dropdown = launcher.locator('.ash-debug-configuration');
	await expect(dropdown).toHaveText('Run configuration with a very long name');
	// The isolated host has no sidebar title label. Constrain it enough to reach
	// the same caption-free state as the full sidebar at its minimum width.
	await page.evaluate(() => window.ashDebugIntegration.resize(80));
	await expect(launcher.locator('.ash-debug-configuration-label')).toHaveCSS('visibility', 'hidden');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		const geometry = await launcher.evaluate(element => {
			const start = element.querySelector<HTMLElement>(':scope > button')!;
			const dropdown = element.querySelector<HTMLElement>('.ash-debug-configuration')!;
			const arrow = dropdown.querySelector<SVGElement>('.ash-icon')!;
			const label = dropdown.querySelector<HTMLElement>('.ash-debug-configuration-label')!;
			const outer = getComputedStyle(element);
			const startStyle = getComputedStyle(start);
			const dropdownStyle = getComputedStyle(dropdown);
			const arrowBox = arrow.getBoundingClientRect();
			const dropdownBox = dropdown.getBoundingClientRect();
			return {
				divider: dropdownStyle.borderLeftStyle === 'solid' && dropdownStyle.borderLeftWidth === outer.borderLeftWidth && dropdownStyle.borderLeftColor === outer.borderLeftColor,
				arrowWidth: arrowBox.width,
				arrowContained: arrowBox.left >= dropdownBox.left && arrowBox.right <= dropdownBox.right,
				startSize: start.getBoundingClientRect().width,
				dropdownSize: dropdownBox.width,
				captionWidth: label.clientWidth,
				captionVisibility: getComputedStyle(label).visibility,
				startColor: startStyle.color,
				innerCorners: [startStyle.borderTopRightRadius, startStyle.borderBottomRightRadius, dropdownStyle.borderTopLeftRadius, dropdownStyle.borderBottomLeftRadius],
			};
		});
		expect(geometry).toMatchObject({ divider: true, arrowWidth: 12, arrowContained: true, startSize: 22, captionVisibility: 'hidden', innerCorners: ['0px', '0px', '0px', '0px'] });
		expect(geometry.dropdownSize).toBeGreaterThanOrEqual(22);
		expect(geometry.startColor).toBe(theme === 'dark' || theme === 'hcDark' ? 'rgb(137, 209, 133)' : 'rgb(56, 138, 52)');
		await launcher.screenshot({ path: testInfo.outputPath(`debug-split-${locale}-${theme}.png`) });
	}
	await page.evaluate(() => window.ashDebugIntegration.resize(400));
	await expect(launcher.locator('.ash-debug-configuration-label')).toHaveCSS('visibility', 'visible');
	await page.evaluate(() => window.ashDebugIntegration.resize(80));
	await expect(launcher.locator('.ash-debug-configuration-label')).toHaveCSS('visibility', 'hidden');
	await dropdown.focus();
	await dropdown.press('Enter');
	await expect(page.getByRole('menuitemradio', { name: 'Run configuration with a very long name', exact: true })).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('searchbox').press('Escape');
	await expect(dropdown).toBeFocused();
	await dropdown.press('ArrowLeft');
	const start = launcher.locator(':scope > button').first();
	await expect(start).toBeFocused();
	await start.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.launches())).toEqual(['first']);
});

test('debug console coalesces an output flood and preserves keyboard evaluation and clearing', async ({ page }, testInfo) => {
	await page.goto('/debug.html?console');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillRepl(page, input, 'answer');
	await input.focus();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	try {
		const before = await cdp.send('Performance.getMetrics');
		const measurement = await output.evaluate(element => {
			let updates = 0;
			const observer = new MutationObserver(records => { updates += records.length; });
			observer.observe(element, { childList: true, characterData: true, subtree: true });
			const burst = window.ashDebugIntegration.burstOutput(2000);
			return new Promise<typeof burst & { updates: number; }>(resolve => {
				const settled = () => {
					if (!element.textContent?.endsWith('burst-1999\n')) { requestAnimationFrame(settled); return; }
					observer.disconnect();
					resolve({ ...burst, updates });
				};
				requestAnimationFrame(settled);
			});
		});
		const after = await cdp.send('Performance.getMetrics');
		const samplesPath = testInfo.outputPath('debug-console-output-flood.json');
		await writeFile(samplesPath, JSON.stringify({ measurement, before, after }, null, 2));
		await testInfo.attach('debug-console-output-flood.json', { path: samplesPath, contentType: 'application/json' });
		expect(measurement.output).toBe(Array.from({ length: 2000 }, (_, index) => `burst-${index}\n`).join(''));
		expect(measurement.updates).toBeLessThan(5);
		await expect(input).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('answer');
		await input.press('Enter');
		await expect(output).toContainText('42');
		const clear = page.locator('[data-view-id="debug.console.integration"] [data-action-id="workbench.debug.panel.action.clearReplAction"] button');
		await clear.focus();
		await clear.press('Enter');
		await expect(output).toHaveText('');
	} finally { await cdp.detach(); }
});

test('disassembly navigates instruction pages, follows frame focus, toggles breakpoints and steps by instruction', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	const grid = view.getByRole('grid', { name: 'Disassembly', exact: true });
	await expect(view.locator('[data-instruction-address="0x1000"]')).toHaveAttribute('aria-current', 'step');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.disassemblyRequests().at(-1))).toEqual({ reference: '0x1000', offset: 0, instructionOffset: 0, instructionCount: 50 });
	await grid.focus();
	await grid.press('F9');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1000', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await grid.press('F9');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1000', exact: true })).toHaveAttribute('aria-pressed', 'false');
	await clickDebugHeaderAction(page, 'stack', 'Add Instruction Breakpoint');
	const byteOffset = page.getByRole('textbox', { name: 'Instruction byte offset', exact: true });
	await byteOffset.fill('4');
	await byteOffset.press('Enter');
	await expect(view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1004', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await view.getByRole('button', { name: 'Toggle instruction breakpoint at 0x1004', exact: true }).click();
	expect(await page.evaluate(() => window.ashDebugIntegration.additionalBreakpoints())).toEqual([]);
	await grid.focus();
	await grid.press('Enter');
	expect(await page.evaluate(() => window.ashDebugIntegration.position())).toBe(2);
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.locator('[data-instruction-address="0x10c8"]')).toBeVisible();
	await view.getByRole('button', { name: 'Previous instructions', exact: true }).click();
	await expect(view.locator('[data-instruction-address="0x1000"]')).toBeVisible();
	const address = view.getByRole('textbox', { name: 'Instruction address', exact: true });
	await address.fill('0x2000');
	await address.press('Enter');
	await expect(view.locator('[data-instruction-address="0x2000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.focusInstruction('0x3000'));
	await expect(view.locator('[data-instruction-address="0x3000"]')).toHaveAttribute('aria-current', 'step');
	await view.getByRole('button', { name: 'Step over instruction', exact: true }).click();
	expect(await page.evaluate(() => window.ashDebugIntegration.stepRequests())).toContain('stepOver:instruction');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(name => window.ashDebugIntegration.theme(name), theme);
		const colors = await view.locator('[aria-current="step"]').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
		expect(colors.color).not.toBe(colors.background);
		expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
	}
});

test('disassembly discards held replies after another frame and after resume', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	await expect(view.locator('[data-instruction-address="0x1000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.holdDisassembly());
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
	await page.evaluate(() => window.ashDebugIntegration.focusInstruction('0x3000'));
	await expect(view.locator('[data-instruction-address="0x3000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.releaseDisassembly());
	await expect(view.locator('[data-instruction-address="0xdead"]')).toHaveCount(0);
	await page.evaluate(() => window.ashDebugIntegration.holdDisassembly());
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await page.evaluate(() => window.ashDebugIntegration.releaseDisassembly());
	await expect(view.getByRole('status')).toHaveText('Pause debugging to view disassembly.');
	await expect(view.locator('[data-instruction-address]')).toHaveCount(0);
	await expect(view.getByRole('button', { name: 'Go to address', exact: true })).toBeDisabled();
});

test('disassembly opens adapter-owned source as a read-only editor', async ({ page }) => {
	await page.goto('/debug.html?virtual');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const grid = page.locator('.ash-disassembly').getByRole('grid');
	await expect(page.locator('.ash-disassembly [data-instruction-address="0x1000"]')).toBeVisible();
	await grid.focus();
	await grid.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources().at(-1))).toEqual({ resource: 'debug:/generated.ts?session=session-one&ref=33', initialText: undefined, readOnly: true, line: 2 });
});

test('a frame without an instruction reference can inspect an explicit address', async ({ page }) => {
	await page.goto('/debug.html?no-address');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	await expect(view.getByRole('status')).toHaveText('This stack frame has no instruction address. Enter an address to inspect.');
	const address = view.getByRole('textbox', { name: 'Instruction address', exact: true });
	await address.fill('');
	await address.press('Enter');
	await expect(address).toHaveAttribute('aria-invalid', 'true');
	await address.fill('0x2000');
	await expect(address).not.toHaveAttribute('aria-invalid');
	await address.press('Enter');
	await expect(view.locator('[data-instruction-address="0x2000"]')).toBeVisible();
});

test('disposing disassembly retires its pending adapter reply and DOM listeners', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Open Disassembly View');
	const view = page.locator('.ash-disassembly');
	await expect(view.locator('[data-instruction-address="0x1000"]')).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.holdDisassembly());
	await view.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect(view.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
	await page.evaluate(() => window.ashDebugIntegration.dispose());
	await page.evaluate(() => window.ashDebugIntegration.releaseDisassembly());
	await expect(view).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('disassembly controls and headings use the selected language', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	await clickDebugHeaderAction(page, 'stack', '打开反汇编视图');
	const view = page.locator('.ash-disassembly');
	await expect(view.getByRole('grid', { name: '反汇编', exact: true })).toBeVisible();
	await expect(view.getByRole('columnheader')).toHaveText(['断点', '地址', '机器码', '指令']);
	await expect(view.getByRole('button', { name: '前面的指令', exact: true })).toBeEnabled();
	await expect(view.getByRole('textbox', { name: '指令地址', exact: true })).toHaveValue('0x1000');
	await expect(view.getByRole('status')).toHaveText('50 条指令');
});

test('all breakpoint families expose localized creation and access labels', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	await clickDebugHeaderAction(page, 'breakpoints', '添加函数断点');
	const name = page.getByRole('textbox', { name: '函数名称', exact: true });
	await name.fill('worker');
	await name.press('Enter');
	await expect(page.locator('[data-breakpoint-kind="function"]')).toContainText('函数：worker');
	await page.getByRole('button', { name: '在访问 parent 的数据时中断', exact: true }).click();
	const access = page.getByRole('combobox', { name: '访问时中断', exact: true });
	await expect(access.locator('option')).toHaveText(['读取', '写入', '读取和写入']);
	await page.getByRole('button', { name: '保存断点', exact: true }).click();
	await expect(page.locator('[data-breakpoint-kind="data"]')).toContainText('数据：parent（写入）');
	await clickDebugHeaderAction(page, 'stack', '添加指令断点');
	const offset = page.getByRole('textbox', { name: '指令字节偏移', exact: true });
	await offset.fill('-4');
	await offset.press('Enter');
	await expect(page.locator('[data-breakpoint-kind="instruction"]')).toContainText('指令：0x1000（偏移 -4）');
});

test('function breakpoints add and edit by keyboard and participate in bulk controls', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'breakpoints', 'Add Function Breakpoint');
	const name = page.getByRole('textbox', { name: 'Function name', exact: true });
	await expect(name).toBeFocused();
	await name.press('Enter');
	await expect(name).toHaveAttribute('aria-invalid', 'true');
	await name.fill('app::process');
	await name.press('Enter');
	const row = page.locator('[data-breakpoint-kind="function"]');
	await expect(row).toContainText('Function: app::process');
	await row.locator('.ash-debug-breakpoint').focus();
	await row.locator('.ash-debug-breakpoint').press('F2');
	await name.fill('app::worker');
	await page.getByRole('textbox', { name: 'Expression condition', exact: true }).fill('counter > 0');
	await name.press('Enter');
	await expect(row).toContainText('app::worker');
	await expect(row).toContainText('counter > 0');
	await page.getByRole('button', { name: 'Disable All Breakpoints', exact: true }).click();
	await expect(row.getByRole('checkbox')).not.toBeChecked();
	await row.getByRole('button', { name: 'Remove breakpoint', exact: true }).click();
	await expect(row).toHaveCount(0);
});

test('data breakpoints query the variable container, offer supported access and reject unavailable locations', async ({ page }) => {
	await page.goto('/debug.html');
	await page.getByRole('button', { name: 'Break on data access for parent', exact: true }).click();
	const access = page.getByRole('combobox', { name: 'Break on access', exact: true });
	await expect(access).toBeFocused();
	await expect(access.locator('option')).toHaveText(['Read', 'Write', 'Read and write']);
	await access.selectOption('readWrite');
	const condition = page.getByRole('textbox', { name: 'Expression condition', exact: true });
	await condition.fill('counter > 0');
	await condition.press('Enter');
	const row = page.locator('[data-breakpoint-kind="data"]');
	await expect(row).toContainText('Data: parent (Read and write)');
	expect(await page.evaluate(() => window.ashDebugIntegration.dataInfoRequests())).toEqual([{ name: 'parent', variablesReference: 20, frameId: 10 }]);
	await row.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await access.selectOption('read');
	await page.getByRole('button', { name: 'Save breakpoint', exact: true }).click();
	await expect(row).toContainText('Data: parent (Read)');
	await page.evaluate(() => window.ashDebugIntegration.denyDataBreakpoint());
	await page.getByRole('button', { name: 'Break on data access for parent', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.notifications())).toContain('The variable has no stable memory location.');
	await expect(page.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
});

test('a data breakpoint query cannot open a stale draft after execution resumes', async ({ page }) => {
	await page.goto('/debug.html');
	await page.evaluate(() => window.ashDebugIntegration.holdDataInfo());
	await page.getByRole('button', { name: 'Break on data access for parent', exact: true }).click();
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await page.evaluate(() => window.ashDebugIntegration.releaseDataInfo());
	await expect(page.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDebugIntegration.additionalBreakpoints())).toEqual([]);
});

test('instruction breakpoints use the selected instruction reference, validate byte offsets and retire their draft on resume', async ({ page }) => {
	await page.goto('/debug.html');
	await clickDebugHeaderAction(page, 'stack', 'Add Instruction Breakpoint');
	const address = page.getByRole('textbox', { name: 'Instruction address', exact: true });
	await expect(address).toBeFocused();
	await expect(address).toHaveValue('0x1000');
	const offset = page.getByRole('textbox', { name: 'Instruction byte offset', exact: true });
	await offset.fill('1.5');
	await offset.press('Enter');
	await expect(offset).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByRole('alert').filter({ hasText: 'Instruction byte offset must be an integer.' })).toHaveText('Instruction byte offset must be an integer.');
	await offset.fill('-4');
	await offset.press('Enter');
	const row = page.locator('[data-breakpoint-kind="instruction"]');
	await expect(row).toContainText('Instruction: 0x1000 (offset -4)');
	await row.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await address.fill('0x2000');
	await address.press('Escape');
	await expect(row).toContainText('0x1000');
	await clickDebugHeaderAction(page, 'stack', 'Add Instruction Breakpoint');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(address).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add Instruction Breakpoint', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Break on data access for parent', exact: true })).toHaveCount(0);
});

test('breakpoints edit expressions by keyboard, update gutter state and support bulk controls', async ({ page }) => {
	await page.goto('/debug.html?breakpoints');
	const first = page.locator('.ash-debug-breakpoints > li').filter({ hasText: 'main.ts:2' });
	const checkbox = first.getByRole('checkbox');
	await expect(checkbox).toBeChecked();
	await checkbox.focus();
	await checkbox.press('Space');
	await expect(checkbox).not.toBeChecked();
	await expect(checkbox).toBeFocused();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(1);
	const action = first.locator('.ash-debug-breakpoint');
	await expect(action).toHaveCSS('height', '22px');
	await action.focus();
	await action.press('F2');
	const condition = page.getByRole('textbox', { name: 'Expression condition', exact: true });
	await expect(condition).toBeFocused();
	await condition.fill('discarded');
	await condition.press('Escape');
	await expect(first.getByRole('button', { name: 'Edit breakpoint', exact: true })).toBeFocused();
	await first.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await condition.fill('answer > 10');
	await page.evaluate(() => window.ashDebugIntegration.resize(180));
	await expect.poll(() => condition.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		const pane = element.closest('.ash-debug')!.getBoundingClientRect();
		return bounds.left >= pane.left && bounds.right <= pane.right;
	})).toBe(true);
	await page.getByRole('textbox', { name: 'Hit count condition', exact: true }).fill('>= 3');
	const log = page.getByRole('textbox', { name: 'Log message', exact: true });
	await log.fill(' answer={answer} ');
	await log.press('Enter');
	await expect(page.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
	await expect(first.getByRole('button', { name: 'Edit breakpoint', exact: true })).toBeFocused();
	expect(await page.evaluate(() => window.ashDebugIntegration.breakpoints())).toEqual([
		{ lineNumber: 2, enabled: false, condition: 'answer > 10', hitCondition: '>= 3', logMessage: ' answer={answer} ' },
		{ lineNumber: 3, enabled: true },
	]);
	await expect(page.locator('.ash-debug-breakpoint-gutter.logpoint')).toHaveCount(1);
	await page.getByRole('button', { name: 'Enable All Breakpoints', exact: true }).click();
	await expect(checkbox).toBeChecked();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(0);
	await page.getByRole('button', { name: 'Disable All Breakpoints', exact: true }).click();
	await expect(page.locator('.ash-debug-breakpoint-gutter.disabled')).toHaveCount(2);
	await page.getByRole('button', { name: 'Remove All Breakpoints', exact: true }).click();
	await expect(page.locator('.ash-debug-breakpoints > li')).toHaveCount(0);
	await expect(page.locator('.ash-debug-breakpoint-gutter')).toHaveCount(0);
});

test('inline debug toolbar keeps session selection, keyboard actions and themed layout coherent', async ({ page }) => {
	await page.goto('/debug.html');
	const controls = page.locator('.ash-debug-controls');
	const toolbar = controls.getByRole('toolbar', { name: 'Debug controls', exact: true });
	const sessions = controls.getByRole('combobox', { name: 'Active debug session', exact: true });
	await sessions.selectOption('session-two');
	await expect(page.locator('.ash-debug-status')).toContainText('Two: stopped');
	await expect(sessions).toHaveValue('session-two');
	await sessions.selectOption('session-one');
	const resume = toolbar.getByRole('button', { name: 'Continue', exact: true });
	await resume.focus();
	await resume.press('ArrowRight');
	await expect(toolbar.getByRole('button', { name: 'Step Over', exact: true })).toBeFocused();
	await page.evaluate(() => window.ashDebugIntegration.resize(220));
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(name => window.ashDebugIntegration.theme(name), theme);
		await expect(controls).toHaveCSS('display', 'flex');
		await expect(controls).toHaveCSS('flex-direction', 'column');
		await expect.poll(() => toolbar.evaluate(element => {
			const box = element.getBoundingClientRect();
			const container = element.parentElement!.getBoundingClientRect();
			return box.width > 0 && box.left >= container.left && box.right <= container.right;
		})).toBe(true);
	}
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(toolbar.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: 'Step Over', exact: true })).toBeDisabled();
	await page.evaluate(() => window.ashDebugIntegration.starting());
	await expect(toolbar.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
	await expect(toolbar.getByRole('button', { name: 'Restart', exact: true })).toBeDisabled();
	await expect(toolbar.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashDebugIntegration.stop());
	await expect(toolbar).toBeHidden();
});

test('unconfigured debugging shows a localized welcome and retains inspection after a session ends', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn&welcome&empty');
	await expect(page.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
	await expect(page.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['运行']);
	await expect(page.getByRole('combobox', { name: '调试配置', exact: true })).toBeHidden();
	await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
	expect(await page.evaluate(() => window.ashDebugIntegration.folderOpens())).toBe(1);
	await page.evaluate(() => window.ashDebugIntegration.start());
	await expect(page.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['变量', '监视', '调用堆栈', '断点']);
	await page.evaluate(() => window.ashDebugIntegration.stop());
	await expect(page.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['变量', '监视', '调用堆栈', '断点']);
	await expect(page.locator('.ash-debug-empty')).toHaveCount(0);
});

test('debug sections resize and collapse by keyboard and only show watch input while adding', async ({ page }) => {
	await page.goto('/debug.html');
	const variables = page.getByRole('button', { name: 'Variables', exact: true });
	const watch = page.getByRole('button', { name: 'Watch', exact: true });
	await variables.focus();
	await variables.press('ArrowDown');
	await expect(watch).toBeFocused();
	await watch.press('ArrowLeft');
	await expect(watch).toHaveAttribute('aria-expanded', 'false');
	await watch.press('ArrowRight');
	await expect(watch).toHaveAttribute('aria-expanded', 'true');
	const separator = page.getByRole('separator', { name: 'Resize panes', exact: true }).first();
	await separator.focus();
	const before = await watch.boundingBox();
	await separator.press('ArrowDown');
	await expect.poll(async () => (await watch.boundingBox())!.y).toBeGreaterThan(before!.y);
	const input = page.getByRole('textbox', { name: 'Add watch expression', exact: true });
	await expect(input).toBeHidden();
	await watch.hover();
	const add = page.getByRole('button', { name: 'Add watch expression', exact: true });
	await add.click();
	await expect(input).toBeFocused();
	await input.fill('cancelled');
	await input.press('Escape');
	await expect(input).toBeHidden();
	await expect(add).toBeFocused();
	await add.click();
	await input.fill('counter');
	await input.press('Enter');
	await expect(input).toBeHidden();
	await expect(page.locator('.ash-debug-watch-value')).toHaveText(['answer = 42', 'counter = 42']);
	await page.getByRole('button', { name: 'Remove All Expressions', exact: true }).click();
	await expect(page.locator('.ash-debug-watch-value')).toHaveCount(0);
	await expect(page.getByRole('list', { name: 'Exception Breakpoints' })).toBeVisible();
	expect(await page.getByRole('list', { name: 'Exception Breakpoints' }).evaluate(element => element.closest('.ash-debug-section')!.querySelector('.ash-pane-view-header-title')!.textContent)).toBe('Breakpoints');
	await page.evaluate(() => window.ashDebugIntegration.resize(180));
	expect(await page.locator('.ash-debug').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('stopped debugging locates source and edits a nested variable with keyboard focus and theme support', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/debug.html');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.position())).toBe(2);
	const parent = page.locator('.ash-debug-variable').filter({ hasText: 'parent = Object' });
	await parent.dblclick();
	const parentValue = page.getByRole('textbox', { name: 'Value of parent', exact: true });
	await expect(parentValue).toBeFocused();
	await parentValue.press('Escape');
	await expect(parent).toHaveAttribute('aria-expanded', 'true');
	const child = page.locator('.ash-debug-variable').filter({ hasText: 'child = value' });
	await child.focus();
	await child.press('F2');
	const value = page.getByRole('textbox', { name: 'Value of child', exact: true });
	await expect(value).toBeFocused();
	await value.fill('cancelled');
	await value.press('Escape');
	await expect(child).toBeFocused();
	expect(await page.evaluate(() => window.ashDebugIntegration.assignments())).toEqual([]);
	await child.dblclick();
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		await value.focus();
		const colors = await value.evaluate(element => {
			const style = getComputedStyle(element.closest('.ash-input-box')!);
			return { background: style.backgroundColor, border: style.borderColor, borderStyle: style.borderStyle };
		});
		expect(colors.borderStyle).toBe('solid');
		expect(colors.border).not.toBe(colors.background);
	}
	await page.evaluate(() => window.ashDebugIntegration.resize(220));
	// PaneView receives the new container dimensions through ResizeObserver.
	await expect.poll(() => value.evaluate(element => {
		const input = element.getBoundingClientRect();
		const pane = element.closest('.ash-debug')!.getBoundingClientRect();
		return input.left >= pane.left && input.right <= pane.right;
	})).toBe(true);
	const geometry = await value.evaluate(element => {
		const input = element.getBoundingClientRect();
		const pane = element.closest('.ash-debug')!.getBoundingClientRect();
		return { width: input.width, fits: input.left >= pane.left && input.right <= pane.right };
	});
	expect(geometry.width).toBeGreaterThan(0);
	expect(geometry.fits).toBe(true);
	await value.fill('43');
	await value.press('Enter');
	const updated = page.locator('.ash-debug-variable').filter({ hasText: 'child = 43' });
	await expect(updated).toBeFocused();
	await expect(page.locator('.ash-debug-watch-value')).toHaveText('answer = 43');
	expect(await page.evaluate(() => window.ashDebugIntegration.assignments())).toEqual([{ reference: 21, name: 'child', value: '43' }]);
	expect(errors).toEqual([]);
});

test('variable edits expose validation, discard replies after resume, and localize input instructions', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	const parent = page.locator('.ash-debug-variable').filter({ hasText: 'parent = Object' });
	await parent.focus();
	await parent.press('F2');
	const value = page.getByRole('textbox', { name: 'parent 的值', exact: true });
	await expect(value).toHaveAttribute('aria-description', '按 Enter 应用新值，按 Escape 取消。');
	await page.evaluate(() => window.ashDebugIntegration.failAssignment());
	await value.fill('invalid');
	await value.press('Enter');
	await expect(value).toHaveAttribute('aria-invalid', 'true');
	await expect(value).toBeFocused();
	await expect(page.getByRole('alert').filter({ hasText: 'Invalid value' })).toHaveText('Invalid value');
	await page.evaluate(() => window.ashDebugIntegration.holdAssignment());
	await value.fill('pending');
	await value.press('Enter');
	await expect(value).toHaveAttribute('readonly');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(page.locator('.ash-debug-variable-edit')).toHaveCount(0);
	await page.evaluate(() => window.ashDebugIntegration.releaseAssignment());
	await expect(page.locator('.ash-debug-frame, .ash-debug-variable')).toHaveCount(0);
	await expect(page.getByRole('status')).toContainText('正在运行');
});


test('structured debug console groups expand objects and open source by keyboard without losing output focus', async ({ page }, testInfo) => {
	await page.goto('/debug.html?console');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillRepl(page, input, 'draft');
	await input.focus();
	await page.evaluate(() => window.ashDebugIntegration.structuredOutput());
	await expect(input).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('draft');
	const tree = output.getByRole('tree');
	const group = tree.getByRole('treeitem').filter({ hasText: 'Structured group' });
	await expect(group).toBeVisible();
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	await tree.focus();
	await tree.press('Home');
	await tree.press('ArrowRight');
	const object = tree.getByRole('treeitem').filter({ hasText: 'Object output' });
	await expect(object).toBeVisible();
	await tree.press('ArrowRight');
	await tree.press('ArrowRight');
	const parent = tree.getByRole('treeitem').filter({ hasText: 'parent: Object' });
	await expect(parent).toBeVisible();
	await tree.press('ArrowRight');
	await tree.press('ArrowRight');
	await expect(output).toContainText('child: value');
	const source = output.getByRole('button', { name: 'main.ts:2', exact: true });
	await source.focus();
	await source.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources())).toContainEqual({ resource: 'file:///workspace/main.ts', readOnly: false, line: 2 });
	await page.evaluate(() => window.ashDebugIntegration.theme('hcDark'));
	await source.focus();
	await expect(source).toHaveCSS('outline-style', 'solid');
	await expect(source).toHaveCSS('outline-width', '1px');
	await page.evaluate(() => window.ashDebugIntegration.burstOutput(100));
	await expect(output).toContainText('burst-99');
	await expect(source).toBeFocused();
	await expect(group).toHaveAttribute('aria-expanded', 'true');
	await page.evaluate(() => window.ashDebugIntegration.resize(240));
	expect(await output.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('structured-console.png') });
	await source.focus();
	await page.evaluate(() => window.ashDebugIntegration.selectConsoleSession('session-two'));
	await expect(tree).toBeFocused();
});

test('structured console labels use the selected display language', async ({ page }) => {
	await page.goto('/debug.html?console&locale=zh-cn');
	await expect(page.getByRole('log', { name: '调试控制台输出', exact: true })).toBeVisible();
	await expect(page.locator('.ash-repl-input .stanza-editor-placeholder-text')).toHaveText('计算表达式');
});

test('debug console tools filter alternatives and exclusions by keyboard while retaining group context', async ({ page }) => {
	await page.goto('/debug.html?console');
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const filter = page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	await page.evaluate(() => window.ashDebugIntegration.consoleOutput());
	const tree = output.getByRole('tree');
	const group = tree.getByRole('treeitem').filter({ hasText: 'Build group' });
	const alpha = output.locator('[data-entry-id="2"]');
	const beta = output.locator('[data-entry-id="3"]');
	const gamma = output.locator('[data-entry-id="4"]');
	await expect(group).toBeVisible();
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	await expect(alpha).toBeHidden();
	await input.focus();
	await input.press('Control+f');
	await expect(filter).toBeFocused();
	await filter.fill('alpha, gamma, !beta');
	await expect(alpha).toBeVisible();
	await expect(beta).toBeHidden();
	await expect(gamma).toBeVisible();
	await expect(group).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.ash-view-filter-badge')).toHaveText('3 of 4');
	expect(await page.evaluate(() => window.ashDebugIntegration.consoleStats())).toEqual({ total: 4, filtered: 3 });
	expect((await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility())).view).toBe('Build group\nAlpha success\nGamma outside\n');
	await filter.fill('alpha, !Build');
	await expect(group).toBeHidden();
	await expect(alpha).toBeHidden();
	expect(await page.evaluate(() => window.ashDebugIntegration.consoleStats())).toEqual({ total: 4, filtered: 0 });
	await filter.fill('!beta');
	await expect(alpha).toBeVisible();
	await expect(beta).toBeHidden();
	await filter.press('Escape');
	await expect(filter).toHaveValue('');
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	await expect(alpha).toBeHidden();
	await expect(gamma).toBeVisible();
	expect((await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility())).view).toBe('Build group\nGamma outside\n');
	await filter.press('Escape');
	await expect(output.getByRole('tree')).toBeFocused();
});

test('debug console tools restore input drafts and persist independent input and filter histories by workspace', async ({ page }) => {
	await page.goto('/debug.html?console');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const filter = page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	for (const expression of ['first', 'second']) { await fillRepl(page, input, expression); await input.press('Enter'); }
	await fillRepl(page, input, 'unsent draft');
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('first');
	await input.press('ArrowDown');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await input.press('ArrowDown');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('unsent draft');
	await filter.fill('Alpha');
	await filter.press('Enter');
	await page.evaluate(() => window.ashDebugIntegration.recreateConsole());
	await input.focus();
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await filter.focus();
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('Alpha');
	await page.reload();
	await input.focus();
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await filter.focus();
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('Alpha');
	await page.evaluate(() => window.ashDebugIntegration.consoleWorkspace('other-debug-workspace'));
	await fillRepl(page, input, '');
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('');
	await filter.fill('');
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('');
	await fillRepl(page, input, 'other');
	await input.press('Enter');
	await page.evaluate(() => window.ashDebugIntegration.consoleWorkspace('debug-console-integration'));
	await input.focus();
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('second');
	await filter.focus();
	await filter.press('ArrowUp');
	await expect(filter).toHaveValue('Alpha');
});

test('debug console tools complete in frame zero and preserve adapter replacement ranges and selections', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const suggestions = page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true });
	const output = page.getByRole('log', { name: 'Debug Console output', exact: true });
	await page.evaluate(() => window.ashDebugIntegration.focusConsoleFrame(0));
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	await expect(suggestions.getByRole('option')).toHaveText(['alpha', 'beta']);
	expect(await page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1))).toMatchObject({ sessionId: 'session-one', frameId: 0, threadId: 2, text: 'value', lineNumber: 1, column: 6 });
	await input.press('ArrowDown');
	await expect(suggestions.getByRole('option', { selected: true })).toHaveText('beta');
	await input.press('ArrowUp');
	await expect(suggestions.getByRole('option', { selected: true })).toHaveText('alpha');
	await input.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('alpha');
	await expect(input).toBeFocused();
	await expect(output).toHaveText('');
	await expect(suggestions).toBeHidden();
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	await expect(suggestions).toBeVisible();
	await input.press('ArrowDown');
	await input.press('Tab');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('beta');
	await expect(input).toBeFocused();
	await expect(output).toHaveText('');
	await fillRepl(page, input, 'pre obj.pa tail');
	await input.press('Home');
	for (let index = 0; index < 10; index++) await input.press('ArrowRight');
	await input.press('Control+Space');
	await expect(suggestions.getByRole('option')).toHaveCount(3);
	await input.press('ArrowDown');
	await input.press('ArrowDown');
	await input.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('pre obj.pair(value) tail');
	expect(await page.evaluate(() => { const { start, end, selection } = window.ashDebugIntegration.consoleInput(); return { start, end, selection }; })).toEqual({ start: 13, end: 18, selection: 'value' });
	await fillRepl(page, input, 'dismiss');
	await input.press('Control+Space');
	await expect(suggestions).toBeVisible();
	await input.press('Escape');
	await expect(suggestions).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('dismiss');
	await expect(output).toHaveText('');
	await fillRepl(page, input, 'obj.');
	await expect(suggestions).toBeVisible();
	expect(await page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1)?.text)).toBe('obj.');
});

test('debug console tools discard late completions after input, caret, frame, session and focus changes', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const suggestions = page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true });
	for (const change of ['input', 'caret', 'frame', 'session', 'focus'] as const) {
		await fillRepl(page, input, `held-${change}`);
		await page.evaluate(() => window.ashDebugIntegration.holdCompletion());
		await input.press('Control+Space');
		await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1)?.held)).toBe(true);
		if (change === 'input') await fillRepl(page, input, 'changed!');
		else if (change === 'caret') await input.press('ArrowLeft');
		else if (change === 'frame') await page.evaluate(() => window.ashDebugIntegration.focusConsoleFrame(99));
		else if (change === 'session') await page.evaluate(() => window.ashDebugIntegration.selectConsoleSession('session-two'));
		else await page.getByRole('log', { name: 'Debug Console output', exact: true }).getByRole('tree').focus();
		await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.completionRequests().at(-1)?.cancelled)).toBe(true);
		await page.evaluate(() => window.ashDebugIntegration.releaseCompletion());
		await expect(suggestions.getByRole('option', { name: 'obsolete-result', exact: true })).toHaveCount(0);
		await expect(suggestions).toBeHidden();
		await expect(input).toHaveAttribute('aria-expanded', 'false');
	}
});

test('debug console tools localize filter, history help and completion labels', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools&locale=zh-cn');
	const input = page.getByRole('textbox', { name: '调试控制台表达式', exact: true });
	const filter = page.getByRole('textbox', { name: '筛选调试控制台', exact: true });
	await expect(filter).toHaveAttribute('placeholder', '筛选（文本、!排除）');
	await input.focus();
	await input.press('Control+f');
	await expect(filter).toBeFocused();
	const help = (await page.evaluate(() => window.ashDebugIntegration.consoleAccessibility())).help;
	expect(help).toContain('按 Control+Space 请求建议');
	expect(help).toContain('用逗号分隔替代条件');
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	const suggestions = page.getByRole('listbox', { name: '调试控制台建议', exact: true });
	await expect(suggestions).toBeVisible();
	await expect(input).toHaveAttribute('aria-expanded', 'true');
	await input.press('Escape');
	await expect(suggestions).toBeHidden();
});

test('debug console tools fit high contrast narrow panes without clipping focused inputs and suggestions', async ({ page }, testInfo) => {
	await page.goto('/debug.html?console&console-tools');
	await page.evaluate(() => window.ashDebugIntegration.resizeConsole(240));
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	const filter = page.getByRole('textbox', { name: 'Filter Debug Console', exact: true });
	await page.evaluate(() => window.ashDebugIntegration.consoleOutput());
	await filter.fill('alpha');
	const filterGeometry = await filter.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		const pane = element.closest('.ash-view-pane')!.getBoundingClientRect();
		return { left: bounds.left, right: bounds.right, paneLeft: pane.left, paneRight: pane.right };
	});
	expect(filterGeometry.left).toBeGreaterThanOrEqual(filterGeometry.paneLeft);
	expect(filterGeometry.right).toBeLessThanOrEqual(filterGeometry.paneRight);
	await fillRepl(page, input, 'value');
	await input.press('Control+Space');
	const suggestions = page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true });
	await expect(suggestions).toBeVisible();
	for (const theme of ['hcDark', 'hcLight'] as const) {
		await page.evaluate(name => window.ashDebugIntegration.theme(name), theme);
		await expect(suggestions).toHaveCSS('box-shadow', 'none');
		await expect(page.locator('.ash-repl-input')).toHaveCSS('outline-style', 'solid');
		const geometry = await suggestions.evaluate(element => {
			const pane = element.closest('.ash-view-pane')!;
			const bounds = element.getBoundingClientRect();
			const outer = pane.getBoundingClientRect();
			const selected = element.querySelector('[aria-selected="true"]')!;
			const style = getComputedStyle(selected);
			return { left: bounds.left, right: bounds.right, outerLeft: outer.left, outerRight: outer.right, color: style.color, background: style.backgroundColor, border: getComputedStyle(element).borderColor, fits: pane.scrollWidth <= pane.clientWidth };
		});
		expect(geometry.left).toBeGreaterThanOrEqual(geometry.outerLeft);
		expect(geometry.right).toBeLessThanOrEqual(geometry.outerRight);
		expect(geometry.fits).toBe(true);
		expect(geometry.color).not.toBe(geometry.background);
		expect(geometry.border).not.toBe('rgba(0, 0, 0, 0)');
	}
	await page.screenshot({ path: testInfo.outputPath('debug-console-tools-hc.png') });
});

async function fillRepl(page: Page, input: Locator, text: string): Promise<void> {
	await input.focus();
	await input.press('ControlOrMeta+a');
	await input.press('Backspace');
	if (text) await page.keyboard.insertText(text);
}

test('debug console editor supports multiline editing, undo, UTF-16 completion coordinates and bounded layout', async ({ page }) => {
	await page.goto('/debug.html?console&console-tools');
	const input = page.getByRole('textbox', { name: 'Debug Console expression', exact: true });
	await fillRepl(page, input, 'first');
	const initial = await page.evaluate(() => window.ashDebugIntegration.consoleInput());
	await input.press('Shift+Enter');
	await page.keyboard.insertText('😀obj.');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('first\n😀obj.');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().height)).toBeGreaterThan(initial.height);
	await input.press('Control+Space');
	await expect(page.getByRole('listbox', { name: 'Debug Console suggestions', exact: true })).toBeVisible();
	const requests = await page.evaluate(() => window.ashDebugIntegration.completionRequests());
	expect(requests.at(-1)).toMatchObject({ text: 'first\n😀obj.', lineNumber: 2, column: 7 });
	await input.press('Escape');
	await input.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('first');
	await fillRepl(page, input, Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n'));
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().lineCount)).toBe(20);
	expect((await page.evaluate(() => window.ashDebugIntegration.consoleInput())).height).toBeLessThanOrEqual(204);
	await page.evaluate(() => window.ashDebugIntegration.resizeConsole(240, 180));
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().height)).toBeLessThanOrEqual(44);
	await input.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().value)).toBe('');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.consoleInput().height)).toBe(initial.height);
});

test('independent Debug views retain a Watch draft, restore focus commands and persist collapse', async ({ page }) => {
	await page.goto('/debug.html?console-workspace=debug-independent-views');
	await expect(page.locator('.ash-debug-viewlet > .ash-pane-view-container')).toHaveCount(1);
	const watch = page.locator('[data-view-id="workbench.debug.watchExpressionsView"]');
	await watch.getByRole('button', { name: 'Watch', exact: true }).hover();
	await watch.getByRole('button', { name: 'Add watch expression', exact: true }).click();
	const input = watch.getByRole('textbox', { name: 'Add watch expression', exact: true });
	await input.fill('pending draft');
	await page.evaluate(() => window.ashDebugIntegration.command('workbench.debug.watchExpressionsView.toggleVisibility'));
	await expect(watch).toHaveCount(0);
	await page.evaluate(() => window.ashDebugIntegration.command('workbench.debug.action.focusWatchView'));
	await expect(input).toHaveValue('pending draft');
	await expect(watch).toBeFocused();
	await expect(watch.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-expanded', 'true');

	const variables = page.getByRole('button', { name: 'Variables', exact: true });
	await variables.focus();
	await variables.press('ArrowLeft');
	await page.evaluate(() => window.ashDebugIntegration.command('workbench.debug.callStackView.toggleVisibility'));
	await page.reload();
	await expect(page.locator('[data-view-id="workbench.debug.callStackView"]')).toHaveCount(0);
	await expect(variables).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.ash-debug-watch-value')).toHaveText('answer = 42');
	await variables.press('ArrowRight');
	await expect(page.getByRole('button', { name: 'parent = Object', exact: false })).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.command('workbench.debug.action.focusCallStackView'));
	await expect(page.locator('[data-view-id="workbench.debug.callStackView"]')).toBeFocused();
	await expect(page.locator('.ash-debug-frame')).toHaveCount(1);
});

test('cross-view breakpoint commands reveal hidden editors and restore keyboard access', async ({ page }) => {
	await page.goto('/debug.html');
	const breakpoints = page.locator('[data-view-id="workbench.debug.breakPointsView"]');
	await page.evaluate(() => window.ashDebugIntegration.command('workbench.debug.breakPointsView.toggleVisibility'));
	await expect(breakpoints).toHaveCount(0);
	await page.getByRole('button', { name: 'Break on data access for parent', exact: true }).click();
	await expect(breakpoints).toBeVisible();
	const access = breakpoints.getByRole('combobox', { name: 'Break on access', exact: true });
	await expect(access).toBeFocused();
	await access.press('Escape');
	await expect(breakpoints.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
	await page.evaluate(() => window.ashDebugIntegration.command('workbench.debug.breakPointsView.toggleVisibility'));
	await clickDebugHeaderAction(page, 'stack', 'Add Instruction Breakpoint');
	await expect(breakpoints.getByRole('textbox', { name: 'Instruction address', exact: true })).toBeFocused();
	await expect(breakpoints.getByRole('textbox', { name: 'Instruction address', exact: true })).toHaveValue('0x1000');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(breakpoints.getByRole('form', { name: 'Edit breakpoint', exact: true })).toHaveCount(0);
});


test('paused editor reads a Debug hover and inline values, then removes them when execution continues', async ({ page }) => {
	await page.goto('/debug.html?editor-inspection');
	const inline = page.locator('#editor .ash-debug-inline-value');
	await expect(inline.first()).toContainText('answer = 42');
	await page.evaluate(() => window.ashDebugIntegration.debugHover());
	const hover = page.locator('.stanza-editor-hover');
	await expect(hover).toBeVisible();
	await expect(hover).toContainText('answer = 42');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(hover).toBeHidden();
	await expect(inline).toHaveCount(0);
});


test('Debug exception widget renders paused details and closes with Escape to the editor', async ({ page }) => {
	await page.goto('/debug.html?exception-details');
	const details = page.getByRole('region', { name: 'Debug exception details' });
	await expect(details).toBeVisible();
	await expect(details).toContainText('TypeError');
	await expect(details).toContainText('at main');
	await details.getByRole('button', { name: 'Close exception details' }).focus();
	await page.keyboard.press('Escape');
	await expect(details).toBeHidden();
	expect(await page.locator('#editor').evaluate(element => element.contains(document.activeElement))).toBe(true);
	await page.reload();
	await expect(details).toBeVisible();
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(details).toBeHidden();
});

test('Debug loaded source picker opens source-reference scripts through the existing source owner', async ({ page }) => {
	await page.goto('/debug.html?loaded-sources');
	await page.evaluate(() => { void window.ashDebugIntegration.command('workbench.action.debug.showLoadedScripts'); });
	await page.getByRole('option').filter({ hasText: 'generated.ts' }).click();
	await expect.poll(() => page.evaluate(() => (window.ashDebugIntegration.openedSources().at(-1) as { resource?: string; } | undefined)?.resource)).toContain('ref=25');
});


test('Debug visualization command selects an inspected variable and opens a read-only tree snapshot', async ({ page }) => {
	await page.goto('/debug.html');
	await page.evaluate(() => { void window.ashDebugIntegration.command('workbench.action.debug.visualizeVariable'); });
	await page.getByRole('option').filter({ hasText: 'parent' }).click();
	await page.getByRole('option').filter({ hasText: 'Variable tree' }).click();
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.openedSources().at(-1))).toMatchObject({ readOnly: true, initialText: expect.stringContaining('child') });
	const chat = await page.evaluate(() => window.ashDebugIntegration.chatContext());
	expect(chat?.content).toContain('parent = Object');
});

test('Debug status color follows session lifetime with themed and high-contrast colors', async ({ page }) => {
	await page.goto('/debug.html?status-color');
	const status = page.locator('#debug-statusbar > [data-part="statusbar"]');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		const colors = await status.evaluate(element => {
			const probe = document.createElement('span');
			probe.style.backgroundColor = 'var(--ash-statusBar-debuggingBackground)';
			element.append(probe);
			const result = { actual: getComputedStyle(element).backgroundColor, expected: getComputedStyle(probe).backgroundColor };
			probe.remove();
			return result;
		});
		expect(colors.actual).toBe(colors.expected);
	}
	await page.evaluate(() => window.ashDebugIntegration.endSessions());
	await expect(status).not.toHaveAttribute('style', /debuggingBackground/);
});

test('Loaded Scripts view filters and opens an adapter script by keyboard', async ({ page }) => {
	await page.goto('/debug.html?loaded-sources');
	await page.evaluate(() => window.ashDebugIntegration.loadedSourcesView());
	const pane = page.locator('[data-pane-view-id="workbench.debug.loadedScriptsView"]');
	await pane.getByRole('textbox', { name: 'Filter loaded sources' }).fill('generated');
	const source = pane.getByRole('button', { name: /generated.ts/ });
	await source.focus();
	await source.press('Enter');
	await expect.poll(() => page.evaluate(() => (window.ashDebugIntegration.openedSources().at(-1) as { resource?: string; } | undefined)?.resource)).toContain('ref=25');
});


test('Debug exception accessibility help is localized and restores widget focus', async ({ page }) => {
	await page.goto('/debug.html?exception-details&locale=zh-cn');
	const close = page.getByRole('button', { name: '关闭异常详情', exact: true });
	await close.focus();
	expect(await page.evaluate(() => window.ashDebugIntegration.showDebugHelp())).toBe(true);
	const help = page.getByRole('textbox', { name: '无障碍帮助', exact: true });
	await expect(help).toHaveValue(/调试异常详情/);
	await help.press('Escape');
	await expect(close).toBeFocused();
	await close.press('Escape');
	await expect(page.getByRole('region', { name: '调试异常详情' })).toBeHidden();
});
