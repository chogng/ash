import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { registerOnboardingTryout } from '../../../onboarding/common/onboardingTryout.js';
import { prepareReleaseNotesMarkdown, releaseNotesTryoutId } from '../../browser/releaseNotesTryouts.js';

suite('ReleaseNotesTryouts', () => {
	test('only a registered ID becomes a clickable link', () => {
		using tryout = registerOnboardingTryout({
			id: 'test.releaseNotes.open', title: 'Open', description: 'Opens a test command',
			presentation: { kind: 'command', commandId: 'test.command' },
		});
		const markdown = '[Known](ash://tryout/test.releaseNotes.open) [Unknown](ash://tryout/test.releaseNotes.missing) [Malformed](ash://tryout/test.releaseNotes.open?command=other)';
		const prepared = prepareReleaseNotesMarkdown(markdown);
		assert.match(prepared, /\[Known\]\(#ash-release-tryout-test\.releaseNotes\.open\)/);
		assert.match(prepared, /\[Unknown\]\(ash:\/\/tryout\/test\.releaseNotes\.missing\)/);
		assert.match(prepared, /\[Malformed\]\(ash:\/\/tryout\/test\.releaseNotes\.open\?command=other\)/);
		assert.equal(releaseNotesTryoutId('#ash-release-tryout-test.releaseNotes.open'), 'test.releaseNotes.open');
		assert.equal(releaseNotesTryoutId('#ash-release-tryout-test.releaseNotes.missing'), undefined);
	});
});

suite('releaseNotes browser component', () => {
	const browserTests = useBrowserTests();
	test('release notes render a registered Try This link and ignore other IDs', async function () {
		const { page } = browserTests;

		await page.goto('/releaseNotes.html');
		const notes = page.frameLocator('main iframe[title="Release Notes"]').frameLocator('iframe');
		await expect(notes.getByRole('heading', { name: 'Ash 0.1' })).toBeVisible();
		await notes.getByRole('link', { name: 'Try Search commands' }).click();
		await expect.poll(() => page.evaluate(() => window.ashReleaseNotesIntegration.opened)).toEqual(['workbench.commandCenter.open']);
		await expect(page.frameLocator('#chinese iframe').frameLocator('iframe').getByRole('heading', { name: '查找操作' })).toBeVisible();
		const invalid = page.frameLocator('iframe[title="Invalid links"]').frameLocator('iframe');
		await expect(invalid.getByRole('link', { name: 'Unknown' })).toHaveCount(0);
		await expect(invalid.getByRole('link', { name: 'Malformed' })).toHaveCount(0);
	});
});
