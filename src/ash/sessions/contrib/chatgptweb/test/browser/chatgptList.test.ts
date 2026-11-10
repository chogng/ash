import { expect, type Page } from '@playwright/test';
import { EOL } from 'node:os';
import { expectVisibleFocusOutline } from '../../../../../../../test/fixtures/browser/focusOutline.js';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { mockChatGPTRequests } from './chatGPTBrowserTestUtils.js';
import { Editor } from '../../../../../../../test/automation/editor.js';

const historyNotices = (page: Page) => page.evaluate(() => window.ashChatGPTIntegration.notifications().map(item => item.message));
const rateLimitNotice = 'ChatGPT 暂时限制了历史请求，请稍后重试。';

suite('ChatGPT catalog in the Ash chat list', () => {
	const browserTests = useBrowserTests();

	test('local project archive includes native and older ChatGPT members and retries partial failure', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		const writes: string[] = [];
		const pages: string[] = [];
		const archived = new Set<string>();
		let failOlder = true;
		await page.route('**/service/backend-api/conversations?*', route => {
			const query = new URL(route.request().url()).searchParams;
			const offset = Number(query.get('offset'));
			const visibility = query.get('is_archived');
			pages.push(`${visibility}:${offset}`);
			const available = ['first', 'unrelated', 'older'];
			const ids = visibility === null ? ['first', 'unrelated'].filter(id => !archived.has(id))
				: available.filter(id => archived.has(id) === (visibility === 'true'));
			const items = ids.slice(offset, offset + 1).map(id => ({ id, title: id, is_archived: archived.has(id) }));
			return route.fulfill({ json: { items, total: ids.length } });
		});
		await page.route('**/service/backend-api/conversation/*', route => {
			if (route.request().method() !== 'PATCH') return route.fallback();
			const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
			expect(route.request().postDataJSON()).toEqual({ is_archived: true });
			writes.push(id);
			if (id === 'older' && failOlder) {
				failOlder = false;
				return route.fulfill({ status: 503 });
			}
			archived.add(id);
			return route.fulfill({ status: 204 });
		});
		await page.goto('/chatgptNavigation.html?mixedProjectArchive&locale=zh-CN');
		const sidebar = page.locator('.ash-chat-navigation-list');
		const project = sidebar.getByRole('button', { name: 'Local Ash project', exact: true });
		await expect(project).toBeVisible();
		expect(pages).toEqual([]);
		const archive = async () => {
			await project.press('Shift+F10');
			await page.getByRole('menuitem', { name: '归档', exact: true }).click();
			await page.getByRole('dialog').getByRole('button', { name: '归档', exact: true }).click();
		};
		await archive();
		await expect.poll(() => historyNotices(page)).toContain('未能完成“Local Ash project”的归档。请重试以继续。');
		await expect(project).toBeVisible();
		await expect(page.locator('body')).toHaveAttribute('data-archived-ash', 'fixture-chat');
		expect(writes).toEqual(['first', 'older']);

		await archive();
		await expect(project).toHaveCount(0);
		expect(writes).toEqual(['first', 'older', 'older']);
		expect([...archived]).toEqual(['first', 'older']);
		expect(pages).toEqual(['false:0', 'false:1', 'false:2', 'false:0', 'false:1', 'true:0']);
	});

	test('project archive visits every page and retries the remaining ChatGPT conversations', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
			json: { items: [{ gizmo: { id: 'g-p-batch', display: { name: 'Batch project' } } }], cursor: null },
		}));
		const requests: string[] = [];
		const archived = new Set(['already-archived']);
		let failSecond = true;
		await page.route('**/service/backend-api/gizmos/g-p-batch/conversations?*', route => {
			const next = new URL(route.request().url()).searchParams.has('cursor');
			requests.push(next ? 'next page' : 'first page');
			const ids = next ? ['second'] : ['first', 'already-archived'];
			return route.fulfill({
				json: { items: ids.map(id => ({ id, title: id, is_archived: archived.has(id) })), cursor: next ? null : 'next' },
			});
		});
		await page.route('**/service/backend-api/conversation/*', route => {
			if (route.request().method() !== 'PATCH') return route.fallback();
			const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
			requests.push(id);
			expect(route.request().postDataJSON()).toEqual({ is_archived: true });
			if (id === 'second' && failSecond) {
				failSecond = false;
				return route.fulfill({ status: 503 });
			}
			archived.add(id);
			return route.fulfill({ status: 204 });
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const project = page.locator('.ash-chat-navigation-list').getByRole('button', { name: 'Batch project', exact: true });
		const confirm = page.getByRole('dialog');
		const openArchive = async () => {
			await project.press('Shift+F10');
			await page.getByRole('menuitem', { name: '归档', exact: true }).click();
		};
		await openArchive();
		await expect(confirm).toContainText('这会归档项目中的所有活跃对话');
		await confirm.getByRole('button', { name: '取消', exact: true }).click();
		expect(requests).toEqual([]);
		await openArchive();
		await confirm.getByRole('button', { name: '归档', exact: true }).click();
		await expect.poll(() => historyNotices(page)).toContain('未能完成“Batch project”的归档。请重试以继续。');
		await expect(project).toBeVisible();
		expect(requests).toEqual(['first page', 'next page', 'first', 'second']);

		await openArchive();
		await confirm.getByRole('button', { name: '归档', exact: true }).click();
		await expect(project).toHaveCount(0);
		expect(requests).toEqual(['first page', 'next page', 'first', 'second', 'first page', 'next page', 'second']);
	});

	test('sidebar project menu edits details, archives, and confirms deletion through the ChatGPT catalog', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		const writes: unknown[] = [];
		const deleted: string[] = [];
		await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
			json: {
				items: ['Research', 'Writing'].map((name, index) => ({
					gizmo: { id: `g-p-sidebar-${index}`, display: { name } },
				})), cursor: null
			},
		}));
		await page.route('**/service/backend-api/gizmos/g-p-sidebar-0', route => route.fulfill({
			json: { gizmo: { id: 'g-p-sidebar-0', instructions: 'Saved notes', display: { name: 'Research', theme: 'blue' } } },
		}));
		await page.route('**/service/backend-api/projects/g-p-sidebar-0', route => {
			writes.push(route.request().postDataJSON());
			return route.fulfill({ status: 204 });
		});
		await page.route('**/service/backend-api/gizmos/g-p-sidebar-1', route => {
			deleted.push(route.request().method());
			return route.fulfill({ status: 204 });
		});
		await page.goto('/chatgptNavigation.html?projects&locale=zh-CN');
		const sidebar = page.locator('.ash-chat-navigation-list');
		const project = (name: string) => sidebar.getByRole('button', { name, exact: true });
		const action = (name: string) => page.getByRole('menuitem', { name, exact: true });
		const more = sidebar.locator('[data-project-id="g-p-sidebar-0"]').getByRole('button', { name: '更多项目操作', exact: true });
		const openEdit = async () => {
			await project('Research').press('Shift+F10');
			await expect(action('重命名')).toHaveCount(0);
			await action('编辑详情').press('Enter');
		};
		const editor = page.getByRole('dialog', { name: '编辑详情', exact: true });
		const input = editor.getByRole('textbox', { name: '你正在做什么？', exact: true });
		await openEdit();
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('Research');
		await page.keyboard.press('Escape');
		await expect(editor).toHaveCount(0);
		await expect(project('Research')).toBeFocused();
		expect(writes).toEqual([]);

		await project('Research').hover();
		await more.click();
		await expect(more).toHaveAttribute('aria-expanded', 'true');
		await action('编辑详情').click();
		await expect(editor).toBeVisible();
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		await editor.getByRole('button', { name: '取消', exact: true }).click();
		await expect(editor).toHaveCount(0);

		await project('Writing').click({ button: 'right' });
		const deleteAction = action('删除');
		const dangerColor = 'rgb(244, 135, 113)';
		await expect(deleteAction.getByText('删除', { exact: true })).toHaveCSS('color', dangerColor);
		await expect(deleteAction.locator('[data-ash-icon-id="trash"]')).toHaveCSS('color', dangerColor);
		await expect(action('归档')).not.toHaveCSS('color', dangerColor);
		await page.keyboard.press('End');
		await expect(deleteAction).toBeFocused();
		await expect(deleteAction).toHaveCSS('color', dangerColor);
		await page.keyboard.press('Escape');
		expect(writes).toEqual([]);

		await openEdit();
		const save = editor.getByRole('button', { name: '保存更改', exact: true });
		await input.fill('   ');
		await expect(save).toBeDisabled();
		await input.fill('  Updated research  ');
		await save.click();
		await expect(project('Updated research')).toBeVisible();
		expect(writes).toEqual([{ name: 'Updated research', instructions: 'Saved notes', emoji: null, theme: 'blue' }]);
		await project('Updated research').press('Shift+F10');
		await action('归档').click();
		await page.getByRole('dialog').getByRole('button', { name: '归档', exact: true }).click();
		await expect(project('Updated research')).toHaveCount(0);
		const projects = page.locator('.ash-projects');
		await page.evaluate(() => window.ashChatGPTIntegration.toggleArchivedProjects());
		await projects.getByRole('button', { name: '取消归档 Updated research' }).click();
		await expect(project('Updated research')).toBeVisible();

		const dialog = page.getByRole('dialog');
		await project('Writing').click({ button: 'right' });
		await action('删除').click();
		await expect(dialog).toContainText('这会永久删除项目、其中的对话和说明');
		await dialog.getByRole('button', { name: '取消', exact: true }).click();
		await expect(project('Writing')).toBeVisible();
		expect(deleted).toEqual([]);
		await project('Writing').click({ button: 'right' });
		await action('删除').click();
		await dialog.getByRole('button', { name: '删除', exact: true }).click();
		await expect(project('Writing')).toHaveCount(0);
		expect(deleted).toEqual(['DELETE']);
	});

	test('Ash project appearance works without ChatGPT project details from the sidebar and Projects page', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
			json: {
				items: ['Research', 'Writing'].map((name, index) => ({
					gizmo: { id: `g-p-appearance-${index}`, display: { name } },
				})), cursor: null
			},
		}));
		let projectRequests = 0;
		await page.route(/\/service\/backend-api\/(gizmos|projects)\/g-p-appearance-0$/, route => {
			projectRequests++;
			return route.fulfill({ status: 401 });
		});
		await page.goto('/chatgptNavigation.html?projects&locale=zh-CN');
		const sidebar = page.locator('.ash-chat-navigation-list');
		const research = sidebar.getByRole('button', { name: 'Research', exact: true });
		const writing = sidebar.getByRole('button', { name: 'Writing', exact: true });
		const iconSlot = research.locator('.ash-sessions-list-project-icon');
		const edit = page.getByRole('menuitem', { name: '编辑详情', exact: true });
		const editor = page.getByRole('dialog', { name: '编辑详情', exact: true });
		const appearance = editor.getByRole('button', { name: '更改项目外观' });
		const picker = page.getByRole('dialog', { name: '更改项目外观', exact: true });
		const search = picker.getByRole('combobox', { name: '搜索图标' });
		const red = picker.getByRole('button', { name: '红色', exact: true });
		const saveAppearance = async () => {
			await picker.getByRole('button', { name: '完成', exact: true }).click();
			await editor.getByRole('button', { name: '保存更改', exact: true }).click();
			await expect(editor).toHaveCount(0);
		};

		await research.click({ button: 'right' });
		await expect(edit.locator('[data-ash-icon-id="gear"]')).toBeVisible();
		await expect(page.getByRole('menuitem', { name: '更改图标…', exact: true })).toHaveCount(0);
		await expect(page.getByRole('menuitem', { name: '更改颜色…', exact: true })).toHaveCount(0);
		await edit.click();
		const name = editor.getByRole('textbox', { name: '项目名称' });
		await expect(name).toHaveValue('Research');
		await expect(name).toHaveAttribute('readonly', '');
		await expect(appearance).toBeFocused();
		await appearance.press('Enter');
		await search.fill('chat');
		await picker.getByRole('option', { name: 'chat', exact: true }).click();
		await red.click();
		await picker.getByRole('button', { name: '完成', exact: true }).click();
		const close = editor.getByRole('button', { name: '关闭对话框', exact: true });
		const colors = await close.evaluate(element => {
			const probe = element.appendChild(element.ownerDocument.createElement('span'));
			try {
				probe.style.backgroundColor = 'var(--ash-button-hoverBackground)';
				const hover = getComputedStyle(probe).backgroundColor;
				probe.style.backgroundColor = 'var(--ash-button-activeBackground)';
				return { hover, active: getComputedStyle(probe).backgroundColor };
			} finally {
				probe.remove();
			}
		});
		await close.hover();
		await expect(close).toHaveCSS('background-color', colors.hover);
		await page.mouse.down();
		await expect(close).toHaveCSS('background-color', colors.active);
		await page.mouse.up();
		const keepEditing = page.getByRole('button', { name: '继续编辑', exact: true });
		await expect(keepEditing).toBeFocused();
		await keepEditing.press('Enter');
		await expect(close).toBeFocused();
		await appearance.press('Enter');
		await expect(red).toHaveAttribute('aria-pressed', 'true');
		await saveAppearance();
		await expect(research).toBeFocused();
		await expect(iconSlot.locator('[data-ash-icon-id="chat"]')).toHaveCount(1);
		await expect(iconSlot).toHaveAttribute('style', /color: var\(--ash-terminal-ansiRed\)/);
		await expect(writing.locator('[data-ash-icon-id="projects"]')).toHaveCount(1);
		await page.reload();
		await expect(iconSlot.locator('[data-ash-icon-id="chat"]')).toHaveCount(1);
		await expect(iconSlot).toHaveAttribute('style', /color: var\(--ash-terminal-ansiRed\)/);

		const card = page.locator('.ash-projects').getByRole('button', { name: 'Research', exact: true });
		await expect(card.locator('[data-ash-icon-id="chat"]')).toBeVisible();
		await card.hover();
		await card.locator('..').locator('.ash-toolbar-more-actions button').click();
		await edit.press('Enter');
		await appearance.press('Enter');
		await expect(picker.getByRole('option', { name: 'chat', exact: true })).toHaveAttribute('aria-selected', 'true');
		await expect(red).toHaveAttribute('aria-pressed', 'true');
		await picker.getByRole('option', { name: 'projects', exact: true }).click();
		await saveAppearance();
		await expect(iconSlot.locator('[data-ash-icon-id="projects"]')).toHaveCount(1);
		await expect(card.locator('[data-ash-icon-id="projects"]')).toBeVisible();
		await expect(iconSlot).toHaveAttribute('style', /color: var\(--ash-terminal-ansiRed\)/);
		expect(projectRequests).toBeGreaterThan(0);
	});

	test('the Chat sidebar shows Ash and ChatGPT rows and excludes Code', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		await page.goto('/chatgptNavigation.html?locale=en&mixedCatalog');
		const sidebar = page.locator('[data-view-container-id="sessions.chatgpt.navigation"]').getByRole('tree');
		const ash = sidebar.getByRole('button', { name: 'Local Ash conversation', exact: true });
		const chatGPT = sidebar.getByRole('button', { name: 'Synthetic conversation', exact: true });
		await expect(ash).toBeVisible();
		await expect(chatGPT).toBeVisible();
		const code = sidebar.getByRole('button', { name: /^Local Code conversation/ });
		await expect(code).toHaveCount(0);

		await ash.press('Enter');
		await expect(page.locator('body')).toHaveAttribute('data-opened-ash', 'fixture-chat/fixture-thread');
		await expect(ash).toHaveAttribute('aria-current', 'page');
		await chatGPT.press('Enter');
		await expect(page.locator('.ash-chatgpt-widget')).toContainText('Synthetic answer');
		await expect(chatGPT).toHaveAttribute('aria-current', 'page');
	});

	test('ChatGPT refreshes visible history after reconnect and honors the list cooldown', async () => {
		const { page } = browserTests;
		let rateLimited = false;
		let changed = false;
		let requests = 0;
		await page.clock.install();
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversations?*', route => {
			requests++;
			if (rateLimited) return route.fulfill({ status: 429 });
			if (changed) return route.fulfill({ json: { items: [{ id: 'remote-new', title: 'New on another device' }], total: 1 } });
			return route.fallback();
		});
		await page.route('**/service/backend-api/conversation/fixture-chat', route => changed
			? route.fulfill({ status: 404 })
			: route.fallback());
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const previous = page.getByRole('button', { name: 'Synthetic conversation', exact: true });
		await previous.click();
		const chat = page.locator('.ash-chatgpt-widget');
		await expect(chat).toContainText('Synthetic answer');
		await page.clock.fastForward(6 * 60_000);
		await page.clock.runFor(1_000);
		expect(requests).toBe(1);
		rateLimited = true;
		await page.evaluate(() => window.dispatchEvent(new Event('offline')));
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => historyNotices(page)).toEqual([rateLimitNotice]);
		await page.evaluate(() => window.ashChatGPTIntegration.retryHistory());
		await expect.poll(() => historyNotices(page)).toEqual([rateLimitNotice]);
		await expect(previous).toBeVisible();
		await expect(chat.locator('.ash-chat-input-notification-message')).toBeHidden();
		await expect(chat).toContainText('Synthetic answer');
		expect(requests).toBe(2);

		rateLimited = false;
		changed = true;
		await page.clock.fastForward(65_000);
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect(page.getByRole('button', { name: 'New on another device', exact: true })).toBeVisible();
		await expect(previous).toHaveCount(0);
		await expect.poll(() => historyNotices(page)).toEqual([]);
		expect(requests).toBe(3);
	});

	test('ChatGPT keeps cached history offline and coalesces flapping reconnects', async () => {
		const { page } = browserTests;
		let listReads = 0;
		await page.clock.install();
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversations?*', route => {
			listReads++;
			return route.fallback();
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const conversation = page.getByRole('button', { name: 'Synthetic conversation', exact: true });
		const chat = page.locator('.ash-chatgpt-widget');
		await conversation.click();
		await expect(chat).toContainText('Synthetic answer');
		const offline = () => page.evaluate(() => window.dispatchEvent(new Event('offline')));
		const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
		await offline();
		await expect.poll(() => historyNotices(page)).toEqual(['ChatGPT 当前离线，仍可查看已加载的会话。']);
		await conversation.click();
		await expect(chat).toContainText('Synthetic answer');
		await online();
		await page.clock.runFor(300);
		await offline();
		await online();
		await online();
		await page.clock.runFor(300);
		expect(listReads).toBe(1);
		await page.clock.runFor(1_100);
		await expect.poll(() => listReads).toBe(2);
		await expect.poll(() => historyNotices(page)).toEqual([]);
		await expect(chat).toContainText('Synthetic answer');
	});

	test('ChatGPT keeps the loaded transcript during the conversation read cooldown', async () => {
		const { page } = browserTests;
		let rateLimited = false;
		let detailReads = 0;
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversation/fixture-chat', route => {
			detailReads++;
			return rateLimited ? route.fulfill({ status: 429, headers: { 'Retry-After': '26' } }) : route.fallback();
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const previous = page.getByRole('button', { name: 'Synthetic conversation', exact: true });
		await previous.click();
		const chat = page.locator('.ash-chatgpt-widget');
		const notice = chat.locator('.ash-chat-input-notification-message');
		await expect(chat).toContainText('Synthetic answer');
		await expect(notice).toBeHidden();
		expect(detailReads).toBe(1);
		rateLimited = true;
		const afterFreshness = Date.now() + 65_000;
		await page.clock.setFixedTime(new Date(afterFreshness));
		await previous.click();
		await expect.poll(() => historyNotices(page)).toEqual([rateLimitNotice]);
		await expect(notice).toBeHidden();
		expect(detailReads).toBe(2);
		await expect(previous).toBeVisible();
		await expect(chat).toContainText('Synthetic answer');

		rateLimited = false;
		await previous.click();
		await expect.poll(() => historyNotices(page)).toEqual([rateLimitNotice]);
		expect(detailReads).toBe(2);
		await page.clock.setFixedTime(new Date(afterFreshness + 26_000));
		await previous.click();
		await expect(notice).toBeHidden();
		await expect.poll(() => historyNotices(page)).toEqual([]);
		expect(detailReads).toBe(3);
	});

	test('Projects shows localized ChatGPT project times from the project list', async () => {
		const { page } = browserTests;
		const now = new Date('2026-11-08T12:00:00Z');
		const updatedAt = '2026-11-05T12:00:00Z';
		const createdAt = '2026-11-02T12:00:00Z';
		await page.clock.install({ time: now });
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
			json: {
				items: [
					{ gizmo: { gizmo: { id: 'g-p-updated', display: { name: 'Updated project' }, created_at: createdAt, updated_at: updatedAt } } },
					{ gizmo: { id: 'g-p-created', display: { name: 'Created project' }, created_at: createdAt, updated_at: 'invalid' } },
					{ gizmo: { id: 'g-p-unknown', display: { name: 'Undated project' } } },
				],
				cursor: null,
			},
		}));
		await page.goto('/chatgptNavigation.html?projects&locale=zh-CN');
		const catalog = page.locator('.ash-projects');
		const updated = catalog.getByRole('button', { name: 'Updated project', exact: true });
		const created = catalog.getByRole('button', { name: 'Created project', exact: true });
		const undated = catalog.getByRole('button', { name: 'Undated project', exact: true });
		await expect(updated.locator('time')).toHaveText('3天前');
		await expect(updated.locator('time')).toHaveAttribute('datetime', new Date(updatedAt).toISOString());
		await expect(updated).toHaveAccessibleDescription(/^更新于 /u);
		await expect(created.locator('time')).toHaveText('6天前');
		await expect(created).toHaveAccessibleDescription(/^创建于 /u);
		await expect(undated).toBeVisible();
		await expect(undated.locator('time')).toHaveCount(0);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`Chat sorts its conversation rows from the empty Projects header (${locale})`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/conversations?*', route => route.fulfill({
				json: {
					items: [
						{ id: 'echo', title: 'Echo', create_time: '2026-01-03T00:00:00Z', update_time: '2026-01-04T00:00:00Z' },
						{ id: 'zulu', title: 'Zulu', create_time: '2026-01-02T00:00:00Z', update_time: '2026-01-03T00:00:00Z' },
						{ id: 'alpha', title: 'Alpha', create_time: Date.UTC(2026, 0, 1) / 1000, update_time: '2026-01-02T00:00:00Z' },
					], total: 3
				},
			}));
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${chinese ? 'hcDark' : 'light'}`);
			const list = page.locator('.ash-chat-navigation-list');
			const projects = list.locator('[data-section="projects"]');
			const headerRow = list.getByRole('treeitem').filter({ has: page.locator('[data-section="projects"]') });
			const toolbar = projects.getByRole('toolbar');
			const more = toolbar.getByRole('button', { name: chinese ? '更多会话操作' : 'More Sessions Actions', exact: true });
			const rows = list.locator('[data-parent-section="recent"] .ash-chat-navigation-item');
			await expect(rows).toHaveText(['Echo', 'Zulu', 'Alpha']);
			await expect(projects.getByRole('heading')).toHaveText(chinese ? '项目' : 'Projects');
			await expect(projects.locator('.ash-sessions-list-section-toggle')).toHaveCount(0);
			await expect(toolbar.getByRole('button')).toHaveCount(1);
			await expect(toolbar).toHaveCSS('opacity', '0');
			await projects.getByRole('heading').hover();
			await expect(toolbar).toHaveCSS('opacity', '1');
			const background = await headerRow.evaluate(node => getComputedStyle(node).backgroundColor);
			expect(background).not.toBe('rgba(0, 0, 0, 0)');
			await more.hover();
			await expect(headerRow).toHaveCSS('background-color', background);
			await expect(projects).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(more).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await page.mouse.move(0, 0);
			await expect(toolbar).toHaveCSS('opacity', '0');
			await more.focus();
			await expect(toolbar).toHaveCSS('opacity', '1');
			const openSort = async () => {
				await more.press('Enter');
				const sort = page.getByRole('menuitem', { name: chinese ? '排序方式' : 'Sort By', exact: true });
				await sort.focus();
				await page.keyboard.press('ArrowRight');
			};
			const choose = async (name: string) => {
				await openSort();
				await page.getByRole('menuitemradio', { name, exact: true }).click();
			};
			await choose(chinese ? '名称' : 'Name');
			await expect(rows).toHaveText(['Alpha', 'Echo', 'Zulu']);
			await choose(chinese ? '创建日期' : 'Date Created');
			await expect(rows).toHaveText(['Echo', 'Zulu', 'Alpha']);
			await choose(chinese ? '升序' : 'Ascending');
			await expect(rows).toHaveText(['Alpha', 'Zulu', 'Echo']);
			await openSort();
			const selected = page.getByRole('menuitemradio', { name: chinese ? '创建日期' : 'Date Created', exact: true, checked: true });
			await expect(selected).toBeVisible();
			await page.keyboard.press('Escape');
			await page.keyboard.press('Escape');
			await expect(more).toBeFocused();
		});

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
			const row = list.getByRole('treeitem').filter({ has: page.locator('.ash-sessions-list-section-toggle') }).first();
			const header = row.locator('.ash-sessions-list-section-toggle');
			await expect(header).toBeVisible();
			const expectInsets = async (inset: number): Promise<void> => {
				await expect.poll(() => row.evaluate(node => {
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
			await expect(row).toHaveCSS('border-radius', '6px');
			await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		});

		test(`ChatGPT history and conversation keep independent loading states (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			let releaseHistory!: () => void;
			const history = new Promise<void>(resolve => { releaseHistory = resolve; });
			await page.route('**/service/backend-api/conversations?*', async route => {
				await history;
				await route.fulfill({
					json: {
						items: [
							{ id: 'previous-chat', title: 'Previous conversation' },
							{ id: 'fixture-chat', title: 'Synthetic conversation' },
						],
						total: 2,
					},
				});
			});
			await page.route('**/service/backend-api/conversation/previous-chat', route => route.fulfill({
				json: {
					title: 'Previous conversation',
					current_node: 'answer',
					mapping: {
						answer: {
							parent: null,
							message: { id: 'answer', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Previous answer'] } },
						},
					},
				},
			}));
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
			await navigation.getByRole('button', { name: 'Previous conversation', exact: true }).click();
			await expect(editor.locator('.ash-chat-transcript')).toContainText('Previous answer');
			let releaseConversation!: () => void;
			const pending = new Promise<void>(resolve => { releaseConversation = resolve; });
			await page.route('**/service/backend-api/conversation/fixture-chat', async route => { await pending; await route.fallback(); });
			try {
				await conversation.click();
				await expect(editor.locator('.ash-chat-transcript')).toHaveAttribute('aria-busy', 'true');
				await expect(navigation.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'false');
				const destinationRow = navigation.locator('[data-item="chatgpt:fixture-chat"]');
				const destination = destinationRow.locator('.ash-chat-navigation-item');
				await expect(destination).toBeEnabled();
				await expect(destination).toHaveAccessibleName(locale === 'zh-CN' ? /正在加载对话…/u : /Loading conversation…/u);
				await expect(destinationRow.locator('.ash-session-status-icon-progress')).toBeVisible();
				await expect(editor.locator('.ash-chat-status')).toBeHidden();
				await expect(editor.locator('.ash-chat-transcript')).toContainText('Previous answer');
				await expect(editor.locator('.ash-chat-welcome h2')).toBeHidden();
				await page.screenshot({ path: browserTests.info.outputPath(`chat-independent-loading-${locale}.png`) });
			} finally { releaseConversation(); }
			await expect(editor.locator('.ash-chat-transcript')).toContainText('Synthetic answer');
			await expect(editor.locator('.ash-chat-transcript')).toHaveAttribute('aria-busy', 'false');
			await expect(conversation).toHaveAttribute('aria-current', 'page');
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
			await expect(row.locator('.ash-session-leading-icon [data-ash-icon-id="chat-session"]')).toBeVisible();
			for (const direction of ['ltr', 'rtl']) {
				await page.locator('#navigation').evaluate((element, dir) => { element.setAttribute('dir', dir); }, direction);
				await page.keyboard.press('Tab');
				await title.focus();
				await title.hover();
				const actions = row.locator('.ash-sessions-list-actions');
				await expect(actions).toHaveCSS('opacity', '1');
				await expect(row.locator('xpath=ancestor::*[@role="treeitem"]')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(title).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(actions).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await testInfo.attach(`conversation-focused-${theme}-${direction}`, { body: await row.screenshot(), contentType: 'image/png' });
				await expectVisibleFocusOutline(title);
				await row.locator('.ash-sessions-list-actions').getByRole('button').first().click({ trial: true });
				await page.keyboard.press('Tab');
				await expect(row.locator('.ash-sessions-list-actions').getByRole('button').first()).toBeFocused();
			}
		}
	});

	test('an overflowing chat title scrolls to its end on hover and resets on exit', async () => {
		const { page } = browserTests;
		const longTitle = '用于测试悬停滚动的长会话标题，最后几个字必须完整显示';
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversations?*', route => route.fulfill({
			json: { items: [{ id: 'long', title: longTitle }, { id: 'short', title: '短标题' }], total: 2 },
		}));
		await page.goto('/chatgptNavigation.html?locale=zh-CN&theme=light');
		const button = page.getByRole('button', { name: longTitle, exact: true });
		const label = button.locator('.ash-sessions-list-label');
		const text = label.locator('span');
		const short = page.getByRole('button', { name: '短标题', exact: true });
		await expect(label).toHaveCSS('text-overflow', 'clip');
		await expect(label).toHaveCSS('mask-image', /^linear-gradient/);
		await expect(text).toHaveCSS('animation-name', 'none');
		for (const direction of ['ltr', 'rtl']) {
			await page.locator('#navigation').evaluate((element, dir) => { element.setAttribute('dir', dir); }, direction);
			await button.hover();
			await expect(label).not.toHaveCSS('mask-image', 'none');
			await expect(text).toHaveCSS('animation-name', 'ash-sessions-row-title-scroll');
			expect(await text.evaluate((element, dir) => {
				element.getAnimations()[0]!.finish();
				const viewport = element.parentElement!.getBoundingClientRect();
				const content = element.getBoundingClientRect();
				return dir === 'rtl' ? content.left - viewport.left : viewport.right - content.right;
			}, direction)).toBeGreaterThanOrEqual(15);
			await expect(label).toHaveCSS('mask-size', '100% 100%');

			await short.hover();
			await expect(text).toHaveCSS('transform', 'none');
			await expect(label).toHaveCSS('animation-name', 'none');
			await expect(short.locator('.ash-sessions-list-label')).toHaveCSS('mask-image', 'none');
		}
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await button.hover();
		await expect(text).toHaveCSS('animation-name', 'none');
		await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'no-preference' });
		await expect(label).toHaveCSS('mask-image', 'none');
		await expect(label).toHaveCSS('text-overflow', 'ellipsis');
		await expect(text).toHaveCSS('animation-name', 'none');
		await page.emulateMedia({ forcedColors: 'none' });
		await page.goto('/chatgptNavigation.html?locale=zh-CN&theme=hcDark');
		await button.hover();
		await expect(label).toHaveCSS('mask-image', 'none');
		await expect(label).toHaveCSS('text-overflow', 'ellipsis');
		await expect(text).toHaveCSS('animation-name', 'none');
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
			const sidebar = page.locator('.ash-chat-navigation');
			await expect(list.getByRole('treeitem').filter({ has: page.locator('.ash-chat-navigation-item') }).first()).toBeVisible();
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
		const recent = list.getByRole('button', { name: '最近使用', exact: true });
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

	test('ChatGPT conversation pagination retries a failure through the history notification', async function () {
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
		await expect.poll(() => historyNotices(page)).toEqual(['Could not sync ChatGPT history. Previously loaded chats are still available.']);
		await expect(page.locator('.ash-chat-input-notification-message')).toBeHidden();
		await expect(list).toHaveAttribute('aria-busy', 'false');
		expect(offsets).toEqual([0, 20]);
		await page.mouse.wheel(0, -100);
		await page.mouse.wheel(0, 200);
		await page.evaluate(() => window.ashChatGPTIntegration.retryHistory());
		await expect(list.locator('.ash-chat-navigation-item:visible')).toHaveCount(40);
		await expect.poll(() => historyNotices(page)).toEqual([]);
		expect(offsets).toEqual([0, 20, 20]);
	});

	test('ChatGPT migrates the previous group collapse choice into the current storage keys once', async function () {
		const { page } = browserTests;

		await mockChatGPTRequests(page);
		await page.goto('/chatgptNavigation.html?locale=en&legacyCollapsed=1');
		const heading = page.locator('[data-section="recent"] .ash-sessions-list-section-toggle');
		const recent = page.locator('[data-parent-section="recent"]');
		await expect(heading).toHaveAttribute('aria-expanded', 'false');
		const storageKeys = () => page.evaluate(() => window.ashChatGPTIntegration.storageKeys());
		const previousKeys = (keys: readonly string[]) => keys.filter(key => key.startsWith('sessions.chatgpt.navigation.collapsed.'));
		expect(previousKeys(await storageKeys())).toEqual([]);
		expect(await storageKeys()).toContain('sessions.list.chat.collapsed.catalog-project:g-p-unloaded');
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

	for (const phase of ['loaded', 'loading'] as const) {
		test(`closes a ${phase} ChatGPT project Markdown preview when the account changes`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			const id = 'g-p-research';
			const name = 'Project notes.md';
			let project = 'First account project';
			let text = 'First account notes';
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: { items: [{ gizmo: { id, display: { name: project } } }], cursor: null },
			}));
			await page.route(`**/service/backend-api/gizmos/${id}*`, route => {
				if (!new URL(route.request().url()).pathname.endsWith(id)) return route.fallback();
				return route.fulfill({ json: { gizmo: { id, display: { name: project } }, files: [{ file_id: 'file-notes', name }] } });
			});
			await page.route('**/service/.resource?*', route => route.fulfill({ contentType: 'text/markdown', body: text }));
			await page.goto('/chatgptNavigation.html?projects&projectMaterials');
			const projects = page.locator('.ash-projects');
			await projects.getByRole('button', { name: project, exact: true }).click();
			const note = projects.getByRole('button', { name, exact: true });
			const preview = page.getByRole('dialog', { name, exact: true });
			await expect(note.locator('.ash-projects-material-card-excerpt')).toHaveText(text);
			if (phase === 'loading') {
				await page.evaluate(name => window.ashChatGPTIntegration.pauseMaterialRead(name), name);
			}
			await note.press('Enter');
			if (phase === 'loading') {
				await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.isMaterialReadPaused())).toBe(true);
				await expect(preview.getByRole('status')).toBeVisible();
				await expect(preview.locator('.stanza-editor')).toHaveCount(0);
			} else {
				await expect(preview.getByText(text, { exact: true })).toBeVisible();
				await page.evaluate(() => window.ashChatGPTIntegration.setOffline(true));
				await expect(preview.getByText(text, { exact: true })).toBeVisible();
				await page.evaluate(() => window.ashChatGPTIntegration.setOffline(false));
			}

			const oldText = text;
			project = 'Second account project';
			text = 'Second account notes';
			await page.evaluate(() => window.ashChatGPTIntegration.switchAccount());
			await expect(page.locator('.ash-project-text-preview')).toHaveCount(0);
			await expect(projects).toBeVisible();
			if (phase === 'loading') {
				await page.evaluate(async () => {
					await window.ashChatGPTIntegration.resumeMaterialRead();
					await new Promise(requestAnimationFrame);
				});
				await expect(page.locator('.ash-project-text-preview')).toHaveCount(0);
			}

			await expect(projects).toHaveAttribute('aria-label', project);
			await expect(note.locator('.ash-projects-material-card-excerpt')).toHaveText(text);
			await note.press('Enter');
			await expect(preview.getByText(text, { exact: true })).toBeVisible();
			await expect(preview.getByText(oldText, { exact: true })).toHaveCount(0);
			await page.keyboard.press('Escape');
			await expect(note).toBeFocused();
			if (phase === 'loaded') {
				await note.press('Enter');
				await expect(preview.getByText(text, { exact: true })).toBeVisible();
				await page.evaluate(() => window.ashChatGPTIntegration.toggleArchivedProjects());
				await expect(page.locator('.ash-project-text-preview')).toHaveCount(0);
			}
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Projects creates a ChatGPT project from the shared project form (${locale})`, async () => {
			const { page } = browserTests;
			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: { items: [{ gizmo: { id: 'g-p-existing', display: { name: 'Existing project' } } }], cursor: null },
			}));
			const writes: unknown[] = [];
			await page.route('**/service/backend-api/projects', route => {
				expect(route.request().method()).toBe('POST');
				writes.push(route.request().postDataJSON());
				return route.fulfill({ json: { gizmo: { id: 'g-p-created' } } });
			});
			await page.route('**/service/backend-api/gizmos/g-p-created*', route => route.fulfill({
				json: { gizmo: { id: 'g-p-created', instructions: 'Keep an experiment log.', display: { name: 'Cloud project' } } },
			}));
			await page.goto(`/chatgptNavigation.html?projects&locale=${locale}`);
			const projects = page.locator('.ash-projects');
			await expect(projects.getByRole('button', { name: 'Existing project', exact: true })).toBeVisible();
			await projects.getByRole('button', { name: zh ? '新建项目' : 'New project', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: zh ? '创建项目' : 'Create a project', exact: true });
			const source = dialog.getByRole('combobox', { name: zh ? '项目来源' : 'Project source', exact: true });
			const folder = dialog.getByRole('button', { name: zh ? '使用文件夹' : 'Use a folder', exact: true });
			const name = dialog.getByRole('textbox').first();
			const instructions = dialog.getByRole('textbox', { name: zh ? '指令' : 'Instructions', exact: true });
			await expect(source).toHaveValue('Ash');
			await expect(folder).toBeVisible();
			await expect(name).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(instructions).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(folder).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(source).toBeFocused();
			await source.selectOption({ label: 'ChatGPT' });
			await expect(source).toHaveAccessibleDescription(zh ? '保存到当前 ChatGPT 账号。' : 'Saved to your current ChatGPT account.');
			await expect(folder).toBeHidden();
			await name.fill('Cloud project');
			await instructions.fill('Keep an experiment log.');
			await dialog.getByRole('button', { name: zh ? '创建' : 'Create', exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(projects).toHaveAttribute('aria-label', 'Cloud project');
			await expect(projects.getByText('Keep an experiment log.', { exact: true })).toBeVisible();
			expect(writes).toEqual([{ name: 'Cloud project', instructions: 'Keep an experiment log.', emoji: null, theme: null }]);
		});

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
			await expect(dialog.getByRole('button', { name: zh ? '更改项目外观' : 'Change project appearance' })).toBeVisible();
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
			await page.getByRole('dialog').getByRole('button', { name: zh ? '归档' : 'Archive', exact: true }).click();
			await expect(updated).toHaveCount(0);
			await page.evaluate(() => window.ashChatGPTIntegration.toggleArchivedProjects());
			await projects.getByRole('button', { name: zh ? '取消归档 Updated research' : 'Unarchive Updated research', exact: true }).click();
			await expect(projects.getByRole('status').filter({ hasText: zh ? '没有已归档的项目。' : 'No archived projects.' })).toBeVisible();
			await page.evaluate(() => window.ashChatGPTIntegration.toggleArchivedProjects());
			await expect(updated).toBeVisible();
		});

		test(`Projects opens conversation groups and pages their history on demand (${locale})`, async function () {
			const { page, info } = browserTests;
			const zh = locale === 'zh-CN';
			await page.setViewportSize({ width: 1280, height: 640 });
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
			const firstPage = [pinned, { id: 'one', title: 'First research chat' },
				...Array.from({ length: 18 }, (_, index) => ({ id: `project-chat-${index}`, title: `Research chat ${index + 2}` }))];
			const firstPageTitles = firstPage.map(item => item.title);
			let releaseNextPage!: () => void;
			const nextPage = new Promise<void>(resolve => { releaseNextPage = resolve; });
			let releaseEmptyPage!: () => void;
			const emptyPage = new Promise<void>(resolve => { releaseEmptyPage = resolve; });
			await page.route('**/service/backend-api/pins?*', route => route.fulfill({ json: [{ item: pinned }] }));
			const cursors: (string | null)[] = [];
			let emptyReads = 0;
			await page.route('**/gizmos/g-p-two/conversations?*', async route => {
				emptyReads++;
				await emptyPage;
				return route.fulfill({ json: { items: [], cursor: null } });
			});
			await page.route('**/gizmos/g-p-one/conversations?*', async route => {
				const cursor = new URL(route.request().url()).searchParams.get('cursor');
				cursors.push(cursor);
				if (!cursor) return route.fulfill({ json: { items: firstPage, cursor: 'page+two' } });
				if (cursors.length === 2) {
					await nextPage;
					return route.fulfill({ status: 503 });
				}
				if (cursor === 'page+two') {
					return route.fulfill({ json: { items: [{ id: 'one', title: 'First research chat' }, { id: 'two', title: 'Older research chat' }], cursor: 'page+three' } });
				}
				return route.fulfill({ json: { items: [{ id: 'three', title: 'Oldest research chat' }], cursor: null } });
			});
			await page.goto(`/chatgptNavigation.html?projects&locale=${locale}&theme=${zh ? 'hcDark' : 'light'}`);
			const sidebar = page.locator('.ash-chat-navigation-list');
			const projects = page.locator('.ash-projects');
			const research = projects.getByRole('button', { name: 'Research', exact: true });
			const writing = projects.getByRole('button', { name: 'Writing', exact: true });
			await expect(research).toBeVisible();
			await expect(writing).toBeVisible();
			await expect(sidebar.locator('.ash-sessions-list-section')).toHaveCount(3);
			await expect(sidebar.locator('[data-parent-section="pinned"] .ash-chat-navigation-item')).toHaveText(pinned.title);
			await expect(sidebar.locator('[data-parent-section="recent"] .ash-chat-navigation-item')).toHaveText('Synthetic conversation');
			expect(cursors).toEqual([]);
			const toggle = sidebar.getByRole('button', { name: 'Research', exact: true });
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			const projectRow = sidebar.locator('[data-item="project:g-p-one"]');
			const iconSlot = projectRow.locator('.ash-sessions-list-project-icon');
			const projectIcon = iconSlot.locator(':scope > .ash-icon').first();
			const projectLabel = projectRow.locator('.ash-sessions-list-section-label');
			const chevron = projectRow.locator('.ash-sessions-list-project-chevron');
			await page.mouse.move(0, 0);
			await expect(projectIcon).toBeVisible();
			await expect(projectIcon).toHaveAttribute('data-ash-icon-id', 'projects');
			await expect(chevron).toBeHidden();
			const labelStart = (await projectLabel.boundingBox())!.x;
			const slotBounds = (await iconSlot.boundingBox())!;
			await page.keyboard.press('Tab');
			await toggle.focus();
			await expect(chevron).toBeVisible();
			await toggle.blur();
			const restingBounds = await toggle.boundingBox();
			await toggle.hover();
			await expect(chevron).toBeVisible();
			await expect(projectIcon).toBeHidden();
			expect(await toggle.boundingBox()).toEqual(restingBounds);
			const recentChat = sidebar.getByRole('button', { name: 'Synthetic conversation', exact: true });
			const recentBounds = (await recentChat.boundingBox())!;
			await recentChat.hover();
			const hoverBackground = await recentChat.evaluate(row => getComputedStyle(row).backgroundColor);
			await toggle.getByText('Research', { exact: true }).click();
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');
			await expect(projectIcon).toHaveAttribute('data-ash-icon-id', 'projects-filled');
			await expect(research).toBeVisible();
			const children = sidebar.locator('[data-parent-project="project:g-p-one"] > .ash-chat-navigation-item');
			await expect(children).toHaveText(firstPageTitles);
			expect(cursors).toEqual([null]);
			const projectChat = children.first();
			const projectBounds = (await projectChat.boundingBox())!;
			expect(projectBounds.x).toBe(recentBounds.x);
			expect(projectBounds.width).toBe(recentBounds.width);
			await projectChat.hover();
			await expect(projectChat).toHaveCSS('background-color', hoverBackground);
			await children.last().scrollIntoViewIfNeeded();
			await expect(toggle).toHaveAttribute('aria-busy', 'true');
			await toggle.hover();
			await expect(projectIcon).toBeHidden();
			await expect(chevron).toBeHidden();
			const ring = iconSlot.locator('.ash-loading-spinner');
			await expect(ring).toBeVisible();
			await expect(ring).toHaveCSS('inline-size', '16px');
			await expect(ring).toHaveAttribute('aria-hidden', 'true');
			expect((await projectLabel.boundingBox())!.x).toBe(labelStart);
			const ringBounds = (await ring.boundingBox())!;
			const rowBounds = (await toggle.boundingBox())!;
			expect(ringBounds.x + ringBounds.width / 2).toBeCloseTo(slotBounds.x + slotBounds.width / 2);
			expect(ringBounds.y + ringBounds.height / 2).toBeCloseTo(rowBounds.y + rowBounds.height / 2);
			await expect(sidebar.locator('.ash-chat-navigation-project-history')).toHaveCount(0);
			expect(cursors).toEqual([null, 'page+two']);
			await toggle.press('ArrowLeft');
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			await expect(children).toHaveCount(0);
			await research.press('Enter');
			const overview = projects.locator('.ash-projects-detail .ash-projects-overview');
			const list = overview.getByRole('list', { name: zh ? '项目对话' : 'Project conversations' });
			const rows = list.getByRole('button');
			await expect(rows).toHaveText(firstPageTitles);
			await expect(projects).toHaveAccessibleName('Research');
			await expect(projects).toBeFocused();
			await expect(list).toHaveAttribute('aria-busy', 'true');
			const loading = overview.getByRole('status').filter({ hasText: zh ? '正在加载项目聊天…' : 'Loading project chats…' });
			await expect(loading).toHaveCSS('clip-path', 'inset(50%)');
			await expect(rows.first()).toHaveCSS('height', '32px');
			await rows.first().press('ArrowDown');
			await expect(rows.nth(1)).toBeFocused();
			await expect(projects.getByRole('heading', { level: 1 })).toHaveCount(0);
			await expect(page.locator('.ash-sessions-titlebar-page-content .ash-project-titlebar-name')).toHaveText('Research');
			expect(emptyReads).toBe(0);
			releaseNextPage();
			await expect.poll(() => historyNotices(page)).toEqual([zh ? '无法同步 ChatGPT 历史，仍可查看已加载的会话。' : 'Could not sync ChatGPT history. Previously loaded chats are still available.']);
			await expect(toggle).toHaveAttribute('aria-busy', 'false');
			await expect(ring).toHaveCount(0);
			await expect(projects.getByRole('button', { name: zh ? '无法加载项目聊天，点击重试' : 'Could not load project chats. Retry', exact: true })).toHaveCount(0);
			await page.evaluate(() => window.ashChatGPTIntegration.retryHistory());
			await expect(rows).toHaveText([...firstPageTitles, 'Older research chat']);
			await expect(rows.nth(1)).toBeFocused();
			await expect(list).toHaveAttribute('aria-busy', 'false');
			await page.screenshot({ path: info.outputPath(`project-conversations-${locale}.png`) });
			await expect.poll(() => historyNotices(page)).toEqual([]);
			await expect(overview.getByRole('button', { name: zh ? '加载更多项目聊天' : 'Load more project chats', exact: true })).toHaveCount(0);
			const olderChat = rows.getByText('Older research chat', { exact: true });
			if (zh) await rows.nth(1).press('End');
			else await olderChat.scrollIntoViewIfNeeded();
			await expect(rows).toHaveText([...firstPageTitles, 'Older research chat', 'Oldest research chat']);
			await expect(zh ? rows.filter({ hasText: 'Older research chat' }) : rows.nth(1)).toBeFocused();
			expect(cursors).toEqual([null, 'page+two', 'page+two', 'page+three']);
			await page.locator('.ash-projects-breadcrumb').getByRole('button', { name: zh ? '项目' : 'Projects', exact: true }).click();
			await expect(research).toBeFocused();
			const writingToggle = sidebar.getByRole('button', { name: 'Writing', exact: true });
			await expect(writingToggle).toHaveAttribute('aria-expanded', 'false');
			await writingToggle.press('ArrowRight');
			await expect.poll(() => emptyReads).toBe(1);
			await writing.click();
			await expect(overview.getByRole('status')).toHaveText(zh ? '正在加载项目聊天…' : 'Loading project chats…');
			releaseEmptyPage();
			await expect(writingToggle).not.toHaveAttribute('aria-expanded');
			await expect(writingToggle.locator('.ash-sessions-list-project-chevron')).toHaveCount(0);
			await expect(sidebar.getByText(zh ? '此项目中没有聊天' : 'No chats in this project', { exact: true })).toHaveCount(0);
			const empty = overview.getByRole('status').filter({ hasText: zh ? '此项目中没有聊天' : 'No chats in this project' });
			await expect(empty).toBeVisible();
			await expect(empty).toHaveCSS('text-align', 'center');
			await expect(projects.locator('.ash-projects-materials')).toBeVisible();
			await expect(projects.locator('.ash-projects-composer')).toBeVisible();
			await page.screenshot({ path: info.outputPath(`project-conversations-empty-${locale}.png`) });
			expect(cursors).toHaveLength(4);
			expect(emptyReads).toBe(1);
		});

		test(`renames a writable ChatGPT project from the breadcrumb (${locale})`, async () => {
			const { page } = browserTests;
			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			const id = 'g-p-rename';
			const readOnlyId = 'g-p-read-only';
			let name = 'Research';
			let instructions = 'Saved instructions';
			const writes: unknown[] = [];
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: {
					items: [
						{ gizmo: { id, display: { name } } },
						{ gizmo: { id: readOnlyId, display: { name: 'Shared research' } } },
					],
					cursor: null,
				},
			}));
			for (const projectId of [id, readOnlyId]) {
				await page.route(`**/service/backend-api/gizmos/${projectId}*`, route => {
					if (!new URL(route.request().url()).pathname.endsWith(projectId)) return route.fallback();
					return route.fulfill({
						json: {
							gizmo: {
								id: projectId, instructions, current_user_permission: { can_write: projectId === id },
								display: { name: projectId === id ? name : 'Shared research', emoji: '🔬', theme: 'blue' },
							},
							files: [],
						},
					});
				});
			}
			await page.route(`**/service/backend-api/projects/${id}`, route => {
				expect(route.request().method()).toBe('PATCH');
				const body = route.request().postDataJSON();
				writes.push(body);
				if (writes.length === 1) return route.fulfill({ status: 503 });
				name = body.name;
				return route.fulfill({ status: 204 });
			});
			await page.goto(`/chatgptNavigation.html?projects&locale=${locale}`);
			const projects = page.locator('.ash-projects');
			await projects.getByRole('button', { name: 'Research', exact: true }).click();
			const breadcrumb = page.locator('.ash-projects-breadcrumb');
			const rename = (name: string) => breadcrumb.getByRole('button', {
				name: zh ? `重命名项目 ${name}` : `Rename project ${name}`, exact: true,
			});
			const input = breadcrumb.getByRole('textbox', { name: zh ? '项目名称' : 'Project name', exact: true });
			await rename('Research').press('Enter');
			await expect(input).toHaveValue('Research');
			await input.fill('New research name');
			await input.press('Enter');
			await expect(projects.locator('.ash-projects-feedback')).toBeVisible();
			await expect(input).toHaveValue('New research name');
			await expect(input).toBeEditable();
			instructions = 'Updated in ChatGPT';
			await input.press('Enter');
			await expect(rename('New research name')).toBeFocused();
			await expect(page.locator('.ash-chat-navigation-list').getByRole('button', { name: 'New research name', exact: true })).toBeVisible();
			expect(writes).toEqual([
				{ name, instructions: 'Saved instructions', emoji: '🔬', theme: 'blue' },
				{ name, instructions: 'Updated in ChatGPT', emoji: '🔬', theme: 'blue' },
			]);
			await breadcrumb.getByRole('button', { name: zh ? '项目' : 'Projects', exact: true }).click();
			await projects.getByRole('button', { name: 'Shared research', exact: true }).click();
			await expect(projects.locator('.ash-projects-description')).toHaveText('Updated in ChatGPT');
			await expect(breadcrumb.getByRole('button', { name: 'Shared research', exact: true })).toBeDisabled();
		});

		test(`edits ChatGPT project instructions in the shared Ash editor (${locale})`, async () => {
			const { page, info } = browserTests;
			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			const id = 'g-p-research';
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: { items: [{ gizmo: { id, display: { name: 'Research' } } }], cursor: null },
			}));
			let instructions = 'Saved instructions\nUse concise examples.';
			let projectFiles = [{ file_id: 'file-existing', name: 'Existing.txt', size: 17 }];
			let canWrite = true;
			let reads = 0;
			let holdDetails: Promise<void> | undefined;
			await page.route(`**/service/backend-api/gizmos/${id}*`, async route => {
				const url = new URL(route.request().url());
				if (!url.pathname.endsWith(id)) return route.fallback();
				if (++reads === 1) return route.fulfill({ status: 503 });
				if (holdDetails) await holdDetails;
				return route.fulfill({ json: { gizmo: { id, instructions, current_user_permission: { can_write: canWrite }, display: { name: 'Research', emoji: '🔬', theme: 'blue' } }, files: projectFiles } });
			});
			await page.route(`**/service/backend-api/projects/${id}`, route => {
				const body = route.request().postDataJSON();
				expect(body).toEqual({ name: 'Research', instructions: 'New instructions\nKeep examples short.', emoji: '🔬', theme: 'blue' });
				instructions = body.instructions;
				return route.fulfill({ status: 204 });
			});
			let upload = { id: 'file-new', name: 'notes.txt', type: 'text/plain', content: 'fixture notes' };
			await page.route('**/service/backend-api/files', route => {
				expect(route.request().postDataJSON()).toMatchObject({ file_name: upload.name, mime_type: upload.type, gizmo_id: id, use_case: 'gizmo' });
				return route.fulfill({ json: { file_id: upload.id, upload_url: 'https://example.test/upload' } });
			});
			await page.route('**/service/.upload?*', route => {
				expect(route.request().postData()).toBe(upload.content);
				return route.fulfill({ status: 201 });
			});
			await page.route('**/service/backend-api/files/process_upload_stream', route => {
				expect(route.request().postDataJSON()).toMatchObject({ gizmo_id: id, file_id: upload.id, entry_surface: 'project_sources' });
				return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ event: 'file.processing.completed', file_id: upload.id, extra: { metadata_object_id: 'library-fixture' } }) + '\n' });
			});
			await page.route(`**/service/backend-api/projects/${id}/files`, route => {
				expect(route.request().postDataJSON()).toMatchObject({ files: [{ file_id: upload.id, name: upload.name, library_file_id: 'library-fixture' }] });
				projectFiles = [...projectFiles, { file_id: upload.id, name: upload.name, size: Buffer.byteLength(upload.content) }];
				return route.fulfill({ status: zh ? 503 : 204 });
			});
			await page.route(`**/service/backend-api/projects/${id}/files/file-existing`, route => {
				expect(route.request().method()).toBe('DELETE');
				projectFiles = projectFiles.filter(file => file.file_id !== 'file-existing');
				return route.fulfill({ status: 204 });
			});
			const downloads: string[] = [];
			await page.route('**/service/.resource?*', route => {
				const url = new URL(new URL(route.request().url()).searchParams.get('url')!);
				expect(url.searchParams.get('gizmo_id')).toBe(id);
				const file = url.pathname.split('/').at(-1)!;
				downloads.push(file);
				if (file === 'file-markdown') return route.fulfill({ contentType: 'text/markdown', body: upload.content });
				return route.fulfill({ contentType: 'text/plain', body: file === 'file-existing' ? 'Saved remote file' : 'New remote file' });
			});
			await page.goto(`/chatgptNavigation.html?projects&projectMaterials&locale=${locale}`);
			const projects = page.locator('.ash-projects');
			await projects.getByRole('button', { name: 'Research', exact: true }).click();
			const materials = projects.getByRole('region', { name: zh ? '上下文' : 'Context', exact: true });
			const guidance = projects.getByRole('region', { name: zh ? '指令' : 'Instructions', exact: true });
			const editInstructions = guidance.getByRole('button', { name: zh ? '编辑指令' : 'Edit instructions', exact: true });
			await materials.getByRole('button', { name: zh ? '重试' : 'Try again', exact: true }).press('Enter');
			await expect(guidance.locator('.ash-projects-description')).toHaveText('Saved instructions\nUse concise examples.');
			await editInstructions.press('Enter');
			const dialog = page.getByRole('dialog', { name: zh ? '设置项目指令' : 'Set project instructions', exact: true });
			const editor = dialog.getByRole('textbox', { name: zh ? '指令' : 'Instructions', exact: true });
			const save = dialog.getByRole('button', { name: zh ? '保存指令' : 'Save instructions', exact: true });
			await expect(dialog.getByRole('textbox')).toHaveCount(1);
			await expect(editor).toBeFocused();
			await expect(editor).toHaveValue('Saved instructions\nUse concise examples.');
			await expect(save).toBeDisabled();
			await page.screenshot({ path: info.outputPath(`project-instructions-${locale}.png`) });
			await editor.fill('New instructions\nKeep examples short.');
			await save.click();
			await expect(guidance.locator('.ash-projects-description')).toHaveText('New instructions\nKeep examples short.');
			await expect(editInstructions).toBeFocused();
			const existing = materials.getByRole('button', { name: 'Existing.txt', exact: true });
			await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.readSavedMaterial('Existing.txt'))).toBe('Saved remote file');
			expect(downloads).toEqual(['file-existing']);
			await page.evaluate(() => window.ashChatGPTIntegration.setOffline(true));
			await existing.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.openedMaterial())).toBe('Saved remote file');
			expect(downloads).toEqual(['file-existing']);
			await page.evaluate(() => window.ashChatGPTIntegration.setOffline(false));
			const addMaterials = materials.getByRole('button', { name: zh ? '添加项目资料' : 'Add project materials', exact: true });
			const detailCard = projects.locator('.ash-projects-detail-card');
			const dropOverlay = detailCard.locator('.ash-projects-drop-overlay');
			if (zh) {
				const dataTransfer = await page.evaluateHandle(() => {
					const transfer = new DataTransfer();
					transfer.items.add(new File(['fixture notes'], 'notes.txt'));
					return transfer;
				});
				await detailCard.dispatchEvent('dragover', { dataTransfer });
				await expect(dropOverlay).toBeVisible();
				await expect(dropOverlay).toHaveText('将文件拖到这里以添加到项目上下文');
				await page.screenshot({ path: info.outputPath(`project-drop-${locale}.png`) });
				await detailCard.dispatchEvent('dragleave', { dataTransfer });
				await expect(dropOverlay).toBeHidden();
				await detailCard.dispatchEvent('dragover', { dataTransfer });
				await detailCard.dispatchEvent('drop', { dataTransfer });
				await expect(dropOverlay).toBeHidden();
				await dataTransfer.dispose();
			} else {
				await addMaterials.click();
				await expect(page.getByRole('menuitem', { name: 'Use a folder', exact: true })).toHaveCount(0);
				const chooser = page.waitForEvent('filechooser');
				await page.getByRole('menuitem', { name: 'Upload or add files', exact: true }).click();
				await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture notes') });
			}
			const fileCard = materials.getByRole('button', { name: 'notes.txt', exact: true });
			await expect(fileCard.locator('.ash-badge.outlined')).toHaveText('TXT');
			await expect(fileCard.locator('.ash-file-card-size')).toHaveText('13B');
			await expect(fileCard.locator('.ash-projects-material-card-excerpt')).toHaveText('New remote file');
			await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.readSavedMaterial('notes.txt'))).toBe('New remote file');
			const markdown = '# Notes\n\n- 第二行\n';
			// The editor serializes the new document with the platform's line endings.
			upload = { id: 'file-markdown', name: 'Project notes.md', type: 'text/markdown', content: markdown.replaceAll('\n', EOL) };
			await addMaterials.click();
			await page.getByRole('menuitem', { name: zh ? '添加文本内容' : 'Add text content', exact: true }).click();
			const textDialog = page.getByRole('dialog', { name: zh ? '添加文本内容' : 'Add text content', exact: true });
			await textDialog.getByRole('textbox', { name: zh ? '标题' : 'Title', exact: true }).fill('Project notes');
			const textEditor = new Editor(textDialog);
			await textEditor.waitForEditorFocus();
			await page.keyboard.insertText(markdown);
			await textDialog.getByRole('button', { name: zh ? '添加内容' : 'Add Content', exact: true }).click();
			await expect(textDialog).toHaveCount(0);
			await expect(addMaterials).toBeFocused();
			const note = materials.getByRole('button', { name: upload.name, exact: true });
			await expect(note.locator('.ash-badge.outlined')).toHaveText('MD');
			await expect(note.locator('.ash-file-card-size')).toHaveText(`${Buffer.byteLength(upload.content)}B`);
			const grid = materials.locator('.ash-projects-material-list');
			const columnCounts = await grid.evaluate(element => {
				const previous = element.style.inlineSize;
				try {
					return [240, 360, 420].map(width => {
						element.style.inlineSize = `${width}px`;
						const cards = [...element.querySelectorAll('.ash-projects-material-card')].map(card => card.getBoundingClientRect());
						return cards.filter(card => Math.abs(card.top - cards[0].top) < 1).length;
					});
				} finally {
					element.style.inlineSize = previous;
				}
			});
			expect(columnCounts).toEqual([2, 2, 2]);
			await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.readSavedMaterial('Project notes.md'))).toBe(upload.content);
			await page.evaluate(() => window.ashChatGPTIntegration.setOffline(true));
			await note.press('Enter');
			const preview = page.getByRole('dialog', { name: upload.name, exact: true });
			await expect(preview.getByText('第二行')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(preview).toHaveCount(0);
			await expect(note).toBeFocused();
			await page.evaluate(() => window.ashChatGPTIntegration.setOffline(false));
			await existing.hover();
			await materials.getByRole('button', { name: zh ? '从项目中移除 Existing.txt' : 'Remove Existing.txt from project', exact: true }).click();
			const confirm = page.getByRole('dialog').filter({ hasText: zh ? '从此项目移除 Existing.txt？' : 'Remove Existing.txt from this project?' });
			await confirm.getByRole('button', { name: zh ? '移除' : 'Remove', exact: true }).click();
			await expect(existing).toHaveCount(0);
			await expect(guidance.locator('.ash-projects-description')).toHaveText('New instructions\nKeep examples short.');
			const freshReads = reads;
			await page.locator('.ash-projects-breadcrumb').getByRole('button', { name: zh ? '项目' : 'Projects', exact: true }).click();
			await projects.getByRole('button', { name: 'Research', exact: true }).click();
			await expect(editInstructions).toBeVisible();
			expect(reads).toBe(freshReads);

			canWrite = false;
			await page.clock.setFixedTime(new Date(Date.now() + 65_000));
			await page.evaluate(() => window.dispatchEvent(new Event('focus')));
			await expect(addMaterials).toHaveCount(0);
			await expect(dropOverlay).toHaveCount(0);
			await expect(editInstructions).toHaveCount(0);
			await expect(materials.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible();

			let releaseDetails!: () => void;
			holdDetails = new Promise<void>(resolve => { releaseDetails = resolve; });
			instructions = 'Updated on ChatGPT Web';
			canWrite = true;
			try {
				await page.reload();
				await projects.getByRole('button', { name: 'Research', exact: true }).click();
				await expect(guidance.locator('.ash-projects-description')).toHaveText('New instructions\nKeep examples short.');
				await expect(editInstructions).toHaveCount(0);
				await expect(materials.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible();
				await expect(materials.getByText(zh ? '正在加载项目详情…' : 'Loading project details…', { exact: true })).toHaveCount(0);
			} finally {
				releaseDetails();
			}
			await expect(guidance.locator('.ash-projects-description')).toHaveText('Updated on ChatGPT Web');
			await expect(editInstructions).toBeVisible();
		});

		test(`pauses the project history fallback between batches (${locale})`, async () => {
			const { page } = browserTests;
			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			const id = 'g-p-fallback';
			await page.route('**/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: { items: [{ gizmo: { id, display: { name: 'Research' } } }], cursor: null },
			}));
			let fallingBack = false;
			await page.route(`**/gizmos/${id}/conversations?*`, route => {
				fallingBack = true;
				return route.fulfill({ status: 403 });
			});
			const offsets: number[] = [];
			await page.route('**/service/backend-api/conversations?*', route => {
				if (!fallingBack) return route.fallback();
				const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
				offsets.push(offset);
				const item = offset < 3 ? { id: `outside-${offset}`, title: 'Other chat' }
					: { id: `project-chat-${offset}`, title: offset === 3 ? 'Older research chat' : 'Oldest research chat', gizmo_id: id };
				return route.fulfill({ json: { items: [item], total: 5 } });
			});

			await page.goto(`/chatgptNavigation.html?projects&locale=${locale}`);
			const projects = page.locator('.ash-projects');
			await projects.getByRole('button', { name: 'Research', exact: true }).click();
			const more = projects.getByRole('button', { name: zh ? '加载更多对话' : 'Load more conversations', exact: true });
			await expect(more).toBeVisible();
			await more.focus();
			await expect(more).toBeFocused();
			expect(offsets).toEqual([0, 1, 2]);
			await more.press('Enter');
			await expect(projects.getByRole('button', { name: 'Older research chat', exact: true })).toBeVisible();
			await expect(more).toBeVisible();
			expect(offsets).toEqual([0, 1, 2, 3]);
			await more.press('Enter');
			await expect(projects.getByRole('button', { name: 'Oldest research chat', exact: true })).toBeVisible();
			await expect(more).toHaveCount(0);
			expect(offsets).toEqual([0, 1, 2, 3, 4]);
		});

		test(`starts a new ChatGPT conversation from the current project (${locale})`, async () => {
			const { page } = browserTests;
			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
				json: { items: ['Research', 'Writing'].map(name => ({ gizmo: { id: `g-p-${name.toLowerCase()}`, display: { name } } })), cursor: null },
			}));
			const sends: unknown[] = [];
			const moves: unknown[] = [];
			const uploads: (string | null)[] = [];
			await page.route('**/service/backend-api/files', route => route.fulfill({
				json: { file_id: 'file-project-note', upload_url: 'https://example.test/upload' },
			}));
			await page.route('**/service/.upload?*', route => {
				uploads.push(route.request().postData());
				return route.fulfill({ status: 201 });
			});
			await page.route('**/service/backend-api/files/file-project-note/uploaded', route => route.fulfill({ json: { status: 'success' } }));
			await page.route('**/service/backend-api/f/conversation', route => {
				sends.push(route.request().postDataJSON());
				if (sends.length === 1) return route.fulfill({ status: 400 });
				return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"conversation_id":"fixture-chat"}\n\ndata: [DONE]\n\n' });
			});
			await page.route('**/service/backend-api/conversation/fixture-chat', route => {
				if (route.request().method() !== 'PATCH') return route.fallback();
				moves.push(route.request().postDataJSON());
				return route.fulfill({ json: {} });
			});
			await page.goto(`/chatgptNavigation.html?projects&locale=${locale}`);
			const projects = page.locator('.ash-projects');
			const card = (name: string) => projects.getByRole('button', { name, exact: true });
			const back = page.locator('.ash-projects-breadcrumb').getByRole('button', { name: zh ? '项目' : 'Projects', exact: true });
			const composer = projects.getByRole('region', { name: zh ? '在项目中新建聊天' : 'New chat in project' });
			const editor = new Editor(composer);
			const send = composer.getByRole('button', { name: zh ? '发送' : 'Send', exact: true });
			await card('Research').click();
			await editor.input.focus();
			await editor.waitForTypeInEditor('Research draft');
			await back.click();
			await card('Writing').click();
			await editor.waitForEditorContents(text => text === '');
			await editor.input.focus();
			await editor.waitForTypeInEditor('Start in Writing');
			await editor.input.evaluate(element => {
				const clipboard = new DataTransfer();
				clipboard.items.add(new File(['project note'], 'note.txt', { type: 'text/plain' }));
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
			});
			await expect(composer.getByText('note.txt', { exact: true })).toBeVisible();
			expect(sends).toEqual([]);
			expect(uploads).toEqual([]);
			await send.click();
			await expect.poll(() => sends.length).toBe(1);
			await expect(send).toBeEnabled();
			await editor.waitForEditorContents(text => text === 'Start in Writing');
			await expect(composer.getByText('note.txt', { exact: true })).toBeVisible();
			expect(moves).toEqual([]);
			await send.click();
			await expect.poll(() => moves).toEqual([{ gizmo_id: 'g-p-writing' }]);
			expect(sends).toHaveLength(2);
			expect(uploads).toEqual(['project note', 'project note']);
			for (const request of sends) expect(request).toMatchObject({
				messages: [{ content: { parts: ['Start in Writing'] }, metadata: { attachments: [{ id: 'file-project-note', name: 'note.txt' }] } }],
			});
			await expect(page.locator('.ash-chatgpt-widget')).toContainText('Synthetic answer');
			const writing = page.locator('.ash-chat-navigation-list').getByRole('button', { name: 'Writing', exact: true });
			await writing.press('ArrowRight');
			await expect(page.locator('[data-parent-project="project:g-p-writing"] .ash-chat-navigation-item')).toHaveText('Synthetic conversation');
			await back.click();
			await card('Research').click();
			await editor.waitForEditorContents(text => text === 'Research draft');
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
			let projectReads = 0;
			let failNewProjectMove = zh;
			await page.route('**/service/backend-api/**', async route => {
				const request = route.request();
				const url = new URL(request.url());
				if (url.pathname.endsWith('/gizmos/snorlax/sidebar')) {
					projectReads++;
					const next = url.searchParams.has('cursor');
					await route.fulfill({ json: { items: [{ gizmo: { id: next ? 'g-p-two' : 'g-p-one', display: { name: next ? 'Project Two' : 'Project One' } } }], cursor: next ? null : 'next' } });
				} else if (request.method() !== 'GET') {
					writes.push({ method: request.method(), path: url.pathname, ...(request.postData() ? { body: request.postDataJSON() } : {}) });
					if (failNewProjectMove && writes.at(-1)?.body?.gizmo_id === 'g-p-three') {
						failNewProjectMove = false;
						await route.fulfill({ status: 503 });
						return;
					}
					await route.fulfill({
						json: url.pathname.endsWith('/share/v2/create') ? { share_url: 'https://chatgpt.com/share/fixture-link' }
							: url.pathname.endsWith('/backend-api/projects') ? { gizmo: { id: 'g-p-three' } } : { success: true }
					});
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
			await row.hover();
			await expect(more).toHaveCSS('width', '32px');
			await expect(row).toHaveCSS('height', '36px');
			await window.evaluate(element => (element as HTMLElement).style.removeProperty('--ash-toolbar-actionSize'));
			for (const forcedColors of ['none', 'active'] as const) {
				await page.emulateMedia({ forcedColors });
				await row.hover();
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
			const unpin = row.getByRole('button', { name: labels.unpin, exact: true });
			await expect(unpin).toHaveAttribute('aria-pressed', 'true');
			await expect(page.locator('.ash-chat-navigation-item').first()).toHaveText('Synthetic conversation');
			await expect(page.locator('.ash-chat-item')).toHaveCount(0);
			const restingPinBackground = await unpin.evaluate(button => getComputedStyle(button).backgroundColor);
			const menu = page.getByRole('menu');
			await openMore();
			await expect(menu).toBeVisible();
			const editorBounds = (await page.locator('#editor').boundingBox())!;
			await page.mouse.click(editorBounds.x + editorBounds.width / 2, editorBounds.y + editorBounds.height / 2);
			await expect(menu).toBeHidden();
			await expect(toolbar).toHaveCSS('opacity', '0');

			await openMore();
			const rename = menu.getByRole('menuitem', { name: labels.rename, exact: true });
			await expect(menu).toBeFocused();
			await expect(menu).toHaveCSS('outline-style', 'none');
			const pinBounds = (await unpin.boundingBox())!;
			await page.mouse.move(pinBounds.x + pinBounds.width / 2, pinBounds.y + pinBounds.height / 2);
			await expect(unpin).toHaveCSS('background-color', restingPinBackground);
			await expect(menu).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(menu).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(rename).toBeFocused();
			const menuItems = menu.getByRole('menuitem');
			await expect(menu.getByRole('separator').or(menuItems)).toHaveText([labels.rename, '', labels.share, labels.move, '', labels.archive, labels.delete]);
			await expect(menuItems.locator('.ash-menu-leading-slot .ash-icon')).toHaveCount(5);
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
			await page.mouse.move(pinBounds.x + pinBounds.width / 2, pinBounds.y + pinBounds.height / 2);
			await page.mouse.down();
			await expect(rename).toBeFocused();
			await page.mouse.up();
			await expect(menu).toBeHidden();
			await expect(more).toBeFocused();
			await expect(unpin).toHaveAttribute('aria-pressed', 'true');
			await page.locator('#editor').hover();
			await expect(toolbar).toHaveCSS('opacity', '0');
			await expect(page.getByRole('button', { name: 'Project Two', exact: true })).toBeVisible();
			const readsBeforeMenu = projectReads;
			await title.click({ button: 'right' });
			await expect(page.getByRole('menuitem', { name: labels.move, exact: true })).toBeVisible();
			expect(projectReads).toBe(readsBeforeMenu);
			await page.getByRole('menuitem', { name: labels.move, exact: true }).focus();
			await page.keyboard.press('ArrowRight');
			const projectMenu = page.getByRole('menu', { name: labels.move, exact: true });
			const newProject = projectMenu.getByRole('menuitem', { name: zh ? '新建项目' : 'New project', exact: true });
			await expect(projectMenu.getByRole('menuitem')).toHaveText([zh ? '新建项目' : 'New project', 'Project One', 'Project Two']);
			await expect(projectMenu.getByRole('separator')).toHaveCount(1);
			await expect(projectMenu.getByRole('menuitem', { name: 'Project One', exact: true }).locator('.ash-menu-leading-slot [data-ash-icon-id="projects"]')).toBeVisible();
			await testInfo.attach('conversation-project-submenu', { body: await page.screenshot(), contentType: 'image/png' });
			await projectMenu.getByRole('menuitem', { name: 'Project Two', exact: true }).click();
			await expect.poll(() => writes.some(write => write.body?.gizmo_id === 'g-p-two')).toBe(true);
			const openProjectMenu = async () => {
				await openMore();
				await page.getByRole('menuitem', { name: labels.move, exact: true }).press('ArrowRight');
			};
			await openProjectMenu();
			await expect(projectMenu.getByRole('menuitem', { name: 'Project Two', exact: true })).toHaveCount(0);
			await newProject.press('Enter');
			const projectForm = page.getByRole('dialog', { name: zh ? '创建项目' : 'Create a project', exact: true });
			const projectName = projectForm.getByRole('textbox').first();
			const source = projectForm.getByRole('combobox', { name: zh ? '项目来源' : 'Project source', exact: true });
			await expect(source).toHaveValue('ChatGPT');
			await expect(source).toBeDisabled();
			await expect(projectName).toBeFocused();
			await projectName.press('Escape');
			await expect(projectForm).toBeHidden();
			expect(writes.filter(write => write.path.endsWith('/backend-api/projects'))).toHaveLength(0);
			await openProjectMenu();
			await newProject.press('Enter');
			await projectName.fill('  Project Three  ');
			await projectForm.getByRole('textbox', { name: zh ? '指令' : 'Instructions', exact: true }).fill('Keep track of sources.');
			await projectForm.getByRole('button', { name: zh ? '创建' : 'Create', exact: true }).click();
			await expect.poll(() => writes.slice(-2)).toEqual([
				{ method: 'POST', path: '/service/backend-api/projects', body: { name: 'Project Three', instructions: 'Keep track of sources.', emoji: null, theme: null } },
				{ method: 'PATCH', path: '/service/backend-api/conversation/fixture-chat', body: { gizmo_id: 'g-p-three' } },
			]);
			await expect(projectForm).toBeHidden();
			await expect(page.getByRole('button', { name: 'Project Three', exact: true })).toBeVisible();
			if (zh) {
				await expect.poll(() => historyNotices(page)).toContain('已创建“Project Three”。请从“移至项目”中选择该项目，再试一次。');
				await openProjectMenu();
				await projectMenu.getByRole('menuitem', { name: 'Project Three', exact: true }).click();
				await expect.poll(() => writes.filter(write => write.body?.gizmo_id === 'g-p-three')).toHaveLength(2);
				expect(writes.filter(write => write.path.endsWith('/backend-api/projects'))).toHaveLength(1);
			}
			await openMore();
			await page.getByRole('menuitem', { name: zh ? '从项目中移除' : 'Remove from project', exact: true }).click();
			await expect.poll(() => writes.some(write => write.body?.gizmo_id === null)).toBe(true);
			const recent = page.locator('.ash-chat-navigation-list [data-section="recent"] > h3 button');
			await row.dragTo(recent);
			await expect.poll(() => writes.some(write => write.body?.is_starred === false)).toBe(true);
			await expect(row).toHaveAttribute('data-parent-section', 'recent');
			const titleBounds = (await title.locator('.ash-sessions-list-label').boundingBox())!;
			await title.click({ button: 'right' });
			await page.getByRole('menuitem', { name: labels.rename, exact: true }).click();
			const name = row.getByRole('textbox', { name: zh ? '会话名称' : 'Session name', exact: true });
			await expect(name).toBeFocused();
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await page.locator('#editor').hover();
			await expect(toolbar).toBeHidden();
			await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(name).toHaveCSS('border-top-width', '0px');
			if (zh) {
				await expect(row).toHaveCSS('outline-style', 'solid');
			} else {
				await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			}
			const inputBounds = (await name.boundingBox())!;
			const rowBounds = (await row.boundingBox())!;
			expect(Math.abs(inputBounds.x - titleBounds.x)).toBeLessThanOrEqual(1);
			expect(Math.abs(inputBounds.y + inputBounds.height / 2 - titleBounds.y - titleBounds.height / 2)).toBeLessThanOrEqual(1);
			expect(inputBounds.y).toBeGreaterThanOrEqual(rowBounds.y);
			expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(rowBounds.y + rowBounds.height);
			expect(await name.evaluate(input => {
				const field = input as HTMLInputElement;
				return field.value.slice(field.selectionStart!, field.selectionEnd!);
			})).toBe('Synthetic conversation');
			await name.fill('  ');
			await name.press('Enter');
			await expect(name).toHaveAttribute('aria-invalid', 'true');
			await name.fill('Cancelled name');
			await name.press('Escape');
			await expect(name).toHaveCount(0);
			await expect(title).toBeFocused();
			expect(writes.some(write => write.path.endsWith('/rename'))).toBe(false);
			await openMore();
			await page.getByRole('menuitem', { name: labels.rename, exact: true }).click();
			await expect(name).toBeFocused();
			await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await name.fill('  Renamed conversation  ');
			await name.press('Enter');
			await expect(name).toHaveCount(0);
			await expect(title).toHaveText('Renamed conversation');
			await openMore();
			await page.getByRole('menuitem', { name: labels.share, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();
			await dialog.getByRole('button', { name: labels.share, exact: true }).click();
			await expect(page.locator('body')).toHaveAttribute('data-copied-link', 'https://chatgpt.com/share/fixture-link');
			await openMore();
			await page.getByRole('menuitem', { name: labels.delete, exact: true }).click();
			await expect(dialog).toContainText(zh ? '要永久删除“Renamed conversation”吗？' : 'Permanently delete Renamed conversation?');
			await dialog.getByRole('button', { name: labels.cancel, exact: true }).click();
			expect(writes.some(write => write.method === 'DELETE')).toBe(false);
			await expect(title).toBeVisible();
			await openMore();
			await page.getByRole('menuitem', { name: labels.archive, exact: true }).click();
			await dialog.getByRole('button', { name: labels.cancel, exact: true }).click();
			await expect(row).toBeVisible();
			expect(writes.some(write => write.body?.is_archived)).toBe(false);
			await openMore();
			await page.getByRole('menuitem', { name: labels.archive, exact: true }).click();
			await dialog.getByRole('button', { name: labels.archive, exact: true }).click();
			await expect(row).toHaveCount(0);
			const third = page.locator('.ash-chat-navigation-row[data-item="chatgpt:third"]');
			await third.hover();
			await third.getByRole('button', { name: labels.more, exact: true }).click();
			await page.getByRole('menuitem', { name: labels.delete, exact: true }).click();
			await dialog.getByRole('button', { name: zh ? '永久删除' : 'Delete permanently', exact: true }).click();
			await expect(third).toHaveCount(0);
			await expect(page.locator('.ash-chat-navigation-row .ash-chat-navigation-item')).toHaveText(['Other chat']);
			expect(writes.map(write => [write.method, write.path])).toEqual([
				['PATCH', '/service/backend-api/conversation/fixture-chat'], ['PATCH', '/service/backend-api/conversation/fixture-chat'],
				['POST', '/service/backend-api/projects'], ['PATCH', '/service/backend-api/conversation/fixture-chat'],
				...(zh ? [['PATCH', '/service/backend-api/conversation/fixture-chat']] : []),
				['PATCH', '/service/backend-api/conversation/fixture-chat'], ['PATCH', '/service/backend-api/conversation/fixture-chat'],
				['POST', '/service/backend-api/conversation/id/fixture-chat/rename'], ['POST', '/service/backend-api/share/v2/create'],
				['PATCH', '/service/backend-api/conversation/fixture-chat'], ['DELETE', '/service/backend-api/conversation/id/third'],
			]);
		});
	}
});
