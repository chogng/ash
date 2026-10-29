import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { expect } from '@playwright/test';
import { SegmentedControl } from '../../browser/ui/segmentedControl/segmentedControl.js';
import { Lxicon } from '../../common/lxicons.js';
import { getHoverDelegate } from '../../browser/ui/hover/hoverDelegate.js';
import { toDisposable } from '../../common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('SegmentedControl contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('invalid items and selection fail without creating DOM or owned resources', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const options = { ariaLabel: 'View', selectedId: 'list', onActivate: () => {} };
		assert.throws(
			() =>
				new SegmentedControl(dom.window.document.body, { ...options, items: [{ id: 'list', label: 'List' }] }),
			TypeError,
		);
		assert.throws(
			() =>
				new SegmentedControl(dom.window.document.body, {
					...options,
					items: [
						{ id: 'list', label: 'List' },
						{ id: 'list', label: 'Duplicate' },
					],
				}),
			TypeError,
		);
		assert.throws(
			() =>
				new SegmentedControl(dom.window.document.body, {
					...options,
					selectedId: 'missing',
					items: [
						{ id: 'list', label: 'List' },
						{ id: 'grid', label: 'Grid' },
					],
				}),
			RangeError,
		);
		assert.throws(
			() =>
				new SegmentedControl(dom.window.document.body, {
					...options,
					presentation: 'icon',
					items: [
						{ id: 'list', label: 'List' },
						{ id: 'grid', label: 'Grid' },
					],
				}),
			TypeError,
		);
		assert.equal(dom.window.document.body.childElementCount, 0);
		dom.window.close();
	});

	test('activation requests do not commit selection and reactivation still fires', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const activations: string[] = [];
		using control = new SegmentedControl(dom.window.document.body, {
			ariaLabel: 'View',
			selectedId: 'list',
			items: [
				{ id: 'list', label: 'List' },
				{ id: 'grid', label: 'Grid' },
				{ id: 'split', label: 'Split' },
			],
			onActivate: id => activations.push(id),
		});
		const buttons = [...control.domNode.querySelectorAll('button')];
		buttons[1]!.click();
		assert.deepEqual(activations, ['grid']);
		assert.deepEqual(
			buttons.map(button => button.getAttribute('aria-pressed')),
			['true', 'false', 'false'],
		);
		control.setSelection('grid');
		buttons[1]!.click();
		assert.deepEqual(activations, ['grid', 'grid']);
		assert.deepEqual(
			buttons.map(button => button.classList.contains('checked')),
			[false, true, false],
		);
		assert.equal(control.domNode.getAttribute('role'), 'toolbar');
		assert.equal(control.domNode.ownerDocument, dom.window.document);
		control.dispose();
		dom.window.close();
	});

	test('roving focus skips disabled options and selection remains owned by the caller', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using control = new SegmentedControl(dom.window.document.body, {
			ariaLabel: 'View',
			selectedId: 'list',
			items: [
				{ id: 'list', label: 'List' },
				{ id: 'grid', label: 'Grid', disabled: true },
				{ id: 'split', label: 'Split' },
			],
			onActivate: () => assert.fail('Arrow keys must only move focus'),
		});
		const buttons = [...control.domNode.querySelectorAll('button')];
		buttons[0]!.focus();
		buttons[0]!.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
		);
		assert.equal(dom.window.document.activeElement, buttons[2]);
		assert.equal(buttons[0]!.getAttribute('aria-pressed'), 'true');
		buttons[2]!.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
		);
		assert.equal(dom.window.document.activeElement, buttons[0]);
		buttons[0]!.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
		);
		assert.equal(dom.window.document.activeElement, buttons[2]);
		buttons[2]!.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
		);
		assert.equal(dom.window.document.activeElement, buttons[0]);
		buttons[1]!.click();
		control.dispose();
		dom.window.close();
	});

	test('disposal removes listeners, hover registrations and the owned root', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let registrations = 0;
		let activations = 0;
		using control = new SegmentedControl(dom.window.document.body, {
			ariaLabel: 'View',
			selectedId: 'list',
			presentation: 'icon',
			items: [
				{ id: 'list', label: 'List', icon: Lxicon.chat1 },
				{ id: 'grid', label: 'Grid', icon: Lxicon.code },
			],
			hoverDelegate: {
				...getHoverDelegate(),
				setupDelayedHover: () => {
					registrations++;
					return toDisposable(() => {
						registrations--;
					});
				},
			},
			onActivate: () => {
				activations++;
			},
		});
		const button = control.domNode.querySelector('button')!;
		assert.equal(registrations, 2);
		control.dispose();
		button.click();
		assert.equal(activations, 0);
		assert.equal(registrations, 0);
		assert.equal(dom.window.document.body.childElementCount, 0);
		dom.window.close();
	});
});

