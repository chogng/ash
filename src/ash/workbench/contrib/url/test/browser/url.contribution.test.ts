import { IHostService } from '../../../../services/host/browser/host.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { StandaloneCommandService } from '../../../../../editor/standalone/browser/standaloneServices.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { DialogResult, IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileRevisionConflictError, IFileService } from '../../../../../platform/files/common/files.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { MainThreadEditors } from '../../../../api/browser/mainThreadEditors.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { NativeWindow } from '../../../../electron-browser/window.js';
import { INativeHostService } from '../../../../common/services.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { ITrustedDomainService } from '../../common/trustedDomainService.js';
import { TRUSTED_DOMAINS_URI } from '../../browser/trustedDomains.js';
import '../../browser/url.contribution.js';

class URLFixture extends Disposable {
	readonly dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	readonly services = this._register(new InstantiationService());
	readonly storage = this._register(
		new BrowserStorageService({
			ownerWindow: this.dom.window as unknown as Window,
			workspaceId: 'url-test',
			flushInterval: 0,
		}),
	);
	readonly notifications = this._register(new TestNotificationService());
	readonly dialogs = this._register(new DialogService());
	readonly files = this._register(new FileService());
	readonly opened: string[] = [];
	readonly copied: string[] = [];
	readonly editors: string[] = [];
	lastInput: string | undefined;
	readonly opener: OpenerService;
	readonly trustedDomains: ITrustedDomainService;
	readonly host;

	constructor(inputTarget?: string) {
		super();
		this._register(toDisposable(() => this.dom.window.close()));
		this.services.registerInstance(IStorageService, this.storage);
		this.services.registerInstance(INotificationService, this.notifications);
		this.services.registerInstance(IDialogService, this.dialogs);
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IClipboardService, {
			writeText: async (value: string) => {
				this.copied.push(value);
			},
		} as IClipboardService);
		this.services.registerInstance(IQuickInputService, {
			...quickInputServiceTestControls,

			input: async (options: { value?: string }) => {
				this.lastInput = options.value;
				return inputTarget;
			},
			createQuickPick: () => {
				throw new Error('Unexpected domain picker');
			},
		});
		this.services.registerInstance(IEditorService, {
			openEditor: async (input: { resource: URI }) => {
				this.editors.push(input.resource.toString());
			},
		} as unknown as IEditorService);
		this.services.registerInstance(ICodeEditorService, {
			getFocusedCodeEditor: () => null,
			openCodeEditor: async () => null,
		} as unknown as ICodeEditorService);
		this.services.registerSingleton(ICommandService, () => this.services.createInstance(StandaloneCommandService));
		this.opener = this._register(this.services.createInstance(OpenerService));
		this.opener.setDefaultExternalOpener({
			openExternal: async href => {
				this.opened.push(href);
				return true;
			},
		});
		this.services.registerInstance(IOpenerService, this.opener);
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === ITrustedDomainService)![1];
		this.services.registerSingleton(
			ITrustedDomainService,
			() => this.services.createInstance(descriptor) as ITrustedDomainService,
		);
		this.trustedDomains = this.services.get(ITrustedDomainService);
		this.host = this._register(
			WorkbenchContributionsRegistry.createHost(
				this.services,
				error => {
					throw error;
				},
				['workbench.contrib.url'],
			),
		);
		this.host.advance(WorkbenchPhase.BlockRestore);
	}
}

