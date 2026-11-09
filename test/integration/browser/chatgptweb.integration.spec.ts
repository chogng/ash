import { startMarkdownMathExtension, startMarkdownExtension } from '../../fixtures/markdownExtension.js';
import { chatGPTModelCatalog, simpleChatGPTModelCatalog } from '../../fixtures/chatGPTModels.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectVisibleFocusOutline } from '../../fixtures/browser/focusOutline.js';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
const preload = transpileModule(readFileSync(new URL('../../../src/ash/platform/browserView/electron-browser/preload-browserView.ts', import.meta.url), 'utf8'), {
	compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;
const rule = { origin: 'https://chatgpt.com', selector: '.ash-chatgpt-turn.complete' };
type TestHost = { configureRendering: (value: typeof rule | undefined) => void; };
// Fake-device flags alone can leave the local ICE candidates hidden.
const voiceTest = test.extend({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

async function fixture(page: Page, origin = rule.origin): Promise<void> {
	await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>body{margin:0;font:16px/1.5 sans-serif}main{width:70%;margin:auto}.turn{padding:16px;border-bottom:1px solid #ccc}p{margin:0}</style><main>${Array.from({ length: 100 }, (_, i) => `<section class="turn ash-chatgpt-turn complete"><p>${(`Synthetic reply ${i}. `).repeat(40)}</p><button>Copy ${i}</button></section>`).join('')}<section id="stream" class="ash-chatgpt-turn">Synthetic reply in progress</section></main>` }));
	await page.addInitScript(() => {
		Object.assign(window, {
			require: () => ({
				contextBridge: { exposeInIsolatedWorld() { } },
				ipcRenderer: {
					send() { }, on(_channel: string, listener: (event: unknown, data: unknown) => void) {
						(window as unknown as TestHost).configureRendering = rule => listener(undefined, { command: 'contentVisibility', data: rule });
					}
				},
			})
		});
	});
	await page.addInitScript(preload);
	await page.goto(`${origin}/c/synthetic`);
}

async function configure(page: Page, enabled: boolean): Promise<void> {
	await page.evaluate(rule => (window as unknown as TestHost).configureRendering(rule ?? undefined), enabled ? rule : null);
}

test('ChatGPT scrolling retains geometry, focus, completed replies and restores page styles', async ({ page }, testInfo) => {
	await fixture(page);
	const first = page.locator('.turn').first();
	const height = await page.evaluate(() => document.documentElement.scrollHeight);
	await configure(page, true);
	await expect(first).toHaveCSS('content-visibility', 'auto');
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
	await expect(page.locator('#stream')).toHaveCSS('content-visibility', 'visible');
	await page.locator('#stream').evaluate(element => element.classList.add('complete'));
	await expect(page.locator('#stream')).toHaveCSS('content-visibility', 'auto');
	const last = page.getByRole('button', { name: 'Copy 99', exact: true });
	await last.focus();
	await expect(last).toBeFocused();
	await expect(last).toBeInViewport();
	await testInfo.attach('retained-long-conversation', { body: await page.screenshot(), contentType: 'image/png' });
	const previousIntrinsicHeight = await first.evaluate(element => element.style.getPropertyValue('contain-intrinsic-height'));
	await page.setViewportSize({ width: 700, height: 600 });
	// Wait for remeasurement; the old containment can survive until the resize event runs.
	await expect(first).not.toHaveCSS('contain-intrinsic-height', previousIntrinsicHeight);
	await expect(first).toHaveCSS('content-visibility', 'auto');
	const resizedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
	await configure(page, false);
	await expect(first).toHaveCSS('content-visibility', 'visible');
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(resizedHeight);
	await expect(first).toHaveCSS('contain-intrinsic-height', 'none');
	await expect(page.getByRole('button', { name: /^Copy / })).toHaveCount(100);
});

test('ChatGPT rendering rules ignore other origins', async ({ page }) => {
	await fixture(page, 'https://chatgpt.com.example.test');
	await configure(page, true);
	await expect(page.locator('.turn').first()).toHaveCSS('content-visibility', 'visible');
});

test('ChatGPT rendering rules reset on print and SPA replacement', async ({ page }) => {
	await fixture(page);
	await configure(page, true);
	await expect(page.locator('.turn').first()).toHaveCSS('content-visibility', 'auto');
	await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
	await expect(page.locator('.turn').first()).toHaveCSS('content-visibility', 'visible');
	await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
	await expect(page.locator('.turn').first()).toHaveCSS('content-visibility', 'auto');
	await page.locator('main').evaluate(main => { main.innerHTML = '<section class="turn ash-chatgpt-turn complete">A different synthetic conversation</section>'; });
	await expect(page.locator('.turn')).toHaveCSS('content-visibility', 'auto');
	await configure(page, false);
	await expect(page.locator('.turn')).toHaveCSS('content-visibility', 'visible');
});

async function fillMessage(page: Page, text: string): Promise<void> {
	const input = page.getByRole('textbox', { name: /^(Ask ChatGPT|询问 ChatGPT)$/u });
	await input.focus();
	await input.press('ControlOrMeta+a');
	await page.keyboard.insertText(text);
	await expectDraft(page, text);
}

async function expectDraft(page: Page, text: string): Promise<void> {
	await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.draft())).toBe(text);
}

/** Exercise the actual page and client with synthetic HTTP boundaries, without a real account. */
async function mockChatGPTRequests(page: Page, answer = 'Synthetic answer'): Promise<void> {
	await page.route('**/service/**', async route => {
		const path = new URL(route.request().url()).pathname;
		const message = (id: string, role: string, text: string): object => ({ id, author: { role }, content: { content_type: 'text', parts: [text] } });
		if (path.endsWith('/models')) {
			await route.fulfill({ json: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]) });
		} else if (path.endsWith('/pins')) {
			await route.fulfill({ json: [] });
		} else if (path.endsWith('/gizmos/snorlax/sidebar')) {
			await route.fulfill({ json: { items: [], cursor: null } });
		} else if (path.endsWith('/conversations')) {
			await route.fulfill({ json: { items: [{ id: 'fixture-chat', title: 'Synthetic conversation' }], total: 1 } });
		} else if (path.endsWith('/conversation/fixture-chat')) {
			await route.fulfill({
				json: {
					title: 'Synthetic conversation', current_node: 'previous-reply', mapping: {
						question: { parent: null, message: message('question', 'user', 'Synthetic question') },
						empty: { parent: 'question', message: message('empty', 'assistant', '') },
						recap: { parent: 'empty', message: { id: 'recap', author: { role: 'assistant' }, content: { content_type: 'reasoning_recap', content: 'Thought for a few seconds' } } },
						whitespace: { parent: 'recap', message: message('whitespace', 'assistant', ' \n\t ') },
						'previous-reply': { parent: 'whitespace', message: message('previous-reply', 'assistant', answer) },
					}
				}
			});
		} else if (path.endsWith('/prepare')) {
			await route.fulfill({ json: { conduit_token: 'fixture-conduit' } });
		} else if (path.includes('/.headers/')) {
			await route.fulfill({ json: { 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-verification' } });
		} else {
			await route.fulfill({ status: 500, json: {} });
		}
	});
}

let math: Awaited<ReturnType<typeof startMarkdownMathExtension>> | undefined;
test.afterAll(async () => { await math?.dispose(); });
async function installMathProvider(page: Page): Promise<{ lists: number; renders: number; }> {
	const counters = { lists: 0, renders: 0 };
	math ??= await startMarkdownMathExtension();
	await page.route('**/__chat_math', async route => {
		try {
			if (route.request().method() === 'POST') {
				counters.renders++;
				await route.fulfill({ json: await math!.invoke('math.render.v2', 'receiveData', route.request().postDataJSON()) });
			} else {
				counters.lists++;
				await route.fulfill({
					json: {
						generation: 1, extensions: [{
							id: 'ash.markdown-math', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
							activationGeneration: 1, incarnation: 1, lifecycle: 'ready', stderr: '', failure: null, outputEvents: [], registrations: math!.registrations,
						}]
					}
				});
			}
		} catch (error) { await route.fulfill({ status: 503, json: { error: String(error) } }); }
	});
	return counters;
}

async function chatPage(page: Page, answer = 'Synthetic answer'): Promise<void> {
	await mockChatGPTRequests(page, answer);
	await page.goto('/chatgptNavigation.html');
	await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
	await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
	await expect(page.locator('.ash-chat-item-agentMessage')).toHaveCount(1);
}

test('ChatGPT sidebar fades long titles at rest and uses ellipsis in forced colors', async ({ page }) => {
	const longTitle = '侧栏分组与会话条目的交互设计以及长标题渐隐效果';
	await mockChatGPTRequests(page);
	await page.route('**/service/backend-api/conversations?*', route => route.fulfill({
		json: { items: [{ id: 'fixture-chat', title: longTitle }, { id: 'fixture-short', title: '短标题' }], total: 2 },
	}));
	await page.goto('/chatgptNavigation.html?locale=zh-CN&theme=light');
	const sidebar = page.locator('.ash-chat-navigation');
	const longLabel = sidebar.getByRole('button', { name: longTitle, exact: true }).locator('.ash-sessions-list-label');
	const shortLabel = sidebar.getByRole('button', { name: '短标题', exact: true }).locator('.ash-sessions-list-label');

	await expect(longLabel).toHaveCSS('text-overflow', 'clip');
	await expect(longLabel).toHaveCSS('mask-image', /^linear-gradient/);
	await expect(shortLabel).toHaveCSS('mask-image', 'none');

	await page.emulateMedia({ forcedColors: 'active' });
	await expect(longLabel).toHaveCSS('text-overflow', 'ellipsis');
	await expect(longLabel).toHaveCSS('mask-image', 'none');
});

test('ChatGPT sidebar groups align rows and keep the selected background when showing actions', async ({ page }, testInfo) => {
	await mockChatGPTRequests(page);
	await page.route('**/service/backend-api/pins?*', route => route.fulfill({
		json: [{ item: { id: 'fixture-pinned', title: '整理本周的设计反馈' } }],
	}));
	await page.route('**/service/backend-api/conversations?*', route => route.fulfill({
		json: {
			items: [
				{ id: 'fixture-other', title: '项目里的调研笔记', gizmo_id: 'g-p-other' },
				{ id: 'fixture-chat', title: '侧栏分组与会话条目的交互设计' },
				{ id: 'fixture-recent', title: '准备下一次设计评审' },
			], total: 3
		},
	}));
	await page.setViewportSize({ width: 960, height: 300 });
	await page.goto('/chatgptNavigation.html?locale=zh-CN&theme=light');
	const sidebar = page.locator('.ash-chat-navigation');
	const projectsHeader = sidebar.locator('[data-section="projects"]');
	await expect(projectsHeader).toBeVisible();
	await expect(sidebar.locator('[data-item="chatgpt:fixture-other"]')).toHaveCount(0);
	const row = sidebar.locator('[data-item="chatgpt:fixture-chat"].ash-chat-navigation-row');
	const sessionIcon = '[data-ash-icon-id="chat-session"]';
	await expect(sidebar.locator('[data-item="chatgpt:fixture-pinned"]').locator(sessionIcon)).toBeVisible();
	await expect(row.locator(sessionIcon)).toBeVisible();
	await expect(row.locator('.ash-session-leading-icon button')).toHaveCSS('border-radius', '6px');
	const conversationTreeRow = row.locator('xpath=ancestor::*[@role="treeitem"][1]');
	const item = row.locator('.ash-chat-navigation-item');
	const actions = row.locator('.ash-sessions-list-actions');
	const recent = sidebar.locator('[data-section="recent"]');
	const pinnedHeader = sidebar.getByRole('button', { name: '置顶', exact: true });
	const recentHeader = recent.getByRole('button', { name: '最近使用', exact: true });
	await expect(recentHeader).toBeVisible();
	await expect.poll(() => recent.evaluate(group => {
		const header = group.querySelector('.ash-sessions-list-section-toggle')!.getBoundingClientRect();
		const treeRow = group.closest('.ash-tree-row')!;
		const [first, second] = treeRow.parentElement!.querySelectorAll('[data-parent-section="recent"]');
		const a = first!.getBoundingClientRect();
		const b = second!.getBoundingClientRect();
		const previous = treeRow.previousElementSibling!.getBoundingClientRect();
		return [header.height, a.height, a.top - header.bottom, b.top - a.bottom, header.top - previous.bottom];
	})).toEqual([32, 32, 2, 2, 8]);
	const headerBounds = (await recentHeader.boundingBox())!;
	const rowBounds = (await conversationTreeRow.boundingBox())!;
	expect([rowBounds.x, rowBounds.width]).toEqual([headerBounds.x, headerBounds.width]);
	// The content clears the scrollbar track while the outer row still aligns with the header.
	expect(await row.evaluate(element => {
		const treeRow = element.closest('.ash-tree-row')!;
		const scrollable = element.closest<HTMLElement>('.ash-list-scrollable')!;
		const trackSize = '--ash-scrollbar-vertical-size';
		const originalSize = scrollable.style.getPropertyValue(trackSize);
		const clearance = () => treeRow.getBoundingClientRect().right - element.getBoundingClientRect().right;
		const normal = clearance();
		scrollable.style.setProperty(trackSize, '14px');
		try {
			return [normal, clearance()];
		} finally {
			scrollable.style.setProperty(trackSize, originalSize);
		}
	})).toEqual([2, 6]);
	await pinnedHeader.click();
	await expect(pinnedHeader).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(async () => {
		const pinned = (await pinnedHeader.boundingBox())!;
		const projects = (await projectsHeader.boundingBox())!;
		const recent = (await recentHeader.boundingBox())!;
		return [projects.y - pinned.y, recent.y - projects.y];
	}).toEqual([40, 40]);
	await pinnedHeader.click();
	await expect(pinnedHeader).toHaveAttribute('aria-expanded', 'true');

	const transparent = 'rgba(0, 0, 0, 0)';
	const rowBackground = () => conversationTreeRow.evaluate(element => getComputedStyle(element).backgroundColor);
	const resting = await rowBackground();
	await item.hover();
	const hovered = await rowBackground();
	expect(hovered).not.toBe(resting);
	await expect(actions).toHaveCSS('opacity', '1');
	await expect(item).toHaveCSS('background-color', transparent);
	await expect(actions).toHaveCSS('background-color', transparent);
	await expect(actions).toHaveCSS('background-image', 'none');
	await testInfo.attach('sidebar-unselected-hover', { body: await sidebar.screenshot(), contentType: 'image/png' });
	await item.click();
	await expect(item).toHaveAttribute('aria-current', 'page');
	await page.mouse.move(350, 1);
	await expect(actions).toHaveCSS('opacity', '0');
	const selected = await rowBackground();
	expect(selected).not.toBe(hovered);
	const navigationStyle = await item.evaluate(element => {
		const document = element.ownerDocument;
		const navigation = document.createElement('div');
		navigation.className = 'ash-sessions-activity-content labeled ash-sessions-navigation';
		const button = document.createElement('button');
		button.className = 'ash-sessions-activity-item selected';
		navigation.append(button);
		element.closest('.ash-sessions-window')!.append(navigation);
		try {
			const style = getComputedStyle(button);
			const { backgroundColor, height, borderRadius } = style;
			button.style.backgroundColor = `color-mix(in srgb, ${backgroundColor} 50%, transparent)`;
			return { backgroundColor, height, borderRadius, hoverBackground: style.backgroundColor };
		} finally {
			navigation.remove();
		}
	});
	expect(selected).toBe(navigationStyle.backgroundColor);
	expect(hovered).toBe(navigationStyle.hoverBackground);
	expect(navigationStyle.borderRadius).toBe('6px');
	await expect(item).toHaveCSS('height', navigationStyle.height);
	await expect(item).toHaveCSS('border-radius', navigationStyle.borderRadius);
	await expect(item).toHaveCSS('background-color', transparent);
	await expect.poll(() => conversationTreeRow.evaluate(element => {
		const row = element.getBoundingClientRect();
		const host = element.closest('.ash-chat-navigation')!.getBoundingClientRect();
		return [row.left - host.left, host.right - row.right];
	})).toEqual([8, 8]);
	await testInfo.attach('sidebar-rest', { body: await sidebar.screenshot(), contentType: 'image/png' });
	await item.hover();
	await expect(actions).toHaveCSS('opacity', '1');
	await expect.poll(rowBackground).toBe(selected);
	await expect(item).toHaveCSS('background-color', transparent);
	await expect(actions).toHaveCSS('background-color', transparent);
	await expect(actions).toHaveCSS('background-image', 'none');
	await expect(actions.locator('[data-action-id]')).toHaveCount(2);
	await expect(actions.getByRole('button').last()).toHaveAccessibleName('更多操作');
	for (const button of await actions.getByRole('button').all()) {
		await expect(button).toHaveCSS('border-radius', '6px');
	}
	await expect.poll(() => actions.evaluate(element => {
		const centerY = (node: Element): number => {
			const bounds = node.getBoundingClientRect();
			return bounds.top + bounds.height / 2;
		};
		const rowCenter = centerY(element.closest('.ash-tree-row')!);
		return [...element.querySelectorAll('button')].map(button => centerY(button) - rowCenter);
	})).toEqual([0, 0]);
	await expect.poll(async () => {
		const bounds = (await conversationTreeRow.boundingBox())!;
		const more = (await actions.locator('button').last().boundingBox())!;
		return bounds.x + bounds.width - more.x - more.width;
	}).toBe(2);
	await actions.locator('button').first().hover();
	await testInfo.attach('sidebar-hover', { body: await sidebar.screenshot(), contentType: 'image/png' });

	await page.mouse.move(350, 1);
	await item.press('Shift+F10');
	const more = actions.getByRole('button', { name: '更多操作', exact: true });
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('menuitem', { name: '重命名' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(item).toBeFocused();
	await item.click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: '重命名' })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.emulateMedia({ forcedColors: 'active' });
	await expect(conversationTreeRow).toHaveCSS('outline-style', 'solid');
	await expect(conversationTreeRow).toHaveCSS('outline-width', '1px');
});

test('ChatGPT sidebar icon picker selects, persists and resets a conversation icon', async ({ page }, testInfo) => {
	await mockChatGPTRequests(page);
	await page.setViewportSize({ width: 900, height: 520 });
	await page.goto('/chatgptNavigation.html?locale=zh-CN&theme=light');
	const row = page.locator('.ash-chat-navigation-row[data-item="chatgpt:fixture-chat"]');
	const title = row.getByRole('button', { name: 'Synthetic conversation', exact: true });
	const trigger = row.getByRole('button', { name: '更换「Synthetic conversation」的图标' });
	const picker = page.getByRole('dialog', { name: '更换图标', exact: true });
	const search = picker.getByRole('combobox', { name: '搜索图标' });
	const defaultIcon = trigger.locator('[data-ash-icon-id="chat-session"]');
	await expect(defaultIcon).toBeVisible();
	await expect(defaultIcon).toHaveCSS('width', '18px');
	await expect.poll(async () => {
		const bounds = (await row.boundingBox())!;
		const button = (await trigger.boundingBox())!;
		return [button.x - bounds.x, button.y - bounds.y, button.width, button.height];
	}).toEqual([7, 2, 28, 28]);
	const moreAction = row.locator('.ash-sessions-list-actions button').last();
	await title.hover();
	await moreAction.hover();
	const actionHover = await moreAction.evaluate(button => getComputedStyle(button).backgroundColor);
	expect(actionHover).not.toBe('rgba(0, 0, 0, 0)');
	await trigger.hover();
	await expect(trigger).toHaveCSS('background-color', actionHover);
	await trigger.press('Enter');
	await expect(search).toBeFocused();
	await testInfo.attach('sidebar-icon-picker', { body: await page.screenshot(), contentType: 'image/png' });
	await search.fill('folder');
	await expect(picker.getByRole('option', { name: 'folder', exact: true })).toBeVisible();
	await picker.getByRole('option', { name: 'folder', exact: true }).click();
	await expect(picker).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(trigger.locator('[data-ash-icon-id="folder"]')).toBeVisible();
	await expect(title).not.toHaveAttribute('aria-current');
	let releaseHistory!: () => void;
	const holdHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
	await page.route('**/service/backend-api/conversation/fixture-chat', async route => {
		await holdHistory;
		await route.fallback();
	}, { times: 1 });
	try {
		await title.click();
		const spinner = trigger.locator('.ash-pixel-spinner');
		await expect(spinner).toBeVisible();
		await expect(row.getByRole('button', { name: /Synthetic conversation.*正在加载/u })).toBeVisible();

		await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('workbench.reduceMotion', 'on'));
		await expect(spinner).toHaveCount(0);
		await expect(trigger.locator('[data-ash-icon-id="sync"]')).toBeVisible();
		await expect(trigger.locator('.ash-session-status-icon-layer')).toHaveCount(1);
		expect(await trigger.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);

		await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('workbench.reduceMotion', 'off'));
		await expect(spinner).toBeVisible();
	} finally {
		releaseHistory();
	}
	await expect(trigger.locator('[data-ash-icon-id="folder"]')).toBeVisible();
	await expect(trigger.locator('.ash-pixel-spinner')).toHaveCount(0);
	await expect(trigger.locator('.ash-session-status-icon-layer')).toHaveCount(1);
	await expect(title).toHaveAttribute('aria-current', 'page');
	await page.evaluate(() => window.ashChatGPTIntegration.setAshChatSelected(true));
	await expect(title).not.toHaveAttribute('aria-current');
	await page.evaluate(() => window.ashChatGPTIntegration.setAshChatSelected(false));
	await expect(title).toHaveAttribute('aria-current', 'page');
	await page.reload();
	await expect(trigger.locator('[data-ash-icon-id="folder"]')).toBeVisible();
	await trigger.click();
	await search.press('Escape');
	await expect(trigger).toBeFocused();
	await expect(trigger.locator('[data-ash-icon-id="folder"]')).toBeVisible();
	await trigger.click();
	await picker.getByRole('button', { name: '恢复默认图标' }).click();
	await expect(trigger.locator('[data-ash-icon-id="chat-session"]')).toBeVisible();
	await page.reload();
	await expect(trigger.locator('[data-ash-icon-id="chat-session"]')).toBeVisible();
});

test('Chat and Work row icons persist independently without a provider write', async ({ page }) => {
	await mockChatGPTRequests(page);
	const writes: string[] = [];
	page.on('request', request => {
		if (new URL(request.url()).pathname.includes('/service/backend-api/conversation') && request.method() !== 'GET') {
			writes.push(request.method());
		}
	});
	await page.goto('/chatgptNavigation.html?locale=zh-CN&workRow');
	const trigger = page.getByRole('button', { name: '更换「Synthetic Work」的图标' });
	const picker = page.getByRole('dialog', { name: '更换图标', exact: true });
	await expect(trigger.locator('[data-ash-icon-id="cowork"]')).toBeVisible();
	await trigger.click();
	await picker.getByRole('combobox', { name: '搜索图标' }).fill('folder');
	await picker.getByRole('option', { name: 'folder', exact: true }).click();
	await page.reload();
	await expect(trigger.locator('[data-ash-icon-id="folder"]')).toBeVisible();
	const chat = page.getByRole('button', { name: '更换「Synthetic conversation」的图标' });
	await expect(chat.locator('[data-ash-icon-id="chat-session"]')).toBeVisible();
	await chat.click();
	await picker.getByRole('combobox', { name: '搜索图标' }).fill('clockface');
	await picker.getByRole('option', { name: 'clockface', exact: true }).click();
	await page.reload();
	await expect(chat.locator('[data-ash-icon-id="clockface"]')).toBeVisible();
	await expect(trigger.locator('[data-ash-icon-id="folder"]')).toBeVisible();
	await chat.click();
	await picker.getByRole('button', { name: '恢复默认图标' }).click();
	await page.reload();
	await expect(chat.locator('[data-ash-icon-id="chat-session"]')).toBeVisible();
	await expect(trigger.locator('[data-ash-icon-id="folder"]')).toBeVisible();
	expect(writes).toEqual([]);
});

test('ChatGPT dictation inserts text at the cursor and cancels on navigation without sending', async ({ page }) => {
	await mockChatGPTRequests(page);
	await page.goto('/chatgptNavigation.html?dictation=1&locale=en');
	const input = page.getByRole('textbox', { name: /^(Ask ChatGPT|询问 ChatGPT)$/u });
	const mic = page.getByRole('button', { name: 'Dictate message', exact: true });
	await expect(input).toBeEnabled();
	await fillMessage(page, 'Please explain');
	await input.press('Home');
	await mic.click();
	const stop = page.getByRole('button', { name: 'Stop dictation', exact: true });
	await expect(stop).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashChatGPTIntegration.dictate('interim speech', false));
	await expect(page.locator('.ash-chatgpt-widget .ash-chat-dictation-preview')).toHaveText('interim speech');
	await expectDraft(page, 'Please explain');
	await page.evaluate(() => window.ashChatGPTIntegration.dictate('First ', true));
	await stop.click();
	await expectDraft(page, 'First Please explain');
	await expect(input).toBeFocused();
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	await mic.click();
	await expect(stop).toHaveAttribute('aria-pressed', 'true');
	await input.focus();
	await input.press('Escape');
	await expect(mic).toHaveAttribute('aria-pressed', 'false');
	await expectDraft(page, 'First Please explain');
	await expect(page.locator('.ash-chatgpt-widget .ash-chat-dictation-preview')).toBeHidden();
	await mic.click();
	await expect(stop).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashChatGPTIntegration.newChat());
	await expect(mic).toHaveAttribute('aria-pressed', 'false');
	await page.evaluate(() => window.ashChatGPTIntegration.dictate('late new-chat speech', true));
	await expectDraft(page, 'First Please explain');
	await mic.click();
	await expect(stop).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
	await expectDraft(page, '');
	await page.evaluate(() => window.ashChatGPTIntegration.dictate('late old speech', true));
	await expectDraft(page, '');
	await mic.click();
	await expect(stop).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashChatGPTIntegration.setVisible(false));
	await expect(mic).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.dictationStops())).toBe(5);
	await expectDraft(page, '');
});

