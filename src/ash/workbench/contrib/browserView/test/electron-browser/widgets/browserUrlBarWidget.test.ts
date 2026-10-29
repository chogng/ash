import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IQuickInputService, IQuickPick } from '../../../../../../platform/quickinput/common/quickInput.js';
import type { BrowserEditorInput } from '../../../common/browserEditorInput.js';
import type { IBrowserUrlSuggestion, IBrowserUrlSuggestionProvider } from '../../../electron-browser/browserEditor.js';
import { BrowserUrlBarWidget, type IUrlPickerItem } from '../../../electron-browser/widgets/browserUrlBarWidget.js';

suite('Browser URL suggestions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('late provider results cannot replace the current query or navigate a replaced page', async () => {
		using f = fixture();
		const queries: Array<{
			text: string;
			token: import('../../../../../../base/common/cancellation.js').CancellationToken;
			result: ReturnType<typeof promiseWithResolvers<readonly IBrowserUrlSuggestion[]>>;
		}> = [];
		const provider: IBrowserUrlSuggestionProvider = {
			getSuggestions: ({ text }, token) => {
				const result = promiseWithResolvers<readonly IBrowserUrlSuggestion[]>();
				queries.push({ text, token, result });
				return result.promise;
			},
		};
		f.widget.mountContributions([{ urlSuggestionProviders: [provider] }]);
		f.widget.openUrlPicker();
		f.pick.value = 'current';
		f.changed.fire('current');
		assert.equal(queries[0]!.token.isCancellationRequested, true);
		queries[1]!.result.resolve([
			{
				id: 'current',
				label: 'current',
				apply: () => {
					f.applied.push('current');
				},
			},
		]);
		await settle();
		queries[0]!.result.resolve([
			{
				id: 'old',
				label: 'old',
				apply: () => {
					f.applied.push('old');
				},
			},
		]);
		await settle();
		assert.ok(f.pick.items.some(item => !('type' in item) && 'id' in item && item.id === 'current'));
		assert.ok(!f.pick.items.some(item => !('type' in item) && 'id' in item && item.id === 'old'));
		f.pick.selectedItems = f.pick.items.filter(item => !('type' in item) && 'id' in item && item.id === 'current') as IUrlPickerItem[];
		f.host.input = undefined;
		f.accepted.fire({ inBackground: false });
		await settle();
		assert.deepEqual(f.applied, []);
	});
	test('accepting a suggestion cannot navigate a page replaced before the action runs', async () => {
		using f = fixture();
		f.widget.openUrlPicker();
		f.pick.selectedItems = [
			{
				label: 'Captured',
				apply: () => {
					f.applied.push('captured');
				},
			},
		];
		f.accepted.fire({ inBackground: false });
		f.host.input = undefined;
		await settle();
		assert.deepEqual(f.applied, []);
		assert.equal(f.focused, 0);
	});
	test('a slow accepted suggestion respects a later focus change', async () => {
		using f = fixture();
		const navigation = promiseWithResolvers<void>();
		f.widget.openUrlPicker();
		f.pick.selectedItems = [{ label: 'Slow', apply: () => navigation.promise }];
		f.accepted.fire({ inBackground: false });
		await settle();
		const button = f.dom.window.document.createElement('button');
		f.dom.window.document.body.append(button);
		button.focus();
		navigation.resolve();
		await settle();
		assert.equal(f.dom.window.document.activeElement, button);
		assert.equal(f.focused, 0);
	});
	test('keyboard dismissal returns to the page and clearing cancels an open suggestion picker', async () => {
		using f = fixture();
		f.widget.refreshUrl();
		f.widget.inputElement.value = 'unfinished';
		f.widget.inputElement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
		assert.equal(f.widget.value, 'https://example.test/');
		assert.equal(f.focused, 1);
		f.widget.openUrlPicker();
		f.widget.clear();
		assert.equal(f.hidden, 1);
		assert.equal(f.widget.value, '');
		assert.equal(f.focused, 1);
	});
});
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}
function fixture() {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	const changed = resources.add(new Emitter<string>());
	const accepted = resources.add(new Emitter<{ inBackground: boolean }>());
	const hide = resources.add(new Emitter<void>());
	let isHidden = false;
	const f = { dom, changed, accepted, focused: 0, hidden: 0, applied: [] as string[] };
	const host = {
		input: { isDisposed: false, model: { state: { url: 'https://example.test/' } } } as unknown as BrowserEditorInput | undefined,
		ensureBrowserFocus: () => {
			f.focused++;
		},
	};
	const pick = {
		items: [],
		value: '',
		activeItems: [],
		selectedItems: [],
		onDidChangeValue: changed.event,
		onDidAccept: accepted.event,
		onDidHide: hide.event,
		onDidBlur: Event.None,
		show: () => {
			isHidden = false;
		},
		hide: () => {
			if (!isHidden) {
				isHidden = true;
				f.hidden++;
				hide.fire();
			}
		},
		dispose: () => {
			pick.hide();
		},
		[Symbol.dispose]: () => {
			pick.hide();
		},
	} as unknown as IQuickPick<IUrlPickerItem>;
	const quick = { createQuickPick: () => pick } as unknown as IQuickInputService;
	const widget = resources.add(
		new BrowserUrlBarWidget(
			host,
			dom.window.document.body,
			async text => {
				f.applied.push(text);
			},
			error => {
				throw error;
			},
			quick,
		),
	);
	return Object.assign(f, {
		widget,
		host,
		pick,
		[Symbol.dispose]: () => {
			resources.dispose();
			dom.window.close();
		},
	});
}

