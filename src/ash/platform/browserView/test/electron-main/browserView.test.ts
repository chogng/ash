import { BrowserPasswordMainService, IBrowserPasswordMainService } from '../../electron-main/browserPasswordMainService.js';
import { browserPasswordChannel } from '../../electron-main/browserPasswordMainService.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { EncryptionMainService } from '../../../encryption/electron-main/encryptionMainService.js';
import { IEncryptionMainService } from '../../../encryption/common/encryptionService.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, WebContentsView } from 'electron/main';
import { suite, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { BrowserViewStorageScope, type BrowserViewEvent } from '../../common/browserView.js';
import { BrowserViewMainService, IBrowserViewMainService } from '../../electron-main/browserViewMainService.js';
import { AppServerBrowserHost } from '../../../agentHost/electron-main/appServerBrowserHost.js';
import { IPlaywrightService } from '../../common/playwrightService.js';
import type { IBrowserViewObservation } from '../../common/browserView.js';
import { Event } from '../../../../base/common/event.js';
import { IApplicationStorageMainService } from '../../../storage/electron-main/storageMainService.js';
import { ILogService, NullLoggerService } from '../../../log/common/log.js';
import type { IStorageSnapshot } from '../../../storage/common/storageIpc.js';
import { StorageScope, StorageTarget } from '../../../storage/common/storage.js';
import type { ContextMenuParams } from 'electron/main';
import type { ElectronContextMenu } from '../../../../base/parts/contextmenu/electron-main/contextmenu.js';
import type { INativeContextMenuRequest, INativeContextMenuResult } from '../../../../base/parts/contextmenu/common/contextmenu.js';
import { IClipboardService } from '../../../clipboard/common/clipboardService.js';

suite('Browser form passwords', () => {
	test('memory credentials support save, fill and update without encryption or disk and disappear with the owner', async () => {
		using services = new InstantiationService();
		using configuration = new InMemoryConfigurationService();
		const forbidden = {
			get: () => {
				throw new Error('Memory credentials touched persistence');
			},
		};
		services.registerInstance(IEncryptionMainService, new Proxy({} as IEncryptionMainService, forbidden));
		services.registerInstance(IApplicationStorageMainService, new Proxy({} as IApplicationStorageMainService, forbidden));
		services.registerInstance(IConfigurationService, configuration);
		using vault = services.createInstance(BrowserPasswordMainService, true);
		const value = {
			session: 'a'.repeat(64),
			scope: 'global' as const,
			origin: 'https://example.test',
			username: 'account',
			password: 'synthetic-password',
		};
		await vault.save(value);
		const [saved] = await vault.find(value.session, value.origin);
		assert.equal(saved?.password, value.password);
		await vault.update(saved!.id, value.username, 'updated-password');
		assert.equal((await vault.find(value.session, value.origin))[0]?.password, 'updated-password');
		using reopened = services.createInstance(BrowserPasswordMainService, true);
		assert.deepEqual(await reopened.readState(), { available: true, entries: [], corrupted: 0 });
		await vault.clearSession(value.session);
		assert.deepEqual(await vault.readState(), { available: true, entries: [], corrupted: 0 });
	});
	ensureNoDisposablesAreLeakedInTestSuite();
	const application = { scope: StorageScope.APPLICATION, id: 'application' };
	async function page(f: ReturnType<typeof fixture>, scope: BrowserViewStorageScope.Global | BrowserViewStorageScope.Workspace | BrowserViewStorageScope.Ephemeral = BrowserViewStorageScope.Global) {
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'https://example.test/login',
			owner: { type: 'user' },
			session: { scope },
		});
		const sent: { command: string; data: unknown }[] = [];
		const frame = {
			detached: false,
			url: 'https://example.test/login',
			framesInSubtree: [] as unknown[],
			send: (_channel: string, message: (typeof sent)[number]) => sent.push(message),
		};
		frame.framesInSubtree.push(frame);
		Object.assign(f.contents, { mainFrame: frame });
		const post = (type: string, data?: unknown, token = 'a'.repeat(32), sender = frame) =>
			f.contents.emit('ipc-message', { senderFrame: sender }, 'ash:browserView:preload', {
				type,
				data,
				frameToken: token,
			});
		post('ready');
		const vault = f.instantiation.get(IBrowserPasswordMainService);
		return { frame, post, sent, vault, session: f.manager.tryGetBrowserView(id)!.session.id };
	}
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));
	const submitted = {
		action: 'https://example.test/login',
		hasUsername: true,
		username: 'synthetic-user',
		password: 'synthetic-password',
	};
	const form = {
		action: submitted.action,
		hasUsername: true,
		username: '',
		field: 'password',
		formId: 'a'.repeat(32) + '-1',
	};

	test('the username expires after two minutes while a password candidate expires independently', async () => {
		mock.timers.enable({ apis: ['Date', 'setTimeout'] });
		try {
			using f = fixture();
			const p = await page(f);
			const identity = { action: submitted.action, username: submitted.username };
			const submit = () => p.post('passwordSubmitted', { ...submitted, username: '', hasUsername: false });
			const finish = () => p.post('passwordPageState', { action: submitted.action, hasPasswordForm: false });
			p.post('passwordIdentitySubmitted', identity);
			mock.timers.tick(120_001);
			submit();
			finish();
			await settle();
			assert.equal(
				f.events.some(event => event.type === 'passwordSaveRequested'),
				false,
			);
			p.post('passwordIdentitySubmitted', identity);
			submit();
			mock.timers.tick(60_001);
			finish();
			await settle();
			assert.equal(
				f.events.some(event => event.type === 'passwordSaveRequested'),
				false,
			);
			submit();
			finish();
			await settle();
			assert.equal(
				f.events.some(event => event.type === 'passwordSaveRequested'),
				true,
			);
		} finally {
			mock.timers.reset();
		}
	});

	test('a username step sends no password and binds a later password-only document to the submitted account', async () => {
		using f = fixture();
		const p = await page(f);
		await p.vault.save({
			session: p.session,
			scope: 'global',
			origin: 'https://example.test',
			username: submitted.username,
			password: submitted.password,
		});
		p.post('passwordFill', { ...form, field: 'username' });
		await settle();
		const fill = p.sent.find(message => message.command === 'fillPassword')!;
		assert.equal('password' in (fill.data as object), false);
		p.post('passwordIdentitySubmitted', { action: submitted.action, username: submitted.username });
		f.contents.emit('did-start-navigation', {}, 'https://example.test/password', false, true);
		p.frame.url = 'https://example.test/password';
		p.post('ready', undefined, 'b'.repeat(32));
		p.post('passwordFill', { ...form, action: p.frame.url, hasUsername: false }, 'a'.repeat(32));
		await settle();
		assert.equal(p.sent.length, 1);
		p.post('passwordFill', { ...form, action: p.frame.url, hasUsername: false }, 'b'.repeat(32));
		await settle();
		assert.equal((p.sent[1]!.data as { password: string }).password, submitted.password);
		// A rejected attempt must retain the account for a subsequent password-only retry.
		for (const password of ['wrong-password', 'replacement-password']) {
			p.post('passwordSubmitted', { action: p.frame.url, username: '', hasUsername: false, password }, 'b'.repeat(32));
		}
		p.post('passwordPageState', { action: p.frame.url, hasPasswordForm: false }, 'b'.repeat(32));
		await settle();
		const request = f.events.find((event): event is Extract<BrowserViewEvent, { type: 'passwordSaveRequested' }> => event.type === 'passwordSaveRequested')!;
		assert.equal(request.username, submitted.username);
		assert.equal(request.update, true);
		await f.manager.respondToPasswordSave(id, request.requestId, true);
		assert.equal((await p.vault.find(p.session, 'https://example.test'))[0]!.password, 'replacement-password');
	});

	test('transient usernames never cross origins, page lifetimes or clearing, and are not persisted on their own', async () => {
		using f = fixture();
		let p = await page(f);
		const identity = { action: submitted.action, username: submitted.username };
		const submitWithoutIdentity = async () => {
			p.post('passwordSubmitted', { ...submitted, username: '', hasUsername: false });
			p.post('passwordPageState', { action: submitted.action, hasPasswordForm: false });
			await settle();
			assert.equal(
				f.events.some(event => event.type === 'passwordSaveRequested'),
				false,
			);
		};
		p.post('passwordIdentitySubmitted', identity);
		assert.equal((await p.vault.readState()).entries.length, 0);
		assert.doesNotMatch(JSON.stringify(await f.storage.getItems(application)), /synthetic-user/);
		f.contents.emit('did-start-navigation', {}, 'https://other.test/', false, true);
		p.frame.url = 'https://other.test/';
		p.post('ready');
		p.post('passwordIdentitySubmitted', { ...identity, action: 'https://example.test/' });
		f.contents.emit('did-start-navigation', {}, submitted.action, false, true);
		p.frame.url = submitted.action;
		p.post('ready');
		await submitWithoutIdentity();
		p.post('passwordIdentitySubmitted', identity);
		await f.manager.clearStorage(id);
		await submitWithoutIdentity();
		p.post('passwordIdentitySubmitted', identity);
		await f.manager.destroyBrowserView(id);
		p = await page(f);
		await submitWithoutIdentity();
		await f.manager.destroyBrowserView(id);
		p = await page(f, BrowserViewStorageScope.Ephemeral);
		p.post('passwordIdentitySubmitted', identity);
		await submitWithoutIdentity();
	});

	test('a submitted login is offered only after the form disappears, encrypted and updated without a password readback', async () => {
		using f = fixture();
		const p = await page(f);
		p.post('passwordSubmitted', submitted);
		p.post('passwordPageState', { action: submitted.action, hasPasswordForm: true });
		await settle();
		assert.equal(
			f.events.some(event => event.type === 'passwordSaveRequested'),
			false,
		);
		for (const password of [submitted.password, 'replacement-password']) {
			p.post('passwordSubmitted', { ...submitted, password });
			p.post('passwordPageState', { action: submitted.action, hasPasswordForm: false });
			await settle();
			const request = [...f.events].reverse().find((event): event is Extract<BrowserViewEvent, { type: 'passwordSaveRequested' }> => event.type === 'passwordSaveRequested')!;
			assert.ok(request);
			assert.equal(request.update, password !== submitted.password);
			assert.doesNotMatch(JSON.stringify(f.events), /synthetic-password|replacement-password/);
			await f.manager.respondToPasswordSave(id, request.requestId, true);
		}
		const snapshot = await f.storage.getItems(application);
		assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-user|synthetic-password|replacement-password|example\.test/);
		const state = (await browserPasswordChannel(p.vault).call('window:1', 'readState', [])) as Awaited<ReturnType<typeof p.vault.readState>>;
		assert.equal(state.entries.length, 1);
		assert.equal(state.entries[0]!.username, submitted.username);
		assert.equal('password' in state.entries[0]!, false);
		p.post('passwordFill', form);
		await settle();
		assert.equal(([...p.sent].reverse().find(message => message.command === 'fillPassword')!.data as { password: string }).password, 'replacement-password');
		await assert.rejects(browserPasswordChannel(p.vault).call('window:1', 'find', [p.session, 'https://example.test']), /Invalid password command/);
		await assert.rejects(browserPasswordChannel(p.vault).call('window:1', 'update', [state.entries[0]!.id, 'user', 'bad\npassword']), /Invalid password command/);
	});

	test('fill binds the native top frame, document, exact origin and session; navigation cancels account selection', async () => {
		using f = fixture();
		const p = await page(f);
		for (const username of ['first', 'second']) {
			await p.vault.save({
				session: p.session,
				scope: 'global',
				origin: 'https://example.test',
				username,
				password: 'secret-' + username,
			});
		}
		for (const [data, token, sender] of [
			[{ ...form, action: 'https://other.test' }, 'a'.repeat(32), p.frame],
			[form, 'stale', p.frame],
			[form, 'a'.repeat(32), { ...p.frame }],
		] as const) {
			p.post('passwordFill', data, token, sender);
		}
		await settle();
		assert.equal(
			p.sent.some(message => message.command === 'fillPassword'),
			false,
		);
		p.post('passwordIdentitySubmitted', { action: submitted.action, username: 'first' });
		p.post('passwordFill', form);
		await settle();
		const request = [...f.events].reverse().find((event): event is Extract<BrowserViewEvent, { type: 'passwordFillRequested' }> => event.type === 'passwordFillRequested')!;
		assert.equal(request.accounts.length, 2);
		f.contents.emit('did-start-navigation', {}, 'https://other.test/', false, true);
		p.frame.url = 'https://other.test/';
		p.post('ready');
		await f.manager.respondToPasswordFill(id, request.requestId, request.accounts[0]!.id);
		assert.equal(
			p.sent.some(message => message.command === 'fillPassword'),
			false,
		);
		assert.deepEqual(await p.vault.find('b'.repeat(64), 'https://example.test'), []);
		assert.deepEqual(await p.vault.find(p.session, 'https://example.test:444'), []);
	});

	test('settings mutations preserve corrupt records, reject account collisions and clear only the requested session', async () => {
		using f = fixture();
		const p = await page(f);
		for (const username of ['first', 'second']) {
			await p.vault.save({
				session: p.session,
				scope: 'global',
				origin: 'https://example.test',
				username,
				password: 'secret',
			});
		}
		await p.vault.save({
			session: 'b'.repeat(64),
			scope: 'workspace',
			origin: 'https://example.test',
			username: 'other',
			password: 'secret',
		});
		const first = (await p.vault.readState()).entries.find(value => value.username === 'first')!;
		await assert.rejects(p.vault.update(first.id, 'second', 'new-secret'), /already exists/);
		await p.vault.update(first.id, 'renamed', 'new-secret');
		assert.equal(
			(await p.vault.readState()).entries.some(value => value.id === first.id),
			false,
		);
		await f.storage.updateItems(application, first.id, { value: 'corrupt', target: StorageTarget.MACHINE });
		assert.equal((await p.vault.readState()).corrupted, 1);
		assert.equal((await f.storage.getItems(application)).entries[first.id]!.value, 'corrupt');
		await p.vault.clearSession(p.session);
		assert.deepEqual(
			(await p.vault.readState()).entries.map(value => value.username),
			['other'],
		);
		const entry = (await p.vault.readState()).entries[0]!;
		await p.vault.delete(entry.id);
		assert.equal((await p.vault.readState()).entries.length, 0);
	});

	test('save and autofill preferences take effect in Main, and ephemeral pages cannot save', async () => {
		using f = fixture();
		const p = await page(f);
		await f.passwordConfiguration.updateValue('workbench.browser.savePasswords', false);
		p.post('passwordSubmitted', submitted);
		p.post('passwordPageState', { action: submitted.action, hasPasswordForm: false });
		await settle();
		assert.equal(
			f.events.some(event => event.type === 'passwordSaveRequested'),
			false,
		);
		await f.passwordConfiguration.updateValue('workbench.browser.savePasswords', true);
		await p.vault.save({ ...submitted, origin: 'https://example.test', session: p.session, scope: 'global' });
		await f.passwordConfiguration.updateValue('workbench.browser.autofillPasswords', false);
		p.post('passwordFill', form);
		await settle();
		assert.equal(
			p.sent.some(message => message.command === 'fillPassword'),
			false,
		);
		await f.manager.destroyBrowserView(id);
		const ephemeral = await page(f, BrowserViewStorageScope.Ephemeral);
		ephemeral.post('passwordSubmitted', submitted);
		ephemeral.post('passwordPageState', { action: submitted.action, hasPasswordForm: false });
		await settle();
		assert.equal(
			f.events.some(event => event.type === 'passwordSaveRequested'),
			false,
		);
		f.encryptionAvailable = false;
		assert.equal((await p.vault.readState()).available, false);
	});
});

