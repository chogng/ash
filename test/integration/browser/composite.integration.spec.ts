import { test, expect } from '@playwright/test';
import type { } from './composite.integration.js';

for (const locale of ['en', 'zh-CN']) {
	test(`Agent Output keeps session identity, clears only its text and opens exact Trace events (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/composite.html?output&agentOutput&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashCompositeIntegration);
		await page.evaluate(async () => {
			await window.ashCompositeIntegration.open('ash.panel.output');
			window.ashCompositeIntegration.resize(1200, 360);
			window.ashCompositeIntegration.showAgentOutput();
		});
		const channel = page.locator('[data-action-id="ash.output.selectChannel"] button');
		await expect(channel).toContainText('Agent output fixture');
		const output = page.locator('[data-view-id="ash.output"]');
		await expect(output).toContainText(locale === 'en' ? 'Turn started' : 'Turn 已开始');
		await page.evaluate(() => window.ashCompositeIntegration.changeAgentSession('second'));
		await expect(channel).toContainText('Agent output fixture');
		const link = output.locator('.view-line').filter({ hasText: 'eventId=event-1' }).locator('span').last();
		await link.click({ modifiers: ['ControlOrMeta'] });
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.openedAgentEvents)).toEqual([{ sessionId: 'first', threadId: 'root', turnId: 'turn', eventId: 'event-1' }]);
		await page.locator('[data-action-id="ash.output.clear"] button').click();
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.outputState().text)).toBe('');
		const follow = page.locator('[data-action-id="ash.output.autoScroll"] button');
		if (await follow.getAttribute('aria-pressed') === 'true') await follow.click();
		await page.evaluate(() => window.ashCompositeIntegration.appendAgentEvent());
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.outputState().text)).toContain('eventId=event-2');
		expect(await page.evaluate(() => window.ashCompositeIntegration.outputState().text)).not.toContain('eventId=event-1');
		await expect(follow).toHaveAttribute('aria-pressed', 'false');
		await page.evaluate(() => window.ashCompositeIntegration.showAgentOutput());
		await expect(channel).toContainText('Agent output second');
		await page.locator('.ash-workbench-panel').screenshot({ path: testInfo.outputPath(`agent-output-${locale}.png`) });
		expect(errors).toEqual([]);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Output moves its filter between the title and body without losing focus (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/composite.html?output&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashCompositeIntegration);
		await page.evaluate(async () => {
			await window.ashCompositeIntegration.open('ash.panel.output');
			window.ashCompositeIntegration.resize(1200, 320);
		});
		const panel = page.locator('.ash-workbench-panel');
		const title = panel.locator('.ash-panel-title-control');
		const input = panel.locator('.ash-output-filter-input');
		const filter = panel.locator('[data-action-id="ash.output.filter"] button');
		const follow = title.locator('[data-action-id="ash.output.autoScroll"] button');
		const clear = title.locator('[data-action-id="ash.output.clear"] button');
		await expect(title.locator('.ash-output-filter-input')).toBeVisible();
		await expect(input).toHaveAttribute('aria-label', locale === 'en' ? 'Filter Output' : '筛选输出');
		await expect(clear.locator('[data-ash-icon-id="clear-all"]')).toBeVisible();
		await expect(follow.locator('[data-ash-icon-id="follow"]')).toBeVisible();
		await expect(follow).toHaveAttribute('aria-pressed', 'true');
		await follow.click();
		await expect(follow).toHaveAttribute('aria-pressed', 'false');
		await page.evaluate(() => window.ashCompositeIntegration.appendOutput('new message while following is off'));
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.outputState().text)).toContain('new message while following is off');
		await expect(follow.locator('[data-ash-icon-id="follow"]')).toBeVisible();
		await follow.press('Enter');
		await expect(follow).toHaveAttribute('aria-pressed', 'true');
		await input.fill('restored');
		await input.evaluate(element => (element as HTMLInputElement).setSelectionRange(2, 5));
		for (const [width, inHeader] of [[480, false], [800, true], [420, false], [1200, true]] as const) {
			const height = 320;
			await page.evaluate(({ width, height }) => window.ashCompositeIntegration.resize(width, height), { width, height });
			await expect(input).toBeFocused();
			await expect(input).toHaveValue('restored');
			expect(await input.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual([2, 5]);
			await expect(title.locator('.ash-output-filter-input')).toHaveCount(inHeader ? 1 : 0);
			await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.outputState().filter)).toBe('restored');
			await expect.poll(() => title.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
			if (width === 480) await panel.screenshot({ path: testInfo.outputPath(`output-${locale}-narrow.png`) });
		}
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-light', 'ash-high-contrast-dark']) {
			await page.evaluate(theme => window.ashCompositeIntegration.setEditorTheme(theme), theme);
			const colors = await input.evaluate(element => {
				const style = getComputedStyle(element.parentElement!);
				return { foreground: style.color, background: style.backgroundColor, border: style.borderTopColor };
			});
			expect(colors.foreground).not.toBe(colors.background);
			expect(colors.border).not.toBe('rgba(0, 0, 0, 0)');
			await panel.screenshot({ path: testInfo.outputPath(`output-${locale}-${theme}.png`) });
		}
		await input.press('Escape');
		await expect(input).toHaveValue('');
		await input.press('Tab');
		await expect(filter).toBeFocused();
		await filter.press('Enter');
		const errorOption = page.getByRole('menuitemcheckbox', { name: locale === 'en' ? 'Error' : '错误', exact: true });
		await expect(errorOption).toBeVisible();
		await errorOption.click();
		await expect(filter).toHaveAttribute('aria-label', locale === 'en' ? 'Filter Output (Filters Active)' : '筛选输出（已启用筛选条件）');
		await clear.click();
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.outputState().text)).toBe('');
		await expect(clear).toBeDisabled();
		expect(errors).toEqual([]);
	});
}

test.beforeEach(async ({ page }) => {
	await page.goto('/composite.html');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
});

test('Auxiliary Part sash stops at the hosted Chat minimum and releases it when Sessions closes', async ({ page }) => {
	await page.goto('/composite.html?partWidth');
	await expect.poll(() => page.evaluate(() => window.ashPartWidthIntegration.state().minimum)).toBe(301);
	await page.evaluate(() => window.ashPartWidthIntegration.setMinimum(520));
	await expect.poll(() => page.evaluate(() => window.ashPartWidthIntegration.state())).toEqual({ minimum: 521, frameMinimum: 537, width: 537 });
	const sash = page.locator('#part-width-host .ash-grid > .ash-split-view > .ash-sash');
	const bounds = await sash.boundingBox();
	expect(bounds).not.toBeNull();
	await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds!.x + 250, bounds!.y + bounds!.height / 2, { steps: 10 });
	await page.mouse.up();
	await expect.poll(() => page.evaluate(() => window.ashPartWidthIntegration.state().width)).toBe(537);
	await sash.focus();
	await page.keyboard.press('ArrowRight');
	await expect.poll(() => page.evaluate(() => window.ashPartWidthIntegration.state().width)).toBe(537);
	const part = page.locator('#part-width-host .ash-workbench-auxiliarybar');
	await expect(part.getByLabel('First input')).toBeVisible();
	await expect.poll(() => part.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.locator('#part-width-host').screenshot({ path: test.info().outputPath('auxiliary-part-minimum.png') });
	await page.evaluate(() => { window.ashPartWidthIntegration.setMinimum(300); window.ashPartWidthIntegration.resize(1); });
	await expect.poll(() => page.evaluate(() => window.ashPartWidthIntegration.state())).toEqual({ minimum: 301, frameMinimum: 317, width: 317 });
});

for (const locale of ['en', 'zh-CN']) {
	test(`empty editor actions follow bindings and stay centered (${locale})`, async ({ page }, testInfo) => {
		await page.goto(`/composite.html?emptyEditor&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashCompositeIntegration);
		const host = page.locator('#editor-tabs-host');
		const shortcuts = host.locator('.ash-editor-group-watermark-shortcuts');
		const entries = shortcuts.locator('.ash-editor-group-watermark-entries');
		const rows = entries.getByRole('button');
		const names = locale === 'zh-CN' ? ['打开文件', '在文件中搜索', '显示所有命令'] : ['Go to File', 'Search in Files', 'Show All Commands'];
		await expect(rows).toHaveCount(3);
		for (const name of names) await expect(entries.getByRole('button', { name, exact: true })).toBeVisible();
		await expect(shortcuts.getByRole('heading')).toHaveText(locale === 'zh-CN' ? '开始工作' : 'Start Working');
		const assertCentered = async () => {
			const content = (await host.locator('.ash-editor-group-content').boundingBox())!;
			const block = await entries.evaluate(element => {
				const bounds = element.getBoundingClientRect();
				const heading = element.previousElementSibling!;
				const top = getComputedStyle(heading).display === 'none' ? bounds.top : heading.getBoundingClientRect().top;
				return { x: bounds.x, width: bounds.width, y: top, height: bounds.bottom - top };
			});
			expect(block.x + block.width / 2).toBeCloseTo(content.x + content.width / 2, 0);
			expect(block.y + block.height / 2).toBeCloseTo(content.y + content.height / 2, 0);
			expect(block.x).toBeGreaterThanOrEqual(content.x + 24);
			expect(block.x + block.width).toBeLessThanOrEqual(content.x + content.width - 24);
			expect(block.y).toBeGreaterThanOrEqual(content.y);
			expect(block.y + block.height).toBeLessThanOrEqual(content.y + content.height);
		};
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashCompositeIntegration.setEditorTheme(theme), theme);
			await expect(rows.nth(0).locator('kbd')).toHaveText(['⌘', 'P']);
			await expect(rows.nth(1).locator('kbd')).toHaveText(['⇧', '⌘', 'F']);
			const caps = await entries.locator('kbd').evaluateAll(elements => elements.map(element => {
				const bounds = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return { width: bounds.width, height: bounds.height, background: style.backgroundColor };
			}));
			for (const cap of caps) {
				expect(cap.width).toBe(22);
				expect(cap.height).toBe(22);
				expect(cap.background).not.toBe('rgba(0, 0, 0, 0)');
			}
			for (const [width, height] of [[800, 520], [320, 180]]) {
				await page.evaluate(([width, height]) => window.ashCompositeIntegration.resizeEditor(width!, height!), [width!, height!]);
				await assertCentered();
			}
			await page.evaluate(() => window.ashCompositeIntegration.resizeEditor(800, 520));
			await host.screenshot({ path: testInfo.outputPath(`${theme}-empty-editor.png`) });
		}
		await rows.nth(0).click();
		await rows.nth(1).focus();
		await rows.nth(1).press('Enter');
		await rows.nth(1).press('Tab');
		await expect(rows.nth(2)).toBeFocused();
		await expect(rows.nth(2)).toHaveCSS('outline-style', 'solid');
		await page.evaluate(() => window.ashCompositeIntegration.setWatermarkBinding('workbench.action.showCommands', 'F2'));
		await expect(rows.nth(2).locator('.ash-keybinding-label')).toHaveText('F2');
		await expect(rows.nth(2)).toBeFocused();
		await page.evaluate(() => window.ashCompositeIntegration.setWatermarkBinding('workbench.action.showCommands', null));
		await expect(rows.nth(2).locator('.ash-keybinding-label')).toHaveCount(0);
		await expect(rows.nth(2)).toBeFocused();
		await rows.nth(2).press('Space');
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.watermarkCommands)).toEqual([
			'workbench.action.quickOpen', 'workbench.action.findInFiles', 'workbench.action.showCommands',
		]);
		await page.evaluate(() => window.ashCompositeIntegration.openEditor('watermark'));
		await expect(shortcuts).toBeHidden();
		await expect(host.locator('.ash-editor-pane-host:visible')).toHaveCount(1);
		await page.evaluate(() => window.ashCompositeIntegration.closeEditor('watermark'));
		await expect(rows).toHaveCount(3);
		await assertCentered();
	});
}