suite('SegmentedControl rendered component', () => {
	const browserTests = useBrowserTests();

	for (const locale of ['en', 'zh-CN'])
		test(`multiple segments preserve hover, keyboard and geometry across themes (${locale})`, async () => {
			const { page, info } = browserTests;
			await page.goto(`/segmentedControl.html?locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.emulateMedia({ reducedMotion: 'reduce' });
			const text = page.locator('#labels .ash-segmented-control');
			const icons = page.locator('#icons .ash-segmented-control');
			const buttons = text.getByRole('button');
			await expect(buttons).toHaveCount(4);
			await expect(buttons.nth(2)).toBeDisabled();
			await buttons.nth(1).click();
			await expect(page.getByRole('status')).toHaveText('grid');
			await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true');
			await page.evaluate(() => window.ashSegmentedControlIntegration.select('grid'));
			await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
			await buttons.nth(1).press('ArrowRight');
			await expect(buttons.nth(3)).toBeFocused();
			await buttons.nth(3).press('Space');
			await expect(page.getByRole('status')).toHaveText('split');
			await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
			const initial = await icons
				.locator('.ash-icon')
				.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
			for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
				await page.evaluate(theme => window.ashSegmentedControlIntegration.theme(theme), theme);
				for (const width of [520, 360]) {
					await text.evaluate((element, width) => {
						element.style.width = `${width}px`;
					}, width);
					await page.evaluate(() => window.ashSegmentedControlIntegration.select('split'));
					const geometry = await text.evaluate(element => {
						const bounds = element.getBoundingClientRect();
						const selected = element.querySelector('.checked')!.getBoundingClientRect();
						const slider = getComputedStyle(element, '::before');
						return {
							width: bounds.width,
							selectedX: selected.x - bounds.x,
							selectedWidth: selected.width,
							sliderWidth: Number.parseFloat(slider.width),
							translate: slider.translate,
							duration: slider.transitionDuration,
						};
					});
					expect(geometry).toMatchObject({ width, translate: '300%', duration: '0s' });
					expect(geometry.selectedX).toBeCloseTo((width * 3) / 4, 1);
					expect(geometry.sliderWidth).toBeCloseTo(geometry.selectedWidth, 1);
					await buttons.nth(0).hover();
					await expect(buttons.nth(0)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
					await buttons.nth(3).press('Home');
					await expect(buttons.nth(0)).toBeFocused();
					await expect(buttons.nth(0)).toHaveCSS('outline-style', 'solid');
					if (theme.startsWith('hc')) {
						await expect(buttons.nth(0)).toHaveCSS('outline-width', '2px');
						await expect(buttons.nth(0)).toHaveCSS('border-top-width', '1px');
						const contrast = await text.evaluate(element => ({
							selected: getComputedStyle(element.querySelector('.checked')!).color,
							unselected: getComputedStyle(element.querySelector('button:not(.checked)')!).color,
							slider: getComputedStyle(element, '::before').backgroundColor,
							background: getComputedStyle(element).backgroundColor,
						}));
						expect(contrast.selected).not.toBe(contrast.unselected);
						expect(contrast.slider).not.toBe(contrast.background);
						expect(contrast.selected).not.toBe(contrast.slider);
						await buttons.first().press('End');
						await expect(buttons.nth(3)).toBeFocused();
						const selectedOutline = await buttons
							.nth(3)
							.evaluate(element => getComputedStyle(element).outlineColor);
						expect(selectedOutline).not.toBe(contrast.slider);
					}
					await icons.getByRole('button').nth(2).click();
					await expect(icons.getByRole('button').nth(2)).toHaveAttribute('aria-pressed', 'true');
					expect(
						await icons
							.locator('.ash-icon')
							.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON())),
					).toEqual(initial);
				}
			}
			await text.evaluate(element => element.setAttribute('dir', 'rtl'));
			await page.evaluate(() => window.ashSegmentedControlIntegration.select('grid'));
			expect(await text.evaluate(element => getComputedStyle(element, '::before').translate)).toBe('-100%');
			await buttons.nth(1).press('ArrowRight');
			await expect(buttons.nth(0)).toBeFocused();
			await page.screenshot({ path: info.outputPath(`segmented-control-${locale}.png`) });
			await page.evaluate(() => window.ashSegmentedControlIntegration.dispose());
			await expect(page.locator('.ash-segmented-control')).toHaveCount(0);
		});
});
