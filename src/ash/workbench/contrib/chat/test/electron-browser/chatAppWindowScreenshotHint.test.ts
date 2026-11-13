import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService, type IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, type IStorageValueChangeEvent } from '../../../../../platform/storage/common/storage.js';
import { IAppWindowScreenshotService } from '../../../screenshotTool/electron-browser/appWindowScreenshot.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from '../../browser/widget/input/chatInputNoticeHost.js';
import { ChatAttachmentModel } from '../../browser/attachments/chatAttachmentModel.js';
import { ChatUserImageAttachmentService, IChatUserImageAttachmentService } from '../../browser/attachments/chatUserImageAttachments.js';
import { AppWindowScreenshotHint } from '../../electron-browser/actions/chatAppWindowScreenshotHint.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatConfiguration } from '../../common/constants.js';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(lifetime: DisposableStore) {
	const services = lifetime.add(new InstantiationService());
	const attached = lifetime.add(new ChatUserImageAttachmentService());
	const changed = lifetime.add(new Emitter<IStorageValueChangeEvent>());
	const configured = lifetime.add(new Emitter<IConfigurationChangeEvent>());
	const captured = lifetime.add(new Emitter<void>());
	const values = new Map<string, string>();
	const state = { enabled: true, captured: false, runs: 0 };
	services.registerInstance(IChatUserImageAttachmentService, attached);
	services.registerInstance(IAppWindowScreenshotService, { get hasCaptured() { return state.captured; }, onDidChangeHasCaptured: captured.event } as IAppWindowScreenshotService);
	services.registerInstance(IConfigurationService, { getValue: (key: string) => key === ChatConfiguration.AppWindowScreenshotsEnabled ? state.enabled : true, onDidChangeConfiguration: configured.event } as unknown as IConfigurationService);
	services.registerInstance(IKeybindingService, { lookupKeybinding: () => undefined } as unknown as IKeybindingService);
	services.registerInstance(ILogService, { error: (...args: unknown[]) => assert.fail(String(args)) } as unknown as ILogService);
	services.registerInstance(IStorageService, {
		get: (key: string) => values.get(key), onDidChangeValue: changed.event,
		compareAndSwapApplicationSharedValue: async (key: string, expected: string | undefined, value: string | undefined) => {
			await Promise.resolve();
			if (values.get(key) !== expected) { return false; }
			if (value === undefined) { values.delete(key); } else { values.set(key, value); }
			changed.fire({ key, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE, external: false });
			return true;
		},
	} as unknown as IStorageService);
	const create = (id: string) => {
		const container = document.createElement('div');
		document.body.append(container);
		lifetime.add(toDisposable(() => container.remove()));
		const input = document.createElement('textarea'); container.append(input);
		const host = lifetime.add(new ChatInputNoticeHost(() => input.focus()));
		const model = lifetime.add(new ChatAttachmentModel());
		const draft = lifetime.add(new Emitter<void>());
		const inputUri = URI.parse(`ash-chat-input:/${id}`);
		const hint = lifetime.add(services.createInstance(AppWindowScreenshotHint, {
			inputUri, noticeHost: host, container,
			getAttachmentIds: () => model.attachments.map(attachment => attachment.id),
			onDidChangeAttachments: model.onDidChange, onDidChangeDraft: draft.event,
			canAttachScreenshots: () => true,
		}, { id: 'capture', title: 'Capture app window', run: () => { state.runs++; } }));
		return {
			container, input, host, hint, model, draft, inputUri, attach: (id: string) => {
				model.addContext({ id, kind: 'image', name: id, resolve: async () => ({ name: id, content: 'image' }) });
				attached.didAttachImages({ inputUri, attachmentIds: [id], gesture: 'paste' });
			}
		};
	};
	return { create, state, configured, captured, values };
}

suite('App window screenshot first-use hint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('Chinese hint copy comes from the client catalog', async () => {
		initializeTestLocalization('zh-CN');
		try {
			using lifetime = new DisposableStore(); const f = fixture(lifetime);
			const first = f.create('first'); first.attach('one'); await settle();
			assert.match(first.container.textContent!, /命令面板支持截取应用窗口/u);
			assert.match(first.container.textContent!, /关闭提示/u);
		} finally { resetNlsResolver(); }
	});
	test('the gesture belongs to its input, yields to a notification, and expires with its images', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const first = f.create('first'); const other = f.create('other');
		const notification = first.host.occupy(ChatInputNoticeLane.Notification);
		first.attach('one'); await settle();
		assert.equal(first.container.querySelector('.ash-app-window-screenshot-hint'), null);
		assert.equal(other.container.querySelector('.ash-app-window-screenshot-hint'), null);
		notification.dispose(); await settle();
		assert.match(first.container.textContent!, /Command Palette/);
		first.model.delete('one');
		assert.equal(first.container.querySelector('.ash-app-window-screenshot-hint'), null);
	});
	test('unseen claims can be reused after the draft goes away', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const first = f.create('first');
		using notification = first.host.occupy(ChatInputNoticeLane.Notification);
		first.attach('one'); first.draft.fire(); await settle();
		const second = f.create('second'); second.attach('two'); await settle();
		assert.ok(second.container.querySelector('.ash-app-window-screenshot-hint'));
	});
	test('two inputs share one atomic showing, and captured windows suppress future hints', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const first = f.create('first'); const second = f.create('second');
		first.attach('one'); second.attach('two'); await settle();
		assert.equal([first, second].filter(value => value.container.querySelector('.ash-app-window-screenshot-hint')).length, 1);
		f.state.captured = true; f.captured.fire();
		assert.equal([first, second].filter(value => value.container.querySelector('.ash-app-window-screenshot-hint')).length, 0);
	});
	test('restoration is silent, disabled features stay silent, and the command keeps its own target', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const first = f.create('first');
		first.model.addContext({ id: 'restored', kind: 'image', name: 'Restored', resolve: async () => ({ name: 'Restored', content: 'image' }) });
		await settle(); assert.equal(first.container.querySelector('.ash-app-window-screenshot-hint'), null);
		f.state.enabled = false; first.attach('disabled'); await settle();
		assert.equal(first.container.querySelector('.ash-app-window-screenshot-hint'), null);
		f.state.enabled = true; first.attach('enabled'); await settle();
		const button = [...first.container.querySelectorAll('button')].find(button => button.textContent === 'Capture app window')!;
		button.click(); assert.equal(f.state.runs, 1);
		assert.equal(first.container.querySelector('.ash-app-window-screenshot-hint'), null);
	});
});
