import assert from 'node:assert/strict';
import { suite, test, setup } from 'mocha';
import { JSDOM } from 'jsdom';
import { Button, ButtonWithDropdown } from '../../browser/ui/button/button.js';
import type { IContextMenuDelegate } from '../../browser/contextmenu.js';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import { setHoverDelegate, type IManagedHover } from '../../browser/ui/hover/hoverDelegate.js';
import { Lxicon } from '../../common/lxicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

suite('Button deferred content', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('host content stays intact while labels and icons are created and released on demand', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using cleanup = { [Symbol.dispose]: () => dom.window.close() };
		let clicks = 0;
		using button = new Button(dom.window.document.body, {
			label: '',
			iconOnly: true,
			ariaLabel: 'Choose color',
			onClick: () => clicks++,
		});
		assert.equal(button.domNode.childElementCount, 0);
		const swatch = dom.window.document.createElement('span');
		button.domNode.append(swatch);
		for (let visit = 0; visit < 3; visit++) {
			button.label = 'Color';
			assert.equal(button.label, 'Color');
			assert.equal(button.domNode.lastElementChild, swatch);
			button.icon = Lxicon.menu;
			button.label = '';
			assert.ok(button.domNode.querySelector('.ash-icon'));
			button.icon = undefined;
			assert.equal(button.domNode.childElementCount, 1);
			assert.equal(button.domNode.firstElementChild, swatch);
		}
		button.icon = Lxicon.menu;
		assert.ok(button.domNode.querySelector('.ash-icon'));
		button.icon = undefined;
		assert.equal(button.domNode.childElementCount, 1);
		assert.equal(button.domNode.getAttribute('aria-label'), 'Choose color');
		button.domNode.click();
		assert.equal(clicks, 1);
	});
});

test('Button only installs a Hover for an explicit title', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const contents: unknown[] = [];
	using delegateRegistration = setHoverDelegate({
		setupDelayedHover() {
			throw new Error('Unexpected delayed hover registration');
		},
		setupHover(options) {
			contents.push(options.content);
			return managedHover();
		},
	});
	using unlabeledHoverButton = new Button(dom.window.document.body, {
		label: 'Save',
	});
	using titledButton = new Button(dom.window.document.body, {
		label: 'Save',
		title: 'Save changes',
	});

	assert.deepEqual(contents, ['Save changes']);
	assert.ok(titledButton.domNode.querySelector('.ash-button-content.ash-icon-label'));
	assert.ok(titledButton.domNode.querySelector('.ash-button-label.ash-icon-label-text'));
	assert.equal(unlabeledHoverButton.domNode.hasAttribute('title'), false);
	titledButton.toggleClassName('host-button', true);
	titledButton.hidden = true;
	assert.equal(titledButton.domNode.hidden, true);
	assert.equal(titledButton.domNode.classList.contains('hidden'), true);
	assert.equal(titledButton.domNode.classList.contains('host-button'), true);

	using labelCenteredButton = new Button(dom.window.document.body, {
		label: 'Commit',
		contentAlignment: 'labelCentered',
	});
	assert.equal(labelCenteredButton.domNode.classList.contains('label-centered'), true);
	labelCenteredButton.label = 'Commit changes';
	assert.equal(labelCenteredButton.label, 'Commit changes');

	using iconButton = new Button(dom.window.document.body, {
		label: 'Menu',
		icon: Lxicon.menu,
		iconOnly: true,
	});
	assert.equal(iconButton.domNode.classList.contains('icon-only'), true);
	assert.equal(iconButton.domNode.getAttribute('aria-label'), 'Menu');
	iconButton.label = 'Application menu';
	assert.equal(iconButton.domNode.getAttribute('aria-label'), 'Application menu');
	assert.ok(iconButton.domNode.querySelector('.ash-icon'));

	using submitButton = new Button(dom.window.document.body, {
		label: 'Submit',
		presentation: 'primary',
		size: 'small',
		type: 'submit',
	});
	assert.equal(submitButton.domNode.type, 'submit');
	assert.equal(submitButton.domNode.classList.contains('ash-button-primary'), true);
	assert.equal(submitButton.domNode.classList.contains('ash-button-small'), true);
	assert.equal(unlabeledHoverButton.domNode.classList.contains('ash-button-quiet'), true);

	dom.window.close();
});

function managedHover(): IManagedHover {
	return {
		visible: false,
		show() {},
		hide() {},
		update() {},
		dispose() {},
		[Symbol.dispose]() {},
	};
}