test('ChatGPT Send finishes dictation before submitting the final transcript', async ({ page }) => {
	await mockChatGPTRequests(page);
	let submitted: string | undefined;
	await page.route('**/service/backend-api/f/conversation', async route => {
		submitted = route.request().postDataJSON().messages[0].content.parts[0];
		await route.fulfill({ status: 500, json: {} });
	});
	await page.goto('/chatgptNavigation.html?dictation=1&locale=en');
	await expect(page.locator('.ash-chat-input-editor').getByRole('textbox')).toBeEnabled();
	await page.getByRole('button', { name: 'Dictate message', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Send', exact: true }).click();
	await expect.poll(() => submitted).toBe('final words');
	await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.dictationStops())).toBe(1);
});

test('ChatGPT uploads images and documents, waits for readiness and preserves attachments on rejection', async ({ page }) => {
	await mockChatGPTRequests(page);
	const uploads: { name: string; useCase: string; bytes?: Buffer; }[] = [];
	let releaseImage!: () => Promise<void>;
	let submitted: { messages: { content: { content_type: string; parts: unknown[]; }; metadata: { attachments: { id: string; name: string; }[]; }; }[]; } | undefined;
	await page.route('**/service/backend-api/files', async route => {
		const body = route.request().postDataJSON();
		uploads.push({ name: body.file_name, useCase: body.use_case });
		await route.fulfill({ json: { file_id: body.file_name.endsWith('.png') ? 'file_image' : 'file_document', upload_url: `https://files.oaiusercontent.com/${body.file_name}?signature=fixture` } });
	});
	await page.route('**/service/.upload?*', async route => {
		const url = new URL(new URL(route.request().url()).searchParams.get('url')!);
		const upload = uploads.find(item => url.pathname.endsWith(item.name))!;
		upload.bytes = route.request().postDataBuffer()!;
		if (upload.name.endsWith('.png')) { releaseImage = () => route.fulfill({ status: 201, body: '' }); }
		else { await route.fulfill({ status: 201, body: '' }); }
	});
	await page.route('**/service/backend-api/files/*/uploaded', route => route.fulfill({ json: { status: 'success' } }));
	await page.route('**/service/backend-api/f/conversation', async route => { submitted = route.request().postDataJSON(); await route.fulfill({ status: 403, json: {} }); });
	await page.goto('/chatgptNavigation.html?locale=en');
	const composer = page.locator('.ash-chat-input-container');
	await expect(composer.getByRole('button', { name: 'Attach files', exact: true })).toBeEnabled();
	const image = Buffer.from(await page.evaluate(() => {
		const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
		return canvas.toDataURL('image/png').split(',')[1]!;
	}), 'base64');
	await composer.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Selected file content') });
	await composer.evaluate((element, bytes) => {
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File([new Uint8Array(bytes)], 'pixel.png', { type: 'image/png' }));
		element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
	}, [...image]);
	await expect.poll(() => typeof releaseImage).toBe('function');
	const attachments = page.getByRole('list', { name: 'Attachments' });
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
	await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
	await releaseImage();
	await expect(attachments.getByText('Ready', { exact: true })).toHaveCount(2);
	expect(uploads.find(item => item.name === 'notes.txt')?.bytes?.toString()).toBe('Selected file content');
	expect(uploads.find(item => item.name === 'notes.txt')?.useCase).toBe('ace_upload');
	expect(uploads.find(item => item.name === 'pixel.png')?.useCase).toBe('multimodal');
	expect(uploads.find(item => item.name === 'pixel.png')?.bytes).toEqual(image);
	await composer.getByRole('button', { name: 'Send', exact: true }).click();
	await expect.poll(() => submitted?.messages[0]?.content.content_type).toBe('multimodal_text');
	expect(submitted!.messages[0]!.metadata.attachments.map(item => item.name)).toEqual(['notes.txt', 'pixel.png']);
	expect(submitted!.messages[0]!.content.parts).toEqual([{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file_image', size_bytes: image.byteLength, width: 1, height: 1 }]);
	await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
});

test('ChatGPT retries failed uploads and keeps removed or old-draft files out of the active draft', async ({ page }) => {
	await mockChatGPTRequests(page);
	let attempts = 0;
	let release!: () => Promise<void>;
	await page.route('**/service/backend-api/files', async route => {
		if (++attempts === 1) { await route.fulfill({ status: 500, json: {} }); return; }
		await route.fulfill({ json: { file_id: 'file_retry', upload_url: 'https://files.oaiusercontent.com/retry?signature=fixture' } });
	});
	await page.route('**/service/.upload?*', route => { release = async () => { await route.fulfill({ status: 201, body: '' }).catch(() => { }); }; });
	await page.route('**/service/backend-api/files/*/uploaded', route => route.fulfill({ json: { status: 'success' } }));
	await page.goto('/chatgptNavigation.html?locale=en');
	await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toBeEnabled();
	await page.locator('input[type=file]').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('Retry this file') });
	await page.getByRole('button', { name: 'Retry retry.txt', exact: true }).click();
	await expect.poll(() => typeof release).toBe('function');
	await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
	await expect(page.getByRole('list', { name: 'Attachments' })).toBeHidden();
	await page.evaluate(() => window.ashChatGPTIntegration.newChat());
	await expect(page.getByRole('list', { name: 'Attachments' })).toContainText('retry.txt');
	await page.getByRole('button', { name: 'Remove retry.txt', exact: true }).click();
	await release();
	await expect(page.getByRole('list', { name: 'Attachments' })).toBeHidden();
	await expect(page.locator('.ash-chat-input-editor').getByRole('textbox')).toBeFocused();
	expect(attempts).toBe(2);
});

