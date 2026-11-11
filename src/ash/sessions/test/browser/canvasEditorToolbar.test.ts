import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('Canvas editor toolbar reuses shared action views', () => {
	const browser = useBrowserTests();
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`preserves grouped choices, geometry and keyboard focus in ${theme}`, async () => {
			const { page } = browser;
			await page.goto(`/canvasEditorToolbar.html?theme=${theme}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			const tools = page.getByRole('toolbar', { name: 'Canvas tools', exact: true });
			const select = tools.getByRole('button', { name: 'Select (V)', exact: true });
			const dropdown = tools.getByRole('button', { name: 'Selection tools', exact: true });
			const geometry = await select.evaluate(main => {
				const arrow = main.closest('.ash-split-action')!.querySelector('.ash-split-action-dropdown button')!;
				const primary = main.getBoundingClientRect();
				const secondary = arrow.getBoundingClientRect();
				return { width: primary.width, height: primary.height, arrowWidth: secondary.width, arrowHeight: secondary.height, gap: secondary.left - primary.right, labelDisplay: getComputedStyle(main.querySelector('.ash-icon-label-container')!).display };
			});
			assert.deepEqual(geometry, { width: 32, height: 32, arrowWidth: 20, arrowHeight: 32, gap: 0, labelDisplay: 'none' });
			await expect(page.locator('.ash-canvas-editor-toolbar .ash-icon-label-container:visible')).toHaveCount(0);
			await expect(select).toHaveAttribute('aria-pressed', 'true');
			await select.focus();
			await select.press('ArrowRight');
			await expect(dropdown).toBeFocused();
			await dropdown.press('ArrowDown');
			await expect(dropdown).toHaveAttribute('aria-expanded', 'true');
			const current = page.getByRole('menuitemradio', { name: 'Select (V)', exact: true, checked: true });
			await expect(current.locator('.ash-menu-leading-slot [data-ash-icon-id="cursor-2"]')).toBeVisible();
			await expect(current.locator('.ash-menu-trailing-check > [data-ash-icon-id="check"]')).toBeVisible();
			await expect(page.getByRole('menuitemradio', { name: 'Move canvas (H)', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(dropdown).toBeFocused();
			await dropdown.press('ArrowLeft');
			await expect(select).toBeFocused();
			await dropdown.click();
			await page.getByRole('menuitemradio', { name: 'Move canvas (H)', exact: true }).click();
			const hand = tools.getByRole('button', { name: 'Move canvas (H)', exact: true });
			await expect(hand).toHaveAttribute('aria-pressed', 'true');
			await tools.getByRole('button', { name: 'Pen (P)', exact: true }).click();
			await expect(hand).toHaveAttribute('aria-pressed', 'false');
			await hand.click();
			await expect(page.locator('output')).toHaveText('hand/design');
			await page.evaluate(() => window.ashCanvasEditorToolbarFixture.setBusy(true));
			await expect(hand).toBeDisabled();
			await expect(dropdown).toBeDisabled();
			await page.evaluate(() => { window.ashCanvasEditorToolbarFixture.setBusy(false); window.ashCanvasEditorToolbarFixture.setCodeMode(true); });
			await expect(hand).toBeDisabled();
			await page.evaluate(() => window.ashCanvasEditorToolbarFixture.setCodeMode(false));
			await expect(hand).toBeEnabled();
			await dropdown.click();
			await page.evaluate(() => window.ashCanvasEditorToolbarFixture.dispose());
			await expect(page.getByRole('menu')).toHaveCount(0);
			await expect(page.locator('.ash-canvas-editor-toolbar button')).toHaveCount(0);
		});
	}

	test('keeps translated names on icon-only primary actions', async () => {
		const { page } = browser;
		await page.goto('/canvasEditorToolbar.html?locale=zh-CN');
		const tools = page.getByRole('toolbar', { name: '画布工具', exact: true });
		await expect(tools.getByRole('button', { name: '选区（V）', exact: true })).toBeVisible();
		await tools.getByRole('button', { name: '选择工具', exact: true }).click();
		await expect(page.getByRole('menuitemradio', { name: '移动画布（H）', exact: true })).toBeVisible();
	});
});
