import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';
import { AgentSessionsDataSource } from '../../browser/agentSessions/agentSessionsViewer.js';
import { isAgentSessionSection, type IAgentSessionListItem } from '../../browser/agentSessions/agentSessionsModel.js';

suite('Agent Sessions data projection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('groups and filters the owning model without changing its records', () => {
		const items: IAgentSessionListItem[] = [
			{ id: 'draft', kind: 'draft', title: 'Draft', description: '', active: false, getActions: () => [], open() { } },
			{ id: 'pin', kind: 'session', title: 'Pinned', description: 'find this', active: true, pinned: true, getActions: () => [], open() { } },
			{ id: 'group', kind: 'session', title: 'Grouped', description: '', active: false, group: { sectionId: 'team', name: 'Team' }, getActions: () => [], open() { } },
		];
		let query = '';
		const source = new AgentSessionsDataSource(() => query);
		const model = { items, state: 'ready' as const, error: undefined, onDidChange: Event.None };
		const sections = [...source.getChildren(model)];
		assert.deepEqual(sections.map(item => isAgentSessionSection(item) ? item.id : undefined), ['pinned', 'drafts', 'group:team']);
		assert.equal([...source.getChildren(sections[0]!)][0], items[1]);
		query = 'FIND';
		assert.deepEqual([...source.getChildren(model)].map(item => isAgentSessionSection(item) ? item.items : []), [[items[1]]]);
		assert.deepEqual(items.map(item => item.id), ['draft', 'pin', 'group']);
	});
});

interface Fixture {
	ready(): Promise<void>;
	focus(): void;
	setVisible(visible: boolean): void;
	restart(): Promise<void>;
	doubleClickMode(): Promise<void>;
	refreshDuringNavigation(): Promise<void>;
	rename(): Promise<void>;
	pin(): Promise<void>;
	invokeMenu(): Promise<void>;
	readonly opened: string[];
	readonly menuOpen: boolean;
	readonly menuCount: number;
	readonly newSessionCount: number;
	readonly menuAnchoredToRow: boolean;
	dispose(): void;
}
declare global { interface Window { agentSessionsFixture: Fixture; } }

