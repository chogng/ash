import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { setup, suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('IconSelectBox keyboard ownership', () => {
	const browser = useBrowserTests();

	setup(async () => {
		await browser.page.goto('/themes.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
	});

	test('modified navigation edits the search text without moving the active icon', async () => {
		const picker = browser.page.locator('#icon-select-host');
		const input = picker.getByRole('combobox', { name: 'Search icons' });
		await input.fill('chev');
		const activeIcon = await input.getAttribute('aria-activedescendant');
		await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(4, 4));
		await input.press('Shift+ArrowLeft');
		assert.deepEqual(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]), [3, 4]);
		await input.press('Shift+Home');
		assert.deepEqual(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]), [0, 4]);
		await expect(input).toHaveAttribute('aria-activedescendant', activeIcon!);
		await expect(input).toBeFocused();
	});

	test('modified and composing keys remain available to the input and its host', async () => {
		const input = browser.page.locator('#icon-select-host').getByRole('combobox', { name: 'Search icons' });
		const results = await input.evaluate((element: HTMLInputElement) => {
			const host = element.closest<HTMLElement>('#icon-select-host')!;
			const activeIcon = element.getAttribute('aria-activedescendant');
			let bubbled = false;
			const onKeyDown = (): void => { bubbled = true; };
			host.addEventListener('keydown', onKeyDown);
			try {
				const inputs: KeyboardEventInit[] = [];
				for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
					for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter']) {
						inputs.push({ key, [modifier]: true });
					}
				}
				inputs.push({ key: 'Enter', isComposing: true });
				return inputs.map(init => {
					bubbled = false;
					const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
					element.dispatchEvent(event);
					return {
						prevented: event.defaultPrevented,
						bubbled,
						iconUnchanged: element.getAttribute('aria-activedescendant') === activeIcon,
						selectedIcon: host.getAttribute('data-selected-icon'),
					};
				});
			} finally {
				host.removeEventListener('keydown', onKeyDown);
			}
		});
		assert.deepEqual(results, results.map(() => ({ prevented: false, bubbled: true, iconUnchanged: true, selectedIcon: null })));
	});
});