suite('browserView browser component', () => {
	const browserTests = useBrowserTests();
	test('reload split button localizes its menu and returns focus in Chinese', async () => {
		const { page } = browserTests;
		await page.goto('/browserView.html?locale=zh-CN');
		const dropdown = page.getByRole('button', { name: '更多刷新操作', exact: true });
		await dropdown.click();
		await expect(page.getByRole('menuitem', { name: '忽略缓存重新加载', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dropdown).toBeFocused();
	});
	test('reload split button dispatches page operations and follows loading and auto reload state', async () => {
		const { page } = browserTests;
		await page.goto('/browserView.html');
		await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
		const primary = page.getByRole('button', { name: 'Reload', exact: true });
		const dropdown = page.getByRole('button', { name: 'More Reload Actions', exact: true });
		await primary.click();
		await dropdown.focus();
		await dropdown.press('ArrowDown');
		await page.getByRole('menuitem', { name: 'Reload Without Cache', exact: true }).click();
		await dropdown.click();
		await page.getByRole('menuitemcheckbox', { name: 'Toggle auto reload', exact: true }).click();
		await expect(primary.locator('[data-ash-icon-id="sync"]')).toHaveCount(1);
		await dropdown.click();
		await expect(page.getByRole('menuitemcheckbox', { name: 'Toggle auto reload', exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await expect(dropdown).toBeFocused();
		await page.evaluate(() => window.ashBrowserViewIntegration.loading(true));
		await expect(dropdown).toHaveCount(0);
		await page.getByRole('button', { name: 'Stop', exact: true }).click();
		assert.deepEqual(await page.evaluate(() => [...window.ashBrowserViewIntegration.calls]), ['reload', 'hardReload', 'autoReload', 'stop']);
	});
	for (const locale of ['en', 'zh-CN']) {
		test(`browser history search opens recorded pages and clears the session in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/browserView.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
			const more = page.locator('.ash-browser-page-actions').getByRole('button', { name: locale === 'en' ? 'More Actions' : '更多操作', exact: true });
			const historyLabel = locale === 'en' ? 'History' : '历史记录';
			const openHistory = async (): Promise<void> => {
				await more.focus();
				await page.keyboard.press('Enter');
				await page.getByRole('menuitem', { name: historyLabel, exact: true }).click();
			};
			await openHistory();
			const search = page.getByRole('combobox', { name: historyLabel, exact: true });
			await expect(search).toBeFocused();
			await search.fill('Visited');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['https://example.com/visited']);
			await openHistory();
			await search.fill(locale === 'en' ? 'Clear browsing history' : '清除浏览历史记录');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['https://example.com/visited', 'clearHistory']);
			await expect(more).toBeFocused();
			await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
		});

		test(`browser model replacement retires navigation state and command conditions in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/browserView.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
			const back = page.getByRole('button', { name: locale === 'en' ? 'Back' : '后退', exact: true });
			const forward = page.getByRole('button', { name: locale === 'en' ? 'Forward' : '前进', exact: true });
			await page.evaluate(() => window.ashBrowserViewIntegration.history(false, false));
			await expect(back).toBeDisabled();
			await expect(forward).toBeDisabled();
			expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual([]);
			await page.evaluate(() => window.ashBrowserViewIntegration.history(true, false));
			await expect(back).toBeEnabled();
			expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual(['workbench.action.browser.goBack']);
			await back.click();
			await page.evaluate(() => window.ashBrowserViewIntegration.attach('second'));
			await page.evaluate(() => window.ashBrowserViewIntegration.history(false, true));
			await page.evaluate(() => window.ashBrowserViewIntegration.oldPageStatus());
			await expect(page.getByRole('status')).toHaveText('Browser layout');
			await expect(back).toBeDisabled();
			await expect(forward).toBeEnabled();
			expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual(['workbench.action.browser.goForward']);
			await forward.click();
			expect(await page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['back', 'forward']);
			await page.evaluate(() => window.ashBrowserViewIntegration.detach());
			expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual([]);
			await expect(page.locator('.ash-browser-address input')).toBeDisabled();
			await expect(page.getByRole('status')).toBeEmpty();
			await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
		});

		test(`browser address suggestions apply live search settings and preserve dismissal focus in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/browserView.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
			const label = locale === 'en' ? 'Browser address' : '浏览器地址';
			const address = page.getByRole('textbox', { name: label, exact: true });
			await expect(address).toHaveAttribute('placeholder', locale === 'en' ? 'Enter a URL' : '输入网址');
			await page.evaluate(() => window.ashBrowserViewIntegration.setSearch('google'));
			await expect(address).toHaveAttribute('placeholder', locale === 'en' ? 'Search or enter a URL' : '搜索或输入网址');
			await address.fill('intranet');
			await address.press('ArrowDown');
			const picker = page.getByRole('combobox', { name: label, exact: true });
			await expect(picker).toBeFocused();
			const options = page.getByRole('option');
			await expect(options).toContainText([locale === 'en' ? 'Search for intranet' : '搜索 intranet', locale === 'en' ? 'Go to intranet' : '转到 intranet']);
			await picker.fill('two words');
			await expect(options).toHaveCount(1);
			await page.evaluate(() => window.ashBrowserViewIntegration.setSearch('duckduckgo'));
			await picker.press('Enter');
			await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['https://duckduckgo.com/?q=two+words']);
			await address.fill('https://example.com/');
			await address.press('ArrowDown');
			await expect(picker).toBeFocused();
			await expect(options).toContainText([
				locale === 'en' ? 'Go to https://example.com/' : '转到 https://example.com/',
				locale === 'en' ? 'Search for https://example.com/' : '搜索 https://example.com/',
			]);
			await picker.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(address).toHaveValue('https://example.com/');
			await expect(page.locator('.ash-browser-viewport')).toBeFocused();
			await address.fill('unfinished');
			await address.press('ArrowDown');
			await expect(picker).toBeFocused();
			const back = page.getByRole('button', { name: locale === 'en' ? 'Back' : '后退', exact: true });
			await back.focus();
			await expect(picker).toHaveCount(0);
			await expect(back).toBeFocused();
			await expect(address).toHaveValue('https://example.com/');
			await page.evaluate(() => window.ashBrowserViewIntegration.setSearch('none'));
			await expect(address).toHaveAttribute('placeholder', locale === 'en' ? 'Enter a URL' : '输入网址');
			await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
		});

		for (const width of [1000, 500, 240]) {
			test(`browser navigation leaves usable address space and keyboard page actions in ${locale} at ${width}px`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await page.setViewportSize({ width, height: 600 });
				await page.goto(`/browserView.html?locale=${locale}`);
				await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
				const address = page.getByRole('textbox', {
					name: locale === 'en' ? 'Browser address' : '浏览器地址',
					exact: true,
				});
				await expect(address).toBeEnabled();
				const geometry = await page.locator('.ash-browser-toolbar').evaluate(toolbar => {
					const bounds = toolbar.getBoundingClientRect();
					const input = toolbar.querySelector('input')!.getBoundingClientRect();
					const buttons = [...toolbar.querySelectorAll('button')];
					const controls = [toolbar.querySelector('input')!, ...buttons];
					const rectangles = controls.map(control => control.getBoundingClientRect());
					return {
						addressWidth: input.width,
						toolbarWidth: bounds.width,
						nonOverlapping: rectangles.every((rect, index) =>
							rectangles.slice(index + 1).every(other => rect.right <= other.left || other.right <= rect.left || rect.bottom <= other.top || other.bottom <= rect.top),
						),
						unobscured: controls.every((control, index) => {
							const rect = rectangles[index]!;
							const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
							return target !== null && control.contains(target);
						}),
						contained: [toolbar.querySelector('input')!, ...buttons].every(control => {
							const rect = control.getBoundingClientRect();
							return rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
						}),
						singleLine: [...toolbar.querySelectorAll('button')].every(button => {
							const bounds = button.getBoundingClientRect();
							return bounds.height <= 32 && button.scrollHeight <= button.clientHeight && button.scrollWidth <= button.clientWidth;
						}),
						overflow: toolbar.scrollWidth > toolbar.clientWidth,
					};
				});
				await testInfo.attach('browser-toolbar-geometry', {
					body: JSON.stringify(geometry),
					contentType: 'application/json',
				});
				await testInfo.attach(`browser-toolbar-${locale}-${width}`, {
					body: await page.screenshot(),
					contentType: 'image/png',
				});
				expect(geometry.addressWidth).toBeGreaterThanOrEqual(120);
				expect(geometry).toMatchObject({
					contained: true,
					singleLine: true,
					overflow: false,
					nonOverlapping: true,
					unobscured: true,
				});
				await address.fill('https://example.com/a-readable-address');
				await expect(address).toHaveValue('https://example.com/a-readable-address');
				const more = page.locator('.ash-browser-page-actions').getByRole('button', { name: locale === 'en' ? 'More Actions' : '更多操作', exact: true });
				const labels = locale === 'en' ? ['Share with Agent', 'Reset all website permissions', 'Cancel downloads'] : ['分享给 Agent', '重置所有网站权限', '取消下载'];
				for (const [index, label] of labels.entries()) {
					await more.focus();
					await page.keyboard.press('Enter');
					await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
					await page.getByRole('menuitem', { name: label, exact: true }).focus();
					await page.keyboard.press('Enter');
					await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['share', 'permissions', 'downloads'].slice(0, index + 1));
					await expect(page.getByRole('menu')).toHaveCount(0);
					await expect(more).toBeFocused();
				}
				await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
			});
		}
	}
});
