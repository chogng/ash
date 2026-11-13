import { IHostService } from '../../../../services/host/browser/host.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { quickInputServiceTestControls } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { parse } from '../../../../../base/common/json.js';
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
import { TrustedDomainService } from '../../browser/trustedDomainService.js';
import { TRUSTED_DOMAINS_URI } from '../../browser/trustedDomains.js';
import '../../browser/url.contribution.js';

class URLFixture extends Disposable {
	readonly dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	readonly services = this._register(new InstantiationService());
	readonly storage = this._register(new BrowserStorageService({ ownerWindow: this.dom.window as unknown as Window, workspaceId: 'url-test', flushInterval: 0 }));
	readonly notifications = this._register(new TestNotificationService());
	readonly dialogs = this._register(new DialogService());
	readonly files = this._register(new FileService());
	readonly opened: string[] = [];
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
		this.services.registerInstance(IQuickInputService, {
			...quickInputServiceTestControls,

			input: async (options: { value?: string; }) => { this.lastInput = options.value; return inputTarget; },
			createQuickPick: () => { throw new Error('Unexpected domain picker'); },
		});
		this.services.registerInstance(IEditorService, { openEditor: async (input: { resource: URI; }) => { this.editors.push(input.resource.toString()); } } as unknown as IEditorService);
		this.services.registerInstance(ICodeEditorService, { getFocusedCodeEditor: () => null, openCodeEditor: async () => null } as unknown as ICodeEditorService);
		this.services.registerSingleton(ICommandService, () => this.services.createInstance(StandaloneCommandService));
		this.opener = this._register(this.services.createInstance(OpenerService));
		this.opener.setDefaultExternalOpener({ openExternal: async href => { this.opened.push(href); return true; } });
		this.services.registerInstance(IOpenerService, this.opener);
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === ITrustedDomainService)![1];
		this.services.registerSingleton(ITrustedDomainService, () => this.services.createInstance(descriptor) as ITrustedDomainService);
		this.trustedDomains = this.services.get(ITrustedDomainService);
		this.host = this._register(WorkbenchContributionsRegistry.createHost(this.services, error => { throw error; }, ['workbench.contrib.url']));
		this.host.advance(WorkbenchPhase.BlockRestore);
	}
}

