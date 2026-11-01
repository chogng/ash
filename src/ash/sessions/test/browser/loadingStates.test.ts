import { suite, test, teardown } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('Region loading in the Sessions workbench', () => {
	const browser = useBrowserTests();
	teardown(async () => {
		expect(await browser.page.evaluate(() => window.ashSessionsIntegration.errors)).toEqual([]);
	});
	for (const locale of ['en', 'zh-CN']) {
		test(`keeps navigation and catalog controls available while content loads, and retains cached cards (${locale})`, async () => {
			const { page } = browser;
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
			try {
				await root.getByRole('tab', { name: chinese ? '连接器' : 'Connectors', exact: true }).click();
				await expect(root.locator('.ash-customize-panel')).toHaveAttribute('aria-busy', 'true');
				await expect(root.getByRole('status')).toHaveText(chinese ? '正在加载资源…' : 'Loading resources…');
				await expect(root.getByRole('tab').first()).toBeEnabled();
				await expect(page.locator('[data-action-id="sessions.open.projects"] button')).toBeEnabled();
				await gate.evaluate(value => value.release());
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
				expect(await card!.evaluate(element => element.isConnected)).toBe(true);
				await refresh.evaluate(value => value.fail());
				await expect(root.getByRole('status')).toContainText('Synthetic loading failure');
			} finally {
				await refresh.evaluate(value => value.release());
				await refresh.dispose();
			}
		});
	}
});