voiceTest('ChatGPT can stop pending voice negotiation and rejects a late or invalid SDP answer', async ({ page }) => {
	await mockChatGPTRequests(page);
	let release!: () => Promise<void>;
	let requests = 0;
	await page.route('**/service/realtime/vp**', route => {
		requests++;
		release = async () => { await route.fulfill({ contentType: 'application/sdp', body: 'Invalid SDP answer' }).catch(() => { }); };
	});
	await page.goto('/chatgptNavigation.html?locale=en');
	const voice = page.getByRole('button', { name: 'Voice conversation', exact: true });
	const placeholder = page.locator('.ash-chat-input-editor .stanza-editor-placeholder-text');
	await expect(voice).toBeEnabled();
	await expect(placeholder).toHaveText('Describe a task or ask a question');
	await page.evaluate(() => {
		const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async () => {
			navigator.mediaDevices.getUserMedia = capture;
			throw new DOMException('Permission denied', 'NotAllowedError');
		};
	});
	const notifications = () => page.evaluate(() => window.ashChatGPTIntegration.notifications().map(item => item.message));
	await voice.click();
	await expect.poll(notifications).toContain('Microphone access was denied. Allow microphone access in your system or browser settings, then try again.');
	await expect(voice).toBeEnabled();
	await expect(placeholder).toHaveText('Describe a task or ask a question');
	await expect(page.locator('.ash-chat-input-notification-message')).toBeHidden();
	expect(requests).toBe(0);
	await voice.click();
	await expect.poll(() => requests).toBe(1);
	await expect(placeholder).toHaveText('Connecting…');
	await expect(page.locator('.ash-chat-status')).toBeHidden();
	await expect(page.locator('.ash-chat-input-editor').getByRole('textbox')).toHaveAttribute('aria-readonly', 'true');
	const cancel = page.getByRole('button', { name: 'Cancel voice connection', exact: true });
	await expect(cancel).toHaveText('Cancel');
	const dots = cancel.locator('.ash-chat-input-voice-connecting-dots > span');
	await expect(dots).toHaveCount(3);
	await expect(dots.first()).toHaveCSS('animation-name', 'ash-chat-input-voice-dot');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(dots.first()).toHaveCSS('animation-name', 'none');
	await cancel.press('Enter');
	await release();
	await expect(voice).toBeEnabled();
	await expect(placeholder).toHaveText('Describe a task or ask a question');
	await expect(page.locator('.ash-chat-status')).toBeHidden();
	await voice.click();
	await expect.poll(() => requests).toBe(2);
	await release();
	await expect.poll(notifications).toEqual(expect.arrayContaining([expect.stringContaining('unsupported response')]));
	await expect(page.locator('.ash-chat-input-notification-message')).toBeHidden();
	await expect(voice).toBeEnabled();
});

