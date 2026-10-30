import { expect, test } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { attachRustSyntax } from '../../fixtures/browser/rustSyntaxProcessFixture.js';

async function syntaxProfiles(): Promise<string[]> {
	return (await readdir(tmpdir())).filter(name => name.startsWith('ash-browser-syntax-')).sort();
}

test('syntax fixture setup failure removes its temporary profile', async ({ page }) => {
	await page.exposeBinding('__rustSyntaxTransport', () => undefined);
	const before = await syntaxProfiles();
	await expect(attachRustSyntax(page)).rejects.toThrow(/__rustSyntaxTransport.*already registered/);
	expect(await syntaxProfiles()).toEqual(before);
});

test('disposed syntax fixtures ignore late reconnects without recreating temporary data', async ({ page }) => {
	const before = await syntaxProfiles();
	const dispose = await attachRustSyntax(page);
	try {
		expect((await syntaxProfiles()).length).toBe(before.length + 1);
		await dispose();
		await page.evaluate(() => (window as unknown as {
			__rustSyntaxTransport(event: string, payload: unknown): Promise<void>;
		}).__rustSyntaxTransport('ash:app-server:connect', {}));
		expect(await syntaxProfiles()).toEqual(before);
	} finally {
		await dispose();
	}
});