test('activity badges keep compact icons readable, center label counts and retain full accessible descriptions', async ({ page }, testInfo) => {
	await page.goto('/composite.html?badges');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
	const tab = page.locator('#badge-icon [data-action-id="first"]');
	const badge = tab.locator('.ash-composite-bar-badge');
	const labelTab = page.locator('#badge-label [data-action-id="first"]');
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(theme => window.ashCompositeIntegration.setEditorTheme(theme), theme);
		await page.evaluate(() => window.ashCompositeIntegration.setBadge(13));
		await expect(badge).toHaveText('13');
		await expect(tab).toHaveAttribute('aria-label', 'first container, 13 changes');
		await expect(badge).toHaveAttribute('aria-hidden', 'true');
		const geometry = await tab.evaluate(element => {
			const tab = element.getBoundingClientRect();
			const badge = element.querySelector('.ash-composite-bar-badge')!.getBoundingClientRect();
			const icon = element.querySelector('.ash-icon')!.getBoundingClientRect();
			const style = getComputedStyle(element.querySelector('.ash-composite-bar-badge')!);
			return {
				height: badge.height,
				itemWidth: tab.width,
				itemHeight: tab.height,
				top: badge.top - tab.top,
				right: tab.right - badge.right,
				font: style.fontSize,
				weight: style.fontWeight,
				lineHeight: style.lineHeight,
				padding: style.padding,
				radius: style.borderRadius,
				inside: badge.left >= tab.left && badge.right <= tab.right && badge.top >= tab.top && badge.bottom <= tab.bottom,
				overlap: Math.max(0, Math.min(badge.right, icon.right) - Math.max(badge.left, icon.left)) * Math.max(0, Math.min(badge.bottom, icon.bottom) - Math.max(badge.top, icon.top)) / (icon.width * icon.height),
				foreground: style.color, background: style.backgroundColor, outline: style.outlineColor,
			};
		});
		expect(geometry).toMatchObject({ height: 13, itemWidth: 24, itemHeight: 24, top: 11, right: 0, font: '9px', weight: '600', lineHeight: '13px', padding: '0px 2px', radius: '16px' });
		expect(geometry.inside).toBe(true);
		expect(geometry.overlap).toBeLessThan(0.5);
		expect(geometry.foreground).not.toBe(geometry.background);
		if (theme.includes('high-contrast')) {
			expect(geometry.outline).not.toBe('rgba(0, 0, 0, 0)');
		}
		const labelGeometry = await labelTab.evaluate(element => {
			const label = element.querySelector('.ash-composite-bar-action')!.getBoundingClientRect();
			const badgeElement = element.querySelector('.ash-composite-bar-badge')!;
			const badge = badgeElement.getBoundingClientRect();
			const style = getComputedStyle(badgeElement);
			return { height: badge.height, gap: badge.left - label.right, center: (badge.top + badge.bottom - label.top - label.bottom) / 2, font: style.fontSize, padding: style.padding, radius: style.borderRadius, weight: style.fontWeight, lineHeight: style.lineHeight };
		});
		expect(labelGeometry).toEqual({ height: 16, gap: 2, center: 0, font: '10px', padding: '3px 5px', radius: '10px', weight: '400', lineHeight: '10px' });
		await tab.focus();
		await expect(tab).toHaveCSS('outline-style', 'solid');
		await page.screenshot({ path: testInfo.outputPath(`${theme}-badges.png`) });
	}
	for (const [count, text] of [[999, '999'], [1000, '1K'], [1234, '1K+']] as const) {
		await page.evaluate(count => window.ashCompositeIntegration.setBadge(count), count);
		await expect(badge).toHaveText(text);
		await expect(tab).toHaveAttribute('aria-label', `first container, ${count} changes`);
		await expect(tab).toBeFocused();
		await expect(badge).toHaveCSS('font-size', count === 1000 ? '9px' : '8px');
		await expect(badge).toHaveCSS('padding', count === 1000 ? '0px 2px' : '0px 3px');
	}
	await page.evaluate(() => window.ashCompositeIntegration.setBadgeOrientation('vertical'));
	await expect(badge).toHaveCSS('height', '16px');
	await expect(badge).toHaveCSS('font-size', '9px');
	for (const compact of [false, true, false]) {
		await page.evaluate(compact => window.ashCompositeIntegration.setBadgeCompact(compact), compact);
		const geometry = await tab.evaluate(element => {
			const tab = element.getBoundingClientRect();
			const badgeElement = element.querySelector('.ash-composite-bar-badge')!;
			const badge = badgeElement.getBoundingClientRect();
			const style = getComputedStyle(badgeElement);
			return { itemHeight: tab.height, height: badge.height, top: badge.top - tab.top, right: tab.right - badge.right, padding: style.padding, radius: style.borderRadius, lineHeight: style.lineHeight };
		});
		expect(geometry).toEqual(compact
			? { itemHeight: 28, height: 13, top: 13, right: 6, padding: '0px 2px', radius: '13px', lineHeight: '13px' }
			: { itemHeight: 48, height: 16, top: 24, right: 8, padding: '0px 4px', radius: '20px', lineHeight: '16px' });
		await page.screenshot({ path: testInfo.outputPath(`vertical-${compact ? 'compact' : 'default'}-badges.png`) });
	}
	await page.evaluate(() => window.ashCompositeIntegration.toggleBadge());
	await expect(badge).toHaveCount(0);
	await expect(tab).toBeFocused();
	await page.evaluate(() => window.ashCompositeIntegration.toggleBadge());
	await expect(badge).toHaveText('1K+');
	await tab.press('ArrowDown');
	await expect(page.locator('#badge-icon [data-action-id="second"]')).toBeFocused();
	await page.evaluate(() => window.ashCompositeIntegration.setBadge(0));
	await expect(badge).toHaveCount(0);
});

