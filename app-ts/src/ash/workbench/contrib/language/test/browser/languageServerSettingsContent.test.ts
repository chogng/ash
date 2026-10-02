import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILanguageServerService, OPEN_LANGUAGE_SERVERS_COMMAND_ID, type LanguageServerConfiguration, type LanguageServerSnapshot } from '../../../../../platform/language/common/languageServerService.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID } from '../../../../../platform/marketplace/common/marketplaceService.js';
import type { RemoteConnectionState } from '../../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService, type EditorInput } from '../../../../services/editor/common/editorService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import { createSettingsEditorInput } from '../../../../services/preferences/common/settingsEditorInput.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { SettingsSearchQuery } from '../../../preferences/browser/settingsSearch.js';
import { LanguageServerSettingsContent, LanguageServerSettingsTarget } from '../../browser/languageServerSettingsContent.js';
import '../../browser/languageServers.contribution.js';

class SettingsFixture extends DisposableStore {
	public readonly root = browserEnvironment.window.document.createElement('div');
	public readonly services = this.add(new InstantiationService());
	public readonly installed = this.add(new Emitter<void>());
	public readonly connection = this.add(new Emitter<RemoteConnectionState>());
	public readonly localeChanged = this.add(new Emitter<void>());
	public locale = 'en';
	public snapshot: LanguageServerSnapshot = { revision: 7, configurations: {}, servers: [{ id: 'rust-analyzer', languageIds: ['rust'] }] };
	public pending: Promise<LanguageServerSnapshot> | undefined;
	public rejectWrites = false;
	public readonly writes: unknown[] = [];
	public readonly commands: unknown[] = [];
	public readonly inputs: EditorInput[] = [];
	public readonly content: LanguageServerSettingsContent;

	constructor() {
		super();
		browserEnvironment.window.document.body.append(this.root);
		this.add(toDisposable(() => this.root.remove()));
		this.services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => ({ getModel: () => ({ getLanguageId: () => 'rust' }) }) } as unknown as ICodeEditorService);
		this.services.registerInstance(ILanguageServerService, {
			read: async () => { const pending = this.pending; this.pending = undefined; return pending ?? this.snapshot; },
			configure: async (id, configuration, revision) => {
				this.writes.push(['save', id, configuration, revision]);
				if (this.rejectWrites) { throw new Error('revision conflict'); }
				this.snapshot = { ...this.snapshot, revision: revision + 1, configurations: { ...this.snapshot.configurations, [id]: configuration } };
			},
			removeConfiguration: async (id, revision) => {
				this.writes.push(['reset', id, revision]);
				this.snapshot = { ...this.snapshot, revision: revision + 1, configurations: {} };
			},
		});
		this.services.registerInstance(IMarketplaceService, { onDidChangeInstalled: this.installed.event } as IMarketplaceService);
		this.services.registerInstance(ICommandService, { executeCommand: async (id: string, ...args: unknown[]) => { this.commands.push([id, ...args]); } } as unknown as ICommandService);
		this.services.registerInstance(IWorkspaceContextService, this.add(new WorkspaceContextService({ id: 'test', folders: [] })));
		this.services.registerInstance(ILocalizationService, {
			onDidChange: this.localeChanged.event, whenReady: Promise.resolve(),
			translate: (bundle, key, text, parameters) => {
				const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === this.locale)!;
				return (catalog.bundles[bundle]?.[key] ?? text).replace(/\{(\d+)\}/gu, (match, index: string) => String(parameters?.[index] ?? match));
			},
		});
		this.services.registerInstance(IRemoteAgentService, { onDidChangeConnection: Event.None, onDidChangeConnectionState: this.connection.event } as IRemoteAgentService);
		this.services.registerInstance(IContextViewService, this.add(new BrowserContextViewService(this.root)));
		this.services.registerInstance(IContextKeyService, this.add(new ContextKeyService()));
		this.services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, dispose() {}, [Symbol.dispose]() {} });
		this.services.registerInstance(IEditorService, { openEditor: async (input: EditorInput) => { this.inputs.push(input); this.content.setInput(input); } } as IEditorService);
		this.content = this.add(this.services.createInstance(LanguageServerSettingsContent, this.root));
		this.root.append(this.content.domNode);
		this.content.setInput(createSettingsEditorInput());
	}

	public field(label: string): HTMLInputElement {
		return this.root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
	}

	public button(label: string): HTMLButtonElement {
		return [...this.root.querySelectorAll('button')].find(button => button.textContent === label)!;
	}

	public edit(label: string, text: string): void {
		const field = this.field(label);
		field.value = text;
		field.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	}
}

async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

test('LSP command opens the editor Settings section with the requested language', async () => {
	using fixture = new SettingsFixture();
	using commands = new CommandService(fixture.services);
	await commands.executeCommand(OPEN_LANGUAGE_SERVERS_COMMAND_ID, 'python');
	assert.equal(new URLSearchParams(fixture.inputs[0]!.resource.query).get('target'), LanguageServerSettingsTarget);
	assert.equal(fixture.field('Language ID').value, 'python');
	await commands.executeCommand(OPEN_LANGUAGE_SERVERS_COMMAND_ID);
	assert.equal(fixture.field('Language ID').value, 'rust');
});

