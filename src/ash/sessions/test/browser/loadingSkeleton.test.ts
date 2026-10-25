import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { LoadingSkeleton } from '../../browser/ui/loadingSkeleton.js';

suite('Independent loading regions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('finishing one region leaves other regions loading and never creates fake controls', () => {
		const parent = document.createElement('div');
		using history = new LoadingSkeleton(parent, 'History', 'list', 3);
		using content = new LoadingSkeleton(parent, 'Content', 'cards', 2);
		history.setVisible(true);
		content.setVisible(true);
		history.setVisible(false);
		assert.equal(history.element.hidden, true);
		assert.equal(history.element.querySelector('[role="status"]')!.textContent, '');
		assert.equal(content.element.hidden, false);
		assert.equal(content.element.querySelector('[role="status"]')!.textContent, 'Content');
		assert.equal(content.element.querySelectorAll('.ash-sessions-loading-row').length, 2);
		assert.equal(content.element.querySelector('.ash-sessions-loading-shapes')!.getAttribute('aria-hidden'), 'true');
		assert.equal(parent.querySelector('button, input, a, [tabindex]'), null);
	});

	test('disposing a region removes its status and decorative shapes', () => {
		const parent = document.createElement('div');
		const skeleton = new LoadingSkeleton(parent, 'History');
		skeleton.setVisible(true);
		skeleton.dispose();
		assert.equal(parent.childElementCount, 0);
	});
});

suite('Region loading in the Sessions workbench', () => {
	const browser = useBrowserTests();
	teardown(async () => {
		expect(await browser.page.evaluate(() => window.ashSessionsIntegration.errors)).toEqual([]);
	});
	for (const locale of ['en', 'zh-CN']) {
		test(`keeps navigation and catalog controls available while content loads, and retains cached cards (${locale})`, async () => {
			const { page, info } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?customize&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.customize"] button').click();
			await expect(page.locator('.ash-customize-card')).toHaveCount(3);
			const hold = () => page.evaluateHandle(() => {
				const connectors = globalThis.ashWebWorkbenchHost!.api.connectors;
				const original = connectors.list;
				let finish!: () => void;
				let fail!: (error: Error) => void;
				const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
				connectors.list = async () => { await pending; return original.call(connectors); };
				return {
					release: () => { connectors.list = original; finish(); },
					fail: () => { connectors.list = original; fail(new Error('Synthetic loading failure')); },
				};
			});
			const gate = await hold();
			const root = page.locator('.ash-customize');
			const skeleton = root.locator('.ash-sessions-loading');
			try {
				await root.getByRole('tab', { name: chinese ? '连接器' : 'Connectors', exact: true }).click();
				await expect(skeleton).toBeVisible();
				await expect(root.locator('.ash-customize-panel')).toHaveAttribute('aria-busy', 'true');
				await expect(skeleton.getByRole('status')).toHaveText(chinese ? '正在加载资源…' : 'Loading resources…');
				await expect(root.getByRole('tab').first()).toBeEnabled();
				await expect(page.locator('[data-action-id="sessions.open.projects"] button')).toBeEnabled();
				for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
					await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
					const block = skeleton.locator('.ash-sessions-loading-block').first();
					await expect(block).toBeVisible();
					await expect(block).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
					if (theme.includes('contrast')) await expect(block).toHaveCSS('outline-style', 'solid');
					await page.screenshot({ path: info.outputPath(`region-loading-${locale}-${theme}.png`) });
				}
				await page.setViewportSize({ width: 720, height: 720 });
				await page.emulateMedia({ reducedMotion: 'reduce' });
				expect(await skeleton.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
				expect(await skeleton.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
				await gate.evaluate(value => value.release());
				await expect(skeleton).toBeHidden();
				await expect(root.locator('.ash-customize-card-name')).toHaveText(['Team library']);
			} finally {
				await gate.evaluate(value => value.release());
				await gate.dispose();
			}

			const refresh = await hold();
			try {
				const card = await root.locator('.ash-customize-card').elementHandle();
				await root.getByRole('button', { name: chinese ? '刷新' : 'Refresh', exact: true }).click();
				await expect(root.locator('.ash-customize-panel')).toHaveAttribute('aria-busy', 'true');
				await expect(skeleton).toBeHidden();
				expect(await card!.evaluate(element => element.isConnected)).toBe(true);
				await refresh.evaluate(value => value.fail());
				await expect(root.getByRole('status')).toContainText('Synthetic loading failure');
				await expect(skeleton).toBeHidden();
			} finally {
				await refresh.evaluate(value => value.release());
				await refresh.dispose();
			}
		});
	}
});
