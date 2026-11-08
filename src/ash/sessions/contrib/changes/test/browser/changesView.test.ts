import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('changes browser component', () => {
	const browserTests = useBrowserTests();
	for (const direction of ['topToBottom', 'bottomToTop'] as const) test(`Animated counts resize and interrupt in ${direction}`, async function () {
		const { page } = browserTests;

		await page.goto('/changes.html');
		await page.evaluate(direction => {
			window.ashChangesIntegration.counter(9, direction);
		}, direction);
		const counter = page.locator('#counter .ash-animated-counter');
		await expect(counter).toHaveText('+9');
		expect(await counter.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		const previousWidth = (await counter.boundingBox())!.width;
		const growing = await page.evaluate(() => {
			window.ashChangesIntegration.updateCounter(100);
			const element = document.querySelector<HTMLElement>('#counter .ash-animated-counter')!;
			const animations = element.getAnimations({ subtree: true });
			for (const animation of animations) { animation.pause(); animation.currentTime = 120; }
			const width = element.getAnimations()[0]!.effect as KeyframeEffect;
			const digits = element.querySelector('.ash-animated-counter-value')!.getAnimations()[0]!.effect as KeyframeEffect;
			return { width: width.getKeyframes().map(frame => Number.parseFloat(String(frame.width))), digits: digits.getKeyframes().map(frame => frame.transform), currentWidth: element.getBoundingClientRect().width };
		});
		await expect(counter).toHaveText('+100');
		await expect(counter.locator('.ash-animated-counter-outgoing')).toHaveAttribute('aria-hidden', 'true');
		expect(growing.width[0]).toBeCloseTo(previousWidth, 1);
		expect(growing.width[1]!).toBeGreaterThan(previousWidth);
		expect(growing.currentWidth).toBeGreaterThan(previousWidth);
		expect(growing.currentWidth).toBeLessThan(growing.width[1]!);
		expect(growing.digits[0]).toBe(direction === 'topToBottom' ? 'translateY(-100%)' : 'translateY(100%)');
		const reversed = await page.evaluate(() => {
			const element = document.querySelector<HTMLElement>('#counter .ash-animated-counter')!;
			const old = element.getAnimations({ subtree: true });
			window.ashChangesIntegration.updateCounter(2);
			const digits = element.querySelector('.ash-animated-counter-value')!.getAnimations()[0]!;
			for (const animation of element.getAnimations({ subtree: true })) animation.pause();
			window.ashChangesIntegration.updateCounter(2);
			return { cancelled: old.every(animation => animation.playState === 'idle'), reused: element.querySelector('.ash-animated-counter-value')!.getAnimations()[0] === digits, from: (digits.effect as KeyframeEffect).getKeyframes()[0]!.transform };
		});
		await expect(counter).toHaveText('+2');
		await expect(counter.locator('.ash-animated-counter-outgoing')).toHaveCount(1);
		expect(reversed).toEqual({ cancelled: true, reused: true, from: direction === 'topToBottom' ? 'translateY(100%)' : 'translateY(-100%)' });
		await page.evaluate(() => {
			for (const animation of document.querySelector('#counter')!.getAnimations({ subtree: true })) animation.finish();
		});
		await expect(counter.locator('.ash-animated-counter-outgoing')).toHaveCount(0);
		expect((await counter.boundingBox())!.width).toBeCloseTo(previousWidth, 1);
	});

	test('Animated counts clear, reduce motion and dispose without retaining transitions', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/changes.html');
		await page.evaluate(() => {
			window.ashChangesIntegration.counter(1);
			window.ashChangesIntegration.updateCounter(99);
			for (const animation of document.querySelector('#counter')!.getAnimations({ subtree: true })) animation.pause();
		});
		const counter = page.locator('#counter .ash-animated-counter');
		await expect(counter.locator('.ash-animated-counter-outgoing')).toHaveCount(1);
		await page.evaluate(() => window.ashChangesIntegration.reduceMotion('on'));
		await expect(counter).toHaveText('+99');
		await expect(counter.locator('.ash-animated-counter-outgoing')).toHaveCount(0);
		expect(await counter.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		await page.evaluate(() => window.ashChangesIntegration.updateCounter(1000));
		await expect(counter).toHaveText('+1000');
		expect(await counter.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		await page.evaluate(() => window.ashChangesIntegration.reduceMotion('auto'));
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(page.locator('body')).toHaveClass(/ash-reduce-motion/);
		await page.evaluate(() => window.ashChangesIntegration.updateCounter(7));
		expect(await counter.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await expect(page.locator('body')).toHaveClass(/ash-enable-motion/);
		await page.evaluate(() => window.ashChangesIntegration.updateCounter(undefined));
		await expect(counter).toHaveText('');
		await page.evaluate(() => window.ashChangesIntegration.updateCounter(8));
		await expect(counter).toHaveText('+8');
		expect(await counter.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		await page.evaluate(() => {
			window.ashChangesIntegration.counter(9, 'topToBottom', 0);
			window.ashChangesIntegration.updateCounter(100);
		});
		expect(await counter.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
		const disposed = await page.evaluate(() => {
			window.ashChangesIntegration.counter(1);
			window.ashChangesIntegration.updateCounter(999);
			const element = document.querySelector('#counter .ash-animated-counter')!;
			window.ashChangesIntegration.disposeCounter();
			window.ashChangesIntegration.updateCounter(2);
			return { connected: element.isConnected, animations: element.getAnimations({ subtree: true }).length, text: element.textContent };
		});
		expect(disposed).toEqual({ connected: false, animations: 0, text: '+999' });
		expect(errors).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) test(`Changes summary shares animated statistics in ${locale}`, async function () {
		const { page } = browserTests;

		await page.goto(`/changes.html?locale=${locale}`);
		const summary = page.locator('.ash-sessions-changes-summary');
		await expect(summary).toHaveText(locale === 'en' ? '1 file +3 −2' : '1 个文件 +3 −2');
		for (const theme of ['light', 'dark', 'contrast']) {
			await page.evaluate(theme => window.ashChangesIntegration.theme(theme), theme);
			const colors = await summary.evaluate(element => {
				const added = element.querySelector('.ash-changes-stats-added')!;
				const removed = element.querySelector('.ash-changes-stats-removed')!;
				const probe = document.createElement('span');
				element.append(probe);
				probe.style.color = 'var(--ash-charts-green)';
				const green = getComputedStyle(probe).color;
				probe.style.color = 'var(--ash-charts-red)';
				const red = getComputedStyle(probe).color;
				probe.remove();
				return { added: getComputedStyle(added).color, removed: getComputedStyle(removed).color, green, red };
			});
			expect(colors.added).toBe(colors.green);
			expect(colors.removed).toBe(colors.red);
			expect(colors.added).not.toBe(colors.removed);
		}
		await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
		await expect(summary).toHaveText(locale === 'en' ? '2 files +6 −4' : '2 个文件 +6 −4');
		await expect.poll(() => summary.locator('.ash-animated-counter-outgoing').count()).toBe(0);
		expect(await page.evaluate(() => window.ashChangesIntegration.content())).toContain(locale === 'en' ? '2 files +6 −4' : '2 个文件 +6 −4');
	});

	for (const locale of ['en', 'zh-CN'] as const) test(`Changes restores per-conversation choices and Viewed after a window reload (${locale})`, async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/changes.html?locale=${locale}&multiple=1`);
		await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
		await expect(page.getByRole('treeitem')).toHaveCount(2);
		const turn = page.getByRole('combobox', { name: locale === 'en' ? 'Changes from Turn' : '选择回合更改' });
		const reviewed = locale === 'en' ? 'Reviewed' : '已审阅';
		await turn.selectOption('second');
		await page.getByRole('treeitem').click();
		await page.getByRole('button', { name: locale === 'en' ? 'Mark reviewed' : '标记已审阅', exact: true }).click();
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(turn).toBeEnabled();
		await turn.selectOption('change');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await expect(turn).toHaveValue('second');
		await page.reload();
		await expect(turn).toBeEnabled();
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(turn).toHaveValue('change');
		await expect(page.getByRole('treeitem')).not.toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await expect(turn).toHaveValue('second');
		await page.evaluate(() => window.ashChangesIntegration.revision(2));
		await expect(page.getByRole('treeitem')).not.toContainText(reviewed);
		expect(errors).toEqual([]);
	});

	test('Changes restores collapsed folders from workspace state after a window reload', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/changes.html?multiple=1');
		await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
		await expect(page.getByRole('treeitem')).toHaveCount(2);
		await page.getByRole('combobox', { name: 'Changes from Turn' }).selectOption('second');
		await page.getByRole('combobox', { name: 'Changes view mode' }).selectOption('tree');
		await page.getByRole('tree').focus();
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await page.reload();
		await expect(page.getByRole('combobox', { name: 'Changes from Turn' })).toHaveValue('second');
		await expect(page.getByRole('combobox', { name: 'Changes view mode' })).toHaveValue('tree');
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await expect(page.getByRole('treeitem')).toHaveAttribute('aria-expanded', 'false');
	});

	for (const locale of ['en', 'zh-CN'] as const) test(`Changes keeps each conversation choice and Viewed through racing catalogues and retry (${locale})`, async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/changes.html?locale=${locale}`);
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
		const turn = page.getByRole('combobox', { name: locale === 'en' ? 'Changes from Turn' : '选择回合更改' });
		const reviewed = locale === 'en' ? 'Reviewed' : '已审阅';
		await turn.selectOption('second');
		await page.getByRole('treeitem').click();
		await page.getByRole('button', { name: locale === 'en' ? 'Mark reviewed' : '标记已审阅', exact: true }).click();
		await page.evaluate(() => { window.ashChangesIntegration.holdRefresh('old', true); window.ashChangesIntegration.selectSession('other'); });
		await expect(turn).toBeEnabled();
		await turn.selectOption('change');
		await page.evaluate(() => { window.ashChangesIntegration.holdRefresh('other'); window.ashChangesIntegration.selectThread('peer'); });
		await expect(turn).toBeEnabled();
		await turn.selectOption('second');
		await page.evaluate(() => { window.ashChangesIntegration.selectSession('session'); window.ashChangesIntegration.selectThread('thread'); });
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => { window.ashChangesIntegration.holdRefresh('concurrent', true); window.ashChangesIntegration.fail(false); });
		await expect(turn).toBeEnabled();
		await page.evaluate(() => {
			window.ashChangesIntegration.releaseRefresh('concurrent');
			window.ashChangesIntegration.releaseRefresh('other', true);
			window.ashChangesIntegration.releaseRefresh('old');
		});
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => { window.ashChangesIntegration.holdRefresh('cancelled', true); window.ashChangesIntegration.visible(false); window.ashChangesIntegration.visible(true); });
		await expect(turn).toBeEnabled();
		await page.evaluate(() => window.ashChangesIntegration.releaseRefresh('cancelled', true));
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(turn).toHaveValue('change');
		await page.evaluate(() => window.ashChangesIntegration.selectThread('peer'));
		await expect(turn).toHaveValue('second');
		expect(await page.evaluate(() => window.ashChangesIntegration.notifications())).toEqual([]);
		expect(errors).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN'] as const) test(`Changes restores Turn choice, selection and Viewed after rebuilding its pane (${locale})`, async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/changes.html?locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
		const turn = page.getByRole('combobox', { name: locale === 'en' ? 'Changes from Turn' : '选择回合更改' });
		const reviewed = locale === 'en' ? 'Reviewed' : '已审阅';
		await turn.selectOption('second');
		await page.getByRole('treeitem').click();
		await page.getByRole('button', { name: locale === 'en' ? 'Mark reviewed' : '标记已审阅', exact: true }).click();
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.rebuild());
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(turn).toHaveValue('');
		await turn.selectOption('change');
		await page.evaluate(() => window.ashChangesIntegration.rebuild());
		await expect(turn).toHaveValue('change');
		await expect(page.getByRole('treeitem')).not.toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => { window.ashChangesIntegration.delayRefresh(); window.ashChangesIntegration.rebuild(); });
		await expect(turn).toBeDisabled();
		await page.evaluate(() => window.ashChangesIntegration.completeRefresh());
		await expect(turn).toBeEnabled();
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.revision(2));
		await expect(page.getByRole('treeitem')).not.toContainText(reviewed);
		await page.evaluate(() => window.ashChangesIntegration.rebuild());
		await expect(turn).toHaveValue('second');
		await expect(page.getByRole('treeitem')).not.toContainText(reviewed);
		expect(errors).toEqual([]);
	});

	for (const transition of ['hide', 'rebuild', 'switch', 'revision'] as const) test(`Changes drops a late comparison failure after ${transition}`, async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/changes.html');
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await page.evaluate(() => window.ashChangesIntegration.delayFileFailure());
		await page.getByRole('tree').focus();
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.fileReadStarted())).toBe(true);
		await page.evaluate(transition => {
			if (transition === 'hide') { window.ashChangesIntegration.visible(false); }
			else if (transition === 'rebuild') { window.ashChangesIntegration.rebuild(); }
			else if (transition === 'switch') { window.ashChangesIntegration.selectSession('other'); }
			else { window.ashChangesIntegration.revision(2); }
			window.ashChangesIntegration.rejectFile();
		}, transition);
		if (transition === 'hide') { await page.evaluate(() => window.ashChangesIntegration.visible(true)); }
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashChangesIntegration.opened())).toBe(0);
		await page.getByRole('treeitem').click();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.opened())).toBe(1);
		expect(await page.evaluate(() => window.ashChangesIntegration.notifications())).toEqual([]);
		expect(errors).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN'] as const) test(`Changes retains each conversation Turn choice across loading, retry and deletion (${locale})`, async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/changes.html?locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
		const turn = page.getByRole('combobox', { name: locale === 'en' ? 'Changes from Turn' : '选择回合更改' });
		const tree = page.getByRole('tree');
		await turn.selectOption('second');
		await page.evaluate(() => window.ashChangesIntegration.delayRefresh());
		await expect(turn).toBeDisabled();
		await expect(turn).toHaveValue('second');
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.ashChangesIntegration.completeRefresh());
		await expect(turn).toBeEnabled();
		await expect(turn).toHaveValue('second');
		await page.evaluate(() => window.ashChangesIntegration.fail(true));
		await expect(page.getByRole('button', { name: locale === 'en' ? 'Retry loading changes' : '重新加载更改' })).toBeVisible();
		await expect(turn).toBeDisabled();
		await page.evaluate(() => window.ashChangesIntegration.fail(false));
		await expect(turn).toBeEnabled();
		await expect(turn).toHaveValue('second');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(turn).toBeEnabled();
		await expect(turn).toHaveValue('');
		await turn.selectOption('change');
		await page.evaluate(() => window.ashChangesIntegration.selectThread('peer'));
		await expect(turn).toHaveValue('');
		await turn.selectOption('second');
		await page.evaluate(() => window.ashChangesIntegration.selectThread('thread'));
		await expect(turn).toHaveValue('change');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await expect(turn).toHaveValue('second');
		await page.evaluate(() => window.ashChangesIntegration.delayRefresh());
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(turn).toBeDisabled();
		await page.evaluate(() => window.ashChangesIntegration.completeRefresh());
		await expect(turn).toBeEnabled();
		await expect(turn).toHaveValue('change');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await expect(turn).toHaveValue('second');
		await page.evaluate(() => window.ashChangesIntegration.removeSecondTurn());
		await expect(turn).toHaveValue('');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(turn).toHaveValue('change');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await expect(turn).toHaveValue('');
		expect(errors).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN'] as const) test(`Changes opens the selected Turn in its canonical editor (${locale})`, async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/changes.html?locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
		const turn = page.getByRole('combobox', { name: locale === 'en' ? 'Changes from Turn' : '选择回合更改' });
		await turn.selectOption('second');
		const review = page.getByRole('button', { name: locale === 'en' ? 'Review all changes' : '查看全部更改', exact: true });
		await review.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.reviews())).toEqual([{ resource: 'ash-session-changes:/session?thread=thread', changesetId: 'second' }]);
		await turn.selectOption('');
		await review.click();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.reviews())).toEqual([
			{ resource: 'ash-session-changes:/session?thread=thread', changesetId: 'second' },
			{ resource: 'ash-session-changes:/session?thread=thread', changesetId: undefined },
		]);
		expect(errors).toEqual([]);
	});

	test('Changes filters Turns, restores tree state and binds review markers to revision and conversation', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/changes.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
		await expect(page.getByRole('treeitem')).toHaveCount(2);
		const mode = page.getByRole('combobox', { name: 'Changes view mode' });
		const turn = page.getByRole('combobox', { name: 'Changes from Turn' });
		await turn.selectOption('second');
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await page.getByRole('treeitem').click();
		await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
		await expect(page.getByRole('treeitem')).toContainText('Reviewed');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.content())).toContain('Reviewed');
		await mode.selectOption('tree');
		await expect(page.getByRole('treeitem')).toHaveCount(3);
		const tree = page.getByRole('tree');
		await tree.focus();
		await tree.press('Home');
		await tree.press('ArrowLeft');
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await mode.selectOption('list');
		await expect(page.getByRole('treeitem')).toHaveAttribute('aria-selected', 'true');
		await mode.selectOption('tree');
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await page.evaluate(() => window.ashChangesIntegration.rebuild());
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await page.evaluate(() => window.ashChangesIntegration.visible(false));
		await page.evaluate(() => window.ashChangesIntegration.visible(true));
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await turn.selectOption('');
		await expect(page.getByRole('treeitem')).toHaveCount(6);
		await mode.selectOption('list');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
		await expect(page.getByRole('treeitem').filter({ hasText: 'Reviewed' })).toHaveCount(0);
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await expect(page.getByRole('treeitem').filter({ hasText: 'Reviewed' })).toHaveCount(0);
		await page.evaluate(() => window.ashChangesIntegration.revision(2));
		await expect(page.getByRole('treeitem').filter({ hasText: 'Reviewed' })).toHaveCount(0);
		await page.setViewportSize({ width: 320, height: 600 });
		for (const theme of ['light', 'dark', 'hc']) {
			await page.evaluate(theme => window.ashChangesIntegration.theme(theme), theme);
			await mode.focus();
			await mode.press('Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(mode).not.toHaveCSS('outline-style', 'none');
		}
		expect(errors).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN'] as const) test(`Conversation Changes follows checkpoint net changes across repositories and history moves (${locale})`, async function () {
		const { page } = browserTests;
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/changes.html?locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => {
			window.ashChangesIntegration.multipleTurns();
			window.ashChangesIntegration.checkpoint({ sequence: 8, revision: 'net-empty', statistics: { files: 0, additions: 0, deletions: 0 }, repositories: [], warnings: [] });
		});
		const picker = page.getByRole('combobox', { name: locale === 'en' ? 'Changes from Turn' : '选择回合更改' });
		await expect(picker.locator('option').first()).toHaveText(locale === 'en' ? 'Conversation Changes' : '对话更改');
		await expect(page.getByRole('treeitem')).toHaveCount(0);
		await expect(page.getByRole('button', { name: locale === 'en' ? 'Review all changes' : '查看全部更改', exact: true })).toBeDisabled();
		await picker.selectOption('second');
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await picker.selectOption('');
		await expect(page.getByRole('treeitem')).toHaveCount(0);
		await page.evaluate(() => window.ashChangesIntegration.checkpoint({
			sequence: 9, revision: 'two-repositories', statistics: { files: 2, additions: 7, deletions: 3 }, repositories: [
				{ repositoryId: 'first', files: [{ path: 'same.txt', kind: 'modified', binary: false, additions: 4, deletions: 1 }] },
				{ repositoryId: 'second', files: [{ path: 'same.txt', kind: 'deleted', binary: false, additions: 3, deletions: 2 }] },
			], warnings: []
		}));
		await expect(page.getByRole('treeitem')).toHaveCount(2);
		await expect(page.locator('.ash-sessions-changes-summary')).toHaveText(locale === 'en' ? '2 files +7 −3' : '2 个文件 +7 −3');
		await page.getByRole('treeitem').filter({ hasText: locale === 'en' ? 'Repository 2' : '仓库 2' }).click();
		await page.getByRole('tree').press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.summaryReads())).toContainEqual({ sessionId: 'session', threadId: 'thread', revision: 'two-repositories', repositoryId: 'second', path: 'same.txt' });
		await page.getByRole('button', { name: locale === 'en' ? 'Mark reviewed' : '标记已审阅', exact: true }).click();
		await expect(page.getByRole('treeitem').filter({ hasText: locale === 'en' ? 'Reviewed' : '已审阅' })).toHaveCount(1);
		await page.evaluate(() => window.ashChangesIntegration.rebuild());
		await expect(page.getByRole('treeitem').filter({ hasText: locale === 'en' ? 'Reviewed' : '已审阅' })).toHaveCount(1);
		await page.evaluate(() => window.ashChangesIntegration.checkpoint({ sequence: 10, revision: 'rewound', statistics: { files: 1, additions: 1, deletions: 0 }, repositories: [{ repositoryId: 'second', files: [{ path: 'same.txt', kind: 'modified', binary: false, additions: 1, deletions: 0 }] }], warnings: ['Synthetic checkpoint warning'] }));
		await expect(page.getByRole('treeitem')).toHaveCount(1);
		await expect(page.getByRole('treeitem')).not.toContainText(locale === 'en' ? 'Reviewed' : '已审阅');
		await expect(page.locator('.ash-sessions-changes-summary')).toHaveText(locale === 'en' ? '1 file +1 −0' : '1 个文件 +1 −0');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.content())).toContain('Synthetic checkpoint warning');
		expect(errors).toEqual([]);
	});

	test('Changes sends the prepared PR request to the initiating Thread and restores allowed form preferences', async function () {
		const { page } = browserTests;

		await page.goto('/changes.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const create = page.getByRole('button', { name: 'Create pull request', exact: true });
		await create.click();
		const form = page.getByRole('dialog', { name: 'Create pull request' });
		await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
		await form.getByRole('textbox', { name: 'Title', exact: true }).fill('Agent reviewed PR');
		await form.getByRole('textbox', { name: 'Description', exact: true }).fill('Changes to review');
		await form.getByRole('combobox', { name: 'Merge mode' }).selectOption('SQUASH');
		const actionMenu = form.getByRole('button', { name: 'Pull request action', exact: true });
		await actionMenu.focus();
		await actionMenu.press('ArrowDown');
		await expect(page.getByRole('menu')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(form).toBeVisible();
		await expect(actionMenu).toBeFocused();
		await actionMenu.click();
		await page.getByRole('menuitemcheckbox', { name: 'Ask agent to create', exact: true }).click();
		await expect(form).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.agentRequests())).toEqual([{
			action: 'start', request: expect.objectContaining({ sessionId: 'session', threadId: 'thread', expectedSequence: 7, mode: 'agent', text: expect.stringContaining('Title: Agent reviewed PR\nDescription:\nChanges to review') }),
		}]);
		expect(await page.evaluate(() => window.ashChangesIntegration.created())).toEqual([]);
		await create.click();
		await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
		await expect(form.getByRole('combobox', { name: 'Merge mode' })).toHaveValue('SQUASH');
		await expect(form.getByRole('button', { name: 'Send to agent', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashChangesIntegration.activeTurn(true));
		await form.getByRole('button', { name: 'Send to agent' }).click();
		await expect(form).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.agentRequests())).toEqual([
			{ action: 'start', request: expect.anything() }, { action: 'queue', request: expect.objectContaining({ sessionId: 'session', threadId: 'thread', expectedSequence: 7 }) },
		]);
	});

	test('Changes keeps keyboard selection and last known totals, but clears stale actions on failure', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/changes.html');
		await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
		const tree = page.getByRole('tree', { name: 'Changes' });
		const file = page.getByRole('treeitem');
		await expect(file).toHaveCount(1);
		await expect(page.locator('.ash-sessions-changes-summary')).toHaveText('1 file +3 −2');
		await expect(page.locator('.ash-sessions-changes-repository-status')).toContainText('origin/feature: 1 incoming · 2 outgoing · 3 uncommitted files');
		await expect(page.locator('.ash-sessions-changes-summary')).toHaveCSS('font-size', '11px');
		await tree.focus();
		await tree.press('ArrowDown');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.opened())).toBe(1);
		await expect(page.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
		await page.evaluate(() => window.ashChangesIntegration.fail(false));
		await expect(file).toHaveAttribute('aria-selected', 'true');
		await expect(tree).toBeFocused();
		await page.evaluate(() => window.ashChangesIntegration.fail(true));
		await expect(file).toHaveCount(0);
		await expect(page.locator('.ash-sessions-changes-summary')).toHaveText('1 file +3 −2');
		await expect(page.getByRole('button', { name: 'Review all changes' })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Retry loading changes' })).toBeVisible();
		await page.evaluate(() => window.ashChangesIntegration.rebuild());
		await expect(page.getByRole('button', { name: 'Retry loading changes' })).toBeVisible();
		await expect(page.locator('.ash-sessions-changes-summary')).toHaveText('1 file +3 −2');
		await page.evaluate(() => window.ashChangesIntegration.selectSession('unseen'));
		await expect(page.getByRole('button', { name: 'Retry loading changes' })).toBeVisible();
		await expect(page.locator('.ash-sessions-changes-summary')).toBeHidden();
		await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
		await page.evaluate(() => window.ashChangesIntegration.fail(false));
		await expect(file).toHaveCount(1);
		await page.setViewportSize({ width: 320, height: 600 });
		const path = page.locator('.ash-sessions-change-path');
		await expect(path).toHaveCSS('text-overflow', 'ellipsis');
		await expect(path).toHaveAttribute('title', 'src/a-long-directory-name/main.ts');
		await expect(page.getByRole('link', { name: 'Build · Successful · team/repo #7' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Tests · Failed · team/repo #7' })).toBeVisible();
		const build = page.getByRole('link', { name: 'Build · Successful · team/repo #7' });
		await build.focus();
		await page.evaluate(() => window.ashChangesIntegration.fail(false));
		await expect(build).toBeFocused();
		const checks = page.getByRole('button', { name: 'Checks', exact: true });
		await checks.focus();
		await checks.press('Enter');
		await expect(checks).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByRole('link', { name: 'Tests · Failed · team/repo #7' })).toBeHidden();
		await checks.press('Space');
		await checks.press('Enter');
		await page.evaluate(() => window.ashChangesIntegration.visible(false));
		await page.evaluate(() => window.ashChangesIntegration.visible(true));
		await expect(page.getByRole('button', { name: 'Checks', exact: true })).toHaveAttribute('aria-expanded', 'false');
		await page.getByRole('button', { name: 'Checks', exact: true }).press('Enter');
		await expect(checks).toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('combobox', { name: 'Git branch actions' }).selectOption('sync');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.gitCalls())).toEqual(['git.pull:repository', 'git.push:repository']);
		await page.evaluate(() => window.ashChangesIntegration.setLocale());
		await expect(page.locator('.ash-sessions-changes-summary')).toHaveText('1 个文件 +3 −2');
		await page.evaluate(() => window.ashChangesIntegration.rebuild());
		await page.getByRole('combobox', { name: 'Git 分支操作' }).selectOption({ label: '发布分支' });
		const scope = page.getByRole('combobox', { name: '选择回合更改' });
		await scope.selectOption('change');
		await scope.selectOption({ label: '查看工作区更改' });
		await expect(scope).toHaveValue('change');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.gitCalls())).toEqual([
			'git.pull:repository', 'git.push:repository', 'git.publish:repository', 'git.openChangesSource:repository',
		]);
	});

	test('Changes creates and attaches the edited PR, and cancellation restores keyboard focus', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/changes.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const create = page.getByRole('button', { name: 'Create pull request', exact: true });
		await create.focus();
		await create.press('Enter');
		const form = page.getByRole('dialog', { name: 'Create pull request' });
		await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
		await expect(form.getByRole('textbox', { name: 'Target branch' })).toHaveValue('main');
		await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(form.getByRole('button', { name: 'Pull request action' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(form).toBeHidden();
		await expect(create).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.created())).toEqual([]);
		await create.press('Enter');
		await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
		for (const name of ['light', 'dark', 'contrast']) {
			await page.evaluate(name => window.ashChangesIntegration.theme(name), name);
			await expect(form).toBeVisible();
			await expect(form).toHaveCSS('border-radius', '12px');
		}
		await page.setViewportSize({ width: 320, height: 600 });
		await expect.poll(() => form.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
		await form.getByRole('textbox', { name: 'Title', exact: true }).fill('Reviewed change');
		await form.getByRole('textbox', { name: 'Description', exact: true }).fill('Why this change is needed');
		await form.getByRole('textbox', { name: 'Target branch' }).fill('release');
		await form.getByRole('checkbox', { name: 'Create as draft' }).check();
		await expect(form.getByRole('combobox', { name: 'Merge mode' })).toBeDisabled();
		await form.getByRole('button', { name: 'Create pull request' }).click();
		await expect(form).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.created())).toEqual([{ repository: { host: 'github.com', owner: 'team', name: 'repo', accountId: 'account' }, request: { title: 'Reviewed change', body: 'Why this change is needed', head: 'feature', base: 'release', draft: true } }]);
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.attached())).toEqual([{ sessionId: 'session', reference: { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 8, isArtifact: true } }]);
		expect(errors).toEqual([]);
	});

	test('Changes rejects a PR after a branch change and closes the form on account changes', async function () {
		const { page } = browserTests;

		await page.goto('/changes.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const create = page.getByRole('button', { name: 'Create pull request', exact: true });
		await create.click();
		const form = page.getByRole('dialog', { name: 'Create pull request' });
		await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
		await page.evaluate(() => window.ashChangesIntegration.branch('other'));
		await form.getByRole('button', { name: 'Create pull request' }).click();
		await expect(form.getByRole('status')).toHaveText('The branch, remote or account changed. Reopen the pull request form.');
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.created())).toEqual([]);
		await page.evaluate(() => window.ashChangesIntegration.accountChanged());
		await expect(form).toBeHidden();
		await expect(create).toBeFocused();
	});

	test('Changes PR form and CI results use the selected Chinese locale', async function () {
		const { page } = browserTests;

		await page.goto('/changes.html?locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(page.getByRole('link', { name: 'Tests · 失败 · team/repo #7' })).toBeVisible();
		await expect(page.locator('.ash-sessions-changes-repository-status')).toContainText('origin/feature：1 个传入 · 2 个传出 · 3 个未提交文件');
		await page.getByRole('combobox', { name: '更改视图模式' }).selectOption('tree');
		await expect(page.getByRole('treeitem')).toHaveCount(4);
		await page.getByRole('button', { name: '创建拉取请求', exact: true }).click();
		const form = page.getByRole('dialog', { name: '创建拉取请求' });
		await expect(form.getByRole('textbox', { name: '标题', exact: true })).toHaveValue('feature');
		await expect(form.getByRole('textbox', { name: '目标分支' })).toHaveValue('main');
		await expect(form.getByRole('button', { name: '拉取请求操作' })).toHaveAttribute('aria-haspopup', 'menu');
		await expect(form.getByRole('button', { name: '创建拉取请求', exact: true })).toBeEnabled();
		await expect(form.getByRole('checkbox', { name: '创建为草稿' })).toBeVisible();
		await form.getByRole('button', { name: '取消', exact: true }).click();
		await expect(form).toBeHidden();
	});

	test('Changes enables the selected auto-merge method only for the captured local head', async function () {
		const { page } = browserTests;

		await page.goto('/changes.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const create = page.getByRole('button', { name: 'Create pull request', exact: true });
		const form = page.getByRole('dialog', { name: 'Create pull request' });
		await create.click();
		await form.getByRole('combobox', { name: 'Merge mode' }).selectOption('SQUASH');
		await form.getByRole('button', { name: 'Create pull request' }).click();
		await expect(form).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.autoMergeCalls())).toEqual([{ repository: { host: 'github.com', owner: 'team', name: 'repo', accountId: 'account' }, number: 8, merge: { commit: 'commit', method: 'squash' } }]);
		await create.click();
		await form.getByRole('combobox', { name: 'Merge mode' }).selectOption('SQUASH');
		await page.evaluate(() => window.ashChangesIntegration.publishedHead('different-commit'));
		await form.getByRole('button', { name: 'Create pull request' }).click();
		await expect(form).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.autoMergeCalls().length)).toBe(1);
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.notifications().at(-1))).toContain('The published branch differs from the local commit. Review the pull request before merging.');
	});
});