voiceTest('ChatGPT WebRTC exchanges audio and releases the microphone on stop and navigation', async ({ context, page }) => {
	voiceTest.setTimeout(60_000);
	await context.addInitScript(() => {
		if (!navigator.mediaDevices) return;
		const tracks: MediaStreamTrack[] = [];
		Object.assign(window, { testMediaTracks: tracks });
		const createDataChannel = RTCPeerConnection.prototype.createDataChannel;
		RTCPeerConnection.prototype.createDataChannel = function (label, options) {
			const channel = createDataChannel.call(this, label, options);
			channel.addEventListener('message', event => {
				document.documentElement.dataset.testVoiceFrame = JSON.parse(event.data).type;
			});
			return channel;
		};
		const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async constraints => {
			const stream = await capture(constraints);
			tracks.push(...stream.getTracks());
			return stream;
		};
	});
	const peer = await context.newPage();
	await mockChatGPTRequests(peer);
	await peer.goto('/chatgptNavigation.html?locale=en');
	// The remote peer answers the real client's SDP and negotiated data channel;
	// only the HTTP service boundary is synthetic.
	const remote = await peer.evaluateHandle(() => {
		const resources: { peer: RTCPeerConnection; channel: RTCDataChannel; stream: MediaStream; audio: HTMLAudioElement; }[] = [];
		return {
			async answer(sdp: string): Promise<string> {
				const peer = new RTCPeerConnection();
				const channel = peer.createDataChannel('', { negotiated: true, id: 0 });
				const audio = document.createElement('audio');
				audio.autoplay = true;
				document.body.append(audio);
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				resources.push({ peer, channel, stream, audio });
				for (const track of stream.getTracks()) peer.addTrack(track, stream);
				peer.ontrack = event => { if (event.track.kind === 'audio') audio.srcObject = new MediaStream([event.track]); };
				await peer.setRemoteDescription({ type: 'offer', sdp });
				await peer.setLocalDescription(await peer.createAnswer());
				if (peer.iceGatheringState !== 'complete') {
					await new Promise<void>(resolve => {
						const gathered = (): void => {
							if (peer.iceGatheringState !== 'complete') return;
							peer.removeEventListener('icegatheringstatechange', gathered);
							resolve();
						};
						peer.addEventListener('icegatheringstatechange', gathered);
					});
				}
				return peer.localDescription!.sdp;
			},
			state(): { connection: string; ice: string; channel: string; }[] {
				return resources.map(({ peer, channel }) => ({ connection: peer.connectionState, ice: peer.iceConnectionState, channel: channel.readyState }));
			},
			send(frame: unknown): void {
				resources.at(-1)!.channel.send(JSON.stringify(frame));
			},
			dispose(): boolean {
				for (const { peer, channel, stream, audio } of resources) {
					peer.ontrack = null;
					channel.close();
					peer.close();
					for (const track of stream.getTracks()) track.stop();
					audio.pause();
					audio.srcObject = null;
					audio.remove();
				}
				return resources.length > 0 && resources.every(({ stream }) => stream.getTracks().every(track => track.readyState === 'ended'));
			},
		};
	});
	try {
		await mockChatGPTRequests(page);
		const utterance = { id: 'voice-prompt', author: { role: 'user' }, content: { content_type: 'text', parts: ['Synthetic voice prompt'] } };
		await page.route('**/service/backend-api/conversation/voice-room', route => route.fulfill({
			json: { title: 'Synthetic voice conversation', current_node: utterance.id, mapping: { [utterance.id]: { parent: null, message: utterance } } },
		}));
		let negotiations = 0;
		await page.route('**/service/realtime/vp**', async route => {
			const request = route.request();
			const form = await new Response(request.postData()!, { headers: { 'Content-Type': request.headers()['content-type']! } }).formData();
			const offer = form.get('sdp');
			expect(typeof offer).toBe('string');
			expect(offer).toMatch(/^v=0\r?\n/u);
			const answer = await remote.evaluate((remote, offer) => remote.answer(offer), String(offer));
			negotiations++;
			await route.fulfill({ contentType: 'application/sdp', body: answer });
		});
		await page.goto('/chatgptNavigation.html?locale=en');
		const voice = page.getByRole('button', { name: 'Voice conversation', exact: true });
		const welcome = page.locator('.ash-chatgpt-widget .ash-chat-welcome');
		const placeholder = page.locator('.ash-chat-input-editor .stanza-editor-placeholder-text');
		const room = { type: 'startup_telemetry', payload: { conversation_id: 'voice-room' } };
		await expect(welcome).toBeVisible();
		await voice.click();
		const connectedPeer = { connection: 'connected', ice: expect.stringMatching(/^(connected|completed)$/u), channel: 'open' };
		await expect.poll(() => remote.evaluate(remote => remote.state())).toEqual([connectedPeer]);
		await expect(page.locator('.ash-chat-status')).toBeHidden();
		const stop = page.getByRole('button', { name: 'Stop voice conversation', exact: true });
		await expect(stop).toHaveText('Stop');
		await expect(stop.locator('.ash-chat-input-voice-connecting-dots > span')).toHaveCount(3);
		await expect(placeholder).toHaveText('Listening…');
		await remote.evaluate((remote, room) => remote.send(room), room);
		await expect(page.locator('html')).toHaveAttribute('data-test-voice-frame', room.type);
		await expect(welcome).toBeVisible();
		await expect(page.getByRole('button', { name: 'Cancel voice connection', exact: true })).toHaveCount(0);
		await expect(page.locator('audio')).toHaveCount(1);
		for (const participant of [page, peer]) {
			await expect.poll(() => participant.evaluate(() => [...document.querySelectorAll('audio')].some(audio => audio.readyState >= 2 && !audio.paused))).toBe(true);
		}
		const microphoneStates = (): Promise<MediaStreamTrackState[]> => page.evaluate(() => {
			const tracks = (window as unknown as { testMediaTracks: MediaStreamTrack[]; }).testMediaTracks;
			return tracks.map(track => track.readyState);
		});
		await expect.poll(microphoneStates).toEqual(['live']);
		await stop.click();
		await expect.poll(microphoneStates).toEqual(['ended']);
		await expect(page.locator('audio')).toHaveCount(0);
		await expect(voice).toBeEnabled();
		await expect(placeholder).toHaveText('Describe a task or ask a question');
		await voice.click();
		await expect.poll(() => remote.evaluate(remote => remote.state())).toEqual([expect.anything(), connectedPeer]);
		await expect(page.locator('.ash-chat-status')).toBeHidden();
		expect(negotiations).toBe(2);
		await expect.poll(microphoneStates).toEqual(['ended', 'live']);
		await remote.evaluate((remote, { room, utterance }) => {
			remote.send(room);
			remote.send({ type: 'full_chat_message', payload: { message: utterance } });
		}, { room, utterance });
		await expect(page.locator('.ash-chat-item-voiceTranscript')).toContainText('Synthetic voice prompt');
		await expect(welcome).toBeHidden();
		// The host can navigate while the in-chat New button is disabled during voice.
		await page.evaluate(() => window.ashChatGPTIntegration.newChat());
		await expect.poll(microphoneStates).toEqual(['ended', 'ended']);
		await expect(page.locator('audio')).toHaveCount(0);
		await expect(page.locator('.ash-chat-status')).toBeHidden();
	} finally {
		try { expect(await remote.evaluate(remote => remote.dispose())).toBe(true); }
		finally { await remote.dispose(); await peer.close(); }
	}
});