suite('ButtonWithDropdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the optional primary menu entry invokes the same primary action', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using cleanup = { [Symbol.dispose]: () => dom.window.close() };
		let runs = 0;
		let menu: IContextMenuDelegate | undefined;
		using button = new ButtonWithDropdown(dom.window.document.body, {
			label: 'Run',
			checked: true,
			onClick: () => runs++,
			actions: [{ id: 'other', label: 'Other', tooltip: '', enabled: true, run: () => {} }],
			contextMenuProvider: {
				showContextMenu: delegate => {
					menu = delegate;
				},
			},
		});
		button.dropdownButton.domNode.click();
		assert.equal(runs, 0);
		assert.equal(button.dropdownButton.domNode.hasAttribute('aria-pressed'), false);
		menu!.getActions()[0]!.run();
		assert.equal(runs, 1);
	});

	test('owns dynamic menus, cancellation, enabled state and stale hide callbacks', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using cleanup = { [Symbol.dispose]: () => dom.window.close() };
		let primaryRuns = 0;
		let menuRuns = 0;
		let suffix = 'first';
		let menu: IContextMenuDelegate | undefined;
		using button = new ButtonWithDropdown(dom.window.document.body, {
			label: 'Commit',
			type: 'submit',
			presentation: 'primary',
			onClick: () => primaryRuns++,
			actions: {
				getActions: () => [{ id: suffix, label: suffix, tooltip: '', enabled: true, run: () => menuRuns++ }],
			},
			addPrimaryActionToDropdown: false,
			contextMenuProvider: {
				showContextMenu: delegate => {
					menu = delegate;
				},
			},
		});
		assert.equal(button.primaryButton.domNode.type, 'submit');
		assert.equal(button.dropdownButton.domNode.type, 'button');
		button.dropdownButton.domNode.click();
		assert.equal(primaryRuns, 0);
		assert.equal(menu!.getAnchor(), button.dropdownButton.domNode);
		assert.deepEqual(
			menu!.getActions().map(action => action.id),
			['first'],
		);
		menu!.getActions()[0]!.run();
		assert.equal(menuRuns, 1);
		const first = menu!;
		button.enabled = false;
		assert.equal(first.cancellationToken!.isCancellationRequested, true);
		assert.equal(button.primaryButton.enabled, false);
		assert.equal(button.dropdownButton.enabled, false);
		assert.equal(button.dropdownButton.domNode.getAttribute('aria-expanded'), 'false');
		button.enabled = true;
		suffix = 'second';
		button.dropdownButton.domNode.click();
		first.onHide?.(true);
		assert.equal(button.dropdownButton.domNode.getAttribute('aria-expanded'), 'true');
		assert.deepEqual(
			menu!.getActions().map(action => action.id),
			['second'],
		);
		const second = menu!;
		button.dispose();
		assert.equal(second.cancellationToken!.isCancellationRequested, true);
		assert.equal(dom.window.document.querySelector('button'), null);
	});
});

