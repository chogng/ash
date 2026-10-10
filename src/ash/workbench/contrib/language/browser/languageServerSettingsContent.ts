import type { IResourceEditorInput } from '../../../common/editor.js';
import './media/languageServerSettingsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ILanguageServerService, type LanguageServerSnapshot } from '../../../../platform/language/common/languageServerService.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID } from '../../../../platform/marketplace/common/marketplaceService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CLOSE_EDITOR_COMMAND_ID } from '../../../browser/parts/editor/editorCommands.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import { SettingsSearchQuery } from '../../preferences/browser/settingsSearch.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';

export const LanguageServerSettingsTarget = 'editor-language.group.language-servers';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.LanguageServers, defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Language servers accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.settings', key: 'lsp.verbosity' }, 'Language Servers Accessibility Help'); },
		get description() { return localize({ bundle: 'ash.settings', key: 'lsp.verbosityDescription' }, 'Announce keyboard help when language server settings receive focus.'); },
	},
});

/** Settings owns this form; the App Server keeps the profile configuration and revision authority. */
export class LanguageServerSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'editor-language';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public readonly domNode: HTMLElement;
	private readonly note: HTMLElement;
	private readonly status: HTMLElement;
	private readonly labels = new Map<string, HTMLElement>();
	private readonly directory: SelectBox;
	private readonly language: InputBox;
	private readonly list: SelectBox;
	private readonly server: InputBox;
	private readonly enabled: Checkbox;
	private readonly executable: InputBox;
	private readonly save: Button;
	private readonly reset: Button;
	private readonly refreshButton: Button;
	private readonly find: Button;
	private readonly help: Button;
	private snapshot: LanguageServerSnapshot | undefined;
	private visible = false;
	private loading = false;
	private working = false;
	private generation = 0;
	private statusMessage: { readonly key: string; readonly text: string; readonly parameters: readonly (string | number)[]; } | undefined;
	private readonly instanceId = ++nextLanguageServerSettingsId;

	constructor(
		container: HTMLElement,
		@ILanguageServerService private readonly servers: ILanguageServerService,
		@IMarketplaceService marketplace: IMarketplaceService,
		@ICommandService private readonly commands: ICommandService,
		@ICodeEditorService private readonly editors: ICodeEditorService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILocalizationService private readonly localization: ILocalizationService,
		@IAppServerRemoteAgentService remote: IAppServerRemoteAgentService,
		@IContextViewService contextView: IContextViewService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-language-server-settings';
		this.note = h(document, 'p');
		this.status = h(document, 'p');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.domNode.append(this.note);
		this.directory = this._register(new SelectBox(this.field('directory'), { options: [], presentation: 'field', contextViewProvider: contextView }));
		this.language = this._register(new InputBox(this.field('language'), { presentation: 'field' }));
		this.find = this.button(this.domNode, () => this.findServers());
		this.list = this._register(new SelectBox(this.field('list'), { options: [], presentation: 'field', contextViewProvider: contextView }));
		this.server = this._register(new InputBox(this.field('server'), { presentation: 'field' }));
		const enabledField = this.field('enabled');
		this.enabled = this._register(new Checkbox(enabledField, {}));
		this.executable = this._register(new InputBox(this.field('executable'), { presentation: 'field' }));
		const actions = h(document, 'div');
		actions.className = 'ash-language-server-settings-actions';
		this.save = this.button(actions, () => this.mutate('save'));
		this.reset = this.button(actions, () => this.mutate('reset'));
		this.refreshButton = this.button(actions, () => this.load());
		this.help = this.button(actions, async () => { this.accessibleView.show(AccessibleViewType.Help); });
		this.domNode.append(actions, this.status);
		this._register(this.list.onDidSelect(() => { this.server.value = this.list.value ?? ''; this.select(); }));
		this._register(this.server.onDidChange(() => this.select()));
		this._register(this.directory.onDidSelect(() => { void this.load(); }));
		this._register(marketplace.onDidChangeInstalled(() => {
			// Catalog invalidation must not discard an unsaved path or enablement draft.
			this.generation++;
			this.loading = false;
			this.snapshot = undefined;
			this.setStatus('changed', 'Installed packages changed. Refresh before saving.');
			this.updateActions();
		}));
		this._register(workspace.onDidChangeWorkspace(() => {
			this.generation++;
			this.snapshot = undefined;
			this.updateDirectories();
			if (this.visible) { void this.load(); }
		}));
		this._register(remote.onDidChangeConnection(() => this.invalidateConnection()));
		this._register(remote.onDidChangeConnectionState(state => {
			if (state === 'connected' && this.visible) { void this.load(); }
			else if (state !== 'connected') { this.invalidateConnection(); }
		}));
		this._register(toDisposable(() => { this.generation++; this.domNode.remove(); }));
		const scopedContext = this._register(contextKeys.createScoped(this.domNode));
		scopedContext.createKey('languageServerSettingsFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 100, name: `language-server-settings-${this.instanceId}`,
			when: ContextKeyExpr.has('languageServerSettingsFocused'),
			getProvider: () => {
				const active = document.activeElement;
				if (!this.visible || !isHTMLElement(active) || !this.domNode.contains(active)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.LanguageServers, { type: AccessibleViewType.Help },
					() => this.label('helpText', 'Language Servers\nUse Tab and Shift+Tab to reach the workspace folder, language, Marketplace, server selection, enable switch, executable path, Save, Use Default, Refresh, and Help. Use arrow keys in server and folder lists. Configuration applies to the App Server profile; the folder only controls availability checks. Leave the executable path empty to use the installed package or PATH. Use Default removes the override. After a conflict or an installation change, Refresh before saving. Find opens Marketplace for the exact language and executable capability. Logs and startup failures are in Output; click a language server status entry to open its log.'),
					() => active.focus(), AccessibilityVerbositySettingId.LanguageServers);
			},
		}));
		this.updateDirectories();
		this.updateLabels();
		this.updateActions();
	}

	public setInput(input: IResourceEditorInput): void {
		const languageId = new URLSearchParams(input.resource.query).get('languageId');
		this.language.value = languageId ?? this.editors.getActiveCodeEditor()?.getModel()?.getLanguageId() ?? '';
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (visible) { void this.load(); }
		else { this.generation++; }
	}

	public getNodes(_query: SettingsSearchQuery): readonly SettingsTreeNode<SettingsContentItem>[] {
		return [{
			element: { kind: 'group', id: LanguageServerSettingsTarget, title: this.label('title', 'Language Servers'), description: this.label('description', 'Configure language servers. View their logs and failures in Output.') },
			children: [{
				element: {
					kind: 'item', id: 'language-servers.configuration', title: this.label('title', 'Language Servers'), description: this.note.textContent ?? '',
					keywords: ['lsp', 'language servers', 'output', 'marketplace', 'executable', this.language.value, ...Object.keys(this.snapshot?.configurations ?? {}), ...(this.snapshot?.servers.flatMap(server => [server.id, ...server.languageIds]) ?? [])],
					value: { domNode: this.domNode },
				}
			}],
		}];
	}

	private invalidateConnection(): void {
		this.generation++;
		this.snapshot = undefined;
		this.loading = false;
		this.list.setOptions([]);
		this.setStatus('disconnected', 'App Server is disconnected.');
		this.updateActions();
	}

	private updateDirectories(): void {
		const folders = this.workspace.getWorkspace().folders;
		this.directory.setOptions(folders.length ? folders.map(folder => ({ label: folder.name, value: folders.length === 1 ? '' : folder.id })) : [{ label: this.label('currentWorkspace', 'Current workspace'), value: '' }]);
	}

	private async load(): Promise<void> {
		if (this.working) { return; }
		const generation = ++this.generation;
		this.snapshot = undefined;
		this.loading = true;
		this.setStatus('loading', 'Loading language servers…');
		this.updateActions();
		try {
			const snapshot = await this.servers.read(this.directory.value || undefined);
			if (this.isDisposed || generation !== this.generation) { return; }
			this.snapshot = snapshot;
			const ids = [...new Set([...Object.keys(snapshot.configurations), ...snapshot.servers.map(server => server.id)])].sort();
			this.list.setOptions(ids.map(id => ({ label: id, value: id })));
			if (ids.includes(this.server.value)) { this.list.value = this.server.value; }
			this.server.value = this.list.value ?? '';
			this.select();
			this.setStatus(snapshot.servers.length ? 'available' : 'empty', snapshot.servers.length ? '{0} servers available. They start when a matching document needs them.' : 'No enabled server is available. Find a package in Marketplace or configure an executable.', snapshot.servers.length ? [snapshot.servers.length] : []);
			this.changed.fire();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) { return; }
			this.setStatus('loadFailed', 'Could not load language servers: {0}', [error instanceof Error ? error.message : String(error)]);
		} finally {
			if (!this.isDisposed && generation === this.generation) { this.loading = false; this.updateActions(); }
		}
	}

	private select(): void {
		const id = this.server.value.trim();
		const config = this.snapshot?.configurations[id];
		this.enabled.checked = config ? config.mode === 'enabled' : !!this.snapshot?.servers.some(server => server.id === id);
		this.executable.value = config?.executable ?? '';
		this.updateActions();
	}

	private async mutate(action: 'save' | 'reset'): Promise<void> {
		const snapshot = this.snapshot;
		if (!snapshot || this.working || this.loading) { return; }
		const id = this.server.value.trim();
		const generation = this.generation;
		this.working = true;
		this.updateActions();
		try {
			if (action === 'reset') { await this.servers.removeConfiguration(id, snapshot.revision); }
			else { await this.servers.configure(id, { mode: this.enabled.checked ? 'enabled' : 'disabled', executable: this.executable.value.trim() || undefined }, snapshot.revision); }
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) { return; }
			// A failed write may mean a revision conflict; only an explicit read permits another write.
			this.snapshot = undefined;
			this.setStatus('saveFailed', 'Could not save language server configuration: {0}. Refresh before saving again.', [error instanceof Error ? error.message : String(error)]);
			return;
		} finally {
			this.working = false;
			if (!this.isDisposed) { this.updateActions(); }
		}
		if (!this.isDisposed && generation === this.generation && this.visible) {
			await this.load();
			if (!this.isDisposed && this.visible && this.generation === generation + 1) { this.server.focus(); }
		}
	}

	private async findServers(): Promise<void> {
		const languageId = this.language.value.trim();
		if (!languageId) { this.setStatus('missingLanguage', 'Open a code file or enter a language ID first.'); this.language.focus(); return; }
		try {
			// Marketplace owns its loading state; do not keep Settings over it while catalog requests run.
			await this.commands.executeCommand(CLOSE_EDITOR_COMMAND_ID);
			await this.commands.executeCommand(OPEN_MARKETPLACE_COMMAND_ID, { languageId, capabilityKind: 'executable' });
		}
		catch (error) { if (!this.isDisposed) { this.setStatus('findFailed', 'Could not open Marketplace: {0}', [error instanceof Error ? error.message : String(error)]); } }
	}

	private updateActions(): void {
		const enabled = !this.working && !this.loading;
		for (const control of [this.directory, this.language, this.list, this.server, this.enabled, this.executable, this.find, this.refreshButton]) { control.enabled = enabled; }
		this.save.enabled = enabled && !!this.snapshot && !!this.server.value.trim();
		this.reset.enabled = enabled && !!this.snapshot?.configurations[this.server.value.trim()];
		this.domNode.setAttribute('aria-busy', String(this.working || this.loading));
	}

	private updateLabels(): void {
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.LanguageServers);
		this.domNode.setAttribute('aria-label', `${this.label('title', 'Language Servers')}${hint ? ` ${hint}` : ''}`);
		this.note.textContent = this.label('note', 'Enable servers and set executable paths for the App Server profile. The workspace folder controls availability checks. Logs and startup failures are shown in Output.');
		const fields: readonly [string, string][] = [['directory', 'Workspace folder'], ['language', 'Language ID'], ['list', 'Language servers'], ['server', 'Server ID'], ['enabled', 'Enable server'], ['executable', 'Executable path (optional)']];
		for (const [key, text] of fields) { this.labels.get(key)!.textContent = this.label(key, text); }
		this.directory.setAriaLabel(this.label('directory', 'Workspace folder'));
		this.list.setAriaLabel(this.label('list', 'Language servers'));
		this.language.inputElement.setAttribute('aria-label', this.label('language', 'Language ID'));
		this.server.inputElement.setAttribute('aria-label', this.label('server', 'Server ID'));
		this.enabled.input.setAttribute('aria-label', this.label('enabled', 'Enable server'));
		this.executable.inputElement.setAttribute('aria-label', this.label('executable', 'Executable path (optional)'));
		this.save.label = this.label('save', 'Save server configuration');
		this.reset.label = this.label('reset', 'Use default configuration');
		this.refreshButton.label = this.label('refresh', 'Refresh');
		this.find.label = this.label('find', 'Find language servers in Marketplace');
		this.help.label = this.label('help', 'Help');
		if (this.statusMessage) { this.setStatus(this.statusMessage.key, this.statusMessage.text, this.statusMessage.parameters); }
	}

	private setStatus(key: string, text: string, parameters: readonly (string | number)[] = []): void {
		this.statusMessage = { key, text, parameters };
		this.status.textContent = this.label(key, text, parameters);
	}

	private label(key: string, text: string, parameters: readonly (string | number)[] = []): string {
		return this.localization.translate('ash.settings', `lsp.${key}`, text, Object.fromEntries(parameters.map((value, index) => [String(index), value])));
	}

	private field(key: string): HTMLElement {
		const field = h(this.domNode.ownerDocument, 'div');
		field.className = 'ash-language-server-settings-field';
		const label = h(this.domNode.ownerDocument, 'span');
		this.labels.set(key, label);
		field.append(label);
		this.domNode.append(field);
		return field;
	}

	private button(container: HTMLElement, run: () => Promise<void>): Button {
		const button = this._register(new Button(container, { label: '', presentation: 'secondary' }));
		this._register(button.onDidClick(() => { void run(); }));
		return button;
	}
}

let nextLanguageServerSettingsId = 0;