suite('Agent Sessions shared Tree in a browser', () => {
	const browser = useBrowserTests();
	teardown(async () => { await browser.page.evaluate(() => window.agentSessionsFixture?.dispose()); });
	for (const locale of ['en', 'zh-CN']) {
		test(`Tree owns keyboard focus, sections, activation and search (${locale})`, async () => {
			const { page } = browser;
			await page.goto(`/agentSessions.html?locale=${locale}`);
			await page.evaluate(() => window.agentSessionsFixture.ready());
			const tree = page.getByRole('tree');
			await expect(tree).toHaveAttribute('aria-label', locale === 'en' ? 'Agent sessions' : '代理会话');
			await expect(tree.getByRole('treeitem')).toHaveCount(5);
			await expect(tree.getByRole('treeitem', { name: locale === 'en' ? 'Session 1, Synthetic session 1' : 'Session 1，Synthetic session 1', exact: true })).toBeVisible();
			await expect(tree.locator('h3')).toHaveText(locale === 'en' ? ['Drafts', 'Sessions'] : ['草稿', '会话']);
			const search = page.getByRole('searchbox');
			await expect(search).toHaveAttribute('placeholder', locale === 'en' ? 'Search sessions' : '搜索会话');
			await search.focus();
			await search.press('ArrowDown');
			await expect(tree).toBeFocused();
			await expect.poll(() => tree.getAttribute('aria-activedescendant')).not.toBeNull();
			await tree.press('ArrowDown');
			await tree.press('ArrowDown');
			await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual([]);
			await tree.press('Enter');
			await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual(['session-1']);
			await page.evaluate(() => window.agentSessionsFixture.rename());
			await expect(tree.locator('[data-item="session-1"] .ash-agent-session-title')).toHaveText('Renamed Session');
			await expect(tree).toBeFocused();
			await tree.press('ArrowLeft');
			await tree.press('ArrowLeft');
			await expect(tree.getByRole('treeitem')).toHaveCount(3);
			await search.fill('missing');
			await expect(tree.getByRole('treeitem')).toHaveCount(0);
			await expect(page.getByRole('status')).toHaveText(locale === 'en' ? 'No matching sessions' : '没有匹配的会话');
			await search.fill('Renamed');
			await expect(tree.locator('[data-item]')).toHaveCount(1);
			await expect(tree.locator('[data-item]')).toHaveAttribute('data-item', 'session-1');
			await search.fill('');
			await expect(tree.getByRole('treeitem')).toHaveCount(3);
			await tree.focus();
			await tree.press('End');
			await tree.press('ArrowRight');
			await expect(tree.getByRole('treeitem')).toHaveCount(5);
		});
	}

	test('Tree honors the shared double-click opening preference', async () => {
		const { page } = browser;
		await page.goto('/agentSessions.html');
		await page.evaluate(async () => { await window.agentSessionsFixture.ready(); await window.agentSessionsFixture.doubleClickMode(); });
		const item = page.getByRole('tree').locator('[data-item="session-1"]');
		await item.click();
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual([]);
		await item.dblclick();
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual(['session-1']);
	});

	test('catalog refresh cannot overwrite newer keyboard focus', async () => {
		const { page } = browser;
		await page.goto('/agentSessions.html');
		await page.evaluate(() => window.agentSessionsFixture.ready());
		await page.getByRole('searchbox').press('ArrowDown');
		const tree = page.getByRole('tree');
		await expect(tree).toBeFocused();
		await page.evaluate(() => window.agentSessionsFixture.refreshDuringNavigation());
		await expect(tree.locator('.ash-tree-row.focused [data-item]')).toHaveAttribute('data-item', 'session-2');
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual([]);
	});

	test('Tree resolves pointer and released keyboard context menus without opening a session', async () => {
		const { page } = browser;
		await page.goto('/agentSessions.html');
		await page.evaluate(() => window.agentSessionsFixture.ready());
		const tree = page.getByRole('tree');
		await tree.locator('[data-item="session-2"]').click({ button: 'right' });
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuCount)).toBe(1);
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual([]);
		await page.evaluate(() => window.agentSessionsFixture.invokeMenu());
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual(['rename-2']);
		await tree.focus();
		await page.keyboard.down('Shift');
		await page.keyboard.down('F10');
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuOpen)).toBe(false);
		await page.keyboard.up('F10');
		await page.keyboard.up('Shift');
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuCount)).toBe(2);
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuAnchoredToRow)).toBe(true);
		await page.evaluate(() => window.agentSessionsFixture.invokeMenu());
		await tree.locator('[data-item="session-1"]').hover();
		await tree.locator('[data-item="session-1"] button').click({ button: 'right' });
		await page.evaluate(() => window.agentSessionsFixture.invokeMenu());
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual(['rename-2', 'rename-2', 'rename-1']);
	});

	test('refocusing preserves navigation, hidden controls defer refresh and empty double clicks request a new session', async () => {
		const { page } = browser;
		await page.goto('/agentSessions.html');
		await page.evaluate(() => window.agentSessionsFixture.ready());
		const tree = page.getByRole('tree');
		await tree.focus();
		await tree.press('End');
		await page.getByRole('searchbox').focus();
		await page.evaluate(() => window.agentSessionsFixture.focus());
		await expect(tree).toBeFocused();
		await expect(tree.locator('.focused [data-item]')).toHaveAttribute('data-item', 'session-2');
		await tree.press('Shift+F10');
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuOpen)).toBe(true);
		await page.evaluate(async () => { window.agentSessionsFixture.setVisible(false); await window.agentSessionsFixture.rename(); });
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuOpen)).toBe(false);
		await expect(tree.locator('[data-item="session-1"] .ash-agent-session-title')).toHaveText('Session 1');
		await page.evaluate(async () => { window.agentSessionsFixture.setVisible(true); await window.agentSessionsFixture.ready(); });
		await expect(tree.locator('[data-item="session-1"] .ash-agent-session-title')).toHaveText('Renamed Session');
		await page.locator('.ash-agent-sessions-viewer').dblclick({ position: { x: 12, y: 360 } });
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.newSessionCount)).toBe(1);
		await tree.locator('[data-item="session-2"]').dblclick();
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.newSessionCount)).toBe(1);
	});

	test('section folding survives control recreation and searching does not overwrite it', async () => {
		const { page } = browser;
		await page.goto('/agentSessions.html');
		await page.evaluate(() => window.agentSessionsFixture.ready());
		const tree = page.getByRole('tree');
		const section = tree.getByRole('treeitem', { name: 'Sessions', exact: true });
		await section.click();
		await expect(section).toHaveAttribute('aria-expanded', 'false');
		await page.evaluate(() => window.agentSessionsFixture.restart());
		await expect(section).toHaveAttribute('aria-expanded', 'false');
		await expect(tree.locator('[data-item]')).toHaveCount(1);
		await page.getByRole('searchbox').fill('Session 1');
		await expect(tree.locator('[data-item="session-1"]')).toBeVisible();
		await page.getByRole('searchbox').fill('');
		await expect(section).toHaveAttribute('aria-expanded', 'false');
		await page.evaluate(() => window.agentSessionsFixture.restart());
		await expect(section).toHaveAttribute('aria-expanded', 'false');
	});

	test('menus use the captured item and model updates preserve the logical focus after regrouping', async () => {
		const { page } = browser;
		await page.goto('/agentSessions.html');
		await page.evaluate(() => window.agentSessionsFixture.ready());
		const tree = page.getByRole('tree');
		const item = tree.locator('[data-item="session-1"]');
		await item.click();
		await tree.press('Tab');
		await expect(item.getByRole('button')).toBeFocused();
		await item.getByRole('button').press('Enter');
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuOpen)).toBe(true);
		await page.evaluate(() => window.agentSessionsFixture.rename());
		await expect(item.locator('.ash-agent-session-title')).toHaveText('Session 1');
		await page.evaluate(() => window.agentSessionsFixture.invokeMenu());
		await expect(item.locator('.ash-agent-session-title')).toHaveText('Renamed Session');
		await expect(tree).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual(['session-1', 'rename-1']);
		await item.getByRole('button').click();
		await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.menuOpen)).toBe(true);
		await page.evaluate(() => window.agentSessionsFixture.invokeMenu());
		await page.evaluate(() => window.agentSessionsFixture.pin());
		await expect(tree.locator('h3').first()).toHaveText('Pinned');
		await expect(tree.locator('.ash-tree-row.focused [data-item]')).toHaveAttribute('data-item', 'session-1');
		await expect(tree.locator('.ash-tree-row.selected [data-item]')).toHaveAttribute('data-item', 'session-1');
	});

	for (const theme of [0, 1, 2, 3]) {
		test(`large Tree virtualizes rows, reveals keyboard targets and disposes them (theme ${theme})`, async () => {
			const { page } = browser;
			await page.goto(`/agentSessions.html?count=1000&theme=${theme}`);
			await page.evaluate(() => window.agentSessionsFixture.ready());
			const tree = page.getByRole('tree');
			await expect(tree.locator('[data-item="session-1"]')).toBeVisible();
			expect(await tree.getByRole('treeitem').count()).toBeLessThan(30);
			await tree.focus();
			await tree.press('End');
			await expect(tree.locator('[data-item="session-999"]')).toBeVisible();
			await expect(tree.locator('.ash-tree-row.focused')).toHaveAttribute('aria-level', '2');
			await expect(tree.locator('.ash-tree-row.focused')).toHaveAttribute('aria-posinset', '999');
			await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual([]);
			await tree.press(' ');
			await expect.poll(() => page.evaluate(() => window.agentSessionsFixture.opened)).toEqual(['session-999']);
			const selected = tree.locator('.ash-tree-row.selected');
			await expect(selected).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(selected).toHaveCSS('outline-style', 'solid');
			const foreground = await selected.evaluate(element => getComputedStyle(element).color);
			await expect(selected.locator('.ash-agent-session-title')).toHaveCSS('color', foreground);
			await expect(selected.getByRole('button')).toHaveCSS('color', foreground);
			await page.screenshot({ path: browser.info.outputPath(`agent-sessions-tree-${theme}.png`) });
			await page.evaluate(() => window.agentSessionsFixture.dispose());
			await expect(page.getByRole('tree')).toHaveCount(0);
		});
	}
});
