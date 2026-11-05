import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('language browser component', () => {
	const browserTests = useBrowserTests();

	test('status circles and the progress ring reflect lifecycle, preserve animation, and support row submenu navigation', async function () {
		const { page } = browserTests;
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.goto('/language.html?widget&preview');
		try {
			await page.locator('[data-statusbar-item-id="ash.status.languageServers"]').getByRole('button').click();
			const widget = page.locator('.ash-language-server-status-widget');
			const server = widget.locator('[data-server-id="rust-analyzer"]');
			const row = server.getByRole('menuitem');
			const icon = server.getByRole('menuitem');
			const firstHover = await widget.evaluate(root => {
				const first = root.querySelector<HTMLElement>('[data-server-id="css-language-server"] > button')!;
				first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 1 }));
				return first.getAttribute('aria-expanded');
			});
			expect(firstHover).toBe('false');
			await expect(widget.getByRole('menu', { name: 'css-language-server', exact: true })).toBeVisible();
			const hoverSwitch = await widget.evaluate(root => {
				const first = root.querySelector<HTMLElement>('[data-server-id="css-language-server"] > button')!;
				const second = root.querySelector<HTMLElement>('[data-server-id="rust-analyzer"] > button')!;
				first.parentElement!.dispatchEvent(new MouseEvent('mouseleave'));
				second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 1 }));
				return { firstAfterSwitch: first.getAttribute('aria-expanded'), secondOpened: second.getAttribute('aria-expanded') };
			});
			expect(hoverSwitch).toEqual({ firstAfterSwitch: 'false', secondOpened: 'true' });
			await page.keyboard.press('Escape');
			await expect(icon.locator('.ash-icon-circle')).toBeVisible();
			await page.evaluate(() => window.languageIntegration.state({ type: 'starting' }));
			const ring = icon.locator('.ash-icon-progress');
			await expect(ring).toBeVisible();
			const animation = await ring.evaluateHandle(node => node.getAnimations()[0]!);
			await animation.evaluate(async animation => { await animation.ready; animation.currentTime = 650; });
			await page.evaluate(() => window.languageIntegration.state({ type: 'backingOff', attempt: 1, retryAfterMillis: 1000 }));
			expect(await ring.evaluate((node, original) => node.getAnimations()[0] === original, animation)).toBe(true);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await expect.poll(() => ring.evaluate(node => node.getAnimations().length)).toBe(0);
			await page.evaluate(() => window.languageIntegration.state({ type: 'ready' }));
			await expect(icon).toHaveClass(/is-ready/);
			await expect(icon.locator('.ash-icon-circle-filled')).toBeVisible();
			await page.evaluate(() => window.languageIntegration.progress(30));
			await expect(icon).toHaveClass(/is-ready/);
			await expect(icon.locator('.ash-icon-progress')).toHaveCount(0);
			await page.evaluate(() => window.languageIntegration.warning('Synthetic warning'));
			await expect(icon).toHaveClass(/is-ready/);
			await page.evaluate(() => window.languageIntegration.error('Synthetic error'));
			await expect(icon).toHaveClass(/is-error/);
			for (const theme of [0, 1, 2, 3]) {
				await page.evaluate(theme => window.languageIntegration.theme(theme), theme);
				const errorColor = await icon.locator('.ash-menu-leading-slot').evaluate(node => getComputedStyle(node).color);
				await page.evaluate(() => window.languageIntegration.state({ type: 'ready' }));
				await expect(icon).toHaveClass(/is-ready/);
				expect(await icon.locator('.ash-menu-leading-slot').evaluate(node => getComputedStyle(node).color)).not.toBe(errorColor);
				expect(await icon.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
				await page.evaluate(() => window.languageIntegration.error('Synthetic error'));
			}
			await page.evaluate(() => { window.languageIntegration.theme(0); window.languageIntegration.state({ type: 'ready' }); window.languageIntegration.progress(100, true); });
			await row.click({ position: { x: 100, y: 12 } });
			const menu = widget.getByRole('menu', { name: 'rust-analyzer', exact: true });
			await expect(menu.getByRole('menuitem', { name: 'View Logs', exact: true })).toBeFocused();
			await expect(row).toHaveAttribute('aria-expanded', 'true');
			const bounds = await widget.boundingBox();
			const menuBounds = await menu.boundingBox();
			expect(menuBounds!.x).toBeGreaterThanOrEqual(bounds!.x + bounds!.width - 8);
			await page.screenshot({ path: browserTests.info.outputPath('status-submenu.png'), clip: { x: bounds!.x, y: Math.min(bounds!.y, menuBounds!.y), width: menuBounds!.x + menuBounds!.width - bounds!.x, height: Math.max(bounds!.y + bounds!.height, menuBounds!.y + menuBounds!.height) - Math.min(bounds!.y, menuBounds!.y) } });
			await page.keyboard.press('ArrowLeft');
			await expect(menu).toHaveCount(0);
			await expect(row).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(widget.getByRole('menuitem', { name: 'Actions for typescript-language-server', exact: true })).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(widget.locator('.ash-context-view-menu > .ash-menu')).toHaveCount(1);
			await widget.getByRole('menuitem', { name: 'View Logs', exact: true }).click();
			await expect(widget).toHaveCount(0);
			expect(await page.evaluate(() => window.languageIntegration.revealedChannel())).toBe('typescript-language-server');
			await animation.dispose();
		} finally {
			await page.evaluate(() => window.languageIntegration.dispose());
		}
	});

	test('the language-server widget updates live state and progress without replacing focused controls', async function () {
		const { page } = browserTests;
		await page.goto('/language.html?widget');
		try {
			const trigger = page.locator('[data-statusbar-item-id="ash.status.languageServers"]').getByRole('button');
			await trigger.click();
			const widget = page.locator('.ash-language-server-status-widget');
			const server = widget.locator('[data-server-id="rust-analyzer"]');
			const menu = widget.getByRole('menu', { name: 'rust-analyzer', exact: true });
			const logs = menu.getByRole('menuitem', { name: 'View Logs', exact: true });
			const stop = menu.getByRole('menuitem', { name: 'Stop Server', exact: true });
			await expect(widget.getByRole('menu', { name: 'Language Services', exact: true })).toBeFocused();
			await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
			await expect(server.getByRole('status')).toHaveText('Not started');
			await expect(server.getByRole('menuitem')).toHaveCount(1);
			await server.getByRole('menuitem', { name: 'Actions for rust-analyzer', exact: true }).press('Enter');
			await expect(stop).toBeDisabled();
			await logs.focus();
			const widgetNode = await widget.elementHandle();
			const logsNode = await logs.elementHandle();
			for (const [state, label] of [
				[{ type: 'starting' }, 'Starting…'],
				[{ type: 'ready' }, 'Running'],
				[{ type: 'backingOff', attempt: 2, retryAfterMillis: 1500 }, 'Restarting…'],
				[{ type: 'failed', message: 'Synthetic start failure' }, 'Failed'],
				[{ type: 'ready' }, 'Running'],
			] as const) {
				await page.evaluate(state => window.languageIntegration.state(state), state);
				await expect(server.getByRole('status')).toHaveText(label);
				await expect(server.getByRole('menuitem')).toHaveAttribute('title', `rust-analyzer: ${label}`);
				await expect(stop).toBeEnabled();
				await expect(logs).toBeFocused();
				expect(await widget.evaluate((node, original) => node === original, widgetNode)).toBe(true);
				expect(await logs.evaluate((node, original) => node === original, logsNode)).toBe(true);
			}
			await page.evaluate(() => window.languageIntegration.progress(68));
			await expect(server.locator('.ash-language-server-progress-text')).toHaveText('Indexing (68%): Reading workspace');
			await expect(logs).toBeFocused();
			await page.evaluate(() => window.languageIntegration.warning('Synthetic warning'));
			await expect(server.getByRole('status')).toHaveText('Running');
			await expect(server.locator('.ash-language-server-detail')).toHaveText('Synthetic warning');
			await expect(server.locator('.ash-language-server-summary.is-ready .ash-icon-circle-filled')).toBeVisible();
			await page.evaluate(() => window.languageIntegration.state({ type: 'ready' }));
			await stop.focus();
			await page.evaluate(() => window.languageIntegration.state({ type: 'stopped' }));
			await expect(server.getByRole('status')).toHaveText('Stopped');
			await expect(stop).toBeDisabled();
			await expect(logs).toBeFocused();
			await expect(server.locator('.ash-language-server-progress-text')).toBeHidden();
			await page.keyboard.press('Escape');
			await expect(menu).toHaveCount(0);
			await expect(widget).toBeVisible();
			await expect(server.getByRole('menuitem')).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(widget).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		} finally {
			await page.evaluate(() => window.languageIntegration.dispose());
		}
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`restart and stop retain the widget and outside dismissal restores focus (${locale})`, async function () {
			const { page } = browserTests;
			await page.goto(`/language.html?widget&locale=${locale}`);
			const zh = locale === 'zh-CN';
			try {
				const trigger = page.locator('[data-statusbar-item-id="ash.status.languageServers"]').getByRole('button');
				await page.evaluate(() => window.languageIntegration.state({ type: 'ready' }));
				await trigger.click();
				const widget = page.locator('.ash-language-server-status-widget');
				const server = widget.locator('[data-server-id="rust-analyzer"]');
				const row = server.getByRole('menuitem');
				const menu = widget.locator('.ash-context-view-menu > .ash-menu');
				const restart = menu.getByRole('menuitem', { name: zh ? '重启服务器' : 'Restart Server', exact: true });
				const stop = menu.getByRole('menuitem', { name: zh ? '停止服务器' : 'Stop Server', exact: true });
				const widgetNode = await widget.elementHandle();
				await row.click();
				await restart.focus();
				await restart.press('Enter');
				await expect(menu).toHaveCount(0);
				await expect(row).toBeFocused();
				await expect(server.getByRole('status')).toHaveText(zh ? '正在启动…' : 'Starting…');
				await expect(server.locator('.ash-icon-progress')).toBeVisible();
				await row.press('ArrowRight');
				await expect(restart).toBeDisabled();
				await expect(stop).toBeDisabled();
				await page.evaluate(() => window.languageIntegration.finishControl());
				await expect(server.getByRole('status')).toHaveText(zh ? '运行中' : 'Running');
				await expect(restart).toBeEnabled();
				await stop.click();
				await expect(menu).toHaveCount(0);
				await expect(server.getByRole('status')).toHaveText(zh ? '已停止' : 'Stopped');
				await page.evaluate(() => window.languageIntegration.finishControl());
				await row.click();
				await expect(restart).toBeEnabled();
				await expect(stop).toBeDisabled();
				expect((await page.evaluate(() => window.languageIntegration.controls())).map(request => request.action)).toEqual(['restart', 'stop']);
				expect(await widget.evaluate((node, original) => node === original, widgetNode)).toBe(true);
				const outside = page.locator('#install');
				const bounds = (await outside.boundingBox())!;
				const x = bounds.x + bounds.width / 2;
				const y = bounds.y + bounds.height / 2;
				await page.mouse.move(x, y);
				expect(await outside.evaluate(button => button.matches(':hover'))).toBe(false);
				await page.mouse.down();
				await expect(widget).toBeVisible();
				await expect(outside).not.toBeFocused();
				await page.mouse.up();
				await expect(widget).toHaveCount(0);
				await expect(trigger).toBeFocused();
				await trigger.press('Enter');
				await expect(widget).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(widget).toHaveCount(0);
				await expect(trigger).toBeFocused();
			} finally {
				await page.evaluate(() => window.languageIntegration.dispose());
			}
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`resting rows show the status icon and name while exposing state through hover and accessibility (${locale})`, async function () {
			const { page } = browserTests;
			await page.goto(`/language.html?widget&preview&locale=${locale}`);
			try {
				await page.evaluate(() => window.languageIntegration.state({ type: 'ready' }));
				await page.locator('[data-statusbar-item-id="ash.status.languageServers"]').getByRole('button').click();
				const widget = page.locator('.ash-language-server-status-widget');
				await expect(widget.getByRole('heading', { level: 2 })).toHaveCount(0);
				await expect(widget.getByRole('button', { name: locale === 'zh-CN' ? '关闭语言服务' : 'Close Language Services', exact: true })).toHaveCount(0);
				await expect(widget.locator('.ash-language-server-row')).toHaveCount(4);
				const bounds = await widget.boundingBox();
				expect(bounds!.height).toBeLessThanOrEqual(220);
				expect(bounds!.width).toBeLessThan(300);
				await expect(widget.getByRole('menu', { name: locale === 'zh-CN' ? '语言服务' : 'Language Services', exact: true })).toBeVisible();
				for (const row of await widget.locator('.ash-language-server-row').all()) {
					await expect(row.getByRole('menuitem')).toHaveCount(1);
					const id = await row.getAttribute('data-server-id');
					const state = id === 'rust-analyzer' ? (locale === 'zh-CN' ? '运行中' : 'Running') : (locale === 'zh-CN' ? '未启动' : 'Not started');
					await expect(row.getByRole('menuitem')).toHaveText(id!);
					await expect(row.getByRole('menuitem')).toHaveAccessibleDescription(state);
					await expect(row.getByRole('menuitem')).toHaveAttribute('title', locale === 'zh-CN' ? `${id}：${state}` : `${id}: ${state}`);
					const name = await row.locator('.ash-icon-label-text').boundingBox();
					const chevron = await row.locator('.ash-submenu-indicator').boundingBox();
					expect(name!.y).toBeLessThan(chevron!.y + chevron!.height);
					expect(chevron!.y).toBeLessThan(name!.y + name!.height);
					expect(await row.getByRole('status').evaluate(node => getComputedStyle(node).clipPath)).toBe('inset(50%)');
				}
				await expect(widget.locator('.ash-language-server-folder-path')).toHaveCount(0);
			} finally {
				await page.evaluate(() => window.languageIntegration.dispose());
			}
		});
	}

	test('the widget retains scrolling and stays readable in a narrow viewport and all four themes', async function () {
		const { page } = browserTests;
		await page.setViewportSize({ width: 360, height: 560 });
		await page.goto('/language.html?widget&many');
		try {
			await page.locator('[data-statusbar-item-id="ash.status.languageServers"]').getByRole('button').click();
			const widget = page.locator('.ash-language-server-status-widget');
			const scrollable = widget.locator(':scope > .ash-menu');
			await expect.poll(() => scrollable.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
			await scrollable.evaluate(node => { node.scrollTop = 150; });
			await page.evaluate(() => window.languageIntegration.warning('LongStatusDetail'.repeat(20)));
			expect(await scrollable.evaluate(node => node.scrollTop)).toBe(150);
			for (const theme of [0, 1, 2, 3]) {
				await page.evaluate(theme => window.languageIntegration.theme(theme), theme);
				const style = await widget.evaluate(node => {
					const computed = getComputedStyle(node.parentElement!);
					const bounds = node.getBoundingClientRect();
					return { color: computed.color, background: computed.backgroundColor, border: computed.borderColor, shadow: computed.boxShadow, radius: computed.borderRadius, width: bounds.width, left: bounds.left, right: bounds.right, horizontalOverflow: node.scrollWidth > node.clientWidth };
				});
				expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
				expect(style.color).not.toBe(style.background);
				expect(style.radius).toBe('8px');
				expect(style.horizontalOverflow).toBe(false);
				expect(style.left).toBeGreaterThanOrEqual(0);
				expect(style.right).toBeLessThanOrEqual(360);
				if (theme >= 2) {
					expect(style.shadow).toBe('none');
					expect(style.border).not.toBe(style.background);
				}
			}
		} finally {
			await page.evaluate(() => window.languageIntegration.dispose());
		}
	});

	test('failed control stays open and disposing status releases its widget', async function () {
		const { page } = browserTests;
		await page.goto('/language.html?widget');
		try {
			await page.locator('[data-statusbar-item-id="ash.status.languageServers"]').getByRole('button').click();
			const widget = page.locator('.ash-language-server-status-widget');
			const server = widget.locator('[data-server-id="rust-analyzer"]');
			const restart = widget.getByRole('menuitem', { name: 'Restart Server', exact: true });
			await server.getByRole('menuitem', { name: 'Actions for rust-analyzer', exact: true }).click();
			await restart.click();
			await page.evaluate(() => window.languageIntegration.finishControl('Synthetic failure'));
			await server.getByRole('menuitem').click();
			await expect(restart).toBeEnabled();
			await expect(widget).toBeVisible();
			await restart.click();
			await page.evaluate(() => window.languageIntegration.disposeProgress());
			await page.evaluate(() => window.languageIntegration.finishControl('Late failure after disposal'));
			await expect(widget).toHaveCount(0);
			await page.evaluate(() => window.languageIntegration.state({ type: 'ready' }));
			await expect(page.locator('[data-statusbar-item-id="ash.status.languageServers"]')).toHaveCount(0);
		} finally {
			await page.evaluate(() => window.languageIntegration.dispose());
		}
	});

	test('status bar progress keeps its animation through its own and other entry updates', async function () {
		const { page } = browserTests;

		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.goto('/language.html');
		try {
			await page.evaluate(() => { window.languageIntegration.progress(10); window.languageIntegration.updatePeer(10); });
			const progress = page.locator('[data-statusbar-item-id="status.progress"]');
			const peer = page.locator('[data-statusbar-item-id="test.sync"]');
			const icon = progress.locator('.ash-statusbar-progress');
			const peerIcon = peer.locator('.ash-statusbar-progress');
			const animation = await icon.evaluateHandle(element => element.getAnimations()[0]!);
			const peerAnimation = await peerIcon.evaluateHandle(element => element.getAnimations()[0]!);
			await animation.evaluate(async animation => { await animation.ready; animation.currentTime = 650; });
			await peerAnimation.evaluate(async animation => { await animation.ready; animation.currentTime = 650; });
			await progress.getByRole('button').focus();
			for (const percentage of [20, 40, 60]) {
				await page.evaluate(percentage => window.languageIntegration.progress(percentage), percentage);
				await expect(progress).toHaveText(`rust-analyzer: Indexing (${percentage}%): Reading workspace`);
				await page.evaluate(percentage => window.languageIntegration.updatePeer(percentage), percentage);
				await expect(peer).toHaveText(`Sync ${percentage}%`);
				expect(await icon.evaluate((element, animation) => element.getAnimations()[0] === animation, animation)).toBe(true);
				expect(await peerIcon.evaluate((element, animation) => element.getAnimations()[0] === animation, peerAnimation)).toBe(true);
				expect(await animation.evaluate(animation => animation.currentTime as number)).toBeGreaterThanOrEqual(650);
				expect(await peerAnimation.evaluate(animation => animation.currentTime as number)).toBeGreaterThanOrEqual(650);
				await expect(progress.getByRole('button')).toBeFocused();
			}
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await expect.poll(() => icon.evaluate(element => element.getAnimations().length)).toBe(0);
			await expect.poll(() => peerIcon.evaluate(element => element.getAnimations().length)).toBe(0);
			await animation.dispose();
			await peerAnimation.dispose();
		} finally {
			await page.evaluate(() => window.languageIntegration.dispose());
		}
	});

	test('language-server window progress names its server and retains keyboard activation through updates', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/language.html');
		try {
			await page.evaluate(() => window.languageIntegration.progress(68));
			const entry = page.locator('[data-statusbar-item-id="status.progress"]');
			const action = entry.getByRole('button', { name: 'rust-analyzer: Indexing (68%): Reading workspace', exact: true });
			await expect(entry).toHaveText('rust-analyzer: Indexing (68%): Reading workspace');
			await page.locator('.ash-workbench-statusbar').focus();
			await page.keyboard.press('ArrowRight');
			await expect(action).toBeFocused();
			await page.evaluate(() => window.languageIntegration.progress(90));
			const updated = entry.getByRole('button', { name: 'rust-analyzer: Indexing (90%): Reading workspace', exact: true });
			await expect(updated).toBeFocused();
			await updated.press('Enter');
			expect(await page.evaluate(() => window.languageIntegration.revealedChannel())).toBe('rust-analyzer');
			await page.evaluate(() => window.languageIntegration.progress(100, true));
			await expect(entry).toHaveCount(0);
			await page.evaluate(() => window.languageIntegration.progress(10));
			await expect(entry).toBeVisible();
			await page.evaluate(() => window.languageIntegration.disposeProgress());
			await expect(entry).toHaveCount(0);
			expect(errors).toEqual([]);
		} finally {
			await page.evaluate(() => window.languageIntegration.dispose());
		}
	});

	test('installing a language package enables completion in an already open Python editor', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto('/language.html');
		try {
			expect(await page.evaluate(() => window.languageIntegration.registered())).toBe(false);
			await page.getByRole('button', { name: 'Install Python server', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.languageIntegration.registered())).toBe(true);
			await page.evaluate(() => window.languageIntegration.focus());
			await page.keyboard.press('Control+Space');
			await expect(page.locator('.stanza-editor-completion-option').filter({ hasText: 'print_from_server' })).toBeVisible();
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Uninstall Python server', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.languageIntegration.registered())).toBe(false);
			const requests = await page.evaluate(() => window.languageIntegration.requests());
			await page.evaluate(() => window.languageIntegration.focus());
			await page.keyboard.press('Control+Space');
			await expect(page.locator('.stanza-editor-completion-option').filter({ hasText: 'print_from_server' })).toHaveCount(0);
			expect(await page.evaluate(() => window.languageIntegration.requests())).toBe(requests);
			expect(errors).toEqual([]);
		} finally {
			await page.evaluate(() => window.languageIntegration.dispose());
		}
	});
});