test('standard editor tabs fill the title row and switch styles without losing keyboard focus', async ({ page }) => {
	await page.goto('/composite.html?editorTabs');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
	await page.evaluate(async () => {
		await window.ashCompositeIntegration.openEditor('alpha');
		await window.ashCompositeIntegration.openEditor('beta');
	});
	const host = page.locator('#editor-tabs-host');
	const tabs = host.locator('.ash-tab');
	const alpha = host.getByRole('tab', { name: 'alpha.ts', exact: true });
	const beta = host.getByRole('tab', { name: 'beta.ts', exact: true });
	const geometry = await tabs.evaluateAll(elements => {
		const row = elements[0]!.closest('.ash-editor-tabs-and-actions')!.getBoundingClientRect();
		const list = elements[0]!.closest('.ash-action-bar')!;
		return {
			gap: getComputedStyle(list).gap,
			tabs: elements.map(element => {
				const bounds = element.getBoundingClientRect();
				return { top: bounds.top - row.top, height: bounds.height, rowHeight: row.height, radius: getComputedStyle(element).borderRadius };
			}),
		};
	});
	expect(geometry.gap).toBe('0px');
	for (const tab of geometry.tabs) {
		expect(tab.top).toBe(0);
		expect(tab.height).toBe(tab.rowHeight);
		expect(tab.radius).toBe('0px');
	}
	await expect(alpha).toHaveCSS('font-weight', '400');
	await alpha.focus();
	await expect(alpha).toHaveCSS('outline-style', 'solid');
	await alpha.press('ArrowRight');
	await expect(beta).toBeFocused();
	await alpha.focus();
	await alpha.press('Enter');
	await expect(alpha).toHaveAttribute('aria-selected', 'true');
	await alpha.focus();
	const retained = await alpha.elementHandle();
	for (const style of ['pill', 'connected', 'standard'] as const) {
		await page.evaluate(style => window.ashCompositeIntegration.configureEditorTabs(style), style);
		await expect(alpha).toBeFocused();
		expect(await retained!.evaluate(element => element.isConnected)).toBe(true);
		await expect(host.locator('.ash-ordinary-editor-tabs-row .ash-tab-list')).toHaveClass(new RegExp(`ash-tab-list-${style === 'standard' ? 'flush' : 'inset'}`));
	}
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(theme => window.ashCompositeIntegration.setEditorTheme(theme), theme);
		await expect(alpha).toHaveCSS('outline-style', 'solid');
		const colors = await tabs.evaluateAll(elements => elements.map(element => ({ background: getComputedStyle(element).backgroundColor, selection: getComputedStyle(element).borderTopColor })));
		if (theme.includes('high-contrast')) {
			expect(colors[0]!.selection).not.toBe('rgba(0, 0, 0, 0)');
			expect(colors[0]!.selection).not.toBe(colors[1]!.selection);
		} else {
			expect(colors[0]!.selection).toBe('rgba(0, 0, 0, 0)');
			expect(colors[0]!.background).not.toBe(colors[1]!.background);
		}
	}
	await page.evaluate(async () => {
		await window.ashCompositeIntegration.openEditor('a-file-with-a-name-that-is-much-longer-than-the-fixed-editor-tab-width');
		await window.ashCompositeIntegration.configureEditorTabs('standard', 'fixed');
	});
	const longTab = host.getByRole('tab', { name: /a-file-with-a-name/ });
	const label = longTab.locator('.ash-icon-label-text');
	await expect(label).toHaveCSS('text-overflow', 'ellipsis');
	expect(await label.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
});

