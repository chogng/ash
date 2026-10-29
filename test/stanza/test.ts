import { expect, test as base, type Page } from '@playwright/test';
import type * as Stanza from '../../src/ash/editor/editor.main.js';

declare global {
	var stanza: typeof Stanza;
}

/** Load only the built Stanza page; product modules must register their own dependencies. */
export const test = base.extend<{ stanzaPage: Page; }>({
	stanzaPage: async ({ page }, use, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
		page.on('response', response => {
			if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
		});
		try {
			await page.goto('/index.html');
			await page.waitForFunction(() => globalThis.stanza?.editor.getEditors().length === 1);
			await expect(page.locator('#editor-root .stanza-editor-input')).toBeVisible();
			await use(page);
		} finally {
			if (errors.length) await testInfo.attach('runtime-errors.json', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
			expect.soft(errors, 'Stanza runtime and resource loading errors').toEqual([]);
		}
	},
});

export { expect };
