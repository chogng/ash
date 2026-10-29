import { expectIconFontLoaded } from '../../../../../../../test/automation/iconFonts.js';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { createTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandsRegistry, type ICommandService } from '../../../../../platform/commands/common/commands.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { GettingStarted } from '../../browser/gettingStartedContent.js';
import { GettingStartedPage } from '../../browser/gettingStarted.js';
const GitCloneCommandId = 'git.clone';
import type { IGitHubConnectionService } from '../../../../services/accounts/common/gitHubConnectionService.js';
import type { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { TestHostService } from '../../../../services/host/test/browser/testHostService.js';
import type { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

suite('Welcome page', () => {
	test('dispatches the Git clone command from an empty desktop window', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const calls: string[] = [];
		using registeredClone = CommandsRegistry.register('git.clone', () => {});
		const history = {
			onDidChangeRecentlyOpened: Event.None,
			getRecentlyOpened: async () => ({ workspaces: [] }),
		} as unknown as IWorkspacesService;
		const host = new TestHostService();
		let commandDispatched: (() => void) | undefined;
		const dispatched = new Promise<void>(resolve => {
			commandDispatched = resolve;
		});
		const commands = {
			executeCommand: async (id: string) => {
				calls.push(id);
				commandDispatched?.();
			},
		} as ICommandService;
		using contextKeys = new ContextKeyService();
		contextKeys.setContext('openFolderWorkspaceSupport', true);
		using services = createTestComponentServices(undefined, undefined, dom.window.document);
		using page = new GettingStartedPage(
			history,
			host,
			{} as IFileDialogService,
			commands,
			contextKeys,
			{} as IGitHubConnectionService,
			services.get(IThemeService),
			services.get(IStorageService),
		);
		page.create(dom.window.document.body);
		const clone = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
			button => button.textContent === 'Clone repo',
		);
		assert.equal(clone?.disabled, false);
		clone?.click();
		await dispatched;
		assert.deepEqual(calls, [GitCloneCommandId]);
		dom.window.close();
	});
	test('shows actions, translates labels, and dispatches the available action', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let openFolderCount = 0;
		let connectGitHubCount = 0;
		const page = new GettingStarted(dom.window.document.body, {
			actions: {
				openFolder: () => {
					openFolderCount += 1;
				},
				connectGitHub: () => {
					connectGitHubCount += 1;
				},
			},
			recentProjects: [{ name: 'ash', path: '~/Desktop' }],
		});
		const cards = page.domNode.querySelectorAll<HTMLButtonElement>('.ash-getting-started-card');
		assert.equal(page.domNode.querySelector('.ash-getting-started-name')?.textContent, 'ASH');
		assert.deepEqual(
			[...cards].map(card => card.textContent),
			['Open folder', 'Clone repo', 'Connect via SSH', 'Connect GitHub'],
		);
		assert.deepEqual(
			[...cards].map(card => card.disabled),
			[false, true, true, false],
		);
		cards[0]?.click();
		cards[3]?.click();
		assert.equal(openFolderCount, 1);
		assert.equal(connectGitHubCount, 1);

		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		try {
			setNlsResolver((bundle, key, fallback, parameters) =>
				formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters),
			);
			using translated = new GettingStarted(dom.window.document.body, {
				recentProjects: [{ name: 'ash', path: '~/Desktop', onRemove: () => {} }],
			});
			assert.deepEqual(
				[...translated.domNode.querySelectorAll('.ash-getting-started-card')].map(
					card => card.querySelector('.ash-getting-started-card-label')?.textContent,
				),
				['打开文件夹', '克隆仓库', '通过 SSH 连接', '连接 GitHub'],
			);
			assert.equal(translated.domNode.querySelector('h2')?.textContent, '最近打开');
			assert.equal(
				translated.domNode
					.querySelector('.ash-getting-started-recent-actions button')
					?.getAttribute('aria-label'),
				'从最近打开中移除 ash',
			);
		} finally {
			resetNlsResolver();
		}
		page.dispose();
		dom.window.close();
	});

	test('shows all recent projects and hides the section when empty', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let openCount = 0;
		let removeCount = 0;
		const page = new GettingStarted(dom.window.document.body, {
			recentProjects: Array.from({ length: 6 }, (_, index) => ({
				name: `project-${index + 1}`,
				path: `/workspaces/project-${index + 1}`,
				onOpen: () => {
					openCount += 1;
				},
				onRemove: () => {
					removeCount += 1;
				},
			})),
		});
		const section = page.domNode.querySelector<HTMLElement>('.ash-getting-started-recent')!;
		const items = section.querySelectorAll<HTMLButtonElement>('.ash-getting-started-recent-content');
		const removeButtons = section.querySelectorAll<HTMLButtonElement>('.ash-getting-started-recent-actions button');
		assert.equal(section.hidden, false);
		assert.deepEqual(
			[...items].map(item => [
				item.querySelector('.ash-getting-started-recent-name')?.textContent,
				item.querySelector('.ash-getting-started-recent-path')?.textContent,
			]),
			Array.from({ length: 6 }, (_, index) => [`project-${index + 1}`, `/workspaces/project-${index + 1}`]),
		);
		assert.equal(section.querySelector('.ash-getting-started-view-all'), null);
		items[0]?.click();
		assert.equal(openCount, 1);
		page.setRecentProjects([]);
		assert.equal(section.hidden, true);
		assert.equal(section.childElementCount, 0);
		items[0]?.click();
		removeButtons[0]?.click();
		assert.equal(openCount, 1);
		assert.equal(removeCount, 0);
		page.setRecentProjects([{ name: 'new-project', path: '/workspaces/new-project' }]);
		assert.equal(section.hidden, false);
		assert.equal(section.querySelector('.ash-getting-started-recent-name')?.textContent, 'new-project');
		assert.equal(section.querySelector('.ash-getting-started-recent-path')?.textContent, '/workspaces/new-project');
		page.dispose();
		dom.window.close();
	});
});