test('ChatGPT rich diagrams retain their nested content without enabling HTML or scripts', async ({ page }, testInfo) => {
	const diagram = `<box border radius="lg" padding={3} gap={2}>
  <box background="surface-secondary" radius="md" padding={3} align="center" gap={1}>
    **Ash editor (TypeScript)**
    <text color="secondary" size="xs">Python input</text>
  </box>
  <row justify="center"><icon name="arrow-down" color="secondary" size="lg"/></row>
  <box background="rgba(26,127,83,0.07)" border={{size:1,color:"rgba(26,127,83,0.35)"}} radius="md" padding={3} align="center" gap={1}>
    **Tree-sitter Rust**
    <text color="secondary" size="xs">Analyze the code in Rust</text>
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box padding={3} align="center">**Syntax colors**</box>
</box>`;
	await chatPage(page, `Before the diagram.\n\n${diagram}\n\nAfter the diagram.\n\n\`<box border>literal example</box>\`\n\n<box onclick="globalThis.auditXss = true" background="url(https://audit-image.invalid/pixel)"><text>Safe text</text><script>globalThis.auditXss = true</script><img src="https://audit-image.invalid/pixel"></box>`);
	const body = page.locator('.ash-chat-item-agentMessage .ash-chat-markdown-part');
	const root = body.locator('.ash-chat-rich-box').first();
	await expect(root).toHaveCSS('display', 'flex');
	await expect(root).toHaveCSS('flex-direction', 'column');
	await expect(root).toHaveCSS('padding-top', '12px');
	await expect(root.locator('.ash-chat-rich-box')).toHaveCount(3);
	await expect(root.locator('strong')).toHaveText(['Ash editor (TypeScript)', 'Tree-sitter Rust', 'Syntax colors']);
	await expect(root.locator('.ash-chat-rich-text')).toHaveText(['Python input', 'Analyze the code in Rust']);
	await expect(root.locator('.ash-chat-rich-icon')).toHaveText(['↓', '↓']);
	await expect(root.locator('.ash-chat-rich-box').nth(1)).toHaveCSS('background-color', 'rgba(26, 127, 83, 0.07)');
	await expect(root.locator('.ash-chat-rich-box').nth(1)).toHaveCSS('border-top-color', 'rgba(26, 127, 83, 0.35)');
	await expect(body).toContainText('After the diagram.');
	await expect(body.locator('code')).toHaveText('<box border>literal example</box>');
	await expect(body.locator('[onclick], script, img[src]')).toHaveCount(0);
	expect(await page.evaluate(() => Reflect.get(globalThis, 'auditXss'))).toBeUndefined();
	await testInfo.attach('chatgpt-rich-diagram', { body: await page.screenshot(), contentType: 'image/png' });
});