test('Panel lays out active and retained panes before resize or activation returns', async ({ page }) => {
	const samples = await page.evaluate(async () => {
		const fixture = window.ashCompositeIntegration;
		await fixture.open('first', true);
		fixture.resize(400, 300);
		const resized = fixture.geometry();
		await fixture.open('second', true);
		const activated = fixture.geometry();
		fixture.resize(600, 240);
		await fixture.open('first', true);
		const retained = fixture.geometry();
		fixture.hide();
		fixture.resize(300, 320);
		await fixture.open('first', true);
		return [resized, activated, retained, fixture.geometry()];
	});
	for (const sample of samples) {
		expect(sample.paneWidth, JSON.stringify(sample)).toBe(sample.hostWidth);
		expect(sample.paneHeight, JSON.stringify(sample)).toBe(sample.hostHeight);
	}
	await expect(page.getByRole('textbox', { name: 'First input' })).toBeFocused();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
	test(`pane headers and resize handles move together with ${reducedMotion} motion`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion });
		await page.goto('/composite.html?paneTransitions');
		await page.waitForFunction(() => !!window.ashCompositeIntegration);
		const host = page.locator('#pane-transitions');
		// A theme change must reach resting pane boundaries without hovering a resize handle.
		for (const color of ['rgb(40, 50, 60)', 'rgb(210, 220, 230)']) {
			const borders = await host.evaluate((element, color) => {
				element.style.setProperty('--ash-border', color);
				return [...element.querySelectorAll<HTMLElement>('.ash-split-view-pane')].map(pane => {
					const style = getComputedStyle(pane, '::before');
					return { content: style.content, height: style.height, width: style.width, color: style.backgroundColor, pointerEvents: style.pointerEvents };
				});
			}, color);
			expect(borders[0]!.content).toBe('none');
			for (const border of borders.slice(1)) {
				expect(border).toEqual({ content: '""', height: '1px', width: '300px', color, pointerEvents: 'none' });
			}
		}
		await host.evaluate(element => element.style.removeProperty('--ash-border'));
		for (const title of ['Changes', 'Graph', 'Agent Review', 'Changes']) {
			const button = host.getByRole('button', { name: title, exact: true });
			const expanded = await button.getAttribute('aria-expanded') === 'true';
			await button.click();
			await expect(button).toHaveAttribute('aria-expanded', String(!expanded));
			const frames = await host.evaluate(async element => {
				const split = element.querySelector<HTMLElement>('.ash-split-view')!;
				const origin = split.getBoundingClientRect().top;
				const panes = [...split.querySelectorAll<HTMLElement>(':scope > .ash-split-view-pane')];
				const sashes = [...split.querySelectorAll<HTMLElement>(':scope > .ash-sash')];
				const frames = [];
				for (let frame = 0; frame < 48; frame++) {
					await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
					const positions = panes.map(pane => ({ actual: pane.getBoundingClientRect().top - origin, allocated: Number.parseFloat(pane.style.top) }));
					const edges = panes.slice(0, -1).map((pane, index) => {
						const sash = sashes[index]!.getBoundingClientRect();
						return { bottom: pane.getBoundingClientRect().bottom, nextTop: panes[index + 1]!.getBoundingClientRect().top, sash: sash.top + sash.height / 2 };
					});
					frames.push({ positions, edges });
					if ([...panes, ...sashes].every(node => node.getAnimations().length === 0)) { break; }
				}
				return frames;
			});
			for (const frame of frames) {
				for (const edge of frame.edges) {
					expect(edge.bottom).toBeCloseTo(edge.nextTop, 0);
					expect(edge.sash).toBeCloseTo(edge.nextTop, 0);
				}
			}
			for (const position of frames.at(-1)!.positions) {
				expect(position.actual).toBeCloseTo(position.allocated, 0);
			}
			if (title === 'Changes') {
				expect(frames.some(frame => frame.positions.some(position => Math.abs(position.actual - position.allocated) > 1))).toBe(reducedMotion === 'no-preference');
			}
		}
		const graph = host.getByRole('button', { name: 'Graph', exact: true });
		await graph.focus();
		await graph.press('ArrowLeft');
		await expect(graph).toHaveAttribute('aria-expanded', 'false');
		await expect(graph).toBeFocused();
		await graph.press('ArrowRight');
		await expect(graph).toHaveAttribute('aria-expanded', 'true');
		await expect(graph).toBeFocused();
	});
}

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


