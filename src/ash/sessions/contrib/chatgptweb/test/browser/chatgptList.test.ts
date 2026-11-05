import { expect } from '@playwright/test';
import { expectVisibleFocusOutline } from '../../../../../../../test/fixtures/browser/focusOutline.js';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { mockChatGPTRequests } from './chatGPTBrowserTestUtils.js';

suite('ChatGPT catalog in the Ash chat list', () => {
	const browserTests = useBrowserTests();

	test('ChatGPT refreshes the visible history when the window comes back online', async () => {
		const { page } = browserTests;
		let changed = false;
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversations?*', route => changed
			? route.fulfill({ json: { items: [{ id: 'remote-new', title: 'New on another device' }], total: 1 } })
			: route.fallback());
		await page.route('**/service/backend-api/conversation/fixture-chat', route => changed
			? route.fulfill({ status: 404 })
			: route.fallback());
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const previous = page.getByRole('button', { name: 'Synthetic conversation', exact: true });
		await previous.click();
		await expect(page.locator('.ash-chatgpt-widget')).toContainText('Synthetic answer');

		changed = true;
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect(page.getByRole('button', { name: 'New on another device', exact: true })).toBeVisible();
		await expect(previous).toHaveCount(0);
		await expect(page.locator('.ash-chatgpt-widget')).not.toContainText('Synthetic answer');
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT history group sizing waits for its detached sidebar to mount (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			let releaseHistory!: () => void;
			const history = new Promise<void>(resolve => { releaseHistory = resolve; });
			await page.route('**/service/backend-api/conversations?*', async route => {
				await history;
				await route.fulfill({ json: { items: [{ id: 'first', title: 'First conversation' }, { id: 'second', title: 'Second conversation' }], total: 2 } });
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			const retained = await page.locator('#navigation').elementHandle();
			expect(retained).not.toBeNull();
			await retained!.evaluate(element => element.remove());
			releaseHistory();
			await expect.poll(() => retained!.evaluate(element => element.querySelectorAll('.ash-chat-navigation-item').length)).toBe(2);
			await retained!.evaluate(element => document.querySelector('.ash-sessions-window')!.prepend(element));
			const sidebar = page.locator('.ash-chat-navigation');
			const first = sidebar.getByRole('button', { name: 'First conversation', exact: true });
			const second = sidebar.getByRole('button', { name: 'Second conversation', exact: true });
			await expect(first).toBeVisible();
			await expect(second).toBeVisible();
			await expect.poll(async () => {
				const header = (await sidebar.locator('.ash-sessions-list-section-toggle').boundingBox())!;
				const row = (await second.boundingBox())!;
				return row.y + row.height - header.y - header.height;
			}).toBe(68);
			await retained!.dispose();
		});

		test(`ChatGPT group hover fills follow list inset changes (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${locale === 'en' ? 'light' : 'hcDark'}`);
			const list = page.locator('.ash-chat-navigation-list');
			const header = list.locator('.ash-sessions-list-section-toggle').first();
			await expect(header).toBeVisible();
			const expectInsets = async (inset: number): Promise<void> => {
				await expect.poll(() => header.evaluate(node => {
					const bounds = node.getBoundingClientRect();
					const list = node.closest('.ash-chat-navigation-list')!.getBoundingClientRect();
					return { left: bounds.left - list.left, right: list.right - bounds.right };
				})).toEqual({ left: inset, right: inset });
			};
			await expectInsets(8);
			await list.evaluate(node => { node.style.setProperty('--ash-sessions-sidebar-row-inset', '16px'); });
			await expectInsets(16);
			await list.evaluate(node => node.style.removeProperty('--ash-sessions-sidebar-row-inset'));
			await expectInsets(8);
			await expect(header).toHaveCSS('height', '32px');
			await expect(header).toHaveCSS('padding', '4px 8px');
			const window = page.locator('.ash-sessions-window');
			await window.evaluate(node => {
				node.style.setProperty('--ash-toolbar-actionSize', '32px');
				node.style.setProperty('--ash-sessions-sidebar-item-inset', '4px');
			});
			await expect(header).toHaveCSS('height', '40px');
			await expect(header).toHaveCSS('padding', '4px 8px');
			await window.evaluate(node => {
				node.style.removeProperty('--ash-toolbar-actionSize');
				node.style.removeProperty('--ash-sessions-sidebar-item-inset');
			});
			await header.hover();
			await expect(header).toHaveCSS('border-radius', '8px');
		});

		test(`ChatGPT history and conversation keep independent loading states (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			let releaseHistory!: () => void;
			const history = new Promise<void>(resolve => { releaseHistory = resolve; });
			await page.route('**/service/backend-api/conversations?*', async route => { await history; await route.fallback(); });
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			const navigation = page.locator('.ash-chat-navigation');
			const editor = page.locator('.ash-chatgpt-widget');
			try {
				await expect(navigation.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'true');
				await expect(editor.locator('.ash-chat-transcript')).toHaveAttribute('aria-busy', 'false');
				await expect(editor.locator('.ash-chat-welcome h2')).toBeVisible();
			} finally { releaseHistory(); }
			const conversation = navigation.getByRole('button', { name: 'Synthetic conversation', exact: true });
			await expect(conversation).toBeVisible();
			await expect(navigation.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'false');
			let releaseConversation!: () => void;
			const pending = new Promise<void>(resolve => { releaseConversation = resolve; });
			await page.route('**/service/backend-api/conversation/fixture-chat', async route => { await pending; await route.fallback(); });
			try {
				await conversation.click();
				await expect(editor.locator('.ash-chat-transcript')).toHaveAttribute('aria-busy', 'true');
				await expect(navigation.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'false');
				// The row's accessible name includes its status during the read.
				await expect(navigation.locator('[data-item="chatgpt:fixture-chat"] .ash-chat-navigation-item')).toBeEnabled();
				await expect(editor.locator('.ash-chat-welcome h2')).toBeHidden();
				await page.screenshot({ path: browserTests.info.outputPath(`chat-independent-loading-${locale}.png`) });
			} finally { releaseConversation(); }
			await expect(editor.locator('.ash-chat-transcript')).toContainText('Synthetic answer');
			await expect(editor.locator('.ash-chat-transcript')).toHaveAttribute('aria-busy', 'false');
		});

		test(`ChatGPT conversations load more on scroll and keyboard navigation (${locale})`, async function () {
			const { page } = browserTests;

			// Keep the first page outside the prefetch threshold until navigation scrolls it.
			await page.setViewportSize({ width: 1000, height: 400 });
			await mockChatGPTRequests(page);
			const offsets: number[] = [];
			let releasePage: (() => Promise<void>) | undefined;
			await page.route('**/service/backend-api/conversations?*', async route => {
				const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
				offsets.push(offset);
				const fulfill = () => route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ id: `chat-${offset + index}`, title: `Conversation ${offset + index}` })), total: 60 } });
				if (offset === 20) { releasePage = fulfill; }
				else { await fulfill(); }
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			const list = page.locator('.ash-chat-navigation-list');
			const items = list.locator('.ash-chat-navigation-item:visible');
			const viewport = page.locator('.ash-chat-navigation-scrollable > .ash-scrollbar-viewport');
			await expect(items).toHaveCount(20);
			await expect(page.getByRole('button', { name: /^(Load more|加载更多)$/ })).toHaveCount(0);
			expect(offsets).toEqual([0]);
			await items.last().focus();
			await expect(list).toHaveAttribute('aria-busy', 'true');
			await list.hover();
			await page.mouse.wheel(0, 1000);
			await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(0);
			const scrollTop = await viewport.evaluate(element => element.scrollTop);
			expect(offsets).toEqual([0, 20]);
			await releasePage!();
			await expect(items).toHaveCount(40);
			await expect(items.nth(19)).toBeFocused();
			expect(await viewport.evaluate(element => element.scrollTop)).toBe(scrollTop);
			await items.nth(19).press('End');
			await expect(items).toHaveCount(60);
			await expect(items.nth(39)).toBeFocused();
			await items.nth(39).press('End');
			await list.hover();
			await page.mouse.wheel(0, 1000);
			await expect(list).toHaveAttribute('aria-busy', 'false');
			expect(offsets).toEqual([0, 20, 40]);
		});
	}

	test('ChatGPT floating conversation actions preserve keyboard focus outlines across themes and directions', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await mockChatGPTRequests(page);
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
			await page.goto(`/chatgptNavigation.html?locale=zh-CN&theme=${theme}`);
			const row = page.locator('.ash-chat-navigation-row[data-item="chatgpt:fixture-chat"]');
			const title = row.locator('.ash-chat-navigation-item');
			await expect(title).toBeVisible();
			for (const direction of ['ltr', 'rtl']) {
				await page.locator('#navigation').evaluate((element, dir) => { element.setAttribute('dir', dir); }, direction);
				await page.keyboard.press('Tab');
				await title.focus();
				await title.hover();
				await expect(row.locator('.ash-sessions-list-actions')).toHaveCSS('opacity', '1');
				await testInfo.attach(`conversation-focused-${theme}-${direction}`, { body: await row.screenshot(), contentType: 'image/png' });
				await expectVisibleFocusOutline(title);
				await row.locator('.ash-sessions-list-actions').getByRole('button').first().click({ trial: true });
				await page.keyboard.press('Tab');
				await expect(row.locator('.ash-sessions-list-actions').getByRole('button').first()).toBeFocused();
			}
		}
	});

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`ChatGPT conversations use the shared scrollbar without a sidebar search field (${theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.setViewportSize({ width: 1000, height: 600 });
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/conversations?*', route => route.fulfill({
				json: {
					items: Array.from({ length: 40 }, (_, index) => ({ id: `chat-${index}`, title: `Conversation ${index} ${'long title '.repeat(8)}` })), total: 40,
				}
			}));
			await page.goto(`/chatgptNavigation.html?locale=zh-CN&theme=${theme}`);
			const list = page.locator('.ash-chat-navigation-list');
			await expect(list.locator('.ash-chat-navigation-item:visible')).toHaveCount(40);
			const scrollable = page.locator('.ash-chat-navigation-scrollable');
			const viewport = scrollable.locator(':scope > .ash-scrollbar-viewport');
			const scrollbar = scrollable.getByRole('scrollbar', { name: 'Vertical scrollbar' });
			await expect(scrollbar).toHaveAttribute('aria-disabled', 'false');
			await expect(list).toHaveCSS('padding-block', '12px');
			await expect(list).toHaveCSS('padding-inline', '8px');
			const sidebar = page.locator('.ash-chat-navigation');
			await expect(sidebar).toHaveCSS('padding', '0px');
			const [sidebarBounds, scrollbarBounds] = await Promise.all([sidebar.boundingBox(), scrollbar.boundingBox()]);
			expect(scrollbarBounds!.x + scrollbarBounds!.width).toBe(sidebarBounds!.x + sidebarBounds!.width);
			expect(await viewport.evaluate(element => getComputedStyle(element).scrollbarWidth)).toBe('none');
			expect(await list.evaluate(element => getComputedStyle(element).overflowY)).toBe('visible');
			await expect(page.locator('.ash-chat-navigation').getByRole('searchbox')).toHaveCount(0);
			await list.hover();
			await page.mouse.wheel(0, 300);
			await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			await expect(scrollbar).toHaveCSS('opacity', '1');
			const thumb = scrollbar.locator('.ash-scrollbar-thumb');
			expect(await thumb.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
			const geometry = await viewport.evaluate(element => ({ width: element.clientWidth, contentWidth: element.scrollWidth }));
			expect(geometry.contentWidth).toBe(geometry.width);
			await scrollbar.focus();
			await scrollbar.press('End');
			await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(0);
			await testInfo.attach(`chatgpt-sidebar-scrollbar-${theme}`, { body: await page.locator('#navigation').screenshot(), contentType: 'image/png' });
		});
	}

	test('ChatGPT conversation pagination fills the viewport after resize and pauses while collapsed', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 1000, height: 400 });
		await mockChatGPTRequests(page);
		const offsets: number[] = [];
		await page.route('**/service/backend-api/conversations?*', async route => {
			const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
			offsets.push(offset);
			const count = offset === 0 ? 2 : 20;
			await route.fulfill({ json: { items: Array.from({ length: count }, (_, index) => ({ id: `chat-${offset + index}`, title: `Conversation ${offset + index}` })), total: 42 } });
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const list = page.locator('.ash-chat-navigation-list');
		await expect(list.locator('.ash-chat-navigation-item:visible')).toHaveCount(22);
		expect(offsets).toEqual([0, 2]);
		const recent = list.getByRole('button', { name: '最近', exact: true });
		await recent.click();
		await page.setViewportSize({ width: 1000, height: 1600 });
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		await expect(recent).toHaveAttribute('aria-expanded', 'false');
		await expect(list.locator('.ash-chat-navigation-item:visible')).toHaveCount(0);
		expect(offsets).toEqual([0, 2]);
		await page.setViewportSize({ width: 1000, height: 400 });
		await recent.click();
		await page.setViewportSize({ width: 1000, height: 1600 });
		await expect(list.locator('.ash-chat-navigation-item:visible')).toHaveCount(42);
		expect(offsets).toEqual([0, 2, 22]);
	});

	test('ChatGPT conversation pagination retries a failure only after another scroll', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 1000, height: 400 });
		await mockChatGPTRequests(page);
		const offsets: number[] = [];
		await page.route('**/service/backend-api/conversations?*', async route => {
			const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
			offsets.push(offset);
			if (offset > 0 && offsets.length === 2) {
				await route.fulfill({ status: 500, json: {} });
				return;
			}
			await route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ id: `chat-${offset + index}`, title: `Conversation ${offset + index}` })), total: 40 } });
		});
		await page.goto('/chatgptNavigation.html?locale=en');
		const list = page.locator('.ash-chat-navigation-list');
		await expect(list.locator('.ash-chat-navigation-item:visible')).toHaveCount(20);
		await list.hover();
		await page.mouse.wheel(0, 2000);
		await expect(page.locator('.ash-chat-input-notification-message')).toBeVisible();
		await expect(list).toHaveAttribute('aria-busy', 'false');
		expect(offsets).toEqual([0, 20]);
		await page.mouse.wheel(0, -100);
		await page.mouse.wheel(0, 200);
		await expect(list.locator('.ash-chat-navigation-item:visible')).toHaveCount(40);
		expect(offsets).toEqual([0, 20, 20]);
	});

	test('ChatGPT migrates the previous group collapse choice into the current storage keys once', async function () {
		const { page } = browserTests;

		await mockChatGPTRequests(page);
		await page.goto('/chatgptNavigation.html?locale=en&legacyCollapsed=1');
		const heading = page.locator('[data-group="recent"] .ash-sessions-list-section-toggle');
		const recent = page.locator('[data-parent-section="recent"]');
		await expect(heading).toHaveAttribute('aria-expanded', 'false');
		const storageKeys = () => page.evaluate(() => window.ashChatGPTIntegration.storageKeys());
		const previousKeys = (keys: readonly string[]) => keys.filter(key => key.startsWith('sessions.chatgpt.navigation.collapsed.'));
		expect(previousKeys(await storageKeys())).toEqual([]);
		expect(await storageKeys()).toContain('workbench.viewContainer.sessions.chatgpt.navigation.sessions.chatgpt.navigation.g-p-unloaded.collapsed');
		expect((await storageKeys()).some(key => key.endsWith('.projects.collapsed'))).toBe(false);
		await expect(recent.getByRole('button', { name: 'Synthetic conversation', exact: true })).toBeHidden();
		await heading.click();
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		await heading.press('ArrowLeft');
		await expect(heading).toHaveAttribute('aria-expanded', 'false');
		await heading.press('ArrowRight');
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		expect(previousKeys(await storageKeys())).toEqual([]);
		await page.goto('/chatgptNavigation.html?locale=en&workspace=another-workspace');
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		expect(previousKeys(await storageKeys())).toEqual([]);
		await expect(recent.getByRole('button', { name: 'Synthetic conversation', exact: true })).toBeVisible();
		// A stale legacy value must never override the newer stored choice.
		await page.goto('/chatgptNavigation.html?locale=en&workspace=third-workspace&legacyCollapsed=1');
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		expect(previousKeys(await storageKeys())).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`Projects More reuses Edit details and saves through the project adapter (${locale})`, async function () {
			const { page } = browserTests;
			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: { items: [{ gizmo: { id: 'g-p-research', display: { name: 'Research' } } }], cursor: null },
			}));
			let reads = 0;
			await page.route('**/service/backend-api/gizmos/g-p-research', route => route.fulfill({
				json: { gizmo: { id: 'g-p-research', instructions: 'Saved notes', display: { name: 'Research', emoji: ++reads === 1 ? '🔬' : '🧪', theme: 'blue' } } },
			}));
			await page.route('**/service/backend-api/projects/g-p-research', route => route.fulfill({ status: 204 }));
			await page.goto(`/chatgptNavigation.html?projects&locale=${locale}`);
			const projects = page.locator('.ash-projects');
			const card = projects.getByRole('button', { name: 'Research', exact: true });
			await card.hover();
			await card.locator('..').locator('.ash-toolbar-more-actions button').click();
			await page.getByRole('menuitem', { name: zh ? '编辑详情' : 'Edit details', exact: true }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog.getByRole('textbox').nth(1)).toHaveValue('Saved notes');
			await dialog.getByRole('textbox').first().fill('Updated research');
			const [write] = await Promise.all([
				page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/projects/g-p-research')),
				dialog.getByRole('button', { name: zh ? '保存更改' : 'Save changes', exact: true }).click(),
			]);
			expect(write.postDataJSON()).toEqual({ name: 'Updated research', instructions: 'Saved notes', emoji: '🧪', theme: 'blue' });
			await expect(dialog).toHaveCount(0);
			const updated = projects.getByRole('button', { name: 'Updated research', exact: true });
			await expect(updated).toBeVisible();
			await updated.hover();
			await updated.locator('..').locator('.ash-toolbar-more-actions button').click();
			await page.getByRole('menuitem', { name: zh ? '归档' : 'Archive', exact: true }).click();
			await expect(updated).toHaveCount(0);
			const archived = projects.getByRole('button', { name: zh ? '已归档' : 'Archived', exact: true });
			await archived.click();
			await projects.getByRole('button', { name: zh ? '取消归档 Updated research' : 'Unarchive Updated research', exact: true }).click();
			await expect(projects.getByRole('status').filter({ hasText: zh ? '没有已归档的项目。' : 'No archived projects.' })).toBeVisible();
			await archived.click();
			await expect(updated).toBeVisible();
		});

		test(`Projects opens conversation groups and pages their history on demand (${locale})`, async function () {
			const { page } = browserTests;
			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: {
					items: [
						{ gizmo: { gizmo: { id: 'g-p-one', display: { name: 'Research' } } } },
						{ gizmo: { gizmo: { id: 'g-p-two', display: { name: 'Writing' } } } },
					], cursor: null,
				},
			}));
			const pinned = { id: 'pinned', title: 'Pinned project chat', gizmo_id: 'g-p-one' };
			await page.route('**/service/backend-api/pins?*', route => route.fulfill({ json: [{ item: pinned }] }));
			const cursors: (string | null)[] = [];
			let emptyReads = 0;
			await page.route('**/gizmos/g-p-two/conversations?*', route => {
				emptyReads++;
				return route.fulfill({ json: { items: [], cursor: null } });
			});
			await page.route('**/gizmos/g-p-one/conversations?*', route => {
				const cursor = new URL(route.request().url()).searchParams.get('cursor');
				cursors.push(cursor);
				if (!cursor) return route.fulfill({ json: { items: [pinned, { id: 'one', title: 'First research chat' }], cursor: 'page+two' } });
				if (cursors.length === 2) return route.fulfill({ status: 503 });
				return route.fulfill({ json: { items: [{ id: 'one', title: 'First research chat' }, { id: 'two', title: 'Older research chat' }], cursor: null } });
			});
			await page.goto(`/chatgptNavigation.html?projects&locale=${locale}&theme=${zh ? 'hcDark' : 'light'}`);
			const sidebar = page.locator('.ash-chat-navigation-list');
			const projects = page.locator('.ash-projects');
			const research = projects.getByRole('button', { name: 'Research', exact: true });
			const writing = projects.getByRole('button', { name: 'Writing', exact: true });
			await expect(research).toBeVisible();
			await expect(writing).toBeVisible();
			await expect(sidebar.locator('.ash-chat-navigation-group')).toHaveCount(3);
			await expect(sidebar.locator('[data-parent-section="pinned"] .ash-chat-navigation-item')).toHaveText(pinned.title);
			await expect(sidebar.locator('[data-parent-section="recent"] .ash-chat-navigation-item')).toHaveText('Synthetic conversation');
			expect(cursors).toEqual([]);
			const toggle = sidebar.getByRole('button', { name: 'Research', exact: true });
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			const projectRow = sidebar.locator('[data-item="project:g-p-one"]');
			const projectIcon = projectRow.locator('[data-ash-icon-id="projects"]');
			const chevron = projectRow.locator('.ash-chat-navigation-project-chevron');
			await page.mouse.move(0, 0);
			await expect(projectIcon).toBeVisible();
			await expect(chevron).toBeHidden();
			await page.keyboard.press('Tab');
			await toggle.focus();
			await expect(chevron).toBeVisible();
			await toggle.blur();
			const restingBounds = await toggle.boundingBox();
			await toggle.hover();
			await expect(chevron).toBeVisible();
			await expect(projectIcon).toBeHidden();
			expect(await toggle.boundingBox()).toEqual(restingBounds);
			await toggle.getByText('Research', { exact: true }).click();
			await expect(research).toBeVisible();
			const children = sidebar.locator('[data-parent-project="project:g-p-one"] > .ash-chat-navigation-item');
			await expect(children).toHaveText([pinned.title, 'First research chat', zh ? '加载更多项目聊天' : 'Load more project chats']);
			expect(cursors).toEqual([null]);
			const recentChat = sidebar.getByRole('button', { name: 'Synthetic conversation', exact: true });
			const projectChat = children.first();
			const recentBounds = (await recentChat.boundingBox())!;
			const projectBounds = (await projectChat.boundingBox())!;
			expect(projectBounds.x).toBe(recentBounds.x);
			expect(projectBounds.width).toBe(recentBounds.width);
			await recentChat.hover();
			const hoverBackground = await recentChat.evaluate(row => getComputedStyle(row).backgroundColor);
			await projectChat.hover();
			await expect(projectChat).toHaveCSS('background-color', hoverBackground);
			await toggle.hover();
			const arrow = (await chevron.boundingBox())!;
			await page.mouse.click(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2);
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			await expect(children).toHaveCount(0);
			await research.press('Enter');
			const rows = projects.getByRole('list', { name: zh ? '项目对话' : 'Project conversations' }).getByRole('button');
			await expect(rows).toHaveText([pinned.title, 'First research chat']);
			await expect(projects.getByRole('heading', { name: 'Research', exact: true })).toBeFocused();
			expect(cursors).toEqual([null]);
			expect(emptyReads).toBe(0);
			await projects.getByRole('button', { name: zh ? '加载更多项目聊天' : 'Load more project chats', exact: true }).click();
			await projects.getByRole('button', { name: zh ? '无法加载项目聊天，点击重试' : 'Could not load project chats. Retry', exact: true }).press('Enter');
			await expect(rows).toHaveText([pinned.title, 'First research chat', 'Older research chat']);
			expect(cursors).toEqual([null, 'page+two', 'page+two']);
			await page.locator('.ash-projects-breadcrumb').getByRole('button', { name: zh ? '项目' : 'Projects', exact: true }).click();
			await expect(research).toBeFocused();
			await writing.click();
			await expect(projects.getByRole('status').filter({ hasText: zh ? '此项目中没有聊天' : 'No chats in this project' })).toBeVisible();
			expect(cursors).toHaveLength(3);
			expect(emptyReads).toBe(1);
		});

		test(`ChatGPT row actions manage the addressed chat and project submenu (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const zh = locale === 'zh-CN';
			const labels = zh
				? { more: '更多操作', pin: '置顶聊天', unpin: '取消置顶聊天', rename: '重命名', share: '分享', archive: '归档', delete: '删除', move: '移至项目', cancel: '取消' }
				: { more: 'More actions', pin: 'Pin chat', unpin: 'Unpin chat', rename: 'Rename', share: 'Share', archive: 'Archive', delete: 'Delete', move: 'Move to project', cancel: 'Cancel' };
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/conversations?*', route => route.fulfill({
				json: {
					items: [
						{ id: 'other', title: 'Other chat' }, { id: 'fixture-chat', title: 'Synthetic conversation' }, { id: 'third', title: 'Third chat' },
					], total: 3
				}
			}));
			const writes: { method: string; path: string; body?: Record<string, unknown>; }[] = [];
			await page.route('**/service/backend-api/**', async route => {
				const request = route.request();
				const url = new URL(request.url());
				if (url.pathname.endsWith('/gizmos/snorlax/sidebar')) {
					const next = url.searchParams.has('cursor');
					await route.fulfill({ json: { items: [{ gizmo: { id: next ? 'g-p-two' : 'g-p-one', display: { name: next ? 'Project Two' : 'Project One' } } }], cursor: next ? null : 'next' } });
				} else if (request.method() !== 'GET') {
					writes.push({ method: request.method(), path: url.pathname, ...(request.postData() ? { body: request.postDataJSON() } : {}) });
					await route.fulfill({ json: url.pathname.endsWith('/share/v2/create') ? { share_url: 'https://chatgpt.com/share/fixture-link' } : { success: true } });
				} else { await route.fallback(); }
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${zh ? 'hcDark' : 'light'}`);
			const row = page.locator('.ash-chat-navigation-row[data-item="chatgpt:fixture-chat"]');
			const title = row.locator('.ash-chat-navigation-item');
			const toolbar = row.locator('.ash-sessions-list-actions');
			const icon = row.locator('.ash-session-leading-icon').getByRole('button');
			const pin = row.getByRole('button', { name: labels.pin, exact: true });
			const more = row.getByRole('button', { name: labels.more, exact: true });
			const openMore = async () => { await row.hover(); await more.click(); };
			await expect(title).toBeVisible();
			const window = page.locator('.ash-sessions-window');
			await window.evaluate(element => (element as HTMLElement).style.setProperty('--ash-toolbar-actionSize', '32px'));
			await expect(icon).toHaveCSS('width', '32px');
			await expect(more).toHaveCSS('width', '32px');
			await expect(row).toHaveCSS('height', '36px');
			await window.evaluate(element => (element as HTMLElement).style.removeProperty('--ash-toolbar-actionSize'));
			for (const forcedColors of ['none', 'active'] as const) {
				await page.emulateMedia({ forcedColors });
				expect((await row.boundingBox())!.height).toBe(32);
				for (const action of [more, pin]) {
					await expect(action).toHaveCSS('width', '28px');
					await expect(action).toHaveCSS('height', '28px');
					const bounds = (await action.boundingBox())!;
					const rowBounds = (await row.boundingBox())!;
					expect(bounds).toMatchObject({ width: 28, height: 28 });
					expect(bounds.y + bounds.height / 2).toBe(rowBounds.y + rowBounds.height / 2);
				}
			}
			await page.emulateMedia({ forcedColors: 'none' });
			await page.locator('#editor').hover();
			await expect(toolbar).toHaveCSS('opacity', '0');
			await row.hover();
			await expect(toolbar).toHaveCSS('opacity', '1');
			await icon.focus();
			await page.keyboard.press('Tab');
			await expect(title).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(pin).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(more).toBeFocused();
			await page.keyboard.press('ArrowLeft');
			await expect(pin).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(row.getByRole('button', { name: labels.unpin, exact: true })).toHaveAttribute('aria-pressed', 'true');
			await expect(page.locator('.ash-chat-navigation-item').first()).toHaveText('Synthetic conversation');
			await expect(page.locator('.ash-chat-item')).toHaveCount(0);
			await openMore();
			const menu = page.getByRole('menu');
			const rename = menu.getByRole('menuitem', { name: labels.rename, exact: true });
			await expect(menu).toBeFocused();
			await expect(menu).toHaveCSS('outline-style', 'none');
			await page.keyboard.press('ArrowDown');
			await expect(rename).toBeFocused();
			const menuItems = menu.getByRole('menuitem');
			await expect(menu.getByRole('separator').or(menuItems)).toHaveText([labels.rename, '', labels.share, labels.move, '', labels.archive, labels.delete]);
			await expect(menuItems.locator('.ash-menu-leading-slot .ash-icon-label-icon > .ash-icon')).toHaveCount(5);
			const deleteItem = menuItems.last();
			const errorColor = await deleteItem.evaluate(element => {
				const sample = element.appendChild(document.createElement('span'));
				sample.style.color = 'var(--ash-error-foreground)';
				const color = getComputedStyle(sample).color;
				sample.remove();
				return color;
			});
			await expect(deleteItem).toHaveCSS('color', errorColor);
			await page.keyboard.press('Escape');
			await expect(more).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(rename).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(more).toBeFocused();
			await openMore();
			await page.getByRole('menuitem', { name: labels.move, exact: true }).focus();
			await page.keyboard.press('ArrowRight');
			await expect(page.getByRole('menuitemcheckbox', { name: 'Project One', exact: true })).toBeVisible();
			await testInfo.attach('conversation-project-submenu', { body: await page.screenshot(), contentType: 'image/png' });
			await page.getByRole('menuitemcheckbox', { name: 'Project Two', exact: true }).click();
			await expect.poll(() => writes.some(write => write.body?.gizmo_id === 'g-p-two')).toBe(true);
			await openMore();
			await page.getByRole('menuitem', { name: zh ? '从项目中移除' : 'Remove from project', exact: true }).click();
			await expect.poll(() => writes.some(write => write.body?.gizmo_id === null)).toBe(true);
			const recent = page.locator('.ash-chat-navigation-list [data-section="recent"] > h3 button');
			await row.dragTo(recent);
			await expect.poll(() => writes.some(write => write.body?.is_starred === false)).toBe(true);
			await expect(row).toHaveAttribute('data-parent-section', 'recent');
			await openMore();
			await page.getByRole('menuitem', { name: labels.rename, exact: true }).click();
			const name = page.getByRole('textbox', { name: labels.rename, exact: true });
			await name.fill('Renamed conversation');
			await name.press('Enter');
			await expect(title).toHaveText('Renamed conversation');
			await openMore();
			await page.getByRole('menuitem', { name: labels.share, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();
			await dialog.getByRole('button', { name: labels.share, exact: true }).click();
			await expect(page.locator('body')).toHaveAttribute('data-copied-link', 'https://chatgpt.com/share/fixture-link');
			await openMore();
			await page.getByRole('menuitem', { name: labels.delete, exact: true }).click();
			await dialog.getByRole('button', { name: labels.cancel, exact: true }).click();
			expect(writes.some(write => write.method === 'DELETE')).toBe(false);
			await expect(title).toBeVisible();
			await openMore();
			await page.getByRole('menuitem', { name: labels.archive, exact: true }).click();
			await expect(row).toHaveCount(0);
			const third = page.locator('.ash-chat-navigation-row[data-item="chatgpt:third"]');
			await third.hover();
			await third.getByRole('button', { name: labels.more, exact: true }).click();
			await page.getByRole('menuitem', { name: labels.delete, exact: true }).click();
			await dialog.getByRole('button', { name: labels.delete, exact: true }).click();
			await expect(third).toHaveCount(0);
			await expect(page.locator('.ash-chat-navigation-row .ash-chat-navigation-item')).toHaveText(['Other chat']);
			expect(writes.map(write => [write.method, write.path])).toEqual([
				['PATCH', '/service/backend-api/conversation/fixture-chat'], ['PATCH', '/service/backend-api/conversation/fixture-chat'],
				['PATCH', '/service/backend-api/conversation/fixture-chat'], ['PATCH', '/service/backend-api/conversation/fixture-chat'],
				['POST', '/service/backend-api/conversation/id/fixture-chat/rename'], ['POST', '/service/backend-api/share/v2/create'],
				['PATCH', '/service/backend-api/conversation/fixture-chat'], ['DELETE', '/service/backend-api/conversation/id/third'],
			]);
		});
	}
});