test('ChatGPT replies omit internal citation tags while preserving literal code and links', async ({ page }) => {
	const citation = '<Cite refs={[["turn744052search0","turn744052search6"]]}/>';
	await chatPage(page, `Before ${citation} after.\n\n${citation}\n\n\`inline ${citation}\`\n\n\`\`\`html\n${citation}\n\`\`\`\n\n[Source](https://example.com/source)`);
	const body = page.locator('.ash-chat-item-agentMessage .ash-chat-markdown-part');
	await expect(body).toContainText('Before  after.');
	await expect(body.locator('code').first()).toHaveText(`inline ${citation}`);
	await expect(body.locator('.view-lines')).toHaveText(citation);
	expect((await body.innerText()).split(citation).length - 1).toBe(2);
	await expect(body.getByRole('link', { name: 'Source' })).toHaveAttribute('href', 'https://example.com/source');
});

test('ChatGPT retains text around structured media and names file attachments', async ({ page }) => {
	await mockChatGPTRequests(page);
	await page.route('**/service/backend-api/conversation/fixture-chat', route => route.fulfill({
		json: {
			title: 'Synthetic conversation', current_node: 'mixed', mapping: {
				question: { parent: null, message: { id: 'question', author: { role: 'user' }, content: { parts: ['<box>User literal</box>'] } } },
				mixed: {
					parent: 'question', message: {
						id: 'mixed', author: { role: 'assistant' },
						content: { content_type: 'multimodal_text', parts: ['Before image', { content_type: 'image_asset_pointer', alt: 'Architecture drawing' }, 'After image'] },
						metadata: { attachments: [{ name: 'report.pdf' }] },
					}
				},
			}
		}
	}));
	await page.goto('/chatgptNavigation.html');
	await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
	const body = page.locator('.ash-chat-item-agentMessage .ash-chat-markdown-part');
	await expect(page.locator('.ash-chat-item-userMessage')).toContainText('<box>User literal</box>');
	await expect(body).toHaveText(/Before image[\s\S]*Architecture drawing[\s\S]*在 ChatGPT 中查看此内容[\s\S]*After image[\s\S]*附件：report\.pdf/u);
	await expect(body.getByRole('link', { name: '在 ChatGPT 中查看此内容', exact: true })).toHaveCount(2);
});

test('ChatGPT resolves citations and runs HTML, Canvas and embedded frames locally without Workbench access', async ({ page }) => {
	await mockChatGPTRequests(page);
	const html = '<button onclick="document.querySelector(\'output\').textContent=\'1\'">Increment</button><output>0</output><canvas id="plot" width="16" height="16"></canvas><script>document.querySelector(\'canvas\').getContext(\'2d\').fillRect(0,0,16,16);try{top.document.body.dataset.escaped="true"}catch{document.body.dataset.isolated="true"}</script>';
	const srcdoc = html.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	await page.route('https://frame.example.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
	await page.route('**/service/backend-api/conversation/fixture-chat', route => route.fulfill({
		json: {
			title: 'Synthetic conversation', current_node: 'reply', mapping: {
				reply: {
					parent: null, message: {
						id: 'reply', author: { role: 'assistant' }, content: {
							content_type: 'text', parts: [
								`Source <Cite refs={[["turn0search1"]]}/> urlPython docsturn0search1\n\n<iframe title="Inline preview" srcdoc="${srcdoc}"/>\n\n<iframe title="External preview" src="https://frame.example.invalid/demo"/>\n\n<Chart title="Dataset chart" data={${JSON.stringify({ labels: ['May', 'June'], datasets: [{ label: 'Amount', data: [42, 64] }] })}}/>\n\n[report.csv](sandbox:/mnt/data/report.csv)`
							]
						}, metadata: { search_result_groups: [{ entries: [{ ref_id: { turn_index: 0, ref_type: 'search', ref_index: 1 }, title: 'CSV documentation', url: 'https://docs.python.org/3/library/csv.html', snippet: 'Read and write tabular data.' }] }] },
					}
				}
			},
		}
	}));
	await page.route('**/service/.resource?*', route => route.fulfill({ contentType: 'text/csv', body: 'name,value\nMay,42\n' }));
	await page.goto('/chatgptNavigation.html');
	await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
	const citation = page.locator('.ash-chat-citation');
	await citation.locator('summary').focus(); await citation.locator('summary').press('Enter');
	await expect(citation).toContainText('CSV documentation');
	await expect(citation).toContainText('Read and write tabular data.');
	await expect(page.getByRole('link', { name: 'Python docs', exact: true })).toHaveAttribute('href', 'https://docs.python.org/3/library/csv.html');
	const inline = page.frameLocator('iframe[title="Inline preview"]').frameLocator('iframe');
	await inline.getByRole('button', { name: 'Increment' }).click();
	await expect(inline.locator('output')).toHaveText('1');
	await expect(inline.locator('body')).toHaveAttribute('data-isolated', 'true');
	expect(await inline.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(1, 1, 1, 1).data[3])).toBe(255);
	const external = page.frameLocator('iframe[title="External preview"]').frameLocator('iframe').frameLocator('iframe');
	await external.getByRole('button', { name: 'Increment' }).click();
	await expect(external.locator('output')).toHaveText('1');
	const chart = page.frameLocator('iframe[title="Dataset chart"]').frameLocator('iframe');
	await expect(chart.getByRole('cell', { name: '64', exact: true })).toBeVisible();
	await chart.locator('canvas').focus(); await chart.locator('canvas').press('ArrowRight');
	await expect(chart.locator('#point')).toContainText('June');
	expect(await page.locator('body').getAttribute('data-escaped')).toBeNull();
	const file = page.locator('.ash-chat-media').filter({ has: page.locator('figcaption', { hasText: 'report.csv' }) });
	await expect(file.locator('pre')).toContainText('May,42');
	const downloadEvent = page.waitForEvent('download');
	await file.getByRole('button', { name: '下载', exact: true }).click();
	const download = await downloadEvent;
	expect(download.suggestedFilename()).toBe('report.csv');
	expect(readFileSync((await download.path())!, 'utf8')).toContain('May,42');
	await page.evaluate(() => window.ashChatGPTIntegration.newChat());
	await expect(page.locator('.ash-chat-media')).toHaveCount(0);
	await expect(page.locator('iframe')).toHaveCount(0);
});

