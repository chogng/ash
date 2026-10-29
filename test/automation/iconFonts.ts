import { expect, type Locator } from '@playwright/test';

/** Observe the browser's actual font face instead of a renderer-maintained ready flag. */
export async function expectIconFontLoaded(icon: Locator): Promise<void> {
	await expect(icon).toHaveClass(/ash-icon-font/u);
	await expect
		.poll(() =>
			icon.evaluate(async element => {
				const style = getComputedStyle(element);
				const query = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
				const character = element.getAttribute('data-ash-icon-character');
				await document.fonts.ready;
				return character !== null && document.fonts.check(query, character);
			}),
		)
		.toBe(true);
}