suite('Split button rendering', () => {
	const browser = useBrowserTests();
	setup(async () => {
		await browser.page.goto('/button.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
	});

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`keeps joined geometry, keyboard focus and menu semantics in ${theme}`, async () => {
			const { page } = browser;
			await page.evaluate(theme => window.ashButtonIntegration.theme(theme), theme);
			const primary = page.getByRole('button', { name: 'Save and Apply', exact: true });
			const dropdown = page.locator('#buttons').getByRole('button', { name: 'More Actions...', exact: true });
			const geometry = await page.locator('#buttons .ash-button-dropdown').evaluate(root => {
				const [main, arrow] = [...root.querySelectorAll('button')];
				const left = main!.getBoundingClientRect();
				const right = arrow!.getBoundingClientRect();
				const mainStyle = getComputedStyle(main!);
				const arrowStyle = getComputedStyle(arrow!);
				const icon = arrow!.querySelector('.ash-icon')!.getBoundingClientRect();
				return {
					height: left.height,
					arrowHeight: right.height,
					gap: right.left - left.right,
					iconOffset: icon.left + icon.width / 2 - right.left - right.width / 2,
					innerRadius: mainStyle.borderTopRightRadius,
					arrowRadius: arrowStyle.borderTopLeftRadius,
					border: arrowStyle.borderLeftWidth,
					borderColor: arrowStyle.borderLeftColor,
					background: mainStyle.backgroundColor,
				};
			});
			assert.equal(geometry.height, geometry.arrowHeight);
			assert.equal(geometry.gap, 0);
			assert.ok(Math.abs(geometry.iconOffset) < 0.5, 'Dropdown icon stays centered when the primary label uses independent centering');
			assert.equal(geometry.innerRadius, '0px');
			assert.equal(geometry.arrowRadius, '0px');
			assert.equal(geometry.border, '1px');
			assert.notEqual(geometry.borderColor, geometry.background);
			await primary.focus();
			await primary.press('Enter');
			await expect(page.locator('output')).toHaveText('primary');
			await primary.press('ArrowRight');
			await expect(dropdown).toBeFocused();
			await dropdown.press('ArrowDown');
			await expect(dropdown).toHaveAttribute('aria-expanded', 'true');
			const save = page.getByRole('menuitem', { name: 'Save as…', exact: true });
			await expect(save).toBeFocused();
			await save.press('Escape');
			await expect(dropdown).toBeFocused();
			await expect(dropdown).toHaveAttribute('aria-expanded', 'false');
			await dropdown.press('ArrowLeft');
			await expect(primary).toBeFocused();
			await dropdown.click();
			await page.getByRole('menuitem', { name: 'Save as…', exact: true }).click();
			await expect(page.locator('output')).toHaveText('saveAs');
			await dropdown.click();
			await page.evaluate(() => window.ashButtonIntegration.disable());
			await expect(page.getByRole('menu')).toHaveCount(0);
			await expect(primary).toBeDisabled();
			await expect(dropdown).toBeDisabled();
		});

		test(`filled split triggers follow button height without enlarging icon tools in ${theme}`, async () => {
			const { page } = browser;
			await page.evaluate(theme => window.ashButtonIntegration.theme(theme), theme);
			const dimensions = async () =>
				page.evaluate(() => {
					const measure = (selector: string) => {
						const root = document.querySelector(selector)!;
						const [primary, dropdown] = [...root.querySelectorAll('button')];
						const main = primary!.getBoundingClientRect();
						const arrow = dropdown!.getBoundingClientRect();
						return { height: main.height, width: arrow.width, arrowHeight: arrow.height };
					};
					const pin = document.querySelector<HTMLButtonElement>('#quiet-toolbar button[aria-label="Pin"]')!.getBoundingClientRect();
					return {
						standard: measure('#buttons'),
						small: measure('#small-buttons'),
						filled: measure('#primary-toolbar'),
						quiet: measure('#quiet-toolbar'),
						pin: { width: pin.width, height: pin.height },
					};
				});
			await expect
				.poll(async () => {
					const sizes = await dimensions();
					return [sizes.standard, sizes.small, sizes.filled].every(size => Math.abs(size.width - size.height) < 0.5 && size.height === size.arrowHeight);
				})
				.toBe(true);
			const initial = await dimensions();
			assert.ok(initial.standard.height >= 28);
			assert.ok(initial.small.height >= 24);
			assert.ok(initial.filled.height >= 28);
			assert.deepEqual(initial.pin, { width: 22, height: 22 });
			assert.deepEqual(initial.quiet, { height: 22, width: 22, arrowHeight: 22 });
			const filledDropdown = page.getByRole('button', { name: 'Theme actions', exact: true });
			await filledDropdown.focus();
			await filledDropdown.press('ArrowDown');
			await expect(page.getByRole('menuitem', { name: 'Save theme', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(filledDropdown).toBeFocused();
			await page.evaluate(() => {
				document.body.style.fontSize = '20px';
				document.body.style.lineHeight = '1.5';
			});
			await expect
				.poll(async () => {
					const sizes = await dimensions();
					return [sizes.standard, sizes.filled].map((size, index) => ({
						...size,
						grew: size.height > [initial.standard, initial.filled][index]!.height,
						square: Math.abs(size.width - size.height) < 0.5 && size.height === size.arrowHeight,
					}));
				})
				.toEqual([expect.objectContaining({ grew: true, square: true }), expect.objectContaining({ grew: true, square: true })]);
			await page.evaluate(() => window.ashButtonIntegration.refreshToolbarDropdown());
			await expect
				.poll(async () => {
					const { filled } = await dimensions();
					return Math.abs(filled.width - filled.height) < 0.5;
				})
				.toBe(true);
		});
	}

	test('localizes the shared dropdown label', async () => {
		await browser.page.goto('/button.html?locale=zh-CN');
		await expect(browser.page.locator('#buttons').getByRole('button', { name: '更多操作…', exact: true })).toBeVisible();
	});
});