test('ChatGPT waits for the streamed conversation ID before resolving a sandbox attachment', async ({ page }) => {
	await chatPage(page);
	await page.evaluate(() => window.ashChatGPTIntegration.newChat());
	const message = { id: 'late-reply', author: { role: 'assistant' }, content: { parts: ['[report.csv](sandbox:/mnt/data/report.csv)'] } };
	const paths: string[] = [];
	await page.route('**/service/.resource?*', route => {
		paths.push(new URL(route.request().url()).searchParams.get('url')!);
		return route.fulfill({ contentType: 'text/csv', body: 'name,value\nMay,42\n' });
	});
	await page.route('**/service/backend-api/f/conversation', route => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ message })}\n\ndata: {"conversation_id":"late-chat"}\n\ndata: [DONE]\n\n` }));
	await fillMessage(page, 'Synthetic rich content probe');
	await page.getByRole('button', { name: '发送', exact: true }).click();
	await expect(page.locator('.ash-chat-media pre')).toContainText('May,42');
	expect(paths).toHaveLength(1);
	expect(paths[0]).toContain('/conversation/late-chat/interpreter/download');
});

test('ChatGPT can embed public images while rejecting local files and executable Markdown', async ({ page }) => {
	const images: string[] = [];
	await page.route('https://audit-image.invalid/**', async route => { images.push(route.request().url()); await route.abort(); });
	await chatPage(page, '![tracker](https://audit-image.invalid/pixel) ![file](file:///audit-fixture.png) ![wrong-type](data:text/html,%3Cbutton%3Ebad%3C/button%3E)\n\n<script>globalThis.auditXss = true</script>\n\n[unsafe](javascript:alert(1))');
	await expect(page.locator('.ash-chat-transcript img[src^="file:"]')).toHaveCount(0);
	await expect(page.locator('.ash-chat-transcript iframe')).toHaveCount(0);
	await expect(page.locator('.ash-chat-transcript a[href^="javascript:"]')).toHaveCount(0);
	expect(await page.evaluate(() => Reflect.get(globalThis, 'auditXss'))).toBeUndefined();
	await expect.poll(() => images.length).toBe(1);
});

test('ChatGPT Stop cancels pending verification without sending or stopping the previous reply', async ({ page }) => {
	await chatPage(page);
	let sent = 0;
	let stops = 0;
	let verify!: () => Promise<void>;
	await page.route('**/service/.headers/**', route => { verify = async () => { await route.fulfill({ json: { 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-verification' } }).catch(() => { }); }; });
	await page.route('**/service/backend-api/f/conversation', async route => { sent++; await route.fulfill({ contentType: 'text/event-stream', body: 'data: [DONE]\n\n' }); });
	let stop!: () => Promise<void>;
	await page.route('**/service/backend-api/stop_conversation', route => { stops++; stop = async () => { await route.fulfill({ json: {} }).catch(() => { }); }; });
	await fillMessage(page, 'Synthetic cancellation probe');
	const input = page.getByRole('textbox', { name: '询问 ChatGPT' });
	await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
	await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
	await input.press('Enter');
	await expect.poll(() => typeof verify).toBe('function');
	await expect(input).toHaveAttribute('aria-readonly', 'true');
	await input.focus();
	await page.keyboard.type('ignored while replying');
	await input.press('Enter');
	await expectDraft(page, 'Synthetic cancellation probe');
	expect(stops).toBe(0);
	await page.getByRole('button', { name: '停止', exact: true }).click();
	try {
		await expect(page.locator('.ash-chatgpt-widget')).toContainText('确认本次回复之前被中断');
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
		await verify();
		expect(sent).toBe(0);
		expect(stops).toBe(0);
		await expectDraft(page, 'Synthetic cancellation probe');
		await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
	} finally { await verify(); await stop?.(); }
});

for (const locale of ['en', 'zh-CN']) {
	test(`ChatGPT uses the Rust math provider and follows math settings (${locale})`, async ({ page }) => {
		test.setTimeout(600000);
		await installMathProvider(page);
		await mockChatGPTRequests(page, '$\\newcommand{\\chatfoo}{x^2}\\chatfoo$\n\n\\[\\chatfoo+\\RR\\]\n\n$$\\sqrt{x}+\\overbrace{a+b}+\\widehat{ABC}$$\n\n$\\frac{1}{$');
		await page.goto(`/chatgptNavigation.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatGPTIntegration.setMathMacros({ '\\RR': '\\mathbb{R}' }));
		await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
		const body = page.locator('.ash-chat-item-agentMessage .ash-chat-markdown-part');
		await expect(body.locator('.katex')).toHaveCount(3);
		await expect(body.locator('.katex-display')).toHaveCount(2);
		await expect(body.locator('.katex-error')).toHaveCount(0);
		const bounds = await body.locator('.katex-display').first().boundingBox();
		expect(bounds!.height).toBeGreaterThan(10);
		await page.evaluate(() => document.fonts.ready);
		const geometry = await body.locator('.katex-html svg').evaluateAll(elements => elements.map(element => ({
			width: element.getAttribute('width'), height: element.getAttribute('height'),
			actual: element.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(element).fontSize),
		})));
		expect(geometry.length).toBeGreaterThanOrEqual(5);
		for (const svg of geometry) {
			expect(svg.width).toMatch(/^(400em|100%)$/);
			expect(svg.height).toMatch(/^[\d.]+em$/);
			expect(Math.abs(svg.actual - parseFloat(svg.height!) * svg.fontSize)).toBeLessThan(1);
		}
		await expect(body.locator('[data-math-diagnostic=invalidFormula]')).toContainText('\\frac{1}{');
		await expect(body.locator('[data-math-diagnostic=invalidFormula]')).toHaveAttribute('title', new RegExp(locale === 'en' ? 'This formula could not be rendered' : '无法渲染此公式'));
		await page.evaluate(() => window.ashChatGPTIntegration.setMathEnabled(false));
		await expect(body.locator('.katex')).toHaveCount(0);
		await expect(body).toContainText('\\chatfoo+\\RR');
		await page.evaluate(() => window.ashChatGPTIntegration.setMathEnabled(true));
		await expect(body.locator('.katex')).toHaveCount(3);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`chat and Markdown share formula syntax, MathML and styles (${locale})`, async ({ page, context }) => {
		test.setTimeout(600000);
		const corpus = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/markdownMath.json'), 'utf8')) as { name: string; markdown: string; formulas: { source: string; display: string; }[]; }[];
		const cases = corpus.filter(entry => entry.formulas.length || ['code and escapes', 'currency and jQuery'].includes(entry.name));
		const text = cases.map(entry => entry.markdown).join('\n\n');
		const expected = cases.flatMap(entry => entry.formulas);
		const extension = await startMarkdownExtension(locale);
		const editor = await context.newPage();
		try {
			await editor.route('**/__markdown_render**', async route => {
				await route.fulfill({ json: await extension.render('vscode.markdown.editor', { document: { languageId: 'markdown', ...route.request().postDataJSON() } }) });
			});
			await installMathProvider(page);
			await mockChatGPTRequests(page, text);
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
			await editor.goto(`/markdownEditor.html?locale=${locale}`);
			await expect(editor.locator('.ash-markdown-content .katex')).toHaveCount(2);
			await editor.evaluate(text => window.postMessage({ type: 'document', version: 2, text, readOnly: true }, location.origin), text);
			const chat = page.locator('.ash-chat-item-agentMessage .ash-chat-markdown-part');
			const markdown = editor.locator('.ash-markdown-content');
			for (const content of [chat, markdown]) {
				await expect(content.locator('.ash-markdown-math')).toHaveCount(expected.length);
				await expect(content.locator('[data-math-diagnostic]')).toHaveCount(2);
				await expect(content.locator('math')).toHaveCount(expected.length - 2);
				await expect(content.locator('code').first()).toHaveText('$x$');
				await content.evaluate(element => { Object.assign((element as HTMLElement).style, { fontFamily: 'system-ui, sans-serif', fontSize: '16px', lineHeight: '1.5', width: '360px' }); });
			}
			await Promise.all([page.evaluate(() => document.fonts.ready), editor.evaluate(() => document.fonts.ready)]);
			for (const content of [chat, markdown]) {
				const overflow = await content.evaluate(element => {
					const formula = [...element.querySelectorAll<HTMLElement>('.ash-markdown-math')].find(node => node.querySelector('annotation')?.textContent?.startsWith('\\underbrace{'))!;
					return { behavior: getComputedStyle(formula).overflowX, width: formula.clientWidth, contentWidth: formula.scrollWidth };
				});
				expect(overflow.behavior).toBe('auto');
				expect(overflow.width).toBeLessThanOrEqual(360);
				expect(overflow.contentWidth).toBeGreaterThan(overflow.width);
			}

			for (const color of ['rgb(30, 30, 30)', 'rgb(240, 240, 240)', 'rgb(255, 255, 0)']) {
				for (const content of [chat, markdown]) {
					await content.evaluate((element, color) => {
						(element as HTMLElement).style.color = color;
						// Give both hosts the same inherited link context for formula comparison.
						for (const link of element.querySelectorAll('a')) { link.style.color = color; }
					}, color);
				}
				const values = await Promise.all([chat, markdown].map(content => content.locator('.ash-markdown-math').evaluateAll(elements => elements.map(element => {
					const semantic = (node: Node): unknown => node instanceof Element
						? { tag: node.localName, attributes: [...node.attributes].map(attribute => [attribute.name, attribute.value]).sort(([a], [b]) => a.localeCompare(b)), children: [...node.childNodes].map(semantic) }
						: node.textContent;
					const math = element.querySelector('math');
					const katex = element.querySelector('.katex');
					const style = getComputedStyle(katex ?? element);
					return {
						source: math?.querySelector('annotation')?.textContent,
						display: (element as HTMLElement).dataset.mathDisplay,
						math: math ? semantic(math) : undefined, color: style.color, fontSize: style.fontSize, fontFamily: style.fontFamily,
						diagnostic: element.querySelector('[data-math-diagnostic]')?.getAttribute('data-math-diagnostic') ?? element.getAttribute('data-math-diagnostic'),
						height: katex?.getBoundingClientRect().height,
					};
				}))));
				for (let index = 0; index < expected.length; index++) {
					const { height: chatHeight, ...chatValue } = values[0][index];
					const { height: markdownHeight, ...markdownValue } = values[1][index];
					expect(chatValue, expected[index].source).toEqual(markdownValue);
					expect(chatValue.color).toBe(color);
					if (chatHeight !== undefined) { expect(Math.abs(chatHeight - markdownHeight!)).toBeLessThan(1); }
				}
			}
		} finally { await editor.close(); await extension.dispose(); }
	});
}