suite('Workbench external link trust', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the production contribution blocks default and contributed openers until an explicit decision', async () => {
		using fixture = new URLFixture();
		using contributed = fixture.opener.registerExternalOpener({
			openExternal: async () => {
				assert.fail('Cancelled link reached a contributed opener');
			},
		});
		const cancelled = fixture.opener.open('https://untrusted.test/path', { allowContributedOpeners: true });
		assert.equal(fixture.dialogs.model.dialogs.length, 1);
		assert.deepEqual(fixture.opened, []);
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Cancel });
		assert.equal(await cancelled, false);
		const allowed = fixture.opener.open('https://untrusted.test/path', { allowContributedOpeners: 'default' });
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary, buttonIndex: 0 });
		assert.equal(await allowed, true);
		assert.deepEqual(fixture.opened, ['https://untrusted.test/path']);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://untrusted.test')), false);
	});

	test('copy and disposal deny the in-flight open, and disposal unregisters the validator', async () => {
		using fixture = new URLFixture();
		const copying = fixture.opener.open('https://untrusted.test/path');
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary, buttonIndex: 1 });
		assert.equal(await copying, false);
		assert.deepEqual(fixture.copied, ['https://untrusted.test/path']);
		const pending = fixture.opener.open('https://another.test');
		fixture.host.dispose();
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary, buttonIndex: 0 });
		assert.equal(await pending, false);
		assert.deepEqual(fixture.opened, []);
		assert.equal(await fixture.opener.open('https://another.test'), true);
	});

	test('a JSONC save updates the same owner and survives a storage restart', async () => {
		using fixture = new URLFixture();
		const source = '// Kept comment\n["https://persisted.test",]\n';
		await fixture.trustedDomains.setTrustedDomains(source);
		assert.equal(await fixture.opener.open('https://persisted.test/docs'), true);
		assert.equal(fixture.dialogs.model.dialogs.length, 0);
		using storage = new BrowserStorageService({
			ownerWindow: fixture.dom.window as unknown as Window,
			workspaceId: 'different-workspace',
			flushInterval: 0,
		});
		assert.equal(storage.get('http.linkProtectionTrustedDomains', StorageScope.APPLICATION), source);
		assert.equal(fixture.trustedDomains.content, source);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('[]', 'stale source'), /changed/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('["*"] trailing garbage'), /JSONC/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('[true]'), /pattern/);
		assert.equal(fixture.trustedDomains.content, source);
		fixture.storage.store(
			'http.linkProtectionTrustedDomains',
			'invalid',
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://persisted.test')), false);
		assert.equal(fixture.notifications.model.getNotifications().length, 1);
	});

	test('complete-value limits and external storage edits do not broaden prior trust', async () => {
		using fixture = new URLFixture();
		await fixture.trustedDomains.setTrustedDomains('["https://before.test"]');
		await assert.rejects(
			fixture.trustedDomains.setTrustedDomains(JSON.stringify(Array.from({ length: 1025 }, () => '*'))),
			/1024/,
		);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains(`// ${'中'.repeat(30_000)}\n["*"]`), /64 KiB/);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://outside.test')), false);
		const scopeKey = 'ash.storage.application';
		const document = JSON.parse(fixture.dom.window.localStorage.getItem(scopeKey)!);
		document.entries['http.linkProtectionTrustedDomains'].value = '["https://after.test"]';
		fixture.dom.window.dispatchEvent(
			new fixture.dom.window.StorageEvent('storage', { key: scopeKey, newValue: JSON.stringify(document) }),
		);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://before.test')), false);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://after.test')), true);
		assert.throws(() => (fixture.trustedDomains.trustedDomains as string[]).push('*'), TypeError);
	});

	test('the management command and file router share the same document and reject stale saves', async () => {
		using fixture = new URLFixture();
		await fixture.services.get(ICommandService).executeCommand('workbench.action.manageTrustedDomain');
		assert.deepEqual(fixture.editors, [TRUSTED_DOMAINS_URI.toString()]);
		const original = await fixture.files.readFile(TRUSTED_DOMAINS_URI);
		const content = '// retained user comment\n["https://managed.test/docs",]\n';
		await fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content, expectedRevision: original.revision });
		assert.equal(fixture.trustedDomains.content, content);
		assert.equal(await fixture.opener.open('https://managed.test/docs/page'), true);
		await assert.rejects(
			fixture.files.writeFile({
				resource: TRUSTED_DOMAINS_URI,
				content: '[]',
				expectedRevision: original.revision,
			}),
			FileRevisionConflictError,
		);
		await assert.rejects(fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: '[false]' }), /pattern/);
		assert.equal((await fixture.files.readFile(TRUSTED_DOMAINS_URI)).content, content);
		fixture.host.dispose();
		assert.throws(() => fixture.files.readFile(TRUSTED_DOMAINS_URI));
	});

	test('Open URL preserves the user input and allows contributed openers after the validator approves it', async () => {
		const target = 'https://input.test/docs?q=a%26b#topic';
		using fixture = new URLFixture(target);
		await fixture.trustedDomains.setTrustedDomains('["https://input.test"]');
		const contributed: string[] = [];
		using handler = fixture.opener.registerExternalOpener({
			openExternal: async href => {
				contributed.push(href);
				return true;
			},
		});
		await fixture.services.get(ICommandService).executeCommand('workbench.action.url.openUrl');
		assert.deepEqual(contributed, [target]);
		assert.equal(fixture.lastInput, '');
		assert.equal(fixture.storage.get('workbench.action.url.openUrl.lastInput', StorageScope.WORKSPACE), target);
		assert.deepEqual(fixture.opened, []);
	});

	test('the URI boundary rejects credentials, escaped controls still prompt, and mail links retain their route', async () => {
		using fixture = new URLFixture();
		await fixture.trustedDomains.setTrustedDomains('["*"]');
		await assert.rejects(fixture.opener.open('https://user:secret@host.test'), /credentials/);
		const pending = fixture.opener.open('https://host.test/path%0Ainjected');
		const request = fixture.dialogs.model.dialogs[0]!.request;
		assert.equal(request.kind, 'choice');
		if (request.kind === 'choice') assert.deepEqual(request.buttons, ['Open', 'Copy']);
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Cancel });
		assert.equal(await pending, false);
		assert.equal(await fixture.opener.open('mailto:person@host.test'), true);
		assert.deepEqual(fixture.opened, ['mailto:person@host.test']);
	});

	test('extension openExternal requests pass through the contribution before the host opens them', async () => {
		using fixture = new URLFixture();
		// Other editor operations are outside this host request and must remain unused.
		fixture.services.registerInstance(IFileDialogService, {} as IFileDialogService);
		fixture.services.registerInstance(IHostService, {} as IHostService);
		fixture.services.registerInstance(IPathService, {} as IPathService);
		using contexts = new ContextKeyService();
		fixture.services.registerInstance(IContextKeyService, contexts);
		fixture.services.registerInstance(IEditorPart, {} as IEditorPart);
		fixture.services.registerInstance(IWorkingCopyService, {} as IWorkingCopyService);
		fixture.services.registerInstance(ITextFileService, {} as ITextFileService);
		fixture.services.registerInstance(IModelService, {
			getModels: () => [],
			onModelAdded: Event.None,
			onModelRemoved: Event.None,
		} as unknown as IModelService);
		using extensionHost = fixture.services.createInstance(MainThreadEditors);
		const request = { method: 'openExternal', uri: 'https://extension.test/docs' };
		const cancelled = extensionHost.handle(request, new AbortController().signal);
		assert.deepEqual(fixture.opened, []);
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Cancel });
		await cancelled;
		assert.deepEqual(fixture.opened, []);
		const allowed = extensionHost.handle(request, new AbortController().signal);
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary, buttonIndex: 0 });
		await allowed;
		assert.deepEqual(fixture.opened, ['https://extension.test/docs']);
	});

	test('the desktop external-URI event reaches the same validator and releases its subscription with the window', async () => {
		using fixture = new URLFixture();
		using links = new Emitter<string>();
		using configuration = new InMemoryConfigurationService();
		fixture.services.registerInstance(IConfigurationService, configuration);
		fixture.services.registerInstance(INativeHostService, {
			onDidRequestOpenExternalUri: links.event,
			onDidChangeZoomLevel: Event.None,
			onDidChangeAuxiliaryWindowState: Event.None,
			getZoomLevel: async () => 0,
			setZoomLevel: async () => {},
		} as unknown as INativeHostApi);
		using window = fixture.services.createInstance(NativeWindow);
		links.fire('https://desktop.test/docs');
		assert.deepEqual(fixture.opened, []);
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Cancel });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(fixture.opened, []);
		let accepted!: () => void;
		const opened = new Promise<void>(resolve => {
			accepted = resolve;
		});
		fixture.opener.setDefaultExternalOpener({
			openExternal: async target => {
				fixture.opened.push(target);
				accepted();
				return true;
			},
		});
		links.fire('https://desktop.test/docs');
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary, buttonIndex: 0 });
		await opened;
		assert.deepEqual(fixture.opened, ['https://desktop.test/docs']);
		window.dispose();
		links.fire('https://ignored.test');
		assert.equal(fixture.dialogs.model.dialogs.length, 0);
	});
});
