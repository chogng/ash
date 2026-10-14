import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IBrowserViewGroupService } from '../../common/browserViewGroup.js';
import { PlaywrightService } from '../../node/playwrightService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { chromium, type BrowserContext } from 'playwright-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Emitter } from '../../../../base/common/event.js';
import type { CDPEvent, CDPResponse } from '../../common/cdp/types.js';

suite('Playwright session lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a live page observation includes computed and focused author styles and retirement keeps the page open', async () => {
		const profileRoot = resolve('.build/desktop');
		const profile = mkdtempSync(join(profileRoot, 'browser-observe-'));
		let context: BrowserContext | undefined;
		try {
			context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--remote-debugging-port=0'] });
			const page = context.pages()[0]!;
			await page.goto('data:text/html,' + encodeURIComponent('<style>:root{--accent:rgb(1,2,3)}input{color:var(--accent);margin:3px 4px}</style><input style="padding:2px" value="Inspect me">'));
			await page.locator('input').focus();
			const [port, endpoint] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
			const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
			await new Promise<void>((done, fail) => { socket.addEventListener('open', () => done(), { once: true }); socket.addEventListener('error', fail, { once: true }); });
			using messages = new Emitter<CDPResponse | CDPEvent>();
			using destroyed = new Emitter<void>();
			const receive = (event: MessageEvent): void => {
				const message = JSON.parse(String(event.data));
				// The Main group normally adds the view's domain identity to Chromium target metadata.
				for (const target of [message.result?.targetInfo, message.params?.targetInfo, ...(message.result?.targetInfos ?? [])]) {
					if (target) { target.browserViewId = 'observed-page'; }
				}
				messages.fire(message);
			};
			socket.addEventListener('message', receive);
			using services = new InstantiationService();
			services.registerInstance(IBrowserViewGroupService, {
				createGroup: async () => 'live-group', destroyGroup: async () => { socket.close(); },
				onDynamicCDPMessage: () => messages.event, onDynamicDidDestroy: () => destroyed.event,
				sendCDPMessage: async (_id, message) => { socket.send(JSON.stringify(message)); },
			});
			using playwright = services.createInstance(PlaywrightService);
			try {
				const observation = await playwright.getObservation('inspect', 'thread', 'observed-page', { includeAccessibilityTree: false, includeDomSnapshot: true, includeScreenshot: false });
				const snapshot = JSON.parse(observation.domSnapshot!);
				assert.ok(snapshot.documents[0].layout.styles.some((styles: unknown[]) => styles.length > 0));
				assert.ok(snapshot.focusedElementStyles.rulesText.includes('color:var(--accent)'));
				assert.ok(snapshot.focusedElementStyles.referencedVars.includes('--accent'));
				await playwright.disposeSession('thread');
				assert.equal(page.isClosed(), false);
			} finally { socket.removeEventListener('message', receive); socket.close(); }
		} finally {
			await context?.close();
			assert.equal(dirname(profile), profileRoot);
			await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test('retiring a Thread cancels discovery and destroys a group that arrives after release', async () => {
		const created = promiseWithResolvers<string>();
		const started = promiseWithResolvers<void>();
		const destroyed = promiseWithResolvers<string>();
		using services = new InstantiationService();
		services.registerInstance(IBrowserViewGroupService, {
			createGroup: async () => { started.resolve(); return created.promise; },
			destroyGroup: async id => { destroyed.resolve(id); },
			onDynamicDidDestroy: () => Event.None,
			onDynamicCDPMessage: () => Event.None,
			sendCDPMessage: async () => { throw new Error('Released Thread must not issue Chromium commands'); },
		});
		using playwright = services.createInstance(PlaywrightService);
		const observation = playwright.getObservation('operation-one', 'thread-one', 'page-one', { includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false });
		await started.promise;
		const rejected = assert.rejects(observation, /BrowserRequestCancelled/);
		await playwright.disposeSession('thread-one');
		await rejected;
		created.resolve('late-group');
		assert.equal(await destroyed.promise, 'late-group');
	});
});
