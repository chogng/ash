import { test, expect } from '@playwright/test';
import type { } from './composite.integration.js';

test.beforeEach(async ({ page }) => {
	await page.goto('/composite.html');
	await page.waitForFunction(() => !!window.ashCompositeIntegration);
});

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
		expect(geometry).toMatchObject({ height: 13, itemHeight: 35, top: 17, right: 0, font: '9px', weight: '600', lineHeight: '13px', padding: '0px 2px', radius: '16px' });
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
	const retainedInput = (await alpha.elementHandle())!;
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
	expect(await retainedInput.evaluate(element => element.isConnected && element === element.ownerDocument.querySelector('[aria-label="alpha prompt"]'))).toBe(true);
	await expect(alpha).toBeFocused();
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