suite('session Code Review', () => {
	const browserTests = useBrowserTests();

	test('keeps Changes independent, batches line drafts and opens the saved comparison from its reply', async function () {
		const { page } = browserTests;
		await page.goto('/changes.html?locale=zh-CN');
		await page.evaluate(() => window.ashChangesIntegration.openCodeReview());
		const review = page.locator('#code-review');
		const changes = page.locator('#existing-changes-editor .ash-sessions-changes-editor');
		await expect(review.getByRole('region', { name: '代码审查' })).toBeVisible();
		await expect(changes).toContainText('Reviewed');
		await expect(changes.getByRole('region', { name: '代码审查' })).toHaveCount(0);
		await expect(review.getByRole('button', { name: '切换并排 Diff' })).toHaveAttribute('aria-pressed', 'false');
		await expect(review.getByLabel('新增 3 行，删除 2 行')).toBeVisible();
		const scope = review.getByRole('combobox', { name: '比较范围' });
		await scope.selectOption('lastTurn');
		await expect(review.locator('.ash-session-code-review-diff')).toContainText('After');
		await scope.selectOption('thread');
		await expect(review.locator('.ash-session-code-review-diff')).toContainText('Reviewed');

		const seen = review.getByRole('checkbox', { name: '已阅', exact: true });
		await seen.check();
		await expect(review.getByRole('status').filter({ hasText: '1/1 已阅' })).toBeVisible();
		const file = review.locator('.stanza-multi-diff-editor-header-toggle');
		await expect(file).toHaveAttribute('aria-expanded', 'false');
		await review.getByRole('combobox', { name: '跳到文件' }).selectOption('1');
		await expect(file).toHaveAttribute('aria-expanded', 'true');

		await review.locator('.stanza-diff-editor-side.modified .line-numbers').getByText('2', { exact: true }).hover({ force: true });
		await review.getByRole('button', { name: '在第 2 行添加评论', exact: true }).click();
		const composer = review.getByRole('textbox', { name: '给 Agent 的评论' });
		const save = review.getByRole('button', { name: '保存草稿', exact: true });
		await composer.fill('Explain this replacement');
		await save.click();
		await page.evaluate(() => window.ashChangesIntegration.focusReviewLine(1, 3));
		await page.keyboard.press('K');
		await expect(composer).toHaveValue('K');
		await composer.fill('Keep the order');
		await save.click();
		await expect(review.getByRole('button', { name: /第 1–3 行.*Keep the order/ })).toBeVisible();
		await expect(review.getByRole('status').filter({ hasText: '2 条评论草稿' })).toBeVisible();
		const split = await review.locator('.ash-session-code-review-workspace').evaluate(element => {
			const comments = element.querySelector('.ash-session-code-review')!.getBoundingClientRect();
			const diff = element.querySelector('.ash-session-code-review-comparison')!.getBoundingClientRect();
			return { left: comments.right <= diff.left, codeLeads: diff.width > comments.width };
		});
		expect(split).toEqual({ left: true, codeLeads: true });
		await browserTests.info.attach('code-review.png', { body: await review.screenshot(), contentType: 'image/png' });
		const send = review.getByRole('button', { name: '发送给代码审查', exact: true });
		await page.evaluate(() => window.ashChangesIntegration.activeTurn(true));
		await send.click();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.notifications())).toContain('Error: 请等当前 Agent 回合结束后再发送审查评论。');
		expect(await page.evaluate(() => window.ashChangesIntegration.agentRequests())).toHaveLength(0);
		expect(await page.evaluate(() => window.ashChangesIntegration.reviewForks())).toHaveLength(0);
		await page.evaluate(() => {
			window.ashChangesIntegration.activeTurn(false);
			window.ashChangesIntegration.loseReviewAcknowledgement();
		});
		await send.click();
		await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.notifications())).toContain('Error: Review acknowledgement lost');
		await review.getByRole('button', { name: '确认或重试发送', exact: true }).click();
		await expect(review.getByRole('status').filter({ hasText: '0 条评论草稿' })).toBeVisible();
		const requests = await page.evaluate(() => window.ashChangesIntegration.agentRequests());
		expect(requests).toHaveLength(1);
		const [{ action, request }] = requests as [{ action: string; request: { commandId: string; threadId: string; contexts: { content: string; }[]; }; }];
		expect(action).toBe('start');
		expect(request.commandId).toMatch(/^ash-code-review-/);
		expect(request.threadId).toBe('review-thread');
		expect(await page.evaluate(() => window.ashChangesIntegration.reviewForks())).toEqual([{
			sessionId: 'session', threadId: 'thread', target: 'thread', commandId: request.commandId + '-thread', title: '审查 main.ts',
		}]);
		expect(JSON.parse(request.contexts[0]!.content)).toMatchObject([
			{ repositoryId: 'repository', path: 'src/a-long-directory-name/main.ts', line: 2, code: 'Original\nReviewed\nThird', feedback: 'Explain this replacement' },
			{ line: 1, endLine: 3, feedback: 'Keep the order' },
		]);

		await page.evaluate(() => window.ashChangesIntegration.replaceReviewCode());
		await expect(review).toContainText('Current content');
		await expect(changes).toContainText('Reviewed');
		await page.evaluate(() => window.ashChangesIntegration.openReviewReply());
		await expect(review).toContainText('2 条评论 · 已保存的比较');
		await expect(review).toContainText('Reviewed');
		await expect(review).toContainText('Explain this replacement');
		await review.getByRole('button', { name: /第 1–3 行.*Keep the order/ }).click();
		await expect(review.locator('.ash-review-zone-body')).toContainText('Keep the order');
		await review.getByRole('button', { name: '查看最新版本' }).click();
		await expect(review.locator('.ash-session-code-review-diff')).toContainText('Current content');
		await expect(review.getByRole('status').filter({ hasText: '0/1 已阅' })).toBeVisible();
		await review.evaluate(element => { element.style.width = '440px'; });
		const stacked = await review.locator('.ash-session-code-review-workspace').evaluate(element => {
			const comments = element.querySelector('.ash-session-code-review')!.getBoundingClientRect();
			const diff = element.querySelector('.ash-session-code-review-comparison')!.getBoundingClientRect();
			return diff.bottom <= comments.top && diff.height > 0 && comments.height > 0;
		});
		expect(stacked).toBe(true);
	});

	for (const scope of ['thread', 'lastTurn'] as const) {
		test(`keeps repository identity for identical paths in the ${scope} comparison`, async function () {
			const { page } = browserTests;
			await page.goto('/changes.html');
			await page.evaluate(() => window.ashChangesIntegration.openCodeReview({ multipleRepositories: true }));
			const review = page.locator('#code-review');
			await review.getByRole('combobox', { name: 'Comparison' }).selectOption(scope);
			const composer = review.getByRole('textbox', { name: 'Comment for the agent' });
			for (const repository of ['repository', 'nested-repository']) {
				const label = `${repository}: src/a-long-directory-name/main.ts`;
				await review.getByRole('combobox', { name: 'Jump to file' }).selectOption({ label });
				const file = review.locator('.stanza-multi-diff-editor-section').filter({ has: page.getByRole('button', { name: `Collapse ${label}`, exact: true }) });
				await file.locator('.stanza-diff-editor-side.modified .line-numbers').getByText('2', { exact: true }).hover({ force: true });
				await file.getByRole('button', { name: 'Add comment on line 2' }).click();
				await composer.fill('Same feedback');
				await review.getByRole('button', { name: 'Save Draft' }).click();
			}
			await review.getByRole('button', { name: 'Send to Code Review' }).click();
			await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.agentRequests().length)).toBe(1);
			const [entry] = await page.evaluate(() => window.ashChangesIntegration.agentRequests()) as [{ request: { contexts: { content: string; }[]; }; }];
			expect(JSON.parse(entry.request.contexts[0]!.content)).toMatchObject(['repository', 'nested-repository'].map(repositoryId => ({
				repositoryId, path: 'src/a-long-directory-name/main.ts', line: 2, code: 'Original\nReviewed\nThird', feedback: 'Same feedback',
			})));
		});
	}

	test('retains new and edited text when a file scrolls out of the review viewport', async function () {
		const { page } = browserTests;
		await page.goto('/changes.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(async () => {
			const files = Array.from({ length: 36 }, (_, index) => ({
				path: `src/file-${index}.ts`, kind: 'modified' as const, binary: false, additions: 1, deletions: 1,
			}));
			window.ashChangesIntegration.checkpoint({
				sequence: 7, revision: 'virtualized', statistics: { files: files.length, additions: files.length, deletions: files.length },
				repositories: [{ repositoryId: 'repository', files }], warnings: [],
			});
			await window.ashChangesIntegration.openCodeReview();
		});
		const review = page.locator('#code-review');
		const file = review.getByRole('button', { name: 'Collapse src/file-0.ts', exact: true });
		const section = review.locator('.stanza-multi-diff-editor-section').filter({ has: page.getByRole('button', { name: 'Collapse src/file-0.ts', exact: true }) });
		const scroll = review.locator('.stanza-multi-diff-editor');
		const composer = review.getByRole('textbox', { name: 'Comment for the agent' });
		const remount = async () => {
			await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
			await expect(file).toHaveCount(0);
			await expect(composer).toHaveCount(0);
			await review.getByRole('combobox', { name: 'Jump to file' }).selectOption({ label: 'src/file-0.ts' });
			await expect(file).toBeVisible();
		};
		const openNewComment = async () => {
			await section.locator('.stanza-diff-editor-side.modified .line-numbers').getByText('2', { exact: true }).hover({ force: true });
			await section.getByRole('button', { name: 'Add comment on line 2' }).click();
		};
		await openNewComment();
		await composer.fill('First saved text');
		await remount();
		await openNewComment();
		await expect(composer).toHaveValue('First saved text');
		await composer.press('Control+Enter');
		const savedNote = review.getByRole('button', { name: /line 2.*First saved text/ });
		await expect(savedNote).toBeVisible();
		await composer.fill('Unsaved replacement');
		await remount();
		await savedNote.click();
		await expect(composer).toHaveValue('Unsaved replacement');
		await review.getByRole('button', { name: 'Save Draft' }).click();
		await expect(review.getByRole('button', { name: /line 2.*Unsaved replacement/ })).toBeVisible();
	});
});
