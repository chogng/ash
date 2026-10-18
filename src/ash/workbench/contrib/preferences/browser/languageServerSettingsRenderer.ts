import { SettingsPageRenderer } from './settingsRenderers.js';
import { validateJsonValue, type JsonValue } from '../../../../base/common/jsonValue.js';
import type { LanguageServerConfiguration } from '../../../../platform/language/common/languageServerService.js';
import {
	defaultButtonStyles,
	defaultCheckboxStyles,
	defaultInputBoxStyles,
	defaultSelectBoxStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import './media/languageServerSettingsRenderer.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
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
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CLOSE_EDITOR_COMMAND_ID } from '../../../browser/parts/editor/editorCommands.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import { SettingsSearchQuery } from './settingsSearch.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';

import { LanguageServerSettingsTarget } from '../common/preferences.js';

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
export class LanguageServerSettingsRenderer extends SettingsPageRenderer<SettingsSectionReference> {
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
	private readonly advanced: InputBox<true>;
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
		@IExtensionManagementService extensionManagement: IExtensionManagementService,
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
		this.directory = this._register(new SelectBox(this.field('directory'), {
			options: [], presentation: 'field', contextViewProvider: contextView
		}, defaultSelectBoxStyles));
		this.language = this._register(new InputBox(this.field('language'), {
			inputBoxStyles: defaultInputBoxStyles,
			presentation: 'field',
		}));
		this.find = this.button(this.domNode, () => this.findServers());
		this.list = this._register(new SelectBox(this.field('list'), {
			options: [], presentation: 'field', contextViewProvider: contextView
		}, defaultSelectBoxStyles));
		this.server = this._register(new InputBox(this.field('server'), {
			inputBoxStyles: defaultInputBoxStyles,
			presentation: 'field',
		}));
		const enabledField = this.field('enabled');
		this.enabled = this._register(new Checkbox(enabledField, {
			...defaultCheckboxStyles,
		}));
		this.executable = this._register(new InputBox(this.field('executable'), {
			inputBoxStyles: defaultInputBoxStyles,
			presentation: 'field',
		}));
		this.advanced = this._register(new InputBox(this.field('advanced'), {
			inputBoxStyles: defaultInputBoxStyles, presentation: 'field', flexibleHeight: true,
			placeholder: '{ "languageIds": ["python"], "args": [], "environment": {}, "initializationOptions": {}, "settings": {} }',
		}));
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
		this._register(extensionManagement.onDidChangeInstalled(() => {
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
					() => this.label('helpText', 'Language Servers\nUse Tab and Shift+Tab to reach the workspace folder, language, Extensions, server selection, enable switch, executable path, Save, Use Default, Refresh, and Help. Use arrow keys in server and folder lists. Configuration applies to the App Server profile; the folder only controls availability checks. Leave the executable path empty to use the installed package or PATH. Rust support is enabled by default and downloads a managed rust-analyzer when no usable local server is available. An explicit path takes priority; disabling the server prevents installation. Advanced configuration accepts languageIds, args, environment, initializationOptions, and settings as JSON. A custom server requires an executable path and languageIds. Arguments are appended to the server launch command without shell expansion. Settings are returned to the server through workspace/configuration. Use Default removes the override. After a conflict or an installation change, Refresh before saving. Find opens Extensions for the exact language and executable capability. Logs and startup failures are in Output; click a language server status entry to open its log.'),
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

	protected override buildNodes(_query: SettingsSearchQuery): readonly SettingsTreeNode<SettingsSectionReference>[] {
		return [{
			element: { kind: 'group', id: LanguageServerSettingsTarget, title: this.label('title', 'Language Servers'), description: this.label('description', 'Configure language servers. View their logs and failures in Output.') },
			children: [{
				element: {
					kind: 'item', id: 'language-servers.configuration', title: this.label('title', 'Language Servers'), description: this.note.textContent ?? '',
					keywords: ['lsp', 'language servers', 'output', 'extensionManagement', 'executable', this.language.value, ...Object.keys(this.snapshot?.configurations ?? {}), ...(this.snapshot?.servers.flatMap(server => [server.id, ...server.languageIds]) ?? [])],
					value: this.retainElement('language-servers.configuration', this.domNode),
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
			if (snapshot.servers.length) {
				this.setStatus('available', '{0} servers available. They start when a matching document needs them.', [snapshot.servers.length]);
			} else {
				this.setStatus('empty', 'No enabled server is available. Find a package in Extensions or configure an executable.');
			}
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
		const { mode: _mode, executable: _executable, ...advanced } = config ?? {};
		this.advanced.value = Object.keys(advanced).length ? JSON.stringify(advanced, undefined, 2) : '{}';
		this.updateActions();
	}

	private async mutate(action: 'save' | 'reset'): Promise<void> {
		const snapshot = this.snapshot;
		if (!snapshot || this.working || this.loading) { return; }
		const id = this.server.value.trim();
		let advanced: Omit<LanguageServerConfiguration, 'mode' | 'executable'> = {};
		if (action === 'save') {
			try { advanced = parseAdvancedConfiguration(this.advanced.value); }
			catch {
				this.setStatus('invalidAdvanced', 'Enter valid JSON with languageIds, args, environment, initializationOptions, or settings. Language IDs and arguments are arrays of strings; environment values are strings; settings is an object.');
				this.advanced.focus();
				return;
			}
		}
		const generation = this.generation;
		this.working = true;
		this.updateActions();
		try {
			if (action === 'reset') { await this.servers.removeConfiguration(id, snapshot.revision); }
			else { await this.servers.configure(id, { ...advanced, mode: this.enabled.checked ? 'enabled' : 'disabled', executable: this.executable.value.trim() || undefined }, snapshot.revision); }
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
			// Extensions owns its loading state; do not keep Settings over it while catalog requests run.
			await this.commands.executeCommand(CLOSE_EDITOR_COMMAND_ID);
			await this.commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { languageId, capabilityKind: 'executable' });
		}
		catch (error) { if (!this.isDisposed) { this.setStatus('findFailed', 'Could not open Extensions: {0}', [error instanceof Error ? error.message : String(error)]); } }
	}

	private updateActions(): void {
		const enabled = !this.working && !this.loading;
		for (const control of [this.directory, this.language, this.list, this.server, this.enabled, this.executable, this.advanced, this.find, this.refreshButton]) { control.enabled = enabled; }
		this.save.enabled = enabled && !!this.snapshot && !!this.server.value.trim();
		this.reset.enabled = enabled && !!this.snapshot?.configurations[this.server.value.trim()];
		this.domNode.setAttribute('aria-busy', String(this.working || this.loading));
	}

	private updateLabels(): void {
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.LanguageServers);
		this.domNode.setAttribute('aria-label', `${this.label('title', 'Language Servers')}${hint ? ` ${hint}` : ''}`);
		this.note.textContent = this.label('note', 'Rust support is built in. Ash uses an available rust-analyzer or downloads a managed version when needed. You can disable it or set an executable path. Logs and startup failures are shown in Output.');
		const fields: readonly [string, string][] = [['directory', 'Workspace folder'], ['language', 'Language ID'], ['list', 'Language servers'], ['server', 'Server ID'], ['enabled', 'Enable server'], ['executable', 'Executable path (optional)'], ['advanced', 'Advanced configuration (JSON)']];
		for (const [key, text] of fields) { this.labels.get(key)!.textContent = this.label(key, text); }
		this.directory.setAriaLabel(this.label('directory', 'Workspace folder'));
		this.list.setAriaLabel(this.label('list', 'Language servers'));
		this.language.inputElement.setAttribute('aria-label', this.label('language', 'Language ID'));
		this.server.inputElement.setAttribute('aria-label', this.label('server', 'Server ID'));
		this.enabled.input.setAttribute('aria-label', this.label('enabled', 'Enable server'));
		this.executable.inputElement.setAttribute('aria-label', this.label('executable', 'Executable path (optional)'));
		this.advanced.inputElement.setAttribute('aria-label', this.label('advanced', 'Advanced configuration (JSON)'));
		this.save.label = this.label('save', 'Save server configuration');
		this.reset.label = this.label('reset', 'Use default configuration');
		this.refreshButton.label = this.label('refresh', 'Refresh');
		this.find.label = this.label('find', 'Find language servers in Extensions');
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
		const button = this._register(new Button(container, {
			...defaultButtonStyles,
			label: '',
			presentation: 'secondary',
		}));
		this._register(button.onDidClick(() => { void run(); }));
		return button;
	}
}

let nextLanguageServerSettingsId = 0;

function parseAdvancedConfiguration(text: string): Omit<LanguageServerConfiguration, 'mode' | 'executable'> {
	const value = validateJsonValue(JSON.parse(text || '{}'));
	const object = (value: JsonValue): value is { readonly [key: string]: JsonValue; } => value !== null && typeof value === 'object' && !Array.isArray(value);
	if (!object(value) || Object.keys(value).some(key => !['languageIds', 'args', 'environment', 'initializationOptions', 'settings'].includes(key))) throw new TypeError('configuration');
	const strings = (value: JsonValue | undefined): readonly string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) throw new TypeError('string array');
		return value;
	};
	const environment: Record<string, string> = {};
	if (value.environment !== undefined) {
		if (!object(value.environment)) throw new TypeError('environment');
		for (const [key, entry] of Object.entries(value.environment)) {
			if (typeof entry !== 'string') throw new TypeError('environment value');
			environment[key] = entry;
		}
	}
	if (value.settings !== undefined && !object(value.settings)) throw new TypeError('settings');
	return {
		...(value.languageIds === undefined ? {} : { languageIds: strings(value.languageIds) }),
		...(value.args === undefined ? {} : { args: strings(value.args) }),
		...(value.environment === undefined ? {} : { environment }),
		...(value.initializationOptions === undefined ? {} : { initializationOptions: value.initializationOptions }),
		...(value.settings === undefined ? {} : { settings: value.settings as Readonly<Record<string, JsonValue>> }),
	};
}
