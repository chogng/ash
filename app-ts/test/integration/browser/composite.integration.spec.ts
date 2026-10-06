import { test, expect } from '@playwright/test';
import type { } from './composite.integration.js';

test.beforeEach(async ({ page }) => {
	await page.goto('/composite.html');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
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
