import assert from 'node:assert/strict';
import { suite, test, setup } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import { JSDOM } from 'jsdom';
import { Checkbox, Switch, Toggle } from '../../browser/ui/toggle/toggle.js';
import { h } from '../../browser/dom.js';

test('Toggle and Checkbox expose shared native boolean state', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const changes: boolean[] = [];
	using checkbox = new Checkbox(dom.window.document.body, {
		label: 'Underline links',
		onChange: checked => changes.push(checked),
	});
	dom.window.document.body.append(checkbox.element);

	assert.equal(checkbox.element.classList.contains('ash-checkbox'), true);
	assert.equal(checkbox.input.type, 'checkbox');
	assert.equal(checkbox.checked, false);

	checkbox.input.click();

	assert.equal(checkbox.checked, true);
	assert.equal(checkbox.element.classList.contains('checked'), true);
	assert.deepEqual(changes, [true]);

	checkbox.checked = false;
	assert.equal(checkbox.element.classList.contains('checked'), false);
	dom.window.close();
});

test('Switch projects the shared state as a switch control', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using toggle = new Toggle(dom.window.document.body, {
		ariaLabel: 'Generic toggle',
	});
	using switchControl = new Switch(dom.window.document.body, {
		ariaLabel: 'Reduce motion',
		checked: true,
	});
	dom.window.document.body.append(toggle.element, switchControl.element);

	assert.equal(toggle.input.getAttribute('role'), null);
	assert.equal(switchControl.input.getAttribute('role'), 'switch');
	assert.equal(switchControl.input.getAttribute('aria-checked'), 'true');
	assert.equal(switchControl.element.querySelector('.ash-switch-track'), switchControl.track);
	switchControl.busy = true;
	assert.equal(switchControl.enabled, true);
	assert.equal(switchControl.input.disabled, true);
	assert.equal(switchControl.input.getAttribute('aria-busy'), 'true');
	assert.equal(switchControl.element.classList.contains('busy'), true);
	assert.equal(switchControl.element.classList.contains('disabled'), false);
	switchControl.busy = false;
	assert.equal(switchControl.input.disabled, false);
	assert.equal(switchControl.input.hasAttribute('aria-busy'), false);

	switchControl.input.click();

	assert.equal(switchControl.checked, false);
	assert.equal(switchControl.input.getAttribute('aria-checked'), 'false');
	assert.equal(switchControl.element.classList.contains('checked'), false);
	dom.window.close();
});

test('Toggle can place its content before the control', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const content = h(dom.window.document, 'span');
	content.textContent = 'Minimap';
	using switchControl = new Switch(dom.window.document.body, {
		ariaLabel: 'Minimap',
		content,
		contentPlacement: 'before-control',
	});
	dom.window.document.body.append(switchControl.element);

	assert.equal(switchControl.element.classList.contains('ash-toggle-content-before-control'), true);
	assert.equal(switchControl.element.querySelector('.ash-toggle-content')?.firstElementChild, content);
	assert.equal(switchControl.element.children[1]?.classList.contains('ash-toggle-content'), true);
	assert.equal(switchControl.element.children[2], switchControl.track);
	dom.window.close();
});

suite('Checkbox rendering', () => {
	const browserTests = useBrowserTests();
	setup(async () => {
		await browserTests.page.goto('/toggle.html');
		await expect(browserTests.page.locator('body')).toHaveAttribute('data-ready', 'true');
	});

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`uses a stable themed surface and a centered checkmark in ${theme}`, async () => {
			const { page } = browserTests;
			await page.evaluate(theme => window.ashToggleIntegration.theme(theme), theme);
			const input = page.getByRole('checkbox', { name: 'Follow branch', exact: true });
			const checkmark = page.locator('#checkbox .ash-checkbox-checkmark');
			const before = await input.evaluate(element => {
				const style = getComputedStyle(element);
				return { appearance: style.appearance, border: style.borderTopWidth, background: style.backgroundColor, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height };
			});
			expect(before).toMatchObject({ appearance: 'none', border: '1px', width: 16, height: 16 });
			await expect(checkmark).toBeHidden();
			await input.check();
			await expect(checkmark).toBeVisible();
			expect(await input.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(before.background);
			expect(await checkmark.evaluate(element => {
				const probe = document.createElement('span');
				probe.style.color = 'var(--ash-input-foreground)';
				element.append(probe);
				const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
				probe.remove();
				return matches;
			})).toBe(true);
			const box = (await input.boundingBox())!;
			const mark = (await checkmark.boundingBox())!;
			expect(mark.x + mark.width / 2).toBeCloseTo(box.x + box.width / 2, 1);
			expect(mark.y + mark.height / 2).toBeCloseTo(box.y + box.height / 2, 1);
			await page.evaluate(() => window.ashToggleIntegration.checked(false));
			await expect(input).not.toBeChecked();
			await expect(checkmark).toBeHidden();
			await page.screenshot({ path: browserTests.info.outputPath(`checkbox-${theme}.png`) });
		});
	}

	test('retains label activation, keyboard focus, disabled state and trailing placement', async () => {
		const { page } = browserTests;
		const input = page.getByRole('checkbox', { name: 'Follow branch', exact: true });
		await page.getByText('Follow branch', { exact: true }).click();
		await expect(input).toBeChecked();
		await expect(page.locator('output')).toHaveText('[true]');
		await input.press('Space');
		await expect(input).not.toBeChecked();
		await expect(page.locator('output')).toHaveText('[true,false]');
		expect(await input.evaluate(element => {
			const style = getComputedStyle(element);
			return { width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset };
		})).toEqual({ width: '1px', style: 'solid', offset: '2px' });
		await expect(page.getByRole('checkbox', { name: 'Disabled branch', exact: true })).toBeDisabled();
		await expect(page.getByRole('switch', { name: 'Automatic fetch', exact: true })).toBeChecked();
		const trailing = page.getByRole('checkbox', { name: 'Notifications', exact: true });
		const mark = page.locator('#before .ash-checkbox-checkmark');
		expect(await mark.boundingBox()).toMatchObject({ x: (await trailing.boundingBox())!.x + 2, y: (await trailing.boundingBox())!.y + 2 });
		expect((await page.locator('#before .ash-toggle-content').boundingBox())!.x).toBeLessThan((await trailing.boundingBox())!.x);
		await page.evaluate(() => window.ashToggleIntegration.dispose());
		await expect(page.locator('.ash-toggle')).toHaveCount(0);
	});
});