const id = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
const observation = { includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false };
const agent = {
	owner: { type: 'agent' as const, sessionId: 'thread-one' },
	session: { scope: BrowserViewStorageScope.Agent as const, affinity: 'thread-one' },
};
const signal = () => new AbortController().signal;

suite('Browser view ownership and operations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rendering rules cross validated IPC, reach only the main frame and survive document replacement', async () => {
		using f = fixture();
		await f.create();
		const sent: unknown[] = [];
		const frame = {
			detached: false,
			framesInSubtree: [] as unknown[],
			send: (_channel: string, message: unknown) => sent.push(message),
		};
		const child = {
			detached: false,
			send: () => {
				throw new Error('A rule must not enter a subframe');
			},
		};
		frame.framesInSubtree.push(frame, child);
		Object.assign(f.contents, { mainFrame: frame });
		const channel = browserViewChannel(f.manager, {
			call: async () => null,
			listen: () => Event.None,
		} as unknown as import('../../../../base/parts/ipc/common/ipc.js').IChannel);
		const rule = { origin: 'https://chatgpt.com', selector: '[data-talvt-turn-state="complete"]' };
		await channel.call('window:1', 'setContentVisibility', [id, rule]);
		for (const senderFrame of [child, frame]) {
			f.contents.emit('ipc-message', { senderFrame }, 'ash:browserView:preload', {
				type: 'ready',
				frameToken: 'frame-one',
			});
		}
		assert.deepEqual(sent, [{ command: 'contentVisibility', data: rule }]);
		f.contents.emit('did-start-navigation', {}, 'https://chatgpt.com/c/next', false, true);
		f.contents.emit('ipc-message', { senderFrame: frame }, 'ash:browserView:preload', {
			type: 'ready',
			frameToken: 'frame-two',
		});
		await channel.call('window:1', 'setContentVisibility', [id, null]);
		assert.deepEqual(sent, [
			{ command: 'contentVisibility', data: rule },
			{ command: 'contentVisibility', data: rule },
			{ command: 'contentVisibility', data: undefined },
		]);
		for (const invalid of [
			{ ...rule, origin: 'https://chatgpt.com/path' },
			{ ...rule, origin: 'http://chatgpt.com' },
			{ ...rule, selector: '' },
			{ ...rule, extra: true },
		]) {
			await assert.rejects(channel.call('window:1', 'setContentVisibility', [id, invalid]), /rendering rule/);
		}
	});

	test('console capture is bounded, isolated to one page and reset at a document navigation', async () => {
		using f = fixture();
		await f.create();
		f.contents.emit('console-message', { level: 'info', message: 'captured message' });
		assert.equal(await f.manager.getConsoleLogs(id), 'info: captured message');
		for (let i = 0; i < 100; i++) {
			f.contents.emit('console-message', { level: 'error', message: '界'.repeat(8192) });
		}
		assert.ok(Buffer.byteLength(await f.manager.getConsoleLogs(id)) <= 64 * 1024 + 500);
		f.contents.emit('did-start-navigation', {}, 'https://example.test/next', false, true);
		assert.equal(await f.manager.getConsoleLogs(id), '');
	});

	test('full-page capture normalizes display scale and refuses an oversized document before requesting pixels', async () => {
		using f = fixture();
		await f.create();
		f.manager.tryGetBrowserView(id)!.webContents.executeJavaScriptInIsolatedWorld = async () => 2;
		let large = false;
		f.command = async method => (method === 'Page.getLayoutMetrics' ? { cssContentSize: { width: 1000, height: large ? 20000 : 2000 } } : { data: 'AA==' });
		await f.manager.captureScreenshot(id, { fullPage: true });
		const capture = f.commands.find(command => command.method === 'Page.captureScreenshot')!;
		assert.deepEqual((capture.params as { clip: unknown }).clip, {
			x: 0,
			y: 0,
			width: 1000,
			height: 2000,
			scale: 0.5,
		});
		large = true;
		f.commands.length = 0;
		await assert.rejects(f.manager.captureScreenshot(id, { fullPage: true }), /TooLarge/);
		assert.equal(
			f.commands.some(command => command.method === 'Page.captureScreenshot'),
			false,
		);
	});

	test('trusted reload IPC forwards cache bypass and rejects malformed flags', async () => {
		using f = fixture();
		await f.create();
		const view = f.manager.tryGetBrowserView(id)!;
		const calls: boolean[] = [];
		view.webContents.reload = () => {
			calls.push(false);
		};
		view.webContents.reloadIgnoringCache = () => {
			calls.push(true);
		};
		const channel = browserViewChannel(f.manager, {
			call: async () => null,
			listen: () => Event.None,
		} as unknown as import('../../../../base/parts/ipc/common/ipc.js').IChannel);
		await channel.call('window:1', 'reload', [id]);
		await channel.call('window:1', 'reload', [id, true]);
		await channel.call('window:1', 'reload', [id, null]);
		assert.deepEqual(calls, [false, true, false]);
		await assert.rejects(channel.call('window:1', 'reload', [id, 'true']), /reload arguments/);
		await assert.rejects(channel.call('window:1', 'reload', [id, false, true]), /reload arguments/);
	});

	test('committed user visits and title updates reach the session history through the trusted service', async () => {
		using f = fixture();
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'https://example.test/',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		f.contents.emit('did-navigate', {}, 'https://example.test/');
		f.title = 'Visited title';
		f.contents.emit('page-title-updated');
		f.contents.emit('did-navigate-in-page', {}, 'https://other.test/frame', false);
		const snapshot = await f.manager.getBrowserHistory(id);
		assert.deepEqual(
			snapshot.items.map(entry => ({ url: entry.url, title: entry.title, explicit: entry.explicit })),
			[{ url: 'https://example.test/', title: 'Visited title', explicit: true }],
		);
		await f.manager.deleteBrowserHistory(id, [snapshot.items[0]!.id]);
		f.contents.emit('page-title-updated');
		assert.deepEqual(await f.manager.getBrowserHistory(id), { items: [] });
	});

	test('agent navigation does not enter the user visit history', async () => {
		using f = fixture();
		await f.create();
		f.contents.emit('did-navigate', {}, 'https://example.test/private');
		assert.deepEqual(await f.manager.getBrowserHistory(id), { items: [] });
	});

	test('retiring a window during history restoration releases its lease without creating a native page', async () => {
		using f = fixture();
		const loading = promiseWithResolvers<void>();
		const snapshot = promiseWithResolvers<IStorageSnapshot>();
		f.storage.getItems = async () => {
			loading.resolve();
			return snapshot.promise;
		};
		const creating = f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'https://example.test/',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		await loading.promise;
		f.manager.dispose();
		snapshot.resolve({
			identity: { scope: StorageScope.APPLICATION, id: 'application' },
			revision: 0,
			isNew: true,
			entries: {},
		});
		await assert.rejects(creating, /BrowserCapabilityUnavailable/);
		assert.equal(f.children.size, 0);
	});

	test('construction requires the host page manager', () => {
		using instantiation = new InstantiationService();
		assert.throws(() => instantiation.createInstance(AppServerBrowserHost), /browserViewMainService/);
	});

	test('Canvas opens retain one page per Thread and instance and publish only successful explicit opens', async () => {
		using f = fixture();
		using host = f.createHost();
		const canvas = { sessionId: 'session-one', instanceId: 'preview', title: 'Preview' };
		const first = await host.create({ threadId: 'thread-one', url: 'https://example.test/first', canvas }, { signal: signal() });
		const updated = await host.create({ threadId: 'thread-one', url: 'https://example.test/second', canvas: { ...canvas, title: 'Updated' } }, { signal: signal() });
		const other = await host.create({ threadId: 'thread-two', url: 'https://example.test/other', canvas }, { signal: signal() });
		assert.equal(updated.targetId, first.targetId);
		assert.notEqual(other.targetId, first.targetId);
		const pages = await f.manager.getBrowserViews();
		assert.equal(pages.length, 2);
		assert.deepEqual(pages.find(page => page.id === first.targetId)!.canvas, {
			sessionId: 'session-one',
			instanceId: 'preview',
			title: 'Updated',
		});
		assert.equal(f.events.filter(event => event.type === 'canvasOpened').length, 3);
		f.load = async () => {
			throw new Error('navigation failed');
		};
		await assert.rejects(host.create({ threadId: 'thread-one', url: 'https://example.test/failure', canvas }, { signal: signal() }), /navigation failed/);
		assert.equal((await f.manager.getBrowserViews()).length, 2);
		assert.equal(f.events.filter(event => event.type === 'canvasOpened').length, 3);
	});

	test('window accessibility inspection reads an unshared user page without granting Agent access', async () => {
		using f = fixture();
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'https://example.test/',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Ephemeral },
		});
		f.command = async method => {
			assert.equal(method, 'Accessibility.getFullAXTree');
			return { nodes: [{ role: { value: 'button' }, name: { value: 'User control' } }] };
		};
		const channel = browserViewChannel(f.manager, { call: async <T>() => null as T, listen: () => Event.None });
		assert.match((await channel.call('window:1', 'getAccessibilityTree', [id])) as string, /User control/);
		assert.throws(() => f.manager.validateAgentAccess(id, 'thread-one'), /BrowserTargetAccessDenied/);
		assert.equal(f.attached, false);
		f.command = async () => ({ nodes: [{ name: { value: 'x'.repeat(512 * 1024) } }] });
		await assert.rejects(channel.call('window:1', 'getAccessibilityTree', [id]), /BrowserAccessibilityTooLarge/);
	});

	test('the renderer channel validates requests, enforces Thread access and returns Main page state', async () => {
		using f = fixture();
		await f.create();
		f.observe = async pageId => ({
			targetId: pageId,
			url: 'https://stale.test/',
			title: 'Worker title',
			loading: true,
		});
		using host = f.createHost();
		const channel = host.getChannel();
		const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		await assert.rejects(channel.call('window:1', 'disposeCore', []), /Unknown browser host command/);
		await assert.rejects(channel.call('window:1', 'observe', { id: 'invalid', params: {} }), /Invalid browser operation/);
		await assert.rejects(
			channel.call('window:1', 'observe', {
				id: requestId,
				params: { threadId: 'thread-two', targetId: id, ...observation },
			}),
			/BrowserTargetAccessDenied/,
		);
		assert.deepEqual(
			await channel.call('window:1', 'observe', {
				id: requestId,
				params: { threadId: 'thread-one', targetId: id, ...observation },
			}),
			{ targetId: id, url: 'https://example.test/', title: 'Example', loading: false },
		);
		await channel.call('window:1', 'disposeSession', { threadId: 'thread-one' });
		assert.deepEqual([f.observations, f.retired, f.children.size], [[id], ['thread-one'], 1]);
	});

	test('the renderer channel streams page closure and cancels loading observations', async () => {
		using f = fixture();
		await f.create();
		f.loading = true;
		using host = f.createHost();
		const channel = host.getChannel();
		const events: BrowserViewEvent[] = [];
		using listener = channel.listen<BrowserViewEvent>('window:1', 'onDidEvent')(event => events.push(event));
		const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = channel.call('window:1', 'observe', {
			id: requestId,
			params: { threadId: 'thread-one', targetId: id, ...observation },
		});
		const rejected = assert.rejects(pending, /BrowserRequestCancelled/);
		await channel.call('window:1', 'cancel', { id: requestId });
		await rejected;
		await f.manager.destroyBrowserView(id);
		assert.equal(
			events.some(event => event.type === 'closed' && event.targetId === id),
			true,
		);
	});

	test('host reset cancels channel requests waiting for schema loading', async () => {
		using f = fixture();
		using host = f.createHost();
		const channel = host.getChannel();
		const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = channel.call('window:1', 'create', {
			id: requestId,
			params: { threadId: 'thread-one', url: 'about:blank' },
		});
		const rejected = assert.rejects(pending, /BrowserRequestCancelled/);
		host.reset();
		await rejected;
		// Let the suspended import resume: it must not create a page using the new connection's signal.
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.children.size, 0);
		assert.deepEqual(await channel.call('window:1', 'list', { id: requestId, params: { threadId: 'thread-one' } }), { pages: [] });
	});

	test('one id has one page, including simultaneous creation', async () => {
		using f = fixture();
		await Promise.all([
			f.manager.getOrCreateBrowserView(id, { initialUrl: 'https://example.test/', ...agent }),
			f.manager.getOrCreateBrowserView(id, { initialUrl: 'https://ignored.test/', ...agent }),
		]);
		assert.deepEqual([f.children.size, f.events.filter(e => e.type === 'created').length, (await f.manager.getState(id)).url], [1, 1, 'https://example.test/']);
	});

	test('preload messages require an owned frame, and picks require a selection mode or an accepted comment', async () => {
		using f = fixture();
		const view = await f.create();
		const sent: unknown[] = [];
		const frame = {
			detached: false,
			url: 'https://example.test/',
			framesInSubtree: [] as unknown[],
			send: (_channel: string, message: unknown) => sent.push(message),
		};
		frame.framesInSubtree.push(frame);
		Object.assign(f.contents, {
			mainFrame: frame,
			focusedFrame: frame,
			isFocused: () => true,
			executeJavaScriptInIsolatedWorld: async () => 'selected words',
			getZoomFactor: () => 1,
		});
		const post = (type: string, data?: unknown, frameToken = 'frame-one', senderFrame: unknown = frame) =>
			f.contents.emit('ipc-message', { senderFrame }, 'ash:browserView:preload', { type, data, frameToken });
		const key = {
			key: 'P',
			code: 'KeyP',
			keyCode: 80,
			ctrlKey: true,
			shiftKey: true,
			altKey: false,
			metaKey: false,
			repeat: false,
		};
		post('keyDown', key);
		post('ready');
		post('keyDown', key, 'stale-frame');
		post('keyDown', key, 'frame-one', { ...frame });
		post('keyDown', { ...key, keyCode: '80' });
		post('keyDown', key);
		assert.deepEqual(
			f.events.filter(event => event.type === 'keyDown'),
			[{ type: 'keyDown', targetId: id, event: key }],
		);
		assert.equal(await f.manager.getSelectedText(id), 'selected words');
		const element = {
			elementId: 'frame-one:element',
			outerHTML: '<button>Pick</button>',
			computedStyle: '',
			innerText: 'Pick',
			bounds: { x: 0, y: 0, width: 40, height: 20 },
		};
		post('elementPicked', element);
		await f.manager.toggleElementSelection(id, true);
		post('elementPicked', { ...element, bounds: { ...element.bounds, width: NaN } });
		post('elementPicked', element);
		assert.deepEqual(
			f.events.filter(event => event.type === 'elementPicked'),
			[{ type: 'elementPicked', targetId: id, data: { ...element, url: frame.url } }],
		);
		assert.ok(sent.some(message => (message as { command: string }).command === 'startElementPicker'));
		await f.manager.toggleAreaSelection(id, true);
		post('areaPicked', { x: 1000, y: 0, width: 40, height: 20 });
		post('areaPicked', { x: 0, y: 0, width: 40, height: 20 });
		assert.equal(f.events.filter(event => event.type === 'areaPicked').length, 1);
		post('selectionStopped');
		post('elementPicked', { ...element, comment: 'Unaccepted marker' });
		assert.equal(f.events.filter(event => event.type === 'elementPicked').length, 1);
		await f.manager.setElementComments(id, {
			comments: [{ elementId: element.elementId, body: 'Original comment' }],
		});
		post('elementPicked', { ...element, comment: 'Edited after picker stopped' });
		assert.equal(f.events.filter(event => event.type === 'elementPicked').length, 2);
		await f.manager.destroyBrowserView(id);
		assert.equal(view.signal.aborted, true);
		assert.equal(f.contents.listenerCount('ipc-message'), 0);
	});

	test('layout precedes visibility and follows the host zoom', async () => {
		using f = fixture();
		const page = await f.create();
		await assert.rejects(f.manager.setVisible(id, true), /BrowserTargetNotLaidOut/);
		await f.manager.layout(id, { x: 2, y: 3, width: 400, height: 300 });
		await f.manager.setVisible(id, true);
		assert.deepEqual([page.view.getBounds(), page.getState().visible], [{ x: 4, y: 6, width: 800, height: 600 }, true]);
	});

	test('closing releases the page once, removes listeners and aborts loading observations', async () => {
		using f = fixture();
		const page = await f.create();
		f.loading = true;
		const pending = page.runOperation(signal(), operationSignal => page.waitForLoad(operationSignal));
		await Promise.resolve();
		await f.manager.destroyBrowserView(id);
		await assert.rejects(pending, /BrowserRequestCancelled/);
		page.dispose();
		assert.deepEqual([f.manager.tryGetBrowserView(id), f.children.size, f.contents.eventNames(), f.events.filter(e => e.type === 'closed').length, f.networkReleases], [undefined, 0, [], 1, 0]);
	});

	test('a destroyed Chromium page leaves the manager immediately', async () => {
		using f = fixture();
		await f.create();
		f.contents.emit('destroyed');
		assert.equal(f.manager.tryGetBrowserView(id), undefined);
	});

	test('cancelling a queued operation leaves the next page operation usable', async () => {
		using f = fixture();
		const page = await f.create();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.observe = async pageId => {
			started.resolve();
			await finish.promise;
			return { targetId: pageId, url: f.url, title: f.title, loading: false };
		};
		using host = f.createHost();
		const first = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		await started.promise;
		const cancellation = new AbortController();
		const second = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: cancellation.signal });
		cancellation.abort();
		await assert.rejects(second, /BrowserRequestCancelled/);
		const third = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		finish.resolve();
		await Promise.all([first, third]);
		assert.equal(f.observations.length, 2);
	});

	test('network authority serializes different pages sharing an agent session', async () => {
		using f = fixture();
		await f.create();
		using host = f.createHost();
		const sibling = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		const order: string[] = [];
		f.observe = async pageId => {
			order.push(pageId);
			if (pageId === id) {
				started.resolve();
				await finish.promise;
			}
			return { targetId: pageId, url: f.url, title: f.title, loading: false };
		};
		const first = host.observe({ threadId: 'thread-one', targetId: id, networkToken: 'first-tool', ...observation }, { signal: signal() });
		await started.promise;
		const second = host.observe({ threadId: 'thread-one', targetId: sibling.targetId, networkToken: 'second-tool', ...observation }, { signal: signal() });
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(order, [id]);
		finish.resolve();
		await Promise.all([first, second]);
		assert.deepEqual(order, [id, sibling.targetId]);
	});

	test('an observation reads the state after preceding navigation', async () => {
		using f = fixture();
		const page = await f.create();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.load = async url => {
			started.resolve();
			await finish.promise;
			f.url = url;
			f.title = 'Loaded page';
		};
		const navigation = f.manager.loadURL(id, 'https://example.test/next');
		await started.promise;
		using host = f.createHost();
		const observed = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		finish.resolve();
		await navigation;
		assert.deepEqual(await observed, {
			targetId: id,
			url: 'https://example.test/next',
			title: 'Loaded page',
			loading: false,
		});
	});

	test('editor navigation waits until the agent screenshot finishes', async () => {
		using f = fixture();
		const page = await f.create();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		const order: string[] = [];
		f.observe = async pageId => {
			order.push('capture');
			started.resolve();
			await finish.promise;
			order.push('captured');
			return { targetId: pageId, url: f.url, title: f.title, loading: false };
		};
		f.load = async url => {
			order.push('navigate');
			f.url = url;
		};
		using host = f.createHost();
		const observed = host.observe({ threadId: 'thread-one', targetId: id, ...observation, includeScreenshot: true }, { signal: signal() });
		await started.promise;
		const navigation = f.manager.loadURL(id, 'https://example.test/next');
		finish.resolve();
		await Promise.all([observed, navigation]);
		assert.deepEqual(order, ['capture', 'captured', 'navigate']);
	});

	test('navigation replaces a loading page without waiting for its old load', async () => {
		using f = fixture();
		const page = await f.create();
		f.loading = true;
		f.load = async url => {
			f.url = url;
			f.loading = false;
		};
		await page.loadURL('https://example.test/next', signal());
		assert.equal(page.getState().url, 'https://example.test/next');
	});

	test('host cancellation returns before loading finishes and removes its load listener', async () => {
		using f = fixture();
		await f.create();
		f.loading = true;
		using host = f.createHost();
		const channel = host.getChannel();
		const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = channel.call('window:1', 'observe', {
			id: requestId,
			params: { threadId: 'thread-one', targetId: id, ...observation },
		});
		await Promise.resolve();
		await channel.call('window:1', 'cancel', { id: requestId });
		await assert.rejects(Promise.resolve(pending), /BrowserRequestCancelled/);
		f.loading = false;
		f.contents.emit('did-stop-loading');
		await host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		assert.equal(f.contents.listenerCount('did-stop-loading'), 1); // The page's state listener remains.
	});

	test('host reset cancels a snapshot before the next Chromium command', async () => {
		using f = fixture();
		await f.create();
		using host = f.createHost();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.observe = async pageId => {
			started.resolve();
			await finish.promise;
			return { targetId: pageId, url: f.url, title: f.title, loading: false };
		};
		const pending = host.observe(
			{
				threadId: 'thread-one',
				targetId: id,
				includeAccessibilityTree: true,
				includeDomSnapshot: true,
				includeScreenshot: false,
			},
			{ signal: signal() },
		);
		await started.promise;
		host.reset();
		await assert.rejects(pending, /BrowserRequestCancelled/);
		finish.resolve();
		await host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		assert.equal(f.cancelled.length, 1);
	});

	test('host reset closes its pages while retaining the user page', async () => {
		using f = fixture();
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'about:blank',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		using host = f.createHost();
		const created = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		host.reset();
		host.reset();
		assert.deepEqual([f.manager.tryGetBrowserView(created.targetId), f.manager.tryGetBrowserView(id)?.id], [undefined, id]);
	});

	test('retiring the manager releases a pending network owner without creating a page', async () => {
		using f = fixture();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.remote = true;
		f.proxy = async () => {
			started.resolve();
			await finish.promise;
			return {
				localPort: 1234,
				signal: signal(),
				...toDisposable(() => {
					f.networkReleases++;
				}),
			};
		};
		const pending = f.manager.createTarget('about:blank', 'thread-one', signal());
		await started.promise;
		f.manager.dispose();
		finish.resolve();
		await assert.rejects(pending, /BrowserCapabilityUnavailable/);
		assert.deepEqual([f.children.size, f.networkReleases], [0, 1]);
	});

	test('retiring the host during creation releases its late network owner', async () => {
		using f = fixture();
		using host = f.createHost();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.remote = true;
		f.proxy = async () => {
			started.resolve();
			await finish.promise;
			return {
				localPort: 1234,
				signal: signal(),
				...toDisposable(() => {
					f.networkReleases++;
				}),
			};
		};
		const pending = host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		await started.promise;
		host.dispose();
		finish.resolve();
		await assert.rejects(pending, /BrowserCapabilityUnavailable/);
		assert.deepEqual([f.children.size, f.networkReleases], [0, 1]);
	});

	test('agent threads share their own storage and cannot read, drive or close another thread page', async () => {
		using f = fixture();
		using host = f.createHost();
		const first = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		const sibling = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		const other = await host.create({ threadId: 'thread-two', url: 'about:blank' }, { signal: signal() });
		const firstSession = f.manager.tryGetBrowserView(first.targetId)!.session;
		assert.equal(firstSession, f.manager.tryGetBrowserView(sibling.targetId)!.session);
		assert.notEqual(firstSession, f.manager.tryGetBrowserView(other.targetId)!.session);
		assert.throws(() => host.observe({ threadId: 'thread-two', targetId: first.targetId, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
		await assert.rejects(host.perform({ threadId: 'thread-two', action: { type: 'reload', targetId: first.targetId } }, { signal: signal() }), /BrowserTargetAccessDenied/);
		await assert.rejects(host.close({ threadId: 'thread-two', targetId: first.targetId }), /BrowserTargetAccessDenied/);
		assert.equal(f.manager.tryGetBrowserView(first.targetId)?.id, first.targetId);
	});

	test('user storage is workspace scoped and user pages are private from agents', async () => {
		using f = fixture();
		using host = f.createHost();
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'about:blank',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Workspace },
		});
		assert.throws(() => host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
		assert.ok([...f.partitions.keys()].every(partition => partition.startsWith('persist:')));
	});
});

