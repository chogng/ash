import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const preload = transpileModule(readFileSync(new URL('../../../src/ash/platform/browserView/electron-browser/preload-browserView.ts', import.meta.url), 'utf8'), {
	compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;
const rule = { origin: 'https://chatgpt.com', selector: '.ash-chatgpt-turn.complete' };
type TestHost = { configureRendering: (value: typeof rule | undefined) => void; };

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
	await page.setViewportSize({ width: 700, height: 600 });
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

/** Exercise the actual page and client with synthetic HTTP boundaries, without a real account. */
async function chatPage(page: Page, answer = 'Synthetic answer'): Promise<void> {
	await page.route('**/service/**', async route => {
		const path = new URL(route.request().url()).pathname;
		const message = (id: string, role: string, text: string): object => ({ id, author: { role }, content: { content_type: 'text', parts: [text] } });
		if (path.endsWith('/me')) {
			await route.fulfill({ json: { id: 'fixture-user', name: 'Fixture' }, headers: { 'X-Ash-Browser-Account': 'fixture-binding', 'X-Ash-Browser-Account-Scope': 'fixture-scope' } });
		} else if (path.endsWith('/models')) {
			await route.fulfill({ json: { models: [{ slug: 'fixture', title: 'Fixture model' }], default_model_slug: 'fixture' } });
		} else if (path.endsWith('/conversations')) {
			await route.fulfill({ json: { items: [{ id: 'fixture-chat', title: 'Synthetic conversation' }], total: 1 } });
		} else if (path.endsWith('/conversation/fixture-chat')) {
			await route.fulfill({
				json: {
					title: 'Synthetic conversation', current_node: 'previous-reply', mapping: {
						question: { parent: null, message: message('question', 'user', 'Synthetic question') },
						'previous-reply': { parent: 'question', message: message('previous-reply', 'assistant', answer) },
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
	await page.goto('/chatgpt.html?locale=zh-CN');
	await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
	await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
	await expect(page.locator('.ash-chatgpt-title')).toHaveText('Synthetic conversation');
}

test('ChatGPT reply Markdown cannot execute scripts or automatically load remote and local images', async ({ page }) => {
	const images: string[] = [];
	await page.route('https://audit-image.invalid/**', async route => { images.push(route.request().url()); await route.abort(); });
	await chatPage(page, '![tracker](https://audit-image.invalid/pixel) ![file](file:///audit-fixture.png)\n\n<script>globalThis.auditXss = true</script>\n\n[unsafe](javascript:alert(1))');
	await expect(page.locator('.ash-chatgpt-messages img[src]')).toHaveCount(0);
	await expect(page.locator('.ash-chatgpt-messages a[href^="javascript:"]')).toHaveCount(0);
	expect(await page.evaluate(() => Reflect.get(globalThis, 'auditXss'))).toBeUndefined();
	expect(images).toEqual([]);
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
	await page.getByRole('textbox', { name: '询问 ChatGPT' }).fill('Synthetic cancellation probe');
	await page.getByRole('button', { name: '发送', exact: true }).click();
	await expect.poll(() => typeof verify).toBe('function');
	await page.getByRole('button', { name: '停止', exact: true }).click();
	try {
		await expect(page.locator('.ash-chatgpt-error')).toContainText('确认本次回复之前被中断');
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
		await verify();
		expect(sent).toBe(0);
		expect(stops).toBe(0);
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toHaveValue('Synthetic cancellation probe');
		await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
	} finally { await verify(); await stop?.(); }
});

test('ChatGPT Stop cancels an active stream immediately and fences a delayed remote stop', async ({ page }) => {
	await page.addInitScript(() => {
		const fetcher = globalThis.fetch.bind(globalThis);
		Object.assign(globalThis, { auditStreamCancelled: false });
		globalThis.fetch = async (input, init) => {
			if (String(input) !== '/service/backend-api/f/conversation') { return fetcher(input, init); }
			return new Response(new ReadableStream({
				start(controller) { controller.enqueue(new TextEncoder().encode('data: {"conversation_id":"fixture-chat","message":{"id":"current-reply","author":{"role":"assistant"},"content":{"parts":["Synthetic live reply"]}}}\n\n')); },
				cancel() { Reflect.set(globalThis, 'auditStreamCancelled', true); },
			}), { headers: { 'Content-Type': 'text/event-stream' } });
		};
	});
	await chatPage(page);
	let stop!: () => Promise<void>;
	let messageId: string | undefined;
	await page.route('**/service/backend-api/stop_conversation', route => {
		messageId = route.request().postDataJSON().message_id;
		stop = async () => { await route.fulfill({ json: {} }); };
	});
	await page.getByRole('textbox', { name: '询问 ChatGPT' }).fill('Synthetic streaming probe');
	await page.getByRole('button', { name: '发送', exact: true }).click();
	await expect(page.locator('.ash-chatgpt-messages')).toContainText('Synthetic live reply');
	await page.getByRole('button', { name: '停止', exact: true }).click();
	await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, 'auditStreamCancelled'))).toBe(true);
	await expect.poll(() => typeof stop).toBe('function');
	expect(messageId).toBe('current-reply');
	await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeDisabled();
	await stop();
	await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
	await expect(page.locator('.ash-chatgpt-status')).toHaveText('已停止回复');
});
