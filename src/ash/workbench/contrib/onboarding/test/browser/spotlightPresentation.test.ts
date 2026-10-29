import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { getWindows } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { registerOnboardingTargetProvider } from '../../browser/spotlight/onboardingTarget.js';
import { SpotlightPresentation } from '../../browser/spotlight/spotlightPresentation.js';

suite('SpotlightPresentation', () => {
	test('guides the scoped target and restores focus after completion', async () => {
		const dom = new JSDOM(
			'<!doctype html><body><main><button id="before">Before</button><button id="first">First</button><button id="second">Second</button></main></body>',
			{ url: 'https://ash.invalid/' },
		);
		const previousWindow = globalThis.window;
		const previousHTMLElement = globalThis.HTMLElement;
		Object.assign(globalThis, { window: dom.window, HTMLElement: dom.window.HTMLElement });
		getWindows();
		try {
			const container = dom.window.document.querySelector('main')!;
			const before = dom.window.document.querySelector<HTMLButtonElement>('#before')!;
			const first = dom.window.document.querySelector<HTMLButtonElement>('#first')!;
			const second = dom.window.document.querySelector<HTMLButtonElement>('#second')!;
			before.focus();
			using target = registerOnboardingTargetProvider('test.scoped', scope =>
				scope === 'second' ? second : first,
			);
			const presentation = new SpotlightPresentation(container);
			const result = presentation.show(
				[{ target: 'test.scoped', title: 'Scoped title', description: 'Scoped description' }],
				CancellationToken.None,
				'second',
			);
			const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
			assert.equal(dialog?.querySelector('h2')?.textContent, 'Scoped title');
			assert.equal(container.querySelectorAll('.ash-onboarding-spotlight-frame').length, 1);
			const next = dialog?.querySelectorAll('button')[1];
			assert.ok(next);
			next.click();
			assert.deepEqual(
				{
					outcome: await result,
					focus: dom.window.document.activeElement?.id,
					remaining: container.querySelectorAll('[role="dialog"]').length,
				},
				{ outcome: 'completed', focus: 'before', remaining: 0 },
			);
		} finally {
			Object.assign(globalThis, { window: previousWindow, HTMLElement: previousHTMLElement });
			dom.window.close();
		}
	});
});

suite('onboarding browser component', () => {
	const browserTests = useBrowserTests();
	test('spotlight follows the scoped control and restores keyboard focus', async function () {
		const { page } = browserTests;

		await page.goto('/onboarding.html');
		await page.locator('#previous').focus();
		await page.evaluate(() => window.ashOnboardingIntegration.show('second'));
		const dialog = page.getByRole('dialog', { name: 'Find the target' });
		await expect(dialog).toBeVisible();
		const target = await page.locator('#second').boundingBox();
		const frame = await page.locator('.ash-onboarding-spotlight-frame').boundingBox();
		expect(frame?.x).toBeCloseTo(target!.x, 0);
		expect(frame?.y).toBeCloseTo(target!.y, 0);
		await page.keyboard.press('F1');
		await expect(dialog.getByText('Use Tab to reach Next or Dismiss.')).toBeVisible();
		await dialog.getByRole('button', { name: 'Done' }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('#previous')).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashOnboardingIntegration.result)).toBe('completed');
	});
});