test('sharing grants only the chosen thread and revocation cancels its operation without closing the user page', async () => {
	using f = fixture();
	using host = f.createHost();
	await f.manager.getOrCreateBrowserView(id, {
		initialUrl: 'about:blank',
		owner: { type: 'user' },
		session: { scope: BrowserViewStorageScope.Workspace },
	});
	await f.manager.setSharing(id, ['thread-one']);
	await assert.rejects(host.perform({ threadId: 'thread-one', action: { type: 'reload', targetId: id } }, { signal: signal() }), /BrowserNetworkIsolationRequired/);
	await assert.rejects(host.close({ threadId: 'thread-one', targetId: id }), /BrowserNetworkIsolationRequired/);
	assert.throws(() => host.observe({ threadId: 'thread-two', targetId: id, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
	const started = promiseWithResolvers<void>();
	const finish = promiseWithResolvers<void>();
	f.observe = async pageId => {
		started.resolve();
		await finish.promise;
		return { targetId: pageId, url: f.url, title: f.title, loading: false };
	};
	const pending = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
	await started.promise;
	await f.manager.setSharing(id, []);
	await assert.rejects(pending, /BrowserRequestCancelled/);
	assert.equal(f.cancelled.length, 1);
	finish.resolve();
	assert.throws(() => host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
	assert.ok(f.manager.tryGetBrowserView(id));
	await f.manager.setSharing(id, ['thread-one']);
	host.reset();
	assert.deepEqual(await f.manager.getSharing(id), []);
	assert.ok(f.manager.tryGetBrowserView(id));
});

export function fixture(storageOverride?: IApplicationStorageMainService, provideEncryption = true, useInMemorySecretStorage = false) {
	const store = new DisposableStore();
	const events: BrowserViewEvent[] = [];
	const children = new Set<WebContentsView>();
	const contents = new EventEmitter();
	const partitions = new Map<string, Electron.Session>();
	const f = {
		[Symbol.dispose]: () => store.dispose(),
		events,
		children,
		contents,
		partitions,
		url: '',
		title: 'Example',
		loading: false,
		attached: false,
		networkReleases: 0,
		workbenchFocused: 0,
		workbenchInput: [] as Electron.KeyboardInputEvent[],
		commands: [] as Array<{ method: string; params: unknown; sessionId?: string }>,
		debugSessions: [] as string[],
		observations: [] as string[],
		cancelled: [] as string[],
		retired: [] as string[],
		observe: async (pageId: string): Promise<IBrowserViewObservation> => ({
			targetId: pageId,
			url: f.url,
			title: f.title,
			loading: f.loading,
		}),
		command: async (_method: string, _params?: unknown): Promise<unknown> => ({}),
		load: async (url: string): Promise<void> => {
			f.url = url;
		},
		capture: async () => ({ toPNG: () => Buffer.from('png') }),
		remote: false,
		encryptionAvailable: true,
		authCacheClears: 0,
		menuRequests: [] as INativeContextMenuRequest[],
		popupMenu: async (_request: INativeContextMenuRequest): Promise<INativeContextMenuResult> => ({}),
		menuCloses: 0,
		messages: {} as Readonly<Record<string, string>>,
		clipboardWrites: [] as string[],
		editing: [] as string[],
		imageCopies: [] as { x: number; y: number }[],
		downloads: [] as string[],
		proxy: async () => ({
			localPort: 1234,
			signal: signal(),
			...toDisposable(() => {
				f.networkReleases++;
			}),
		}),
	};
	const window = {
		id: 1,
		contentView: {
			addChildView: (view: WebContentsView) => children.add(view),
			removeChildView: (view: WebContentsView) => children.delete(view),
		},
		webContents: {
			getZoomFactor: () => 2,
			focus: () => {
				f.workbenchFocused++;
			},
			sendInputEvent: (input: Electron.KeyboardInputEvent) => {
				f.workbenchInput.push(input);
			},
		},
		isDestroyed: () => false,
	} as unknown as BrowserWindow;
	const instantiation = store.add(new InstantiationService());
	const snapshots = new Map<string, IStorageSnapshot>();
	const storage: IApplicationStorageMainService = storageOverride ?? {
		onDidChangeStorage: Event.None,
		onWillSaveState: Event.None,
		initialize: async () => {},
		getItemsIfExists: async identity => snapshots.get(JSON.stringify(identity)),
		getItems: async identity => {
			const key = JSON.stringify(identity);
			let snapshot = snapshots.get(key);
			if (!snapshot) {
				snapshot = { identity, revision: 0, isNew: true, entries: {} };
				snapshots.set(key, snapshot);
			}
			return snapshot;
		},
		updateItems: async (identity, key, entry) => {
			const previous = await storage.getItems(identity);
			const entries = { ...previous.entries };
			if (entry) {
				entries[key] = entry;
			} else {
				delete entries[key];
			}
			const snapshot = { ...previous, revision: previous.revision + 1, entries };
			snapshots.set(JSON.stringify(identity), snapshot);
			return snapshot;
		},
		cleanUpStorage: async () => {},
		use: () => toDisposable(() => {}),
		flush: async () => {},
		close: async () => {},
		dispose: () => {},
		[Symbol.dispose]: () => {},
	};
	instantiation.registerInstance(IApplicationStorageMainService, storage);
	// Deterministic OS facility replacement; the production service still owns encoding and failure policy.
	const encryption = new EncryptionMainService(
		{
			isEncryptionAvailable: () => f.encryptionAvailable,
			encryptString: value => {
				const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), Buffer.alloc(12, 8));
				return Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
			},
			decryptString: bytes => {
				const cipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), Buffer.alloc(12, 8));
				cipher.setAuthTag(bytes.subarray(-16));
				return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString('utf8');
			},
		} as Electron.SafeStorage,
		'win32',
	);
	if (provideEncryption) {
		instantiation.registerInstance(IEncryptionMainService, encryption);
	}
	instantiation.registerInstance(ILogService, new NullLoggerService());
	instantiation.registerInstance(IClipboardService, {
		writeText: async (text: string) => {
			f.clipboardWrites.push(text);
		},
	} as unknown as IClipboardService);
	const passwordConfiguration = store.add(new InMemoryConfigurationService());
	instantiation.registerInstance(IConfigurationService, passwordConfiguration);
	// Construct the vault only when encryption is registered, preserving the missing-registration test.
	if (provideEncryption) {
		instantiation.registerInstance(IBrowserPasswordMainService, store.add(instantiation.createInstance(BrowserPasswordMainService, useInMemorySecretStorage)));
	}
	const manager = store.add(
		instantiation.createInstance(BrowserViewMainService, {
			window,
			getWorkspaceId: () => 'workspace-one',
			contextMenu: {
				popup: (request: INativeContextMenuRequest) => {
					f.menuRequests.push(request);
					return f.popupMenu(request);
				},
				close: () => {
					f.menuCloses++;
				},
			} as unknown as ElectronContextMenu,
			getNlsMessages: () => f.messages,
			getRemoteNetwork() {
				return f.remote
					? {
							authority: 'ssh-remote+test',
							tunnels: {
								openProxy: () => f.proxy(),
							} as unknown as import('../../../remote/electron-main/sshPortForwardingService.js').SshPortForwardingService,
						}
					: undefined;
			},
			createSession: (partition: string) => {
				let session = partitions.get(partition);
				if (!session) {
					session = Object.assign(new EventEmitter(), {
						protocol: { handle: () => {}, unhandle: () => {} },
						webRequest: { onBeforeRequest: () => {} },
						setPermissionCheckHandler: () => {},
						setPermissionRequestHandler: () => {},
						setDevicePermissionHandler: () => {},
						setProxy: async () => {},
						closeAllConnections: async () => {},
						clearAuthCache: async () => {
							f.authCacheClears++;
						},
						clearStorageData: async () => {},
						clearCache: async () => {},
					}) as unknown as Electron.Session;
					partitions.set(partition, session);
				}
				return session;
			},
			createView: (browserStorage: Electron.Session) => {
				const chromiumId = 'chromium-target-' + children.size;
				const pageContents = children.size === 0 ? contents : new EventEmitter();
				let destroyed = false;
				let zoomFactor = 1;
				let bounds = { x: 0, y: 0, width: 0, height: 0 };
				Object.assign(pageContents, {
					getZoomFactor: () => zoomFactor,
					setZoomFactor: (value: number) => {
						zoomFactor = value;
					},
					id: children.size + 1,
					setWebRTCIPHandlingPolicy: () => {},
					session: browserStorage,
					setWindowOpenHandler: () => {},
					isDestroyed: () => destroyed,
					isLoading: () => f.loading,
					getURL: () => f.url,
					getTitle: () => f.title,
					focus: () => {},
					stop: () => {
						f.loading = false;
					},
					reload: () => {},
					reloadIgnoringCache: () => {},
					navigationHistory: {
						canGoBack: () => false,
						canGoForward: () => false,
						goBack: () => {},
						goForward: () => {},
					},
					loadURL: (url: string) => f.load(url),
					capturePage: () => f.capture(),
					undo: () => f.editing.push('undo'),
					redo: () => f.editing.push('redo'),
					cut: () => f.editing.push('cut'),
					copy: () => f.editing.push('copy'),
					paste: () => f.editing.push('paste'),
					pasteAndMatchStyle: () => f.editing.push('pastePlain'),
					selectAll: () => f.editing.push('selectAll'),
					copyImageAt: (x: number, y: number) => {
						f.imageCopies.push({ x, y });
					},
					downloadURL: (url: string) => {
						f.downloads.push(url);
					},
					close: () => {
						destroyed = true;
						pageContents.emit('destroyed');
					},
					debugger: Object.assign(new EventEmitter(), {
						isAttached: () => f.attached,
						attach: () => {
							f.attached = true;
						},
						detach: () => {
							f.attached = false;
						},
						sendCommand: (method: string, params?: unknown, sessionId?: string) => {
							f.commands.push({ method, params, ...(sessionId ? { sessionId } : {}) });
							if (method === 'Target.attachToTarget') {
								const sessionId = 'session-' + f.debugSessions.length;
								f.debugSessions.push(sessionId);
								return Promise.resolve({ sessionId });
							}
							return method === 'Target.getTargetInfo' ? Promise.resolve({ targetInfo: { targetId: chromiumId } }) : f.command(method, params);
						},
					}),
				});
				return {
					webContents: pageContents,
					setVisible: () => {},
					setBounds: (value: typeof bounds) => {
						bounds = value;
					},
					getBounds: () => bounds,
				} as unknown as WebContentsView;
			},
		}),
	);
	instantiation.registerInstance(IBrowserViewMainService, manager);
	instantiation.registerInstance(IPlaywrightService, {
		getObservation: async (_operationId, _sessionId, pageId) => {
			f.observations.push(pageId);
			return f.observe(pageId);
		},
		performAction: async () => undefined,
		cancelOperation: async operationId => {
			f.cancelled.push(operationId);
		},
		disposeSession: async sessionId => {
			f.retired.push(sessionId);
		},
	});
	store.add(manager.onDidEvent(event => events.push(event)));
	return Object.assign(f, {
		manager,
		instantiation,
		store,
		storage,
		passwordConfiguration,
		createHost: () => instantiation.createInstance(AppServerBrowserHost),
		create: async () => {
			await manager.getOrCreateBrowserView(id, { initialUrl: 'https://example.test/', ...agent });
			return manager.tryGetBrowserView(id)!;
		},
	});
}