test('Sessions replace conversation views while retaining the sibling draft and outside focus', async ({ page }) => {
	await page.evaluate(() => window.ashSessionGridIntegration.show(['alpha', 'beta'], 'beta'));
	const host = page.locator('#session-grid');
	const alpha = host.getByRole('textbox', { name: 'alpha prompt', exact: true });
	await alpha.fill('Retained draft');
	await host.getByRole('textbox', { name: 'beta prompt', exact: true }).focus();
	const before = await alpha.boundingBox();
	await page.getByRole('button', { name: 'Outside content' }).focus();
	await page.evaluate(() => window.ashSessionGridIntegration.replace('gamma'));
	await expect(host.locator('.ash-editor-group, .ash-editor-title-control')).toHaveCount(0);
	await expect(host.getByRole('region')).toHaveCount(2);
	await expect(host.getByRole('tab')).toHaveCount(0);
	await expect(host.getByRole('textbox', { name: 'beta prompt', exact: true })).toHaveCount(0);
	await expect(host.getByRole('textbox', { name: 'gamma prompt', exact: true })).toBeVisible();
	await expect(alpha).toHaveValue('Retained draft');
	expect(await alpha.boundingBox()).toEqual(before);
	await expect(page.getByRole('button', { name: 'Outside content' })).toBeFocused();
	await alpha.focus();
	await expect(alpha).toBeFocused();
	expect(await page.evaluate(() => window.ashSessionGridIntegration.active())).toBe('alpha');
});

test('Sessions resize and restore their own grid without replacing the live conversation', async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 1200 });
	await page.evaluate(() => window.ashSessionGridIntegration.show(['alpha', 'beta'], 'beta'));
	const host = page.locator('#session-grid');
	const alpha = host.getByRole('textbox', { name: 'alpha prompt', exact: true });
	const region = host.getByRole('region', { name: 'alpha', exact: true });
	await alpha.fill('Keep this draft');
	const retainedInput = (await alpha.elementHandle())!;
	const before = (await region.boundingBox())!.width;
	const sash = host.locator('.ash-sash').first();
	const bounds = (await sash.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x - 100, bounds.y + bounds.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect.poll(async () => (await region.boundingBox())!.width).toBeLessThan(before - 50);
	const resizedWidth = (await region.boundingBox())!.width;
	await expect(alpha).toHaveValue('Keep this draft');
	expect(await retainedInput.evaluate(element => element.isConnected && element === element.ownerDocument.querySelector('[aria-label="alpha prompt"]'))).toBe(true);
	await expect(alpha).toBeFocused();
	await page.reload();
	await page.waitForFunction(() => !!window.ashSessionGridIntegration);
	await page.evaluate(() => window.ashSessionGridIntegration.show(['alpha', 'beta'], 'beta'));
	await expect.poll(async () => (await region.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);
	await expect(host.locator('.ash-editor-group, .ash-editor-title-control')).toHaveCount(0);
});

test('Sessions never become a document drop target', async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 1200 });
	await page.evaluate(() => window.ashSessionGridIntegration.show(['conversation'], 'conversation'));
	const host = page.locator('#session-grid');
	const draft = host.getByRole('textbox', { name: 'conversation prompt', exact: true });
	await draft.fill('Keep this conversation');
	await page.evaluate(() => window.ashCompositeIntegration.openEditor('document'));
	const source = page.locator('.ash-tab').filter({ has: page.getByRole('tab', { name: 'document.ts', exact: true }) });
	const target = host.getByRole('region', { name: 'conversation', exact: true });
	const bounds = (await target.boundingBox())!;
	await source.dragTo(target, { targetPosition: { x: bounds.width / 2, y: bounds.height - 5 } });
	await expect(host.locator('.ash-editor-group')).toHaveCount(0);
	await expect(host.getByRole('region')).toHaveCount(1);
	await expect(draft).toHaveValue('Keep this conversation');
	await expect(page.getByRole('tab', { name: 'document.ts', exact: true })).toBeVisible();
});

test('Sessions expose Chinese conversation names without editor tab semantics', async ({ page }) => {
	await page.goto('/composite.html?locale=zh-CN');
	await page.waitForFunction(() => !!window.ashSessionGridIntegration);
	await page.evaluate(() => window.ashSessionGridIntegration.show(['甲', '乙'], '乙'));
	const host = page.locator('#session-grid');
	await expect(host.getByRole('region', { name: '甲', exact: true })).toBeVisible();
	await expect(host.getByRole('region', { name: '乙', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashSessionGridIntegration.replace('丙'));
	await expect(host.getByRole('region', { name: '甲', exact: true })).toBeVisible();
	await expect(host.getByRole('region', { name: '丙', exact: true })).toBeVisible();
	await expect(host.getByRole('region', { name: '乙', exact: true })).toHaveCount(0);
	await expect(host.locator('.ash-editor-group, .ash-editor-title-control')).toHaveCount(0);
	await expect(host.getByRole('region')).toHaveCount(2);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
	test(`rapidly reversed pane transitions never paint content across the next header (${reducedMotion})`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion });
		await page.goto('/composite.html?paneTransitions&locale=zh-CN');
		await page.waitForFunction(() => !!window.ashCompositeIntegration);
		const samples = await page.locator('#pane-transitions').evaluate(async host => {
			const panes = [...host.querySelectorAll<HTMLElement>('.ash-pane-view')];
			const buttons = panes.map(pane => pane.querySelector<HTMLButtonElement>('.ash-pane-view-header-button')!);
			const samples: { title: string; paintedBottom: number; nextHeaderTop: number; paneBottom: number; sash: number; }[] = [];
			for (let index = 0; index < 12; index++) {
				buttons[index % buttons.length]!.click();
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				for (let paneIndex = 0; paneIndex < panes.length - 1; paneIndex++) {
					const pane = panes[paneIndex]!;
					const body = pane.querySelector<HTMLElement>('.ash-pane-view-content')!;
					if (body.hidden) { continue; }
					const paintedBottom = Math.min(body.getBoundingClientRect().bottom, pane.getBoundingClientRect().bottom, pane.parentElement!.getBoundingClientRect().bottom);
					const nextHeaderTop = panes[paneIndex + 1]!.querySelector('.ash-pane-view-header')!.getBoundingClientRect().top;
					const sash = host.querySelectorAll('.ash-sash')[paneIndex]!.getBoundingClientRect();
					samples.push({ title: buttons[paneIndex]!.textContent!, paintedBottom, nextHeaderTop, paneBottom: pane.parentElement!.getBoundingClientRect().bottom, sash: sash.top + sash.height / 2 });
				}
			}
			return samples;
		});
		expect(samples.length).toBeGreaterThan(0);
		for (const sample of samples) {
			expect(sample.paintedBottom, JSON.stringify(sample)).toBeLessThanOrEqual(sample.nextHeaderTop + 1);
			expect(sample.paneBottom, JSON.stringify(sample)).toBeCloseTo(sample.nextHeaderTop, 0);
			expect(sample.sash, JSON.stringify(sample)).toBeCloseTo(sample.nextHeaderTop, 0);
		}
	});
}