suite('Workbench external link trust', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('product rules appear as comments and keep applying after saving an empty user list', async () => {
		using fixture = new URLFixture();
		const domains = fixture.trustedDomains;
		assert.equal(domains.isValid(URI.parse('https://learn.microsoft.com/en-us/')), true);
		assert.equal(domains.isValid(URI.parse('https://openai.com/')), true);
		assert.equal(domains.isValid(URI.parse('https://github.com/microsoft/vscode')), true);
		assert.equal(domains.isValid(URI.parse('http://github.com/')), false);
		assert.equal(domains.isValid(URI.parse('https://example.github.com/')), false);
		const document = await fixture.files.readFile(TRUSTED_DOMAINS_URI);
		assert.match(document.content, /\/\/ .*https:\/\/example\.com\/docs/u);
		assert.match(document.content, /^\/\/ - "https:\/\/github\.com"$/mu);
		assert.deepEqual(parse(document.content), []);
		assert.deepEqual(domains.userTrustedDomains, []);
		await fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: '[]', expectedRevision: document.revision });
		using reopened = fixture.services.createInstance(TrustedDomainService);
		assert.match(reopened.content, /^\/\/ - "https:\/\/github\.com"$/mu);
		assert.deepEqual(parse(reopened.content), []);
		assert.deepEqual(reopened.userTrustedDomains, []);
		assert.equal(reopened.isValid(URI.parse('https://github.com/')), true);
		assert.equal(await fixture.opener.open('https://github.com/microsoft/vscode'), true);
		for (const url of [
			'https://update.code.visualstudio.com/latest/darwin-arm64/stable',
			'https://vscode.download.prss.microsoft.com/',
			'https://marketplace.visualstudio.com/items?itemName=ms-python.python',
			'https://vscode.dev/github/microsoft/vscode',
			'https://insiders.vscode.dev/',
			'https://science.org/journal/science',
			'https://www.science.org/journal/sciadv',
			'https://nature.com/nature',
			'https://www.nature.com/ncomms/',
			'https://pubs.acs.org/journal/',
			'https://www.cnki.net/',
			'https://kns.cnki.net/kns8s/',
			'https://navi.cnki.net/knavi/journals/index',
			'https://oversea.cnki.net/',
			'https://sciencedirect.com/',
			'https://www.sciencedirect.com/journal/cell',
			'https://onlinelibrary.wiley.com/',
			'https://www.onlinelibrary.wiley.com/',
			'https://advanced.onlinelibrary.wiley.com/hub/about',
			'https://chemistry-europe.onlinelibrary.wiley.com/',
			'https://link.springer.com/journals',
			'https://pubs.rsc.org/en/journals',
			'https://ieeexplore.ieee.org/browse/periodicals/title',
			'https://dl.acm.org/journals',
		]) {
			assert.equal(reopened.isValid(URI.parse(url)), true, url);
			assert.equal(await fixture.opener.open(url), true, url);
		}
		assert.equal(reopened.isValid(URI.parse('http://marketplace.visualstudio.com/')), false);
		assert.equal(reopened.isValid(URI.parse('https://example.vscode.dev/')), false);
		assert.equal(reopened.isValid(URI.parse('http://www.science.org/journal/sciadv')), false);
		assert.equal(reopened.isValid(URI.parse('https://spj.science.org/')), false);
		assert.equal(reopened.isValid(URI.parse('https://www.nature.com.example.org/')), false);
		assert.equal(reopened.isValid(URI.parse('http://pubs.acs.org/journal/')), false);
		assert.equal(reopened.isValid(URI.parse('https://www.wiley.com/')), false);
		assert.equal(reopened.isValid(URI.parse('https://kns.cnki.net.example.org/')), false);
		assert.equal(fixture.dialogs.model.dialogs.length, 0);
	});

	test('older mixed lists keep their user rules and comments when saved in the new format', async () => {
		using fixture = new URLFixture();
		const legacy = '// My rules\n[\n  "https://GITHUB.com/", // keep this comment\n  "https://github.com/team",\n  "https://legacy.test",\n  "https://openai.com"\n]\n';
		fixture.storage.store('http.linkProtectionTrustedDomains', legacy, StorageScope.APPLICATION, StorageTarget.USER);
		const document = await fixture.files.readFile(TRUSTED_DOMAINS_URI);
		assert.deepEqual(parse(document.content), ['https://github.com/team', 'https://legacy.test']);
		assert.match(document.content, /\/\/ keep this comment/u);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://legacy.test')), true);
		assert.equal(fixture.storage.get('http.linkProtectionTrustedDomains', StorageScope.APPLICATION), legacy);

		const crlf = document.content.replaceAll('\n', '\r\n');
		const saved = await fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: crlf, expectedRevision: document.revision });
		const source = fixture.storage.get('http.linkProtectionTrustedDomains', StorageScope.APPLICATION)!;
		assert.match(source, /^\/\/ My rules\r\n/u);
		assert.match(source, /\/\/ keep this comment/u);
		assert.deepEqual(parse(source), ['https://github.com/team', 'https://legacy.test']);
		using reopened = fixture.services.createInstance(TrustedDomainService);
		assert.equal(reopened.content, crlf);
		assert.equal(reopened.content, saved.revision);
	});

	test('editing rules preserves JSONC comments and revokes every equivalent entry', async () => {
		using fixture = new URLFixture();
		const domains = fixture.trustedDomains;
		await domains.setTrustedDomains('// Keep this list\n["https://EXAMPLE.test", "https://example.test/", "keep.test",]\n');
		await domains.addTrustedDomain(' https://example.test/ ');
		assert.equal(domains.userTrustedDomains.length, 2);
		await domains.addTrustedDomain('https://added.test/docs?source=settings#top');
		await domains.removeTrustedDomain('https://example.test/');
		assert.deepEqual(domains.userTrustedDomains, ['keep.test/', 'https://added.test/docs']);
		assert.match(domains.content, /\/\/ Keep this list/);
		assert.equal(domains.isValid(URI.parse('https://example.test')), false);
		assert.equal(domains.isValid(URI.parse('https://added.test/docs/page')), true);
		assert.equal(domains.isValid(URI.parse('https://added.test')), false);
		const content = domains.content;
		await assert.rejects(domains.addTrustedDomain('https://user@bad.test?query'), /Invalid trusted domain/);
		assert.equal(domains.content, content);
	});

	test('replacing a rule keeps its position and comments and rejects invalid or stale edits', async () => {
		using fixture = new URLFixture();
		const domains = fixture.trustedDomains;
		const original = 'https://example.test/';
		const content = '[\n  "https://EXAMPLE.test", // primary\n  "keep.test",\n  "https://example.test/", // equivalent\n]\n';
		const originalDocument = await domains.setTrustedDomains(content);
		await assert.rejects(domains.updateTrustedDomain(original, 'keep.test'), /already exists/);
		await assert.rejects(domains.updateTrustedDomain(original, 'https://user@bad.test?query'), /Invalid trusted domain/);
		assert.equal(domains.content, originalDocument);
		await domains.updateTrustedDomain(original, 'https://replacement.test#top');
		assert.equal(domains.content, originalDocument.replaceAll(/https:\/\/example\.test\/?/gi, 'https://replacement.test/'));
		assert.deepEqual(domains.userTrustedDomains, ['https://replacement.test/', 'keep.test/']);
		assert.equal(domains.isValid(URI.parse(original)), false);
		assert.equal(domains.isValid(URI.parse('https://replacement.test')), true);
		await assert.rejects(domains.updateTrustedDomain(original, '*'), /changed or been removed/);
	});

	test('the production contribution blocks default and contributed openers until an explicit decision', async () => {
		using fixture = new URLFixture();
		using contributed = fixture.opener.registerExternalOpener({ openExternal: async () => { assert.fail('Cancelled link reached a contributed opener'); } });
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

	test('disposal denies the in-flight open and unregisters the validator', async () => {
		using fixture = new URLFixture();
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
		const document = await fixture.trustedDomains.setTrustedDomains(source);
		assert.equal(await fixture.opener.open('https://persisted.test/docs'), true);
		assert.equal(fixture.dialogs.model.dialogs.length, 0);
		using storage = new BrowserStorageService({ ownerWindow: fixture.dom.window as unknown as Window, workspaceId: 'different-workspace', flushInterval: 0 });
		assert.equal(storage.get('http.linkProtectionTrustedDomains', StorageScope.APPLICATION), source);
		assert.equal(fixture.trustedDomains.content, document);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('[]', 'stale source'), /changed/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('["*"] trailing garbage'), /JSONC/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('[true]'), /pattern/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('["https://example.test/?query"]'), /pattern/);
		assert.equal(fixture.trustedDomains.content, document);
		fixture.storage.store('http.linkProtectionTrustedDomains', 'invalid', StorageScope.APPLICATION, StorageTarget.USER);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://persisted.test')), false);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://github.com')), true);
		assert.equal(fixture.notifications.model.getNotifications().length, 1);
	});

	test('complete-value limits and external storage edits do not broaden prior trust', async () => {
		using fixture = new URLFixture();
		await fixture.trustedDomains.setTrustedDomains('["https://before.test"]');
		await assert.rejects(fixture.trustedDomains.setTrustedDomains(JSON.stringify(Array.from({ length: 1025 }, () => '*'))), /1024/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains(`// ${'中'.repeat(30_000)}\n["*"]`), /64 KiB/);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://outside.test')), false);
		const scopeKey = 'ash.storage.application';
		const document = JSON.parse(fixture.dom.window.localStorage.getItem(scopeKey)!);
		document.entries['http.linkProtectionTrustedDomains'].value = '["https://after.test"]';
		fixture.dom.window.dispatchEvent(new fixture.dom.window.StorageEvent('storage', { key: scopeKey, newValue: JSON.stringify(document) }));
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://before.test')), false);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://after.test')), true);
		assert.throws(() => (fixture.trustedDomains.userTrustedDomains as string[]).push('*'), TypeError);
	});

	test('the management command and file router share the same document and reject stale saves', async () => {
		using fixture = new URLFixture();
		await fixture.services.get(ICommandService).executeCommand('workbench.action.manageTrustedDomain');
		assert.deepEqual(fixture.editors, [TRUSTED_DOMAINS_URI.toString()]);
		const original = await fixture.files.readFile(TRUSTED_DOMAINS_URI);
		const source = '// retained user comment\n["https://managed.test/docs",]\n';
		const saved = await fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: source, expectedRevision: original.revision });
		const content = fixture.trustedDomains.content;
		assert.equal(saved.revision, content);
		assert.ok(content.endsWith(source));
		assert.deepEqual(fixture.trustedDomains.userTrustedDomains, ['https://managed.test/docs']);
		assert.equal(await fixture.opener.open('https://managed.test/docs/page'), true);
		const draft = await fixture.files.readFile(TRUSTED_DOMAINS_URI);
		await fixture.trustedDomains.updateTrustedDomain('https://managed.test/docs', 'https://edited.test/docs');
		await assert.rejects(fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: '[]', expectedRevision: draft.revision }), FileRevisionConflictError);
		await assert.rejects(fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: '[false]' }), /pattern/);
		assert.equal((await fixture.files.readFile(TRUSTED_DOMAINS_URI)).content, content.replace('managed.test', 'edited.test'));
		fixture.host.dispose();
		assert.throws(() => fixture.files.readFile(TRUSTED_DOMAINS_URI));
	});

	test('Open URL preserves the user input and allows contributed openers after the validator approves it', async () => {
		const target = 'https://input.test/docs?q=a%26b#topic';
		using fixture = new URLFixture(target);
		await fixture.trustedDomains.setTrustedDomains('["https://input.test"]');
		const contributed: string[] = [];
		using handler = fixture.opener.registerExternalOpener({ openExternal: async href => { contributed.push(href); return true; } });
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
		if (request.kind === 'choice') assert.deepEqual(request.buttons, ['Open']);
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Cancel });
		assert.equal(await pending, false);
		assert.equal(await fixture.opener.open('mailto:person@host.test'), true);
		assert.deepEqual(fixture.opened, ['mailto:person@host.test']);
	});

	test('extension openExternal requests pass through the contribution before the host opens them', async () => {
		using fixture = new URLFixture();
		// Other editor operations are outside this host request and must remain unused.
		fixture.services.registerInstance(IClipboardService, {} as IClipboardService);
		fixture.services.registerInstance(IFileDialogService, {} as IFileDialogService);
		fixture.services.registerInstance(IHostService, {} as IHostService);
		fixture.services.registerInstance(IPathService, {} as IPathService);
		using contexts = new ContextKeyService();
		fixture.services.registerInstance(IContextKeyService, contexts);
		fixture.services.registerInstance(IEditorPart, {} as IEditorPart);
		fixture.services.registerInstance(IWorkingCopyService, {} as IWorkingCopyService);
		fixture.services.registerInstance(ITextFileService, {} as ITextFileService);
		fixture.services.registerInstance(IModelService, {
			getModels: () => [], onModelAdded: Event.None, onModelRemoved: Event.None,
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
			setZoomLevel: async () => { },
		} as unknown as INativeHostApi);
		using window = fixture.services.createInstance(NativeWindow);
		links.fire('https://desktop.test/docs');
		assert.deepEqual(fixture.opened, []);
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Cancel });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(fixture.opened, []);
		let accepted!: () => void;
		const opened = new Promise<void>(resolve => { accepted = resolve; });
		fixture.opener.setDefaultExternalOpener({ openExternal: async target => { fixture.opened.push(target); accepted(); return true; } });
		links.fire('https://desktop.test/docs');
		fixture.dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary, buttonIndex: 0 });
		await opened;
		assert.deepEqual(fixture.opened, ['https://desktop.test/docs']);
		window.dispose();
		links.fire('https://ignored.test');
		assert.equal(fixture.dialogs.model.dialogs.length, 0);
	});
});
