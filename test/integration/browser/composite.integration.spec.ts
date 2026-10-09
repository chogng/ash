import { test, expect } from '@playwright/test';
import type { } from './composite.integration.js';

test.beforeEach(async ({ page }) => {
	await page.goto('/composite.html');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
});

test('typed case aliases reuse the open editor pane and unsaved model', async ({ page }) => {
	expect(await page.evaluate(() => window.ashCompositeIntegration.openFileAliases())).toEqual({ tabs: 1, models: 1, retained: true, text: 'unsaved content' });
	await expect(page.locator('.stanza-editor-line-text').filter({ hasText: 'unsaved content' })).toBeVisible();
});

test('typed case aliases reuse the modal editor pane and unsaved model', async ({ page }) => {
	expect(await page.evaluate(() => window.ashCompositeIntegration.openFileAliases('modalGroup'))).toEqual({ tabs: 0, models: 1, retained: true, text: 'unsaved content' });
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page.locator('.stanza-editor-line-text').filter({ hasText: 'unsaved content' })).toBeVisible();
});

test('content focus enters once, survives internal Tab navigation and leaves once', async ({ page }) => {
	await page.evaluate(() => window.ashCompositeIntegration.openView('first.view'));
	await expect(page.getByRole('textbox', { name: 'First input', exact: true })).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.state())).toEqual([
		{ id: 'first', title: 'first container', focused: true, retained: true },
		{ id: 'second', title: 'second container', focused: false, retained: true },
	]);
	await page.keyboard.press('Tab');
	await expect(page.getByRole('textbox', { name: 'Second input', exact: true })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(page.getByRole('textbox', { name: 'First input', exact: true })).toBeFocused();
	expect(await page.evaluate(() => window.ashCompositeIntegration.events)).toEqual(['first:focus']);
	await page.getByRole('button', { name: 'Outside content' }).focus();
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.events)).toEqual(['first:focus', 'first:blur']);
	expect(await page.evaluate(() => window.ashCompositeIntegration.state().map(state => state.focused))).toEqual([false, false]);
});

test('switching and hiding content releases focus while retaining the same control', async ({ page }) => {
	await page.evaluate(() => window.ashCompositeIntegration.open('first', true));
	await page.evaluate(() => window.ashCompositeIntegration.open('second', true));
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.state().map(state => state.focused))).toEqual([false, true]);
	await page.evaluate(() => window.ashCompositeIntegration.hide());
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.state().map(state => state.focused))).toEqual([false, false]);
	await page.evaluate(() => window.ashCompositeIntegration.open('first', true));
	await expect(page.getByRole('textbox', { name: 'First input', exact: true })).toBeFocused();
	expect(await page.evaluate(() => window.ashCompositeIntegration.state().map(state => state.retained))).toEqual([true, true]);
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.events)).toEqual([
		'first:focus', 'second:focus', 'first:blur', 'second:blur', 'first:focus',
	]);
});

test('disposed content stops reporting focus even if its old root is mounted again', async ({ page }) => {
	await page.evaluate(() => window.ashCompositeIntegration.open('first', true));
	await page.getByRole('button', { name: 'Outside content' }).focus();
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.events)).toEqual(['first:focus', 'first:blur']);
	await page.evaluate(() => {
		window.ashCompositeIntegration.dispose();
		window.ashCompositeIntegration.reattachDisposed();
	});
	await page.getByRole('textbox', { name: 'Disposed input' }).focus();
	await expect(page.getByRole('textbox', { name: 'Disposed input' })).toBeFocused();
	await page.getByRole('button', { name: 'Outside content' }).focus();
	expect(await page.evaluate(() => window.ashCompositeIntegration.events)).toEqual(['first:focus', 'first:blur']);
});

test('panel tabs open the retained control, report focus intent and clear hidden active state', async ({ page }) => {
	await page.getByRole('tab', { name: 'second container', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'First input', exact: true })).toBeFocused();
	await page.evaluate(() => window.ashCompositeIntegration.hide());
	await page.evaluate(() => window.ashCompositeIntegration.open('second', true));
	await expect(page.getByRole('textbox', { name: 'First input', exact: true })).toBeFocused();
	expect(await page.evaluate(() => window.ashCompositeIntegration.partEvents)).toEqual([
		{ id: 'first', visible: false }, { id: 'second', visible: true, focus: true },
		{ id: 'second', visible: false }, { id: 'second', visible: true, focus: true },
	]);
	expect(await page.evaluate(() => window.ashCompositeIntegration.state().every(state => state.retained))).toBe(true);
});

test('real text editor panes report focus across tab switches and stop after closing', async ({ page }) => {
	await page.evaluate(() => window.ashCompositeIntegration.openEditor('alpha'));
	const input = page.locator('.ash-editor-pane-host:visible .stanza-editor-input');
	await expect(input).toBeFocused();
	await page.evaluate(() => window.ashCompositeIntegration.openEditor('beta'));
	await expect(input).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.editorState())).toEqual([
		{ name: 'alpha', focused: false, visible: false, retained: true },
		{ name: 'beta', focused: true, visible: true, retained: true },
	]);
	await page.evaluate(() => window.ashCompositeIntegration.openEditor('alpha'));
	await expect(input).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.editorEvents)).toEqual(['alpha:focus', 'beta:focus', 'alpha:blur', 'alpha:focus', 'beta:blur']);
	await page.evaluate(() => window.ashCompositeIntegration.closeEditor('alpha'));
	await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.editorState()[0]!.focused)).toBe(false);
});

