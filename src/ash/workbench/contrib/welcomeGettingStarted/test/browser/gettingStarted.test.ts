import { OPEN_AGENTS_WINDOW_COMMAND_ID, AgentsWindowGraphicVariant, agentsWindowGraphicConfiguration } from '../../../chat/common/constants.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { expectIconFontLoaded } from '../../../../../../../test/automation/iconFonts.js';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { createTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
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

const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
if (!registry.owns(agentsWindowGraphicConfiguration.key)) registry.registerConfiguration(agentsWindowGraphicConfiguration);

suite('Welcome page', () => {
	test('dispatches the Git clone command from an empty desktop window', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const calls: string[] = [];
		using registeredClone = CommandsRegistry.register('git.clone', () => { });
		const history = { onDidChangeRecentlyOpened: Event.None, getRecentlyOpened: async () => ({ workspaces: [] }) } as unknown as IWorkspacesService;
		const host = new TestHostService();
		let commandDispatched: (() => void) | undefined;
		const dispatched = new Promise<void>(resolve => { commandDispatched = resolve; });
		const commands = { executeCommand: async (id: string) => { calls.push(id); commandDispatched?.(); } } as ICommandService;
		using contextKeys = new ContextKeyService();
		contextKeys.setContext('openFolderWorkspaceSupport', true);
		using configuration = new InMemoryConfigurationService();
		using services = createTestComponentServices(undefined, undefined, dom.window.document);
		using page = new GettingStartedPage(
			history,
			host,
			{} as IFileDialogService,
			commands,
			contextKeys,
			{} as IGitHubConnectionService,
			configuration,
			services.get(IThemeService),
			services.get(IStorageService),
		);
		page.create(dom.window.document.body);
		const clone = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Clone repo');
		assert.equal(clone?.disabled, false);
		clone?.click();
		await dispatched;
		assert.deepEqual(calls, [GitCloneCommandId]);
		dom.window.close();
	});
	test('ignores stale window snapshots after an explicit setting change and after disposal', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const pending: ((windows: Awaited<ReturnType<TestHostService['getWindows']>>) => void)[] = [];
		using focusChanged = new Emitter<boolean>();
		const host = new class extends TestHostService { override readonly onDidChangeFocus = focusChanged.event; }();
		host.getWindows = () => new Promise(resolve => pending.push(resolve));
		using command = CommandsRegistry.register(OPEN_AGENTS_WINDOW_COMMAND_ID, () => { });
		using configuration = new InMemoryConfigurationService();
		using contexts = new ContextKeyService();
		using services = createTestComponentServices(undefined, undefined, dom.window.document);
		using page = new GettingStartedPage(
			{ onDidChangeRecentlyOpened: Event.None, getRecentlyOpened: async () => ({ workspaces: [] }) } as unknown as IWorkspacesService,
			host, {} as IFileDialogService, { executeCommand: async () => { } } as unknown as ICommandService,
			contexts, {} as IGitHubConnectionService, configuration, services.get(IThemeService), services.get(IStorageService),
		);
		try {
			page.create(dom.window.document.body);
			assert.equal(pending.length, 1);
			focusChanged.fire(false);
			assert.equal(pending.length, 1);
			focusChanged.fire(true);
			assert.equal(pending.length, 2);
			await configuration.updateValue(agentsWindowGraphicConfiguration.key, AgentsWindowGraphicVariant.ManyWindowsToOne);
			pending[0]!([]);
			pending[1]!([]);
			await Promise.resolve();
			assert.ok(dom.window.document.querySelector('.many-windows-to-one'));
			await configuration.updateValue(agentsWindowGraphicConfiguration.key, AgentsWindowGraphicVariant.Auto);
			assert.equal(pending.length, 3);
			const illustration = dom.window.document.querySelector('.ash-agents-banner')!;
			assert.equal(illustration.querySelector('svg'), null);
			page.dispose();
			pending[2]!([]);
			await Promise.resolve();
			assert.equal(illustration.isConnected, false);
			assert.equal(illustration.querySelector('svg'), null);
		} finally {
			page.dispose();
			dom.window.close();
		}
	});

	test('shows actions, translates labels, and dispatches the available action', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let openFolderCount = 0;
		let connectGitHubCount = 0;
		const page = new GettingStarted(dom.window.document.body, {
			actions: { openFolder: () => { openFolderCount += 1; }, connectGitHub: () => { connectGitHubCount += 1; } },
			recentProjects: [{ name: 'ash', path: '~/Desktop' }],
		});
		const cards = page.domNode.querySelectorAll<HTMLButtonElement>('.ash-getting-started-card');
		assert.equal(page.domNode.querySelector('.ash-getting-started-name')?.textContent, 'ASH');
		assert.deepEqual([...cards].map(card => card.textContent), ['Open folder', 'Clone repo', 'Connect via SSH', 'Connect GitHub']);
		assert.deepEqual([...cards].map(card => card.disabled), [false, true, true, false]);
		cards[0]?.click();
		cards[3]?.click();
		assert.equal(openFolderCount, 1);
		assert.equal(connectGitHubCount, 1);

		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		try {
			setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
			using translated = new GettingStarted(dom.window.document.body, { recentProjects: [{ name: 'ash', path: '~/Desktop', onRemove: () => { } }] });
			assert.deepEqual([...translated.domNode.querySelectorAll('.ash-getting-started-card')].map(card => card.querySelector('.ash-getting-started-card-label')?.textContent), ['打开文件夹', '克隆仓库', '通过 SSH 连接', '连接 GitHub']);
			assert.equal(translated.domNode.querySelector('h2')?.textContent, '最近打开');
			assert.equal(translated.domNode.querySelector('.ash-getting-started-recent-actions button')?.getAttribute('aria-label'), '从最近打开中移除 ash');
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
				onOpen: () => { openCount += 1; },
				onRemove: () => { removeCount += 1; },
			})),
		});
		const section = page.domNode.querySelector<HTMLElement>('.ash-getting-started-recent')!;
		const items = section.querySelectorAll<HTMLButtonElement>('.ash-getting-started-recent-content');
		const removeButtons = section.querySelectorAll<HTMLButtonElement>('.ash-getting-started-recent-actions button');
		assert.equal(section.hidden, false);
		assert.deepEqual([...items].map(item => [
			item.querySelector('.ash-getting-started-recent-name')?.textContent,
			item.querySelector('.ash-getting-started-recent-path')?.textContent,
		]), Array.from({ length: 6 }, (_, index) => [`project-${index + 1}`, `/workspaces/project-${index + 1}`]));
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
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`Agents introduction supports keyboard launch and theme surfaces (${theme})`, async () => {
			const { page } = browserTests;
			await page.setViewportSize({ width: 1000, height: 900 });
			await page.goto(`/gettingStarted.html?agents&seed=false&theme=${theme}`);
			const welcome = page.getByRole('region', { name: 'Welcome', exact: true });
			const graphic = welcome.locator('.ash-agents-window-graphic');
			await expect(graphic).toBeVisible();
			await expect(graphic.locator('svg')).toHaveCount(2);
			await expect(graphic.locator('svg').first()).toHaveAttribute('aria-hidden', 'true');
			const frame = graphic.locator('.window-frame').first();
			const colors = await frame.evaluate(node => ({ fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke }));
			expect(colors.fill).toBe(await welcome.evaluate(node => getComputedStyle(node).backgroundColor));
			expect(colors.stroke).not.toBe('none');
			expect(colors.stroke).not.toBe('rgba(0, 0, 0, 0)');
			const launch = welcome.getByRole('button', { name: 'Open Agents window', exact: true });
			await welcome.focus();
			for (let index = 0; index < 4; index++) {
				await page.keyboard.press('Tab');
			}
			await expect(launch).toBeFocused();
			await expect(launch).toHaveCSS('outline-style', 'solid');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashWelcomeIntegration.agentsLaunches)).toBe(1);
		});
	}

	test('Agents entry follows command availability and preserves a safe focus target', async () => {
		const { page } = browserTests;
		await page.goto('/gettingStarted.html?seed=false');
		const banner = page.locator('.ash-agents-banner');
		await expect(banner).toBeHidden();
		await page.evaluate(() => window.ashWelcomeIntegration.setAgentsAvailable(true));
		const button = banner.getByRole('button', { name: 'Open Agents window', exact: true });
		await expect(button).toBeVisible();
		await button.focus();
		await page.evaluate(() => window.ashWelcomeIntegration.setAgentsAvailable(false));
		await expect(banner).toBeHidden();
		await expect(page.locator('.ash-getting-started')).toBeFocused();
		await page.evaluate(() => window.ashWelcomeIntegration.setAgentsAvailable(true));
		await button.click();
		await expect.poll(() => page.evaluate(() => window.ashWelcomeIntegration.agentsLaunches)).toBe(1);
	});

	test('Graphic preference overrides auto and auto excludes managed and auxiliary windows', async () => {
		const { page } = browserTests;
		await page.setViewportSize({ width: 1000, height: 900 });
		await page.goto('/gettingStarted.html?agents&seed=false');
		const graphic = page.locator('.ash-agents-window-graphic');
		await page.evaluate(() => window.ashWelcomeIntegration.setEditorWindows(1));
		await expect(graphic.locator('h2')).toHaveText(['Editor window', 'Agents window']);
		await page.evaluate(() => window.ashWelcomeIntegration.setEditorWindows(2));
		await expect(graphic).toHaveClass(/many-windows-to-one/);
		const nestedWidth = await graphic.locator('svg > svg').first().evaluate(node => node.getBoundingClientRect().width);
		expect(nestedWidth).toBeGreaterThan(150);
		expect(nestedWidth).toBeLessThan(250);
		await page.evaluate(() => window.ashWelcomeIntegration.setGraphic('windowComparison'));
		await expect(graphic.locator('h2')).toHaveCount(2);
		await page.evaluate(() => window.ashWelcomeIntegration.setGraphic('none'));
		await expect(graphic).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Open Agents window', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashWelcomeIntegration.setGraphic('auto'));
		await expect(graphic).toHaveClass(/many-windows-to-one/);
		await page.evaluate(() => window.ashWelcomeIntegration.setEditorWindows(1));
		await expect(graphic.locator('h2')).toHaveCount(2);
	});

	test('Agents introduction fits height changes without losing the focused launch button', async () => {
		const { page } = browserTests;
		await page.setViewportSize({ width: 1000, height: 900 });
		await page.goto('/gettingStarted.html?agents&seed=false');
		const welcome = page.locator('.ash-getting-started');
		const banner = welcome.locator('.ash-agents-banner');
		const graphic = banner.locator('.ash-agents-window-graphic');
		const launch = banner.getByRole('button', { name: 'Open Agents window', exact: true });
		await expect(graphic).toBeVisible();
		await launch.focus();
		for (const [height, compact, shown] of [[600, true, true], [450, true, false], [900, false, true]] as const) {
			await page.setViewportSize({ width: 1000, height });
			await expect.poll(() => banner.evaluate(node => node.classList.contains('compact'))).toBe(compact);
			if (shown) {
				await expect(graphic).toBeVisible();
			} else {
				await expect(graphic).toBeHidden();
			}
			await expect(launch).toBeFocused();
			await expect(launch).toBeInViewport();
			await expect.poll(() => welcome.evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
		}
	});

	test('Agents introduction stacks on narrow editors and uses Chinese captions', async () => {
		const { page } = browserTests;
		await page.setViewportSize({ width: 360, height: 1200 });
		await page.goto('/gettingStarted.html?agents&seed=false&locale=zh-CN');
		const graphic = page.locator('.ash-agents-window-graphic');
		await expect(graphic).toBeVisible();
		await expect(graphic.locator('h2')).toHaveText(['编辑器窗口', '智能体窗口']);
		const figures = await graphic.locator('figure').evaluateAll(nodes => nodes.map(node => {
			const rect = node.getBoundingClientRect();
			return { x: rect.x, y: rect.y, right: rect.right };
		}));
		expect(figures[1]!.y).toBeGreaterThan(figures[0]!.y);
		expect(figures[1]!.x).toBe(figures[0]!.x);
		expect(figures[0]!.x).toBeGreaterThanOrEqual(0);
		expect(figures[0]!.right).toBeLessThanOrEqual(360);
		await page.getByRole('button', { name: '打开智能体窗口', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashWelcomeIntegration.agentsLaunches)).toBe(1);
	});

	test('Agents introduction refits when recent projects grow and shrink', async () => {
		const { page } = browserTests;
		await page.setViewportSize({ width: 1000, height: 720 });
		await page.goto('/gettingStarted.html?agents&seed=false');
		const graphic = page.locator('.ash-agents-window-graphic');
		await expect(graphic).toBeVisible();
		await page.evaluate(async () => {
			for (let index = 0; index < 12; index++) {
				await window.ashWelcomeIntegration.addRecent(`project-${index}`);
			}
		});
		await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(12);
		await expect(graphic).toBeHidden();
		for (let index = 0; index < 12; index++) {
			const row = page.locator('.ash-getting-started-recent-item').first();
			await row.hover();
			await row.getByRole('button', { name: 'Remove', exact: false }).click();
		}
		await expect(graphic).toBeVisible();
		await expect(page.locator('.ash-agents-banner')).not.toHaveClass(/compact/);
	});

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
		await expect(mark.locator('.ash-icon')).toHaveCSS('color', await mark.evaluate(element => getComputedStyle(element).color));
		const cards = welcome.locator('.ash-getting-started-card');
		await expect(cards).toHaveCount(4);
		await expect(cards.locator('.ash-getting-started-card-label')).toHaveText(['Open folder', 'Clone repo', 'Connect via SSH', 'Connect GitHub']);
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
		expect(await githubIcon.evaluate(element => getComputedStyle(element, '::before').color)).toBe('rgb(255, 255, 255)');
		await github.hover();
		await expect(github).toHaveCSS('background-color', 'rgb(38, 38, 38)');
	});

	test('Welcome cards keep even spacing and shrink before wrapping in a narrow editor', async function () {
		const { page } = browserTests;

		await page.goto('/gettingStarted.html');
		const welcome = page.getByRole('region', { name: 'Welcome', exact: true });
		const cards = welcome.locator('.ash-getting-started-card');
		await expect(cards).toHaveCount(4);
		const [topLeft, topRight, bottomLeft, bottomRight] = await Promise.all([0, 1, 2, 3].map(index => cards.nth(index).boundingBox()));
		expect(topLeft && topRight && bottomLeft && bottomRight ? {
			columnGap: Math.round(topRight.x - topLeft.x - topLeft.width),
			rowGap: Math.round(bottomLeft.y - topLeft.y - topLeft.height),
			leftColumnAligned: topLeft.x === bottomLeft.x,
			rightColumnAligned: topRight.x === bottomRight.x,
		} : null).toEqual({ columnGap: 12, rowGap: 12, leftColumnAligned: true, rightColumnAligned: true });
		for (const [width, expectedCardWidth, sameRow] of [[364, 160, true], [350, 180, false]] as const) {
			await page.setViewportSize({ width, height: 720 });
			await expect.poll(() => cards.evaluateAll(elements => {
				const [first, second] = elements.map(element => element.getBoundingClientRect());
				return {
					cardWidth: Math.round(first!.width),
					secondCardOnFirstRow: first!.top === second!.top,
					labelOverflow: Math.max(0, ...elements.map(card => {
						const label = card.querySelector('.ash-getting-started-card-label')!;
						return label.getBoundingClientRect().right - card.getBoundingClientRect().right;
					})),
				};
			})).toEqual({ cardWidth: expectedCardWidth, secondCardOnFirstRow: sameRow, labelOverflow: 0 });
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
		expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([process.platform === 'win32' ? '\\synthetic\\projects\\with-a-long-parent-path\\alpha' : '/synthetic/projects/with-a-long-parent-path/alpha']);
		await alpha.getByRole('button', { name: 'Remove alpha from Recents', exact: true }).click();
		await expect(alpha).toHaveCount(0);
		await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([process.platform === 'win32' ? '\\synthetic\\projects\\with-a-long-parent-path\\alpha' : '/synthetic/projects/with-a-long-parent-path/alpha']);
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
		await expect(page.locator('.ash-getting-started-recent-item').filter({ hasText: 'beta' }).locator('.ash-getting-started-recent-content')).toBeFocused();
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
		const touchContext = await browser.newContext({ baseURL: new URL(page.url()).origin, hasTouch: true, isMobile: true, viewport: { width: 320, height: 720 } });
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