test('keyboard resizing cancels an in-progress pane transition and keeps the focused separator', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/composite.html?paneTransitions');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
	const result = await page.locator('#pane-transitions').evaluate(host => {
		const buttons = [...host.querySelectorAll<HTMLButtonElement>('.ash-pane-view-header-button')];
		for (const button of buttons) {
			if (button.getAttribute('aria-expanded') === 'false') { button.click(); }
		}
		const panes = [...host.querySelectorAll<HTMLElement>('.ash-split-view-pane')];
		const sash = host.querySelector<HTMLElement>('.ash-sash')!;
		const before = Number.parseFloat(panes[0]!.style.height);
		const wasAnimating = panes.some(pane => pane.getAnimations().length > 0);
		sash.focus();
		sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		const boundary = sash.getBoundingClientRect();
		return {
			wasAnimating,
			animating: panes.some(pane => pane.getAnimations().length > 0),
			focused: sash === document.activeElement,
			delta: Number.parseFloat(panes[0]!.style.height) - before,
			bottom: panes[0]!.getBoundingClientRect().bottom,
			nextTop: panes[1]!.getBoundingClientRect().top,
			sash: boundary.top + boundary.height / 2,
		};
	});
	expect(result.wasAnimating).toBe(true);
	expect(result.animating).toBe(false);
	expect(result.focused).toBe(true);
	expect(result.delta).toBe(-10);
	expect(result.bottom).toBeCloseTo(result.nextTop, 0);
	expect(result.sash).toBeCloseTo(result.nextTop, 0);
});


test('Conversation title switches through history and preserves editor appearance and focus', async ({ page }) => {
	await page.goto('/composite.html?editorTabs');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
	await page.evaluate(() => window.ashCompositeIntegration.openEditor('alpha'));
	const host = page.locator('#chat-tabs-host');
	const title = host.getByRole('button', { name: 'Switch conversation: Chat alpha', exact: true });
	await expect(host.getByRole('tab')).toHaveCount(0);
	await title.focus();
	await title.press('Enter');
	await expect(title).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	const selected = host.getByRole('button', { name: 'Switch conversation: Chat beta', exact: true });
	await expect(selected).toBeFocused();
	await expect(selected).toHaveAttribute('aria-expanded', 'false');
	for (const style of ['pill', 'connected', 'standard'] as const) {
		await page.evaluate(style => window.ashCompositeIntegration.configureEditorTabs(style, 'fixed'), style);
		await expect(selected).toBeFocused();
		await expect(host.getByRole('tab')).toHaveCount(0);
		const editorTitleHeight = await page.locator('#editor-tabs-host .ash-editor-tabs-and-actions').evaluate(element => getComputedStyle(element).height);
		await expect(host.locator('.ash-pane-composite-title')).toHaveCSS('height', editorTitleHeight);
	}
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(theme => window.ashCompositeIntegration.setEditorTheme(theme), theme);
		await expect(selected).toHaveCSS('outline-style', 'solid');
		await expect(selected).toHaveCSS('font-weight', '400');
	}
	await selected.press('Space');
	await page.keyboard.press('Escape');
	await expect(selected).toBeFocused();
	await expect(selected).toHaveAttribute('aria-expanded', 'false');
});


for (const locale of ['en', 'zh-CN']) test(`Conversation title menus copy their opening target and restore keyboard focus (${locale})`, async ({ page }) => {
	await page.goto(`/composite.html?editorTabs&chatLinks${locale === 'zh-CN' ? '&locale=zh-CN' : ''}`);
	await page.waitForFunction(() => !!window.ashChatTitleIntegration);
	const host = page.locator('#chat-tabs-host');
	const title = host.locator('.ash-chat-view-title-button');
	const copyLabel = locale === 'en' ? 'Copy Conversation Link' : '复制对话链接';
	const copy = page.getByRole('menuitem', { name: copyLabel, exact: true });
	await title.click({ button: 'right' });
	await expect(copy).toBeVisible();
	await page.evaluate(() => window.ashChatTitleIntegration.select('chat-beta'));
	await copy.click();
	await expect.poll(() => page.evaluate(() => window.ashChatTitleIntegration.clipboard())).toEqual(['agent-host-session://local/open?sessionId=session&threadId=chat-alpha']);
	await title.focus();
	await title.press('Shift+F10');
	await expect(copy).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(copy).toBeHidden();
	await expect(title).toBeFocused();
	await host.getByRole('button', { name: locale === 'en' ? 'More Actions' : '更多操作', exact: true }).click();
	await expect(copy).toBeVisible();
	await copy.click();
	await expect.poll(() => page.evaluate(() => window.ashChatTitleIntegration.clipboard())).toEqual([
		'agent-host-session://local/open?sessionId=session&threadId=chat-alpha',
		'agent-host-session://local/open?sessionId=session&threadId=chat-beta',
	]);
	await title.press('Shift+F10');
	await expect(copy).toBeVisible();
	await page.evaluate(() => window.ashChatTitleIntegration.dispose());
	await expect(copy).toBeHidden();
	await expect(title).toHaveCount(0);
});

