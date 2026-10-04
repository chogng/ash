import { expect, test } from '@playwright/test';

test('ordinary links route pointer and keyboard activation through the opener', async ({ page }) => {
	await page.goto('/link.html');
	const link = page.getByRole('button', { name: 'Documentation', exact: true });
	await page.locator('#before').focus();
	await page.keyboard.press('Tab');
	await expect(link).toBeFocused();
	await link.press('Enter');
	await link.press('Space');
	await link.click();
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.opened)).toEqual(Array(3).fill('https://example.test/docs'));
	await page.getByRole('button', { name: 'Custom action', exact: true }).click();
	expect(await page.evaluate(() => window.ashLinkIntegration.customOpened)).toEqual(['https://example.test/custom']);
	await page.evaluate(() => window.ashLinkIntegration.blockOpening());
	await link.click();
	expect(await page.evaluate(() => window.ashLinkIntegration.opened)).toHaveLength(3);
	await expect(page).toHaveURL(/\/link.html$/u);
});

test('disabled links suppress navigation and restore the descriptor tab order', async ({ page }) => {
	await page.goto('/link.html');
	await page.evaluate(() => {
		window.ashLinkIntegration.update('Updated destination', 'Updated hover', 3, true);
		window.ashLinkIntegration.setEnabled(false);
	});
	const link = page.getByRole('button', { name: 'Updated destination', exact: true });
	await expect(link).toHaveAttribute('aria-disabled', 'true');
	await expect(link).toHaveAttribute('tabindex', '-1');
	// Programmatic activation must be blocked even though disabled controls are excluded from Tab.
	await link.evaluate(element => (element as HTMLElement).click());
	await link.press('Enter');
	await link.press('Space');
	expect(await page.evaluate(() => window.ashLinkIntegration.opened)).toEqual([]);
	await expect(page).toHaveURL(/\/link.html$/u);
	await page.evaluate(() => window.ashLinkIntegration.setEnabled(true));
	await expect(link).toHaveAttribute('aria-disabled', 'false');
	await expect(link).toHaveAttribute('tabindex', '3');
	await link.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.opened)).toEqual(['https://example.test/updated']);
});

test('managed link hover updates, clears and is released with its control', async ({ page }) => {
	await page.goto('/link.html');
	const link = page.locator('#default-link .ash-link');
	await link.hover();
	await expect(page.getByRole('tooltip')).toHaveText('Read documentation');
	await page.evaluate(() => window.ashLinkIntegration.update('Updated', 'Updated hover'));
	await expect(page.getByRole('tooltip')).toHaveText('Updated hover');
	await page.evaluate(() => window.ashLinkIntegration.update('Updated'));
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.evaluate(() => window.ashLinkIntegration.update('Updated', 'Final hover'));
	await page.mouse.move(0, 0);
	await link.hover();
	await expect(page.getByRole('tooltip')).toHaveText('Final hover');
	await page.evaluate(() => window.ashLinkIntegration.disposeLink());
	await expect(link).toHaveCount(0);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('link colors and keyboard focus follow all four product themes', async ({ page }) => {
	await page.goto('/link.html');
	const link = page.locator('#default-link .ash-link');
	for (const index of [0, 1, 2, 3]) {
		await page.evaluate(index => window.ashLinkIntegration.setTheme(index), index);
		await page.mouse.move(0, 0);
		await page.locator('#before').focus();
		await page.keyboard.press('Tab');
		const state = await link.evaluate(element => {
			const style = getComputedStyle(element);
			const expected = document.createElement('span');
			element.after(expected);
			expected.style.color = 'var(--ash-accent-foreground)';
			const color = getComputedStyle(expected).color;
			expected.style.color = 'var(--ash-focus-border)';
			const focus = getComputedStyle(expected).color;
			expected.remove();
			return { color: style.color, expected: color, focus: style.outlineColor, expectedFocus: focus, outline: style.outlineStyle, width: style.outlineWidth, focused: element.matches(':focus-visible'), underline: style.textDecorationLine };
		});
		expect(state).toEqual({ color: state.expected, expected: state.expected, focus: state.expectedFocus, expectedFocus: state.expectedFocus, outline: 'solid', width: '1px', focused: true, underline: 'underline' });
	}
	await page.mouse.move(0, 0);
	expect(await page.locator('#custom-link .ash-link').evaluate(element => getComputedStyle(element).color)).toBe('rgb(255, 128, 128)');
});

test('Output file links open the detected position and release old rows and hovers', async ({ page }) => {
	await page.goto('/link.html');
	const link = page.getByRole('button', { name: 'src/main.ts:12:7', exact: true });
	await link.focus();
	await link.press('Enter');
	await link.press('Space');
	await link.click();
	await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.files)).toEqual(Array(3).fill({ resource: 'file:///workspace/src/main.ts', line: 12, column: 7 }));
	await page.mouse.move(0, 0);
	await link.hover();
	await expect(page.getByRole('tooltip')).toHaveText('file:///workspace/src/main.ts');
	await page.evaluate(() => window.ashLinkIntegration.appendOutput());
	await expect(page.locator('#output .ash-link')).toHaveCount(2);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.evaluate(() => window.ashLinkIntegration.clearOutput());
	await expect(page.locator('#output .ash-link')).toHaveCount(0);
	await page.evaluate(() => window.ashLinkIntegration.disposeOutput());
	await expect(page.locator('#output .ash-view-pane')).toHaveCount(0);
});

test('touch activation opens an ordinary link once', async ({ browser }) => {
	const context = await browser.newContext({ hasTouch: true });
	try {
		const page = await context.newPage();
		await page.goto('http://127.0.0.1:5185/link.html');
		await page.getByRole('button', { name: 'Documentation', exact: true }).tap();
		await expect.poll(() => page.evaluate(() => window.ashLinkIntegration.opened)).toEqual(['https://example.test/docs']);
	} finally {
		await context.close();
	}
});