suite('gettingStarted browser component', () => {
	const browserTests = useBrowserTests();
	test('Welcome renders its brand and light-theme action cards', async function () {
		const { page } = browserTests;

		await page.goto('/gettingStarted.html?theme=light');
		const welcome = page.getByRole('region', { name: 'Welcome', exact: true });
		await expect(welcome.locator('.ash-getting-started-brand')).toHaveText('ASH');
		await expect(welcome.getByRole('button', { name: 'Open folder', exact: true })).toBeVisible();
		const mark = welcome.locator('.ash-getting-started-mark');
		await expect(mark).toBeVisible();
		await expect(mark).toHaveAttribute('aria-hidden', 'true');
		await expectIconFontLoaded(mark.locator('.ash-icon'));
		await expect(mark.locator('svg')).toHaveCount(0);
		await expect(mark).toHaveCSS('background-image', 'none');
		await expect(mark.locator('.ash-icon')).toHaveCSS(
			'color',
			await mark.evaluate(element => getComputedStyle(element).color),
		);
		const cards = welcome.locator('.ash-getting-started-card');
		await expect(cards).toHaveCount(4);
		await expect(cards.locator('.ash-getting-started-card-label')).toHaveText([
			'Open folder',
			'Clone repo',
			'Connect via SSH',
			'Connect GitHub',
		]);
		for (const index of [0, 1, 2]) {
			const card = cards.nth(index);
			await expect(card).toHaveCSS('background-color', 'rgb(243, 243, 243)');
			await expect(card).toHaveCSS('border-color', 'rgb(212, 212, 212)');
			await expect(card).toHaveCSS('opacity', '1');
			await expect(card.locator('.ash-icon')).toHaveCSS('width', '16px');
			await card.hover();
			await expect(card).toHaveCSS('background-color', 'rgb(228, 228, 228)');
		}
		const github = cards.nth(3);
		await expect(github).toBeEnabled();
		await expect(github.locator('.ash-getting-started-card-arrow')).toHaveCount(0);
		await expect(github).toHaveCSS('background-color', 'rgb(0, 0, 0)');
		await expect(github).toHaveCSS('color', 'rgb(255, 255, 255)');
		await expect(github.locator('.ash-icon')).toHaveCSS('color', 'rgb(255, 255, 255)');
		const githubIcon = github.locator('.ash-icon');
		await expectIconFontLoaded(githubIcon);
		await expect(githubIcon.locator('svg')).toHaveCount(0);
		expect(await githubIcon.evaluate(element => getComputedStyle(element, '::before').color)).toBe(
			'rgb(255, 255, 255)',
		);
		await github.hover();
		await expect(github).toHaveCSS('background-color', 'rgb(38, 38, 38)');
	});

	test('Welcome cards keep even spacing and shrink before wrapping in a narrow editor', async function () {
		const { page } = browserTests;

		await page.goto('/gettingStarted.html');
		const welcome = page.getByRole('region', { name: 'Welcome', exact: true });
		const cards = welcome.locator('.ash-getting-started-card');
		await expect(cards).toHaveCount(4);
		const [topLeft, topRight, bottomLeft, bottomRight] = await Promise.all(
			[0, 1, 2, 3].map(index => cards.nth(index).boundingBox()),
		);
		expect(
			topLeft && topRight && bottomLeft && bottomRight
				? {
						columnGap: Math.round(topRight.x - topLeft.x - topLeft.width),
						rowGap: Math.round(bottomLeft.y - topLeft.y - topLeft.height),
						leftColumnAligned: topLeft.x === bottomLeft.x,
						rightColumnAligned: topRight.x === bottomRight.x,
					}
				: null,
		).toEqual({ columnGap: 12, rowGap: 12, leftColumnAligned: true, rightColumnAligned: true });
		for (const [width, expectedCardWidth, sameRow] of [
			[364, 160, true],
			[350, 180, false],
		] as const) {
			await page.setViewportSize({ width, height: 720 });
			await expect
				.poll(() =>
					cards.evaluateAll(elements => {
						const [first, second] = elements.map(element => element.getBoundingClientRect());
						return {
							cardWidth: Math.round(first!.width),
							secondCardOnFirstRow: first!.top === second!.top,
							labelOverflow: Math.max(
								0,
								...elements.map(card => {
									const label = card.querySelector('.ash-getting-started-card-label')!;
									return label.getBoundingClientRect().right - card.getBoundingClientRect().right;
								}),
							),
						};
					}),
				)
				.toEqual({ cardWidth: expectedCardWidth, secondCardOnFirstRow: sameRow, labelOverflow: 0 });
		}
	});

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`Recents exposes removable history on hover and keyboard focus (${theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/gettingStarted.html?theme=${theme}`);
			await expect(page.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible();
			const row = page.locator('.ash-getting-started-recent-item').filter({ hasText: 'alpha' });
			const open = row.locator('.ash-getting-started-recent-content');
			const actions = row.locator('.ash-getting-started-recent-actions');
			const remove = row.getByRole('button', { name: 'Remove alpha from Recents', exact: true });
			await expect(actions).toHaveCSS('opacity', '0');
			const before = await open.boundingBox();
			expect(before!.height).toBe(22);
			const card = await page.locator('.ash-getting-started-card').first().boundingBox();
			const name = await row.locator('.ash-getting-started-recent-name').boundingBox();
			const path = await row.locator('.ash-getting-started-recent-path').boundingBox();
			const lastCard = await page.locator('.ash-getting-started-card').nth(1).boundingBox();
			const rowBounds = (await row.boundingBox())!;
			const heading = await page.getByRole('heading', { name: 'Recents', exact: true }).boundingBox();
			expect(heading!.x).toBe(card!.x);
			expect(rowBounds.x).toBe(card!.x);
			expect(rowBounds.x + rowBounds.width).toBe(lastCard!.x + lastCard!.width);
			expect(name!.x - rowBounds.x).toBe(8);
			expect(rowBounds.x + rowBounds.width - path!.x - path!.width).toBe(8);
			await expect(row.locator('.ash-getting-started-recent-path')).toHaveCSS('text-align', 'right');
			const idleBackground = await row.evaluate(element => getComputedStyle(element).backgroundColor);
			await row.hover();
			await expect(actions).toHaveCSS('opacity', '1');
			expect(await row.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(idleBackground);
			expect(await open.boundingBox()).toEqual(before);
			await open.focus();
			await page.keyboard.press('Tab');
			await expect(remove).toBeFocused();
			await expect(row).toHaveCSS('outline-style', 'solid');
			await expect(row).toHaveCSS('outline-width', '1px');
			const rowBox = await row.boundingBox();
			const actionBox = await actions.boundingBox();
			const removeBox = await remove.boundingBox();
			const iconBox = await remove.locator('.ash-icon').boundingBox();
			expect(removeBox).toMatchObject({ width: 20, height: 20 });
			expect(iconBox!.x + iconBox!.width / 2).toBeCloseTo(removeBox!.x + removeBox!.width / 2, 2);
			expect(iconBox!.y + iconBox!.height / 2).toBeCloseTo(removeBox!.y + removeBox!.height / 2, 2);
			expect(rowBox!.x + rowBox!.width - removeBox!.x - removeBox!.width).toBeCloseTo(1, 1);
			expect(actionBox!.y).toBeGreaterThan(rowBox!.y);
			expect(actionBox!.y + actionBox!.height).toBeLessThan(rowBox!.y + rowBox!.height);
			await page.screenshot({ path: testInfo.outputPath(`recents-${theme}.png`) });
			await page.keyboard.press('Enter');
			await expect(row).toHaveCount(0);
			await expect(page.locator('.ash-getting-started-recent-content')).toBeFocused();
			expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([]);
			await page.goto(`/gettingStarted.html?theme=${theme}&seed=false`);
			await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(1);
			await page.getByRole('button', { name: 'Remove beta from Recents', exact: true }).focus();
			await page.keyboard.press('Space');
			await expect(page.locator('.ash-getting-started-recent')).toBeHidden();
			await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeFocused();
		});
	}

	test('Recents opens rows and removes only the clicked history entry', async function () {
		const { page } = browserTests;

		await page.goto('/gettingStarted.html');
		const alpha = page.locator('.ash-getting-started-recent-item').filter({ hasText: 'alpha' });
		await alpha.locator('.ash-getting-started-recent-content').click();
		expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([
			process.platform === 'win32'
				? '\\synthetic\\projects\\with-a-long-parent-path\\alpha'
				: '/synthetic/projects/with-a-long-parent-path/alpha',
		]);
		await alpha.getByRole('button', { name: 'Remove alpha from Recents', exact: true }).click();
		await expect(alpha).toHaveCount(0);
		await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([
			process.platform === 'win32'
				? '\\synthetic\\projects\\with-a-long-parent-path\\alpha'
				: '/synthetic/projects/with-a-long-parent-path/alpha',
		]);
	});

	test('Recents keeps the focused remove action when history refreshes', async function () {
		const { page } = browserTests;

		await page.goto('/gettingStarted.html');
		const remove = page.getByRole('button', { name: 'Remove alpha from Recents', exact: true });
		await remove.focus();
		await page.evaluate(() => window.ashWelcomeIntegration.addRecent('gamma'));
		await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(3);
		await expect(remove).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(remove).toHaveCount(0);
		await expect(
			page
				.locator('.ash-getting-started-recent-item')
				.filter({ hasText: 'beta' })
				.locator('.ash-getting-started-recent-content'),
		).toBeFocused();
	});

	test('Recents removes a workspace file with spaces and URL characters durably', async function () {
		const { page } = browserTests;

		await page.goto('/gettingStarted.html?workspace');
		await page.locator('.ash-getting-started-recent-item').hover();
		await page.getByRole('button', { name: 'Remove Team from Recents', exact: true }).click();
		await expect(page.locator('.ash-getting-started-recent')).toBeHidden();
		await page.goto('/gettingStarted.html?seed=false');
		await expect(page.locator('.ash-getting-started-recent')).toBeHidden();
		expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([]);
	});

	test('Recents stays within a narrow editor and supports touch removal', async function () {
		const { page, browser } = browserTests;

		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto('/gettingStarted.html');
		const row = page.locator('.ash-getting-started-recent-item').first();
		await row.hover();
		const box = await row.boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(320);
		const touchContext = await browser.newContext({
			baseURL: new URL(page.url()).origin,
			hasTouch: true,
			isMobile: true,
			viewport: { width: 320, height: 720 },
		});
		try {
			const touchPage = await touchContext.newPage();
			await touchPage.goto('/gettingStarted.html');
			await expect(touchPage.locator('.ash-getting-started-recent-actions').first()).toHaveCSS('opacity', '1');
			await touchPage.getByRole('button', { name: 'Remove alpha from Recents', exact: true }).tap();
			await expect(touchPage.locator('.ash-getting-started-recent-item')).toHaveCount(1);
		} finally {
			await touchContext.close();
		}
	});
});
