import { expect } from '@playwright/test';
import { suite, test, setup } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('sessionsCreator browser component', () => {
	const browserTests = useBrowserTests();
	setup(async function () {
		const { page } = browserTests;
		await page.goto('/sessions.html?creator');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	});
	test('Sessions chat fills its content area without a duplicate session title', async function () {
		const { page } = browserTests;

		const sessionsContent = page.locator('[data-part="sessions"] > .ash-workbench-part-content');
		const navigation = page.locator('.ash-sessions-activity-content');
		for (const width of [1_200, 760]) {
			await page.setViewportSize({ width, height: 760 });
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await navigation.getByRole('button', { name: /^New(?:\.|$)/u }).click();
			await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
			await expect(sessionsContent.locator('.ash-sessions-chat-input')).toBeVisible();
			await expect
				.poll(() =>
					sessionsContent.evaluate(content => {
						const contentBounds = content.getBoundingClientRect();
						const viewBounds = content.querySelector('.ash-sessions-chat-view')!.getBoundingClientRect();
						return [
							Math.round(viewBounds.y - contentBounds.y),
							Math.round(viewBounds.height - contentBounds.height),
						];
					}),
				)
				.toEqual([0, 0]);
		}
	});
	test('Sessions new session keeps the welcome composer stable across frames', async function () {
		const { page } = browserTests;

		for (let session = 0; session < 3; session++) {
			await page.setViewportSize(
				[
					{ width: 1793, height: 1333 },
					{ width: 1280, height: 800 },
					{ width: 760, height: 600 },
				][session]!,
			);
			const navigation = page.locator('.ash-sessions-activity-content');
			if (session === 2) {
				await page
					.locator('.ash-window-mode-control')
					.getByRole('button', { name: 'Chat / Agents', exact: true })
					.click();
				await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
			}
			if (session === 1) {
				await page
					.locator('.ash-window-mode-control')
					.getByRole('button', { name: 'Code', exact: true })
					.click();
			} else {
				await navigation.getByRole('button', { name: /^New(?:\.|$)/u }).click();
			}
			const chat = page.locator('.ash-sessions-chat-slot :is(.ash-chat,.ash-cowork):visible').first();
			await expect(chat.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)')).toBeVisible();
			await expect(chat.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)')).toHaveAttribute(
				'aria-busy',
				'false',
			);
			if (session === 2) {
				await chat.getByRole('button', { name: 'Dismiss tip', exact: true }).click();
			}
			const sampling = page.evaluate(async () => {
				const samples: number[][] = [];
				let finished = false;
				const finish = (): void => {
					finished = true;
				};
				document.addEventListener('ash-integration-composer-sampling-complete', finish, { once: true });
				const sample = (): void => {
					const composer = document.querySelector(
						'.ash-sessions-chat-slot.active :is(.ash-sessions-chat-input,.ash-sessions-cowork-input):not([hidden])',
					)!;
					const card = composer.querySelector(':is(.ash-chat-input-container,.ash-cowork-input-container)')!;
					const rect = composer.getBoundingClientRect();
					samples.push([
						rect.x,
						rect.y,
						rect.width,
						rect.height,
						card.getBoundingClientRect().y,
						card.getBoundingClientRect().height,
					]);
				};
				const observer = new MutationObserver(sample);
				observer.observe(document.querySelector('[data-part="sessions"]')!, { childList: true, subtree: true });
				try {
					while (!finished) {
						await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
						sample();
					}
				} finally {
					observer.disconnect();
					document.removeEventListener('ash-integration-composer-sampling-complete', finish);
				}
				return samples;
			});
			for (let click = 0; click < 6; click++) {
				await page.locator('[data-action-id="sessions.newSession"] button').click();
			}
			await expect(chat.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)')).toHaveAttribute(
				'aria-busy',
				'false',
			);
			await page.evaluate(() => document.dispatchEvent(new Event('ash-integration-composer-sampling-complete')));
			const samples = await sampling;
			const changes = samples
				.slice(1)
				.filter((sample, index) => sample.some((value, axis) => Math.abs(value - samples[index]![axis]!) > 1));
			expect(changes, JSON.stringify([...new Set(samples.map(sample => JSON.stringify(sample)))])).toEqual([]);
		}
	});
});