test('Language server Settings saves and resets the backend profile at the read revision', async () => {
	using fixture = new SettingsFixture();
	fixture.content.setVisible(true);
	await settle();
	fixture.edit('Executable path (optional)', '/host/program with spaces');
	fixture.button('Save server configuration').click();
	await settle();
	assert.deepEqual(fixture.writes, [['save', 'rust-analyzer', { mode: 'enabled', executable: '/host/program with spaces' } satisfies LanguageServerConfiguration, 7]]);
	assert.equal(fixture.button('Use default configuration').disabled, false);
	fixture.button('Use default configuration').click();
	await settle();
	assert.deepEqual(fixture.writes[1], ['reset', 'rust-analyzer', 8]);
	assert.equal(fixture.button('Use default configuration').disabled, true);
	assert.equal(fixture.field('Executable path (optional)').value, '');
});

test('Revision conflicts preserve the draft and require Refresh before another write', async () => {
	using fixture = new SettingsFixture();
	fixture.content.setVisible(true);
	await settle();
	fixture.edit('Executable path (optional)', '/edited/path');
	fixture.rejectWrites = true;
	fixture.button('Save server configuration').click();
	await settle();
	assert.match(fixture.root.querySelector('[role="status"]')!.textContent!, /revision conflict.*Refresh/);
	assert.equal(fixture.field('Executable path (optional)').value, '/edited/path');
	assert.equal(fixture.button('Save server configuration').disabled, true);
	fixture.button('Save server configuration').click();
	assert.equal(fixture.writes.length, 1);
	fixture.rejectWrites = false;
	fixture.snapshot = { ...fixture.snapshot, revision: 20 };
	fixture.button('Refresh').click();
	await settle();
	fixture.button('Save server configuration').click();
	await settle();
	assert.equal((fixture.writes[1] as unknown[])[3], 20);
});

test('Installation changes and disconnects discard late language server reads', async () => {
	using fixture = new SettingsFixture();
	const pending = new DeferredPromise<LanguageServerSnapshot>();
	fixture.pending = pending.p;
	fixture.content.setVisible(true);
	fixture.installed.fire();
	await pending.complete(fixture.snapshot);
	await settle();
	assert.equal(fixture.button('Save server configuration').disabled, true);
	assert.equal(fixture.root.querySelector('[role="status"]')!.textContent, 'Installed packages changed. Refresh before saving.');
	fixture.button('Refresh').click();
	await settle();
	fixture.edit('Executable path (optional)', '/unsaved');
	fixture.installed.fire();
	assert.equal(fixture.field('Executable path (optional)').value, '/unsaved');
	const disconnectedRead = new DeferredPromise<LanguageServerSnapshot>();
	fixture.pending = disconnectedRead.p;
	fixture.button('Refresh').click();
	fixture.connection.fire('disconnected');
	await disconnectedRead.complete(fixture.snapshot);
	await settle();
	assert.equal(fixture.button('Save server configuration').disabled, true);
	assert.equal(fixture.root.querySelector('[role="status"]')!.textContent, 'App Server is disconnected.');
});

test('Language server Settings searches server metadata, localizes Chinese, and restores focus after help', async () => {
	using fixture = new SettingsFixture();
	fixture.content.setVisible(true);
	await settle();
	const nodes = fixture.content.getNodes(new SettingsSearchQuery('rust-analyzer'));
	assert.equal(new SettingsSearchQuery('rust-analyzer').matches(nodes[0]!.children![0]!.element), true);
	fixture.locale = builtinLanguagePackCatalogs.find(catalog => catalog.locale !== 'en')!.locale;
	fixture.localeChanged.fire();
	const field = fixture.field('语言 ID');
	assert.equal(field.value, 'rust');
	assert.ok(fixture.button('保存服务器配置'));
	field.focus();
	const implementation = AccessibleViewRegistry.getImplementations().find(entry => entry.name.startsWith('language-server-settings-') && entry.type === AccessibleViewType.Help)!;
	const provider = fixture.services.invokeFunction(accessor => implementation.getProvider(accessor))!;
	assert.match(provider.provideContent(), /语言服务器[\s\S]*输出/);
	fixture.button('帮助').focus();
	provider.dispose();
	assert.equal(browserEnvironment.window.document.activeElement, field);
	fixture.content.dispose();
	assert.equal(AccessibleViewRegistry.getImplementations().includes(implementation), false);
});

test('Finding language servers opens Marketplace with an exact executable route and closes Settings', async () => {
	using fixture = new SettingsFixture();
	fixture.edit('Language ID', 'python');
	fixture.button('Find language servers in Marketplace').click();
	await settle();
	assert.deepEqual(fixture.commands, [['workbench.action.closeActiveEditor'], [OPEN_MARKETPLACE_COMMAND_ID, { languageId: 'python', capabilityKind: 'executable' }]]);
});

test('A save finishing after Settings is hidden does not move keyboard focus back to the form', async () => {
	using fixture = new SettingsFixture();
	fixture.content.setVisible(true);
	await settle();
	const reload = new DeferredPromise<LanguageServerSnapshot>();
	fixture.pending = reload.p;
	fixture.button('Save server configuration').click();
	await settle();
	fixture.content.setVisible(false);
	const outside = browserEnvironment.window.document.createElement('button');
	fixture.root.append(outside);
	outside.focus();
	await reload.complete(fixture.snapshot);
	await settle();
	assert.equal(browserEnvironment.window.document.activeElement, outside);
});