test('Editor and conversation title share rounded outer corners across styles and themes', async ({ page }, testInfo) => {
	await page.goto('/composite.html?editorTabs');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
	await page.evaluate(() => window.ashCompositeIntegration.openEditor('alpha'));
	const editorHost = page.locator('#editor-tabs-host');
	const chatHost = page.locator('#chat-tabs-host');
	const editorPart = editorHost.locator('.ash-workbench-editor');
	const chatPart = chatHost.locator('.ash-workbench-auxiliarybar');
	const editorTab = editorHost.getByRole('tab', { name: 'alpha.ts', exact: true });
	const chatTab = chatHost.getByRole('button', { name: 'Switch conversation: Chat alpha', exact: true });
	// A contrasting backdrop exposes paint escaping any rounded outer corner.
	for (const host of [editorHost, chatHost]) {
		await host.evaluate(element => { element.style.background = 'rgb(255, 0, 255)'; });
	}
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(theme => window.ashCompositeIntegration.setEditorTheme(theme), theme);
		for (const style of ['standard', 'connected', 'pill'] as const) {
			await page.evaluate(style => window.ashCompositeIntegration.configureEditorTabs(style), style);
			for (const [part, tab] of [[editorPart, editorTab], [chatPart, chatTab]] as const) {
				await tab.focus();
				await expect(tab).toBeFocused();
				await expect(tab).toHaveCSS('outline-style', 'solid');
				await expect(part).toHaveCSS('border-radius', '8px');
				const screenshot = await part.screenshot();
				const corners = await page.evaluate(async base64 => {
					const image = new Image();
					image.src = `data:image/png;base64,${base64}`;
					await image.decode();
					const canvas = document.createElement('canvas');
					canvas.width = image.width;
					canvas.height = image.height;
					const context = canvas.getContext('2d')!;
					context.drawImage(image, 0, 0);
					return [[1, 1], [image.width - 2, 1], [1, image.height - 2], [image.width - 2, image.height - 2]].map(([x, y]) => [...context.getImageData(x!, y!, 1, 1).data]);
				}, screenshot.toString('base64'));
				expect(corners, `${theme}, ${style}, ${part === editorPart ? 'editor' : 'chat'}`).toEqual(Array.from({ length: 4 }, () => [255, 0, 255, 255]));
			}
			await expect(chatHost.getByRole('tab')).toHaveCount(0);
		}
	}
	for (const host of [editorHost, chatHost]) {
		await host.evaluate(element => { element.style.removeProperty('background'); });
	}
	await page.evaluate(async () => {
		await window.ashCompositeIntegration.configureEditorTabs('standard');
		window.ashCompositeIntegration.setEditorTheme('ash-light');
	});
	await testInfo.attach('rounded-editor-title', { body: await editorPart.screenshot(), contentType: 'image/png' });
	await testInfo.attach('rounded-chat-title', { body: await chatPart.screenshot(), contentType: 'image/png' });
	for (const host of [editorHost, chatHost]) {
		await host.evaluate(element => { element.classList.remove('modern-ui'); });
	}
	for (const part of [editorPart, chatPart]) {
		await expect(part).toHaveCSS('border-radius', '0px');
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`editor title menu operates on its group and restores layout (${locale})`, async ({ page }, testInfo) => {
		await page.goto(`/composite.html?editorMenu&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashEditorTitleIntegration);
		const host = page.locator('#editor-tabs-host');
		const names = locale === 'zh-CN'
			? ['显示已打开的编辑器', '全部关闭', '关闭已保存', '启用预览编辑器', '锁定组', '配置编辑器']
			: ['Show Opened Editors', 'Close All', 'Close Saved', 'Enable Preview Editors', 'Lock Group', 'Configure Editors'];
		const menu = page.getByRole('menu');
		const primary = await page.evaluate(() => navigator.platform.includes('Mac') ? 'Meta' : 'Control');
		const primaryLabel = primary === 'Meta' ? '⌘' : 'Ctrl+';
		const openMenu = async (index = 0) => {
			await host.locator('.ash-editor-group').nth(index).locator('.ash-editor-title-actions [aria-haspopup="menu"]').click();
			await expect(menu).toBeVisible();
		};
		await page.evaluate(() => window.ashEditorTitleIntegration.open('first', true));
		await openMenu();
		await expect(menu.locator('[role^=menuitem] .ash-button-label')).toHaveText(names);
		await expect(menu.getByRole('menuitem', { name: names[1], exact: true }).locator('.ash-menu-keybinding kbd')).toHaveText([`${primaryLabel}K`, 'W']);
		await expect(menu.getByRole('menuitem', { name: names[2], exact: true }).locator('.ash-menu-keybinding kbd')).toHaveText([`${primaryLabel}K`, 'U']);
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashEditorTitleIntegration.split());
		await page.evaluate(() => window.ashEditorTitleIntegration.open('second'));
		await openMenu(0);
		await menu.getByRole('menuitemcheckbox', { name: names[4], exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashEditorTitleIntegration.state().groups.map(group => group.locked))).toEqual([true, false]);
		await openMenu(0);
		await expect(menu.getByRole('menuitemcheckbox', { name: names[4], exact: true })).toHaveAttribute('aria-checked', 'true');
		await menu.getByRole('menuitem', { name: names[0], exact: true }).click();
		await expect(page.locator('.ash-quick-pick-row-label')).toHaveText(['first.ts']);
		await page.keyboard.press('Escape');
		await openMenu(0);
		await menu.getByRole('menuitemcheckbox', { name: names[3], exact: true }).click();
		await page.evaluate(() => window.ashEditorTitleIntegration.open('kept', true));
		await expect.poll(() => page.evaluate(() => window.ashEditorTitleIntegration.state().groups[0]!.previews)).toEqual([false, false]);
		const groups = host.locator('.ash-editor-group');
		const before = await groups.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
		await openMenu(0);
		const maximize = menu.getByRole('menuitem', { name: locale === 'zh-CN' ? '最大化组' : 'Maximize Group', exact: true });
		await expect(maximize.locator('.ash-menu-keybinding kbd')).toHaveText([`${primaryLabel}K`, `${primaryLabel}M`]);
		await page.keyboard.press('Escape');
		await host.getByRole('textbox', { name: 'kept.ts', exact: true }).focus();
		await page.keyboard.press(`${primary}+KeyK`);
		await page.keyboard.press(`${primary}+KeyM`);
		await expect.poll(() => page.evaluate(() => window.ashEditorTitleIntegration.state().groups.map(group => group.visible))).toEqual([true, false]);
		const maximized = await groups.nth(0).evaluate(element => ({ width: element.getBoundingClientRect().width, available: element.closest('.ash-grid')!.getBoundingClientRect().width }));
		// The Workbench frame reserves its border inside the Grid's CSS width.
		expect(maximized.width).toBeGreaterThan(before[0]! * 1.9);
		expect(maximized.available - maximized.width).toBeLessThanOrEqual(2);
		await openMenu(0);
		await menu.getByRole('menuitem', { name: locale === 'zh-CN' ? '还原组' : 'Unmaximize Group', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashEditorTitleIntegration.state().groups.map(group => group.visible))).toEqual([true, true]);
		const after = await groups.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
		for (let index = 0; index < before.length; index++) expect(after[index]).toBeCloseTo(before[index]!, 0);
		await openMenu(0);
		await host.screenshot({ path: testInfo.outputPath(`editor-title-menu-${locale}.png`) });
		await page.keyboard.press('Escape');
		await host.getByRole('textbox', { name: 'kept.ts', exact: true }).focus();
		await page.keyboard.press(`${primary}+KeyK`);
		await page.keyboard.press('KeyU');
		await expect.poll(() => page.evaluate(() => window.ashEditorTitleIntegration.state().groups.flatMap(group => group.tabs))).toEqual(['first.ts', 'second.ts']);
		await page.evaluate(() => window.ashEditorTitleIntegration.split());
		await page.evaluate(async () => {
			await window.ashEditorTitleIntegration.open('close-all-a');
			await window.ashEditorTitleIntegration.open('close-all-b');
		});
		await host.getByRole('textbox', { name: 'close-all-b.ts', exact: true }).focus();
		await page.keyboard.press(`${primary}+KeyK`);
		await page.keyboard.press('KeyW');
		await expect.poll(() => page.evaluate(() => window.ashEditorTitleIntegration.state().groups.map(group => group.tabs))).toEqual([['first.ts', 'second.ts']]);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Problems hosts its filter and actions in the Panel title (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await expect(page.locator('.ash-panel-title-control').getByRole('separator')).toBeHidden();
		await page.goto(`/composite.html?problems&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashCompositeIntegration);
		await page.evaluate(() => window.ashCompositeIntegration.open('ash.panel.problems'));
		const panel = page.locator('.ash-workbench-panel');
		const title = panel.locator('.ash-panel-title-control');
		const input = title.getByRole('textbox');
		const controls = title.locator('.ash-problems-controls');
		const sharedActions = title.locator('.ash-pane-composite-title-part-actions');
		const sharedActionIds = ['workbench.action.toggleMaximizedPanel', 'workbench.action.closePanel'];
		expect(await sharedActions.locator('[data-action-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-action-id')))).toEqual(sharedActionIds);
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-light', 'ash-high-contrast-dark']) {
			await page.evaluate(theme => window.ashCompositeIntegration.setEditorTheme(theme), theme);
			const separator = sharedActions.getByRole('separator');
			await expect(separator).toBeVisible();
			await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
			const geometry = await separator.boundingBox();
			expect(geometry!.width).toBe(1);
			expect(geometry!.height).toBe(16);
			// Sample painted pixels so a present but imperceptible line cannot pass.
			const image = await title.screenshot();
			const titleBounds = (await title.boundingBox())!;
			const pixels = await page.evaluate(async ({ base64, x, y }) => {
				const image = new Image();
				image.src = `data:image/png;base64,${base64}`;
				await image.decode();
				const canvas = document.createElement('canvas');
				canvas.width = image.width;
				canvas.height = image.height;
				const context = canvas.getContext('2d')!;
				context.drawImage(image, 0, 0);
				const line = [...context.getImageData(x, y, 1, 1).data];
				const background = [...context.getImageData(x - 3, y, 1, 1).data];
				const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
				const values = [luminance(line), luminance(background)].sort((a, b) => b - a);
				return { line, background, contrast: (values[0]! + 0.05) / (values[1]! + 0.05) };
			}, { base64: image.toString('base64'), x: Math.round(geometry!.x - titleBounds.x), y: Math.round(geometry!.y + geometry!.height / 2 - titleBounds.y) });
			expect(pixels.line).not.toEqual(pixels.background);
			expect(pixels.contrast, theme).toBeGreaterThanOrEqual(3);

		}

		await expect(input).toBeVisible();
		await expect(panel.locator('.ash-problems .ash-problems-controls')).toHaveCount(0);
		const filter = title.getByRole('button', { name: locale === 'en' ? 'Filter' : '筛选', exact: true });
		const collapse = title.getByRole('button', { name: locale === 'en' ? 'Collapse All' : '全部折叠', exact: true });
		const copy = title.getByRole('button', { name: locale === 'en' ? 'Copy Problems' : '复制问题', exact: true });
		for (const width of [1200, 600, 300]) {
			await page.evaluate(width => window.ashCompositeIntegration.resize(width, 240), width);
			await expect.poll(() => title.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
			const [inputBounds, filterBounds, controlsBounds, titleBounds] = await Promise.all([input.boundingBox(), filter.boundingBox(), controls.boundingBox(), title.boundingBox()]);
			expect(filterBounds!.x).toBeGreaterThan(inputBounds!.x);
			expect(controlsBounds!.x + controlsBounds!.width).toBeLessThanOrEqual(titleBounds!.x + titleBounds!.width);
			await expect(copy).toBeInViewport();
		}
		await collapse.press('Enter');
		await expect(panel.locator('.ash-problems-file-heading').first()).toHaveAttribute('aria-expanded', 'false');
		await copy.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.copiedProblems[0]?.split('\n').length)).toBe(2);
		await input.fill('utils.ts');
		await copy.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.copiedProblems.length)).toBe(2);
		expect(await page.evaluate(() => window.ashCompositeIntegration.copiedProblems[1])).toContain('/project/src/utils.ts');
		await page.evaluate(() => window.ashCompositeIntegration.resize(1000, 240));
		await page.evaluate(() => window.ashCompositeIntegration.setEditorTheme('ash-light'));
		await input.fill('');
		for (const heading of await panel.locator('.ash-problems-file-heading').all()) await heading.press('Enter');
		await testInfo.attach('problems-title', { body: await panel.screenshot(), contentType: 'image/png' });
		await input.fill('utils.ts');
		await page.evaluate(() => window.ashCompositeIntegration.open('first'));
		await expect(title.locator('.ash-problems-controls')).toHaveCount(0);
		expect(await sharedActions.locator('[data-action-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-action-id')))).toEqual(sharedActionIds);
		await expect(sharedActions.getByRole('separator')).toBeVisible();

		await page.evaluate(() => window.ashCompositeIntegration.open('ash.panel.problems'));
		await expect(input).toHaveValue('utils.ts');
		expect(errors).toEqual([]);
	});
}