import { browserViewChannel } from '../../electron-main/browserViewIpc.js';

suite('Browser authentication', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const credentials = { username: 'private-user', password: 'private-password', remember: true };
	const application = { scope: StorageScope.APPLICATION, id: 'application' };
	const user = { owner: { type: 'user' as const }, session: { scope: BrowserViewStorageScope.Workspace as const } };
	const create = (f: ReturnType<typeof fixture>, session = user.session) => f.manager.getOrCreateBrowserView(id, { initialUrl: 'https://example.test/', owner: user.owner, session });
	const challenge = (f: ReturnType<typeof fixture>, firstAuthAttempt = true, overrides: Partial<Electron.AuthInfo> = {}) => {
		const calls: Array<readonly [string | undefined, string | undefined]> = [];
		let prevented = false;
		f.contents.emit(
			'login',
			{
				preventDefault: () => {
					prevented = true;
				},
			},
			{ url: 'https://example.test/private', firstAuthAttempt },
			{ isProxy: false, host: 'example.test', port: 443, realm: 'private', scheme: 'basic', ...overrides },
			(username?: string, password?: string) => calls.push([username, password]),
		);
		assert.equal(prevented, true);
		return calls;
	};
	const prompt = async (f: ReturnType<typeof fixture>) => {
		const find = () => [...f.events].reverse().find((event): event is Extract<BrowserViewEvent, { type: 'authenticationRequested' }> => event.type === 'authenticationRequested');
		if (find()) {
			return find()!;
		}
		return new Promise<NonNullable<ReturnType<typeof find>>>(resolve => {
			const listener = f.manager.onDidEvent(event => {
				if (event.type === 'authenticationRequested') {
					listener.dispose();
					resolve(event);
				}
			});
			f.store.add(listener);
		});
	};
	const response = (f: ReturnType<typeof fixture>, requestId: string, value: typeof credentials | null) =>
		browserViewChannel(f.manager, { call: async <T>() => null as T, listen: () => Event.None }).call('window:1', 'respondToAuthentication', [id, requestId, value]);

	test('production page construction requires the Main encryption registration', async () => {
		using f = fixture(undefined, false);
		await assert.rejects(create(f), /Unknown service: encryptionMainService/);
	});

	test('memory mode authenticates without native encryption and leaves saved HTTP credentials untouched', async () => {
		using f = fixture(undefined, true, true);
		await create(f);
		const key = `browser.credentials.${f.manager.tryGetBrowserView(id)!.session.id}.preserved`;
		await f.storage.updateItems(application, key, { value: 'preserved-ciphertext', target: StorageTarget.MACHINE });
		let nativeCalls = 0;
		f.instantiation.get(IEncryptionMainService).isEncryptionAvailable = async () => {
			nativeCalls++;
			throw new Error('Unexpected native encryption');
		};
		const calls = challenge(f);
		const request = await prompt(f);
		assert.equal(request.canRemember, false);
		assert.equal(request.storageFailed, false);
		await response(f, request.requestId, credentials);
		assert.deepEqual(calls, [[credentials.username, credentials.password]]);
		await f.manager.tryGetBrowserView(id)!.clearAuthentication();
		assert.equal(nativeCalls, 0);
		const entries = (await f.storage.getItems(application)).entries;
		assert.deepEqual(
			Object.keys(entries).filter(key => key.startsWith('browser.credentials.')),
			[key],
		);
		assert.equal(entries[key]!.value, 'preserved-ciphertext');
	});

	test('unreadable encrypted credentials are preserved, and failed saving never blocks a one-time sign-in', async () => {
		using f = fixture();
		await create(f);
		challenge(f);
		await response(f, (await prompt(f)).requestId, credentials);
		const snapshot = await f.storage.getItems(application);
		const key = Object.keys(snapshot.entries).find(key => key.startsWith('browser.credentials.'))!;
		await f.storage.updateItems(application, key, {
			value: 'unreadable-ciphertext',
			target: StorageTarget.MACHINE,
		});
		await f.manager.destroyBrowserView(id);
		await create(f);
		f.events.length = 0;
		const calls = challenge(f);
		const request = await prompt(f);
		assert.equal(request.storageFailed, true);
		assert.equal((await f.storage.getItems(application)).entries[key]!.value, 'unreadable-ciphertext');
		const original = f.storage.updateItems;
		f.storage.updateItems = async () => {
			throw new Error('OS error must not reach the page');
		};
		try {
			await response(f, request.requestId, credentials);
		} finally {
			f.storage.updateItems = original;
		}
		assert.deepEqual(calls, [[credentials.username, credentials.password]]);
		assert.equal(
			f.events.some(event => event.type === 'authenticationStorageFailed'),
			true,
		);
		assert.doesNotMatch(JSON.stringify(f.events), /OS error|private-password/);
	});

	test('clearing a partition cancels an in-flight encrypted save before a late result can restore the credential', async () => {
		using f = fixture();
		await create(f);
		const calls = challenge(f);
		const request = await prompt(f);
		const encryption = f.instantiation.get(IEncryptionMainService);
		const original = encryption.encrypt.bind(encryption);
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		encryption.encrypt = async value => {
			started.resolve();
			await finish.promise;
			return original(value);
		};
		const saving = response(f, request.requestId, credentials);
		await started.promise;
		try {
			await f.manager.clearStorage(id);
		} finally {
			finish.resolve();
			await saving;
		}
		assert.deepEqual(calls, [[undefined, undefined]]);
		assert.equal(
			Object.keys((await f.storage.getItems(application)).entries).some(key => key.startsWith('browser.credentials.')),
			false,
		);
	});

	test('login reaches validated IPC, persists only ciphertext and reuses it after reopening the page', async () => {
		using f = fixture();
		await create(f);
		const calls = challenge(f);
		const request = await prompt(f);
		assert.equal(request.canRemember, true);
		await response(f, request.requestId, credentials);
		assert.deepEqual(calls, [[credentials.username, credentials.password]]);
		const snapshot = await f.storage.getItems(application);
		assert.equal(Object.keys(snapshot.entries).filter(key => key.startsWith('browser.credentials.')).length, 1);
		assert.doesNotMatch(JSON.stringify(snapshot), /private-user|private-password|example\.test|"private"/);
		await f.manager.destroyBrowserView(id);
		await create(f);
		f.events.length = 0;
		const restored = challenge(f);
		await new Promise<void>(resolve => {
			if (restored.length) {
				resolve();
				return;
			}
			const listener = f.manager.onDidEvent(event => {
				if (event.type === 'authenticationRequestClosed') {
					listener.dispose();
					queueMicrotask(resolve);
				}
			});
			f.store.add(listener);
		});
		assert.deepEqual(restored, [[credentials.username, credentials.password]]);
		assert.equal(
			f.events.some(event => event.type === 'authenticationRequested'),
			false,
		);
		assert.doesNotMatch(JSON.stringify(f.events), /private-user|private-password/);
	});

	test('a rejected saved credential prompts again, removes the stale value and never loops automatic retries', async () => {
		using f = fixture();
		await create(f);
		challenge(f);
		await response(f, (await prompt(f)).requestId, credentials);
		f.events.length = 0;
		const retry = challenge(f, false);
		const request = await prompt(f);
		assert.equal(
			Object.keys((await f.storage.getItems(application)).entries).some(key => key.startsWith('browser.credentials.')),
			false,
		);
		await response(f, request.requestId, null);
		assert.deepEqual(retry, [[undefined, undefined]]);
	});

	test('protection spaces and browser storage sessions do not share credentials', async () => {
		using f = fixture();
		await create(f);
		challenge(f);
		await response(f, (await prompt(f)).requestId, credentials);
		for (const overrides of [{ realm: 'other' }, { isProxy: true }, { scheme: 'digest' }]) {
			f.events.length = 0;
			const calls = challenge(f, true, overrides);
			const request = await prompt(f);
			assert.deepEqual(calls, []);
			await response(f, request.requestId, null);
		}
		await f.manager.destroyBrowserView(id);
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'https://example.test/',
			owner: user.owner,
			session: { scope: BrowserViewStorageScope.Global },
		});
		f.events.length = 0;
		const calls = challenge(f);
		await response(f, (await prompt(f)).requestId, null);
		assert.deepEqual(calls, [[undefined, undefined]]);
	});

	test('unavailable encryption and ephemeral sessions permit one sign-in without saving; Agent pages are denied', async () => {
		using f = fixture();
		await create(f);
		f.encryptionAvailable = false;
		const calls = challenge(f);
		const request = await prompt(f);
		assert.deepEqual([request.canRemember, request.storageFailed], [false, true]);
		await response(f, request.requestId, credentials);
		assert.deepEqual(calls, [[credentials.username, credentials.password]]);
		assert.equal(Object.keys((await f.storage.getItems(application)).entries).length, 0);
		await f.manager.destroyBrowserView(id);
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'https://example.test/',
			owner: user.owner,
			session: { scope: BrowserViewStorageScope.Ephemeral },
		});
		f.events.length = 0;
		f.encryptionAvailable = true;
		challenge(f);
		const ephemeral = await prompt(f);
		assert.equal(ephemeral.canRemember, false);
		await response(f, ephemeral.requestId, credentials);
		assert.equal(Object.keys((await f.storage.getItems(application)).entries).length, 0);
		await f.manager.destroyBrowserView(id);
		await f.create();
		f.events.length = 0;
		assert.deepEqual(challenge(f), [[undefined, undefined]]);
		assert.equal(
			f.events.some(event => event.type === 'authenticationRequested'),
			false,
		);
	});

	test('navigation cancels once, stale or malformed IPC cannot authenticate, and clearing data removes saved and cached authentication', async () => {
		using f = fixture();
		await create(f);
		const calls = challenge(f);
		const request = await prompt(f);
		await assert.rejects(response(f, request.requestId, { ...credentials, password: 'bad\nheader' }), /Invalid browser authentication/);
		f.contents.emit('did-start-navigation', {}, 'https://example.test/next', false, true);
		await response(f, request.requestId, credentials);
		assert.deepEqual(calls, [[undefined, undefined]]);
		f.events.length = 0;
		challenge(f);
		await response(f, (await prompt(f)).requestId, credentials);
		f.events.length = 0;
		const pending = challenge(f, true, { realm: 'another-realm' });
		const pendingRequest = await prompt(f);
		await f.manager.clearStorage(id);
		await response(f, pendingRequest.requestId, credentials);
		assert.deepEqual(pending, [[undefined, undefined]]);
		assert.equal(f.authCacheClears, 1);
		assert.equal(
			Object.keys((await f.storage.getItems(application)).entries).some(key => key.startsWith('browser.credentials.')),
			false,
		);
	});
});