test('ChatGPT streaming reuses math while prose grows and renders one new ordered batch when formulas change', async ({ page }) => {
	await page.addInitScript(() => {
		const fetcher = globalThis.fetch.bind(globalThis);
		globalThis.fetch = async (input, init) => {
			if (String(input) !== '/service/backend-api/f/conversation') { return fetcher(input, init); }
			return new Response(new ReadableStream({
				start(controller) {
					const push = (text: string) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ conversation_id: 'fixture-chat', message: { id: 'math-stream', author: { role: 'assistant' }, content: { parts: [text] } } })}\n\n`));
					Reflect.set(globalThis, 'pushMathStream', push);
					Reflect.set(globalThis, 'endMathStream', () => { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); });
					push('$x$ prose 0');
				},
			}), { headers: { 'Content-Type': 'text/event-stream' } });
		};
	});
	const counters = await installMathProvider(page);
	await chatPage(page);
	await fillMessage(page, 'Synthetic math streaming');
	await page.getByRole('button', { name: '发送', exact: true }).click();
	const body = page.locator('.ash-chat-item-agentMessage[data-transient] .ash-chat-markdown-part');
	await expect(body.locator('math')).toHaveCount(1);
	for (let index = 1; index <= 8; index++) {
		await page.evaluate(index => Reflect.get(globalThis, 'pushMathStream')(`$x$ prose ${index}`), index);
		await expect(body).toContainText(`prose ${index}`);
		await expect(body.locator('math')).toHaveCount(1);
	}
	expect(counters).toEqual({ lists: 1, renders: 1 });
	await page.evaluate(() => Reflect.get(globalThis, 'pushMathStream')('$x$\n\n$y$ final prose'));
	await expect(body.locator('math')).toHaveCount(2);
	expect(counters).toEqual({ lists: 1, renders: 2 });
	await page.evaluate(() => Reflect.get(globalThis, 'endMathStream')());
	await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
	expect(counters).toEqual({ lists: 1, renders: 2 });
});


test('ChatGPT retains semantic content and gives custom cards and charts local interaction', async ({ page }, testInfo) => {
	test.setTimeout(600000);
	await installMathProvider(page);
	await chatPage(page, `<FuturePanel title="Overview"><FutureCard>**Card body**</FutureCard></FuturePanel>

<details><summary>More details</summary><table><tr><th>Name</th><td>Retained cell</td></tr></table>H<sub>2</sub>O and x<sup>2</sup></details>

<Chart title="Sales" data={[{"month":"May","amount":42}]}/>

![Architecture image](https://audit-image.invalid/diagram)

<video src="https://audit-image.invalid/movie" title="Demo video"/>

<svg><title>SVG diagram</title><text>Node A</text><path d="M0 0"/></svg>

$$x^2 + y^2 = z^2$$

<https://example.com/source>

\`<FutureCard>literal code</FutureCard>\`

Last paragraph.

<img>`);
	const body = page.locator('.ash-chat-item-agentMessage .ash-chat-markdown-part');
	await expect(body).toContainText('Overview');
	await expect(body.locator('strong')).toHaveText('Card body');
	const summary = body.locator('summary').filter({ hasText: 'More details' });
	await summary.focus();
	await summary.press('Enter');
	await expect(body.getByRole('cell', { name: 'Retained cell' })).toBeVisible();
	await expect(body.locator('sub')).toHaveText('2');
	await expect(body.locator('sup')).toHaveText('2');
	await expect(body).toContainText('Sales');
	await expect(body).toContainText('此处暂无法显示该媒体内容。');
	const chart = page.frameLocator('iframe[title="Sales"]').frameLocator('iframe');
	await expect(chart.getByRole('cell', { name: '42', exact: true })).toBeVisible();
	await chart.getByRole('combobox').selectOption('line');
	await expect(chart.getByRole('combobox')).toHaveValue('line');
	for (const text of ['Architecture image', 'Demo video', 'SVG diagram', 'Node A', 'Last paragraph.']) { await expect(body).toContainText(text); }
	await expect(body.getByRole('link', { name: 'https://example.com/source', exact: true })).toHaveAttribute('href', 'https://example.com/source');
	await expect(body.locator('code').last()).toHaveText('<FutureCard>literal code</FutureCard>');
	await expect(body.locator('.ash-katex-container')).toHaveAttribute('data-latex', 'x^2 + y^2 = z^2');
	await expect(body.locator('.ash-katex-container math')).toBeAttached();
	const links = body.getByRole('link', { name: '在 ChatGPT 中查看此内容', exact: true });
	expect(await links.count()).toBe(1);
	for (const link of await links.all()) { await expect(link).toHaveAttribute('href', 'https://chatgpt.com/c/fixture-chat'); }
	await links.last().focus();
	await expect(links.last()).toBeFocused();
	await expect(body.locator('script, [onclick]')).toHaveCount(0);
	await testInfo.attach('chatgpt-rich-content-retention', { body: await page.screenshot(), contentType: 'image/png' });
});
