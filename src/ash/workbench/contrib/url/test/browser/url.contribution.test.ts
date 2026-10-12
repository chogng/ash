import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { StandaloneCommandService } from '../../../../../editor/standalone/browser/standaloneServices.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { DialogResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileRevisionConflictError, IFileService } from '../../../../../platform/files/common/files.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { ITrustedDomainService } from '../../common/trustedDomainService.js';
import { TRUSTED_DOMAINS_URI } from '../../browser/trustedDomains.js';
import '../../browser/url.contribution.js';

class URLFixture extends Disposable {
	readonly dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	readonly services = this._register(new InstantiationService());
	readonly storage = this._register(new BrowserStorageService({ ownerWindow: this.dom.window as unknown as Window, workspaceId: 'url-test', flushInterval: 0 }));
	readonly notifications = this._register(new NotificationService());
	readonly dialogs = this._register(new DialogService());
	readonly files = this._register(new FileService());
	readonly opened: string[] = [];
	readonly copied: string[] = [];
	readonly editors: string[] = [];
	readonly opener: OpenerService;
	readonly trustedDomains: ITrustedDomainService;
	readonly host;

	constructor() {
		super();
		this._register(toDisposable(() => this.dom.window.close()));
		this.services.registerInstance(IStorageService, this.storage);
		this.services.registerInstance(INotificationService, this.notifications);
		this.services.registerInstance(IDialogService, this.dialogs);
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IClipboardService, { writeText: async (value: string) => { this.copied.push(value); } } as IClipboardService);
		this.services.registerInstance(IQuickInputService, { createQuickPick: () => { throw new Error('Unexpected domain picker'); } } as unknown as IQuickInputService);
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
		using storage = new BrowserStorageService({ ownerWindow: fixture.dom.window as unknown as Window, workspaceId: 'different-workspace', flushInterval: 0 });
		assert.equal(storage.get('http.linkProtectionTrustedDomains', StorageScope.APPLICATION), source);
		assert.equal(fixture.trustedDomains.content, source);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('[]', 'stale source'), /changed/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('["*"] trailing garbage'), /JSONC/);
		await assert.rejects(fixture.trustedDomains.setTrustedDomains('[true]'), /pattern/);
		assert.equal(fixture.trustedDomains.content, source);
		fixture.storage.store('http.linkProtectionTrustedDomains', 'invalid', StorageScope.APPLICATION, StorageTarget.USER);
		assert.equal(fixture.trustedDomains.isValid(URI.parse('https://persisted.test')), false);
		assert.equal(fixture.notifications.getNotifications().length, 1);
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
		await assert.rejects(fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: '[]', expectedRevision: original.revision }), FileRevisionConflictError);
		await assert.rejects(fixture.files.writeFile({ resource: TRUSTED_DOMAINS_URI, content: '[false]' }), /pattern/);
		assert.equal((await fixture.files.readFile(TRUSTED_DOMAINS_URI)).content, content);
		fixture.host.dispose();
		await assert.rejects(fixture.files.readFile(TRUSTED_DOMAINS_URI));
	});

	test('Open URL preserves the user input and allows contributed openers after the validator approves it', async () => {
		using fixture = new URLFixture();
		const target = 'https://input.test/docs?q=a%26b#topic';
		let previousInput: string | undefined;
		fixture.services.registerInstance(IQuickInputService, {
			input: async options => { previousInput = options.value; return target; },
		} as IQuickInputService);
		await fixture.trustedDomains.setTrustedDomains('["https://input.test"]');
		const contributed: string[] = [];
		using handler = fixture.opener.registerExternalOpener({ openExternal: async href => { contributed.push(href); return true; } });
		await fixture.services.get(ICommandService).executeCommand('workbench.action.url.openUrl');
		assert.deepEqual(contributed, [target]);
		assert.equal(previousInput, '');
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
});