suite('Browser webpage context menu', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const context = (overrides: Partial<ContextMenuParams> = {}): ContextMenuParams =>
		({
			x: 12,
			y: 18,
			frame: { detached: false },
			linkURL: '',
			srcURL: '',
			mediaType: 'none',
			selectionText: '',
			isEditable: false,
			hasImageContents: false,
			menuSourceType: 'mouse',
			editFlags: {
				canUndo: false,
				canRedo: false,
				canCut: false,
				canCopy: true,
				canPaste: true,
				canDelete: false,
				canSelectAll: true,
			},
			...overrides,
		}) as ContextMenuParams;

	test('keyboard editing menus target the page, retain disabled actions and follow client language and zoom', async () => {
		using f = fixture();
		await f.create();
		f.messages = JSON.parse(await readFile(join(process.cwd(), 'extensions/language-pack-zh-cn/translations/workbench.json'), 'utf8'))['ash.workbench'];
		await f.manager.layout(id, { x: 20, y: 30, width: 400, height: 300 });
		f.popupMenu = async () => ({ selectedId: 'paste' });
		f.contents.emit('context-menu', {}, context({ isEditable: true, menuSourceType: 'keyboard' }));
		await Promise.resolve();
		assert.deepEqual(f.editing, ['paste']);
		const request = f.menuRequests.at(-1)!;
		assert.deepEqual({ x: request.x, y: request.y }, { x: 26, y: 39 });
		assert.ok(request.items.some(item => item.type === 'action' && item.id === 'cut' && !item.enabled));
		assert.ok(request.items.some(item => item.type === 'action' && item.id === 'paste' && item.label === '粘贴'));
		f.popupMenu = async () => ({ selectedId: 'cut' });
		await Promise.resolve();
		f.contents.emit('context-menu', {}, context({ isEditable: true }));
		await Promise.resolve();
		assert.deepEqual(f.editing, ['paste']);
	});

	test('link and image actions reuse page opening, clipboard and download owners', async () => {
		using f = fixture();
		await f.manager.getOrCreateBrowserView(id, {
			initialUrl: 'https://example.test/',
			owner: { type: 'user' },
			session: { scope: BrowserViewStorageScope.Global },
		});
		f.popupMenu = async () => ({ selectedId: 'openLink' });
		f.contents.emit('context-menu', {}, context({ linkURL: 'https://example.test/next' }));
		await Promise.resolve();
		assert.ok(f.events.some(event => event.type === 'openRequested' && event.targetId === id && event.url === 'https://example.test/next'));
		await Promise.resolve();
		f.popupMenu = async () => ({ selectedId: 'copyLink' });
		f.contents.emit('context-menu', {}, context({ linkURL: 'javascript:alert(1)' }));
		await Promise.resolve();
		assert.ok(f.menuRequests.at(-1)!.items.some(item => item.type === 'action' && item.id === 'openLink' && !item.enabled));
		assert.deepEqual(f.clipboardWrites, ['javascript:alert(1)']);
		await Promise.resolve();
		f.popupMenu = async () => ({ selectedId: 'copyImage' });
		f.contents.emit('context-menu', {}, context({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.test/image.png' }));
		await Promise.resolve();
		assert.deepEqual(f.imageCopies, [{ x: 12, y: 18 }]);
		await Promise.resolve();
		f.popupMenu = async () => ({ selectedId: 'saveImage' });
		f.contents.emit('context-menu', {}, context({ mediaType: 'image', hasImageContents: true, srcURL: 'blob:https://example.test/image-id' }));
		await Promise.resolve();
		assert.deepEqual(f.downloads, ['blob:https://example.test/image-id']);
	});

	test('navigation and page disposal revoke pending menu actions and release event listeners', async () => {
		using f = fixture();
		await f.create();
		const pending = promiseWithResolvers<INativeContextMenuResult>();
		f.popupMenu = () => pending.promise;
		f.contents.emit('context-menu', {}, context({ linkURL: 'https://example.test/next' }));
		assert.ok(f.menuRequests.at(-1)!.items.some(item => item.type === 'action' && item.id === 'openLink' && !item.enabled));
		f.contents.emit('did-start-navigation', {}, 'https://example.test/other', false, true);
		assert.equal(f.menuCloses, 1);
		pending.resolve({ selectedId: 'copyLink' });
		await Promise.resolve();
		assert.deepEqual(f.clipboardWrites, []);
		assert.equal(f.contents.listenerCount('context-menu'), 1);
		await f.manager.destroyBrowserView(id);
		assert.equal(f.contents.listenerCount('context-menu'), 0);
	});
});