test('storage flush captures the live pane size and stops after the panel is disposed', async ({ page }) => {
	const height = await page.locator('[data-view-id="first.view"]').evaluate(element => element.getBoundingClientRect().height);
	expect(height).toBeGreaterThan(0);
	expect(await page.evaluate(() => window.ashCompositeIntegration.flushPaneState())).toBeCloseTo(height, 0);
	await page.evaluate(() => window.ashCompositeIntegration.dispose());
	expect(await page.evaluate(() => window.ashCompositeIntegration.flushPaneState())).toBeUndefined();
});


test('Sessions reuse single-content editor groups, replace in place and keep the sibling draft and outside focus', async ({ page }) => {
	await page.evaluate(() => window.ashSessionGridIntegration.show(['alpha', 'beta'], 'beta'));
	const host = page.locator('#session-grid');
	const alpha = host.getByRole('textbox', { name: 'alpha prompt', exact: true });
	await alpha.fill('Retained draft');
	await host.getByRole('textbox', { name: 'beta prompt', exact: true }).focus();
	const before = await alpha.boundingBox();
	await page.getByRole('button', { name: 'Outside content' }).focus();
	await page.evaluate(() => window.ashSessionGridIntegration.replace('gamma'));
	await expect(host.locator('.ash-editor-group')).toHaveCount(2);
	await expect(host.getByRole('tab')).toHaveCount(2);
	await expect(host.getByRole('textbox', { name: 'beta prompt', exact: true })).toHaveCount(0);
	await expect(host.getByRole('textbox', { name: 'gamma prompt', exact: true })).toBeVisible();
	await expect(alpha).toHaveValue('Retained draft');
	expect(await alpha.boundingBox()).toEqual(before);
	await expect(page.getByRole('button', { name: 'Outside content' })).toBeFocused();
	await host.getByRole('tab', { name: 'alpha', exact: true }).press('Enter');
	await expect(alpha).toBeFocused();
	expect(await page.evaluate(() => window.ashSessionGridIntegration.active())).toBe('alpha');
});

test('Sessions use editor drag and drop to arrange conversations vertically without recreating the input', async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 1200 });
	await page.evaluate(() => window.ashSessionGridIntegration.show(['alpha', 'beta'], 'beta'));
	const host = page.locator('#session-grid');
	const alpha = host.getByRole('textbox', { name: 'alpha prompt', exact: true });
	const beta = host.getByRole('textbox', { name: 'beta prompt', exact: true });
	await alpha.fill('Keep this draft');
	const source = host.locator('.ash-tab').filter({ has: page.getByRole('tab', { name: 'alpha', exact: true }) });
	const target = host.locator('.ash-editor-group').filter({ has: page.getByRole('textbox', { name: 'beta prompt', exact: true }) });
	const bounds = (await target.boundingBox())!;
	await source.dragTo(target, { targetPosition: { x: bounds.width / 2, y: bounds.height - 5 } });
	await expect(host.locator('.ash-editor-group')).toHaveCount(2);
	await expect.poll(async () => {
		const a = (await alpha.boundingBox())!;
		const b = (await beta.boundingBox())!;
		return { below: a.y > b.y, aligned: Math.abs(a.x - b.x) < 1, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
	}).toMatchObject({ below: true, aligned: true });
	await expect(alpha).toHaveValue('Keep this draft');
	await page.reload();
	await page.waitForFunction(() => !!window.ashSessionGridIntegration);
	await page.evaluate(() => window.ashSessionGridIntegration.show(['alpha', 'beta'], 'beta'));
	await expect.poll(async () => {
		const a = (await alpha.boundingBox())!;
		const b = (await beta.boundingBox())!;
		return a.y > b.y && Math.abs(a.x - b.x) < 1;
	}).toBe(true);
});

test('Sessions reject a document tab from a host with a different pane registry', async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 1200 });
	await page.evaluate(() => window.ashSessionGridIntegration.show(['conversation'], 'conversation'));
	const host = page.locator('#session-grid');
	const draft = host.getByRole('textbox', { name: 'conversation prompt', exact: true });
	await draft.fill('Keep this conversation');
	await page.evaluate(() => window.ashCompositeIntegration.openEditor('document'));
	const source = page.locator('.ash-tab').filter({ has: page.getByRole('tab', { name: 'document.ts', exact: true }) });
	const target = host.locator('.ash-editor-group');
	const bounds = (await target.boundingBox())!;
	await source.dragTo(target, { targetPosition: { x: bounds.width / 2, y: bounds.height - 5 } });
	await expect(host.locator('.ash-editor-group')).toHaveCount(1);
	await expect(draft).toHaveValue('Keep this conversation');
	await expect(page.getByRole('tab', { name: 'document.ts', exact: true })).toBeVisible();
});

test('Sessions preserve Chinese titles when replacing the active group under the Chinese locale', async ({ page }) => {
	await page.goto('/composite.html?locale=zh-CN');
	await page.waitForFunction(() => !!window.ashSessionGridIntegration);
	await page.evaluate(() => window.ashSessionGridIntegration.show(['甲', '乙'], '乙'));
	const host = page.locator('#session-grid');
	await expect(host.getByRole('tab', { name: '甲', exact: true })).toBeVisible();
	await expect(host.getByRole('tab', { name: '乙', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashSessionGridIntegration.replace('丙'));
	await expect(host.getByRole('tab', { name: '甲', exact: true })).toBeVisible();
	await expect(host.getByRole('tab', { name: '丙', exact: true })).toBeVisible();
	await expect(host.getByRole('tab', { name: '乙', exact: true })).toHaveCount(0);
	await expect(host.locator('.ash-editor-group')).toHaveCount(2);
});
