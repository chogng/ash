import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService, type NotificationItem } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService, type OpenOptions } from '../../../../../platform/opener/common/opener.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { NotificationService } from '../../../notification/common/notificationService.js';
import { BrowserClipboardService } from '../../browser/clipboardService.js';

suite('Workbench browser clipboard', () => {
	test('typed text bypasses system permission prompts and is retained independently', async () => {
		using fixture = new ClipboardFixture({ readText: async () => { throw new Error('Denied'); } });
		await fixture.clipboard.writeText('selected', 'selection');
		assert.equal(await fixture.clipboard.readText('selection'), 'selected');
		assert.deepEqual(fixture.notifications.getNotifications(), []);
	});
	test('reads and writes through the owning window without prompting', async () => {
		let text = 'initial';
		using fixture = new ClipboardFixture({ readText: async () => text, writeText: async value => { text = value; } });
		await fixture.clipboard.writeText('updated');
		assert.deepEqual([await fixture.clipboard.readText(), fixture.notifications.getNotifications()], ['updated', []]);
	});

	test('retries denied reads and keeps permission help separate from the pending read', async () => {
		let attempts = 0;
		using fixture = new ClipboardFixture({
			readText: async () => {
				if (++attempts === 1) { throw new Error('denied'); }
				return 'recovered';
			}
		});
		const added = fixture.nextNotification();
		const reading = fixture.clipboard.readText();
		const prompt = await added;
		await prompt.actions![1]!.run();
		assert.deepEqual(fixture.opened, [['https://support.google.com/chrome/answer/114662', { openExternal: true }]]);
		assert.equal(attempts, 1);
		await prompt.actions![0]!.run();
		assert.deepEqual([await reading, attempts, fixture.notifications.getNotifications()], ['recovered', 2, []]);
	});

	test('a failed retry prompts again and dismissal completes with empty text', async () => {
		using fixture = new ClipboardFixture({ readText: async () => { throw new Error('denied'); } });
		const firstAdded = fixture.nextNotification();
		const reading = fixture.clipboard.readText();
		const first = await firstAdded;
		const secondAdded = fixture.nextNotification();
		await first.actions![0]!.run();
		const second = await secondAdded;
		assert.notEqual(second.id, first.id);
		fixture.notifications.remove(second.id);
		assert.deepEqual([await reading, fixture.notifications.getNotifications()], ['', []]);
	});

	test('disposing the service scope closes all outstanding reads and prompts', async () => {
		using fixture = new ClipboardFixture({ readText: async () => { throw new Error('denied'); } });
		const added = fixture.nextNotification();
		const first = fixture.clipboard.readText();
		const second = fixture.clipboard.readText();
		await added;
		await Promise.resolve();
		fixture.services.dispose();
		assert.deepEqual([await first, await second, fixture.notifications.getNotifications()], ['', '', []]);
	});

	test('a late read failure after scope disposal does not create a prompt', async () => {
		let reject!: (error: Error) => void;
		using fixture = new ClipboardFixture({ readText: () => new Promise<string>((_resolve, rejectRead) => { reject = rejectRead; }) });
		const reading = fixture.clipboard.readText();
		fixture.services.dispose();
		reject(new Error('late denial'));
		assert.deepEqual([await reading, fixture.notifications.getNotifications()], ['', []]);
	});

	test('permission recovery uses the Chinese catalog', async () => {
		initializeTestLocalization('zh-CN');
		try {
			using fixture = new ClipboardFixture({ readText: async () => { throw new Error('denied'); } });
			const added = fixture.nextNotification();
			const reading = fixture.clipboard.readText();
			const prompt = await added;
			assert.deepEqual([prompt.message, prompt.actions!.map(action => action.label)], ['无法读取剪贴板。请允许此网站访问剪贴板，然后重试。', ['重试', '了解详情']]);
			fixture.notifications.remove(prompt.id);
			assert.equal(await reading, '');
		} finally {
			resetNlsResolver();
		}
	});

	test('rich reads recover all formats after permission retry without reading plain text separately', async () => {
		let attempts = 0;
		using fixture = new ClipboardFixture({
			read: async () => {
				if (++attempts === 1) throw new DOMException('denied', 'NotAllowedError');
				return [{ types: ['text/html'], getType: async () => new Blob(['<b>recovered</b>']) } as unknown as ClipboardItem];
			},
			readText: async () => { throw new Error('Must not downgrade'); },
		});
		const added = fixture.nextNotification();
		const reading = fixture.clipboard.read();
		const prompt = await added;
		await prompt.actions![0]!.run();
		assert.deepEqual([await reading, attempts, fixture.notifications.getNotifications()], [
			[{ type: 'text/html', data: new TextEncoder().encode('<b>recovered</b>') }], 2, [],
		]);
	});

	for (const close of ['dismiss', 'dispose']) {
		test(`rich read ends empty on ${close} and releases its permission prompt`, async () => {
			using fixture = new ClipboardFixture({ read: async () => { throw new Error('denied'); } });
			const added = fixture.nextNotification();
			const reading = fixture.clipboard.read();
			const prompt = await added;
			if (close === 'dismiss') fixture.notifications.remove(prompt.id);
			else fixture.services.dispose();
			assert.deepEqual([await reading, fixture.notifications.getNotifications()], [[], []]);
		});
	}

	test('service construction rejects missing notification dependencies', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(BrowserClipboardService), /notificationService/);
	});
});

class ClipboardFixture extends Disposable {
	public readonly notifications = this._register(new NotificationService());
	public readonly services = this._register(new InstantiationService());
	public readonly opened: [string, OpenOptions | undefined][] = [];
	public readonly clipboard: IClipboardService;

	constructor(clipboard: Partial<Clipboard>) {
		super();
		const browser = new JSDOM('<!doctype html><body></body>');
		this._register(toDisposable(() => browser.window.close()));
		Object.defineProperty(browser.window.navigator, 'clipboard', { value: clipboard });
		this.services.registerSingleton(IClipboardService, () => this.services.createInstance(BrowserClipboardService), { instantiation: InstantiationType.Delayed });
		this.clipboard = this.services.get(IClipboardService);
		this.services.registerInstance(ILayoutService, { mainContainer: browser.window.document.body } as ILayoutService);
		this.services.registerInstance(INotificationService, this.notifications);
		this.services.registerInstance(ILogService, new NullLoggerService());
		this.services.registerInstance(IOpenerService, {
			open: async (target: string, options?: OpenOptions) => {
				this.opened.push([target, options]);
				return true;
			}
		} as IOpenerService);
	}

	public nextNotification(): Promise<NotificationItem> {
		return new Promise(resolve => {
			const listener = this._register(this.notifications.onDidAdd(item => {
				listener.dispose();
				resolve(item);
			}));
		});
	}
}
