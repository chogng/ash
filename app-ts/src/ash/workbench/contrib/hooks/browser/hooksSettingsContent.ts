import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import './media/hooksSettingsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { SettingsSearchQuery } from '../../preferences/browser/settingsSearch.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';
import { Disposable, DisposableStore, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { HookEvents, IHooksService, type HookDeclaration, type HookEvent, type HookSource } from '../../../../platform/hooks/common/hooksService.js';
import { createSshRemoteWorkspaceUri } from '../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.HooksSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Hooks accessibility verbosity must be boolean');
		return value;
	},
});

/** A project file is editable before session discovery supplies its backend namespace. */
interface HookConfigurationTarget {
	readonly configPath: string;
	readonly namespace: string | undefined;
}

interface EventRow {
	readonly domNode: HTMLDetailsElement;
	readonly summary: HTMLElement;
	readonly description: HTMLElement;
	readonly empty: HTMLElement;
	readonly hooks: HTMLElement;
	readonly ask: Button;
}

interface HookRow {
	readonly domNode: HTMLDetailsElement;
	readonly summary: HTMLElement;
	readonly fields: HTMLElement;
	readonly edit: Button;
	readonly ask: Button;
}

/** Displays backend declarations; editing remains with the owning TOML and text editor. */
export class HooksSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'hooks';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly configurationOpened = this._register(new Emitter<URI | undefined>());
	/** The profile configuration opens on its host; project configurations use this window's editor. */
	public readonly onDidOpenConfiguration = this.configurationOpened.event;
	private query = new SettingsSearchQuery('');
	public readonly domNode: HTMLElement;
	private readonly status: HTMLElement;
	private readonly note: HTMLElement;
	private readonly scope: SelectBox;
	private readonly edit: Button;
	private readonly ask: Button;
	private readonly refreshButton: Button;
	private readonly eventRows = new Map<HookEvent, EventRow>();
	private readonly hookResources = this._register(new DisposableMap<string, DisposableStore>());
	private readonly hookRows = new Map<string, HookRow>();
	private sources: readonly HookSource[] | undefined;
	private statusMessage: { readonly key: string; readonly text: string; readonly parameters?: readonly (string | number)[] } | undefined;
	private visible = false;
	private loadVersion = 0;
	private readonly instanceId = ++nextHooksSettingsId;

	constructor(
		container: HTMLElement,
		private readonly prepareChat: () => Promise<void>,
		@IHooksService private readonly hooks: IHooksService,
		@IRemoteAgentService private readonly remote: IRemoteAgentService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IChatSessionNavigationService private readonly chats: IChatSessionNavigationService,
		@IEditorService private readonly editors: IEditorService,
		@IFileService private readonly files: IFileService,
		@ILocalizationService private readonly localization: ILocalizationService,
		@IContextViewService contextView: IContextViewService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-agent-hooks-settings';
		this.status = h(document, 'p');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.note = h(document, 'p');
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-hooks-toolbar';
		this.scope = this._register(new SelectBox(toolbar, { options: [], presentation: 'field', contextViewProvider: contextView }));
		this.edit = this.button(toolbar, 'edit-scope');
		this.ask = this.button(toolbar, 'ask-scope');
		this.refreshButton = this.button(toolbar, 'refresh');
		this.domNode.append(this.note, toolbar, this.status);
		for (const event of HookEvents) this.createEventRow(event);
		this._register(this.scope.onDidSelect(() => this.updateActions()));
		this._register(this.hooks.onDidChange(() => { if (this.visible) void this.refresh(); }));
		this._register(this.workspace.onDidChangeWorkspace(() => this.changeSourceContext()));
		this._register(this.remote.onDidChangeConnectionState(state => {
			this.loadVersion++;
			this.sources = undefined;
			this.render();
			if (this.visible && state === 'connected') void this.refresh();
			else this.setStatus('disconnected', 'App Server is disconnected.');
		}));
		this._register(this.remote.onDidChangeConnection(() => this.changeSourceContext()));
		this._register(this.localization.onDidChange(() => this.render()));
		this._register(toDisposable(() => { this.loadVersion++; this.domNode.remove(); }));
		const scopedContext = this._register(contextKeys.createScoped(container));
		scopedContext.createKey('hooksSettingsFocused', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `hooks-settings-${this.instanceId}-${type}`,
				when: ContextKeyExpr.has('hooksSettingsFocused'),
				getProvider: () => {
					const active = this.domNode.ownerDocument.activeElement;
					if (!this.visible || !isHTMLElement(active) || (!this.domNode.contains(active) && ![...this.eventRows.values()].some(row => row.domNode.contains(active)))) return undefined;
					const focusTarget = isHTMLElement(active) && container.contains(active) ? active : this.edit.domNode;
					return new AccessibleContentProvider(AccessibleViewProviderId.HooksSettings, { type },
						() => type === AccessibleViewType.Help ? this.label('help', 'Agent Hooks\nUse Tab and Shift+Tab to reach the configuration scope, Edit TOML, Ask Ash, Refresh, and events. Use the Settings search to filter events and declarations. Press Enter or Space on an event or Hook to expand its details. Search filters event names, Hook IDs, commands, and paths. Edit TOML opens the selected configuration; save it, then choose Refresh. Ask Ash appends a configuration request to the current chat draft without sending it. Configured Hooks still require execution permission.') : this.accessibleContent(),
						() => focusTarget.focus(), AccessibilityVerbositySettingId.HooksSettings);
				},
			}));
		}
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) void this.refresh();
		else this.loadVersion++;
	}

	private changeSourceContext(): void {
		this.loadVersion++;
		this.sources = undefined;
		this.render();
		if (this.visible) void this.refresh();
	}

	private async refresh(): Promise<void> {
		const version = ++this.loadVersion;
		this.setStatus('loading', 'Loading Hooks…');
		this.render();
		try {
			const sources = await this.hooks.read(this.chats.getActiveConversation()?.sessionId);
			if (version !== this.loadVersion || !this.visible) return;
			this.sources = sources;
			this.setStatus('loaded', '{0} event types · {1} configured Hooks', [HookEvents.length, sources.reduce((sum, source) => sum + source.hooks.length, 0)]);
			this.render();
		} catch (error) {
			if (version !== this.loadVersion || !this.visible) return;
			this.sources = undefined;
			this.setStatus('failed', 'Could not load Hooks: {0}', [error instanceof Error ? error.message : String(error)]);
			this.render();
		}
	}

	private createEventRow(event: HookEvent): EventRow {
		const document = this.domNode.ownerDocument;
		const domNode = h(document, 'details');
		domNode.className = 'ash-hooks-event';
		domNode.dataset.hookEvent = event;
		const summary = h(document, 'summary');
		const description = h(document, 'p');
		const empty = h(document, 'p');
		const hooks = h(document, 'div');
		const actions = h(document, 'div');
		actions.className = 'ash-hooks-toolbar';
		const ask = this.button(actions, 'ask-event');
		ask.domNode.dataset.hookTrigger = event;
		domNode.append(summary, description, actions, empty, hooks);
		const row = { domNode, summary, description, empty, hooks, ask };
		this.eventRows.set(event, row);
		return row;
	}

	private render(): void {
		if (this.statusMessage) this.status.textContent = this.label(this.statusMessage.key, this.statusMessage.text, this.statusMessage.parameters);
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.HooksSettings);
		this.domNode.setAttribute('aria-label', `${this.label('aria', 'Agent Hooks')}${hint ? ` ${hint}` : ''}`);
		this.note.textContent = this.label('note', 'Choose a scope to edit its TOML or ask Ash to configure it. Hook declarations do not grant execution permission. Save the file, then refresh to check your changes.');
		this.scope.setAriaLabel(this.label('scope', 'Configuration scope'));
		this.edit.label = this.label('edit', 'Edit TOML');
		this.ask.label = this.label('ask', 'Ask Ash to configure');
		this.refreshButton.label = this.label('refresh', 'Refresh');
		this.scope.setOptions([
			{ value: 'user', label: this.label('user', 'User configuration') },
			...this.workspace.getWorkspace().folders.map(folder => ({ value: folder.id, label: this.label('project', 'Project: {0}', [folder.name]) })),
		]);
		this.updateActions();
		const declarations = (this.sources ?? []).flatMap(source => source.hooks.map(hook => ({ source, hook })));
		for (const { hook } of declarations) {
			if (!this.eventRows.has(hook.event)) this.createEventRow(hook.event);
		}
		const currentIds = new Set(declarations.map(({ hook }) => hook.id));
		for (const [id, row] of this.hookRows) {
			if (!currentIds.has(id)) {
				row.domNode.remove();
				this.hookRows.delete(id);
				this.hookResources.deleteAndDispose(id);
			}
		}
		for (const [event, row] of this.eventRows) {
			const matches = declarations.filter(entry => entry.hook.event === event);
			row.summary.textContent = this.label('eventCount', '{0} · {1} configured', [eventName(event), this.sources ? matches.length : '—']);
			row.description.textContent = this.label(`events.${event}`, EventDescriptions[event]);
			row.ask.label = this.label('ask', 'Ask Ash to configure');
			row.ask.enabled = !!this.selectedConfiguration();
			row.empty.textContent = this.label('empty', 'No Hooks configured for this event.');
			row.empty.hidden = !this.sources || matches.length !== 0;
			row.domNode.hidden = !HookEvents.includes(event as typeof HookEvents[number]) && matches.length === 0;
			for (const { source, hook } of matches) {
				let hookRow = this.hookRows.get(hook.id);
				if (!hookRow) {
					const resources = this.hookResources.set(hook.id, new DisposableStore());
					const domNode = h(this.domNode.ownerDocument, 'details');
					domNode.className = 'ash-hooks-declaration';
					domNode.dataset.hookId = hook.id;
					const summary = h(this.domNode.ownerDocument, 'summary');
					const fields = h(this.domNode.ownerDocument, 'dl');
					const actions = h(this.domNode.ownerDocument, 'div');
					actions.className = 'ash-hooks-toolbar';
					const edit = this.button(actions, 'edit-hook', hook.id, resources);
					const ask = this.button(actions, 'ask-hook', hook.id, resources);
					domNode.append(summary, fields, actions);
					hookRow = { domNode, summary, fields, edit, ask };
					this.hookRows.set(hook.id, hookRow);
				}
				hookRow.summary.textContent = `${hook.id} · ${this.enablement(hook)}`;
				hookRow.fields.replaceChildren();
				for (const [label, value] of this.fields(source, hook)) {
					const term = h(this.domNode.ownerDocument, 'dt');
					term.textContent = label;
					const detail = h(this.domNode.ownerDocument, 'dd');
					detail.textContent = value;
					hookRow.fields.append(term, detail);
				}
				hookRow.edit.label = this.label('edit', 'Edit TOML');
				hookRow.edit.enabled = this.canEdit(source);
				hookRow.ask.label = this.label('ask', 'Ask Ash to configure');
				if (hookRow.domNode.parentElement !== row.hooks) row.hooks.append(hookRow.domNode);
			}
		}
		this.changed.fire();
	}

	public getNodes(query: SettingsSearchQuery): readonly SettingsTreeNode<SettingsContentItem>[] {
		this.query = query;
		const declarations = (this.sources ?? []).flatMap(source => source.hooks.map(hook => ({ source, hook })));
		const nodes: SettingsTreeNode<SettingsContentItem>[] = [{
			element: { kind: 'item', id: 'hooks.configuration', title: this.label('aria', 'Agent Hooks'), description: this.note.textContent ?? '', keywords: [...HookEvents, ...declarations.flatMap(({ source, hook }) => [hook.id, source.configPath, hook.program, ...hook.args, ...hook.toolNames])], value: { domNode: this.domNode } },
		}];
		for (const [event, row] of this.eventRows) {
			const matches = declarations.filter(entry => entry.hook.event === event);
			if (!HookEvents.includes(event as typeof HookEvents[number]) && matches.length === 0) continue;
			const metadata = { id: `hooks.event.${event}`, title: eventName(event), description: row.description.textContent ?? '', keywords: [event, ...matches.flatMap(({ source, hook }) => [hook.id, source.configPath, hook.program, ...hook.args, ...hook.toolNames])] };
			for (const { source, hook } of matches) {
				this.hookRows.get(hook.id)!.domNode.hidden = !query.matches({ id: metadata.id, title: eventName(event), description: row.description.textContent ?? '', keywords: [event] }) && !query.matches({ id: hook.id, title: hook.id, description: source.configPath, keywords: [hook.program, ...hook.args, ...hook.toolNames] });
			}
			nodes.push({ element: { kind: 'item', ...metadata, value: { domNode: row.domNode } } });
		}
		return nodes;
	}

	private fields(source: HookSource, hook: HookDeclaration): readonly (readonly [string, string])[] {
		return [
			[this.label('event', 'Event'), eventName(hook.event)],
			[this.label('state', 'State'), this.enablement(hook)],
			[this.label('source', 'Source file'), source.configPath],
			[this.label('matcher', 'Tool names'), JSON.stringify(hook.toolNames)],
			[this.label('program', 'Program'), hook.program],
			[this.label('args', 'Arguments'), JSON.stringify(hook.args)],
		];
	}

	private enablement(hook: HookDeclaration): string {
		return hook.enabled ? this.label('enabled', 'Enabled') : this.label('disabled', 'Disabled');
	}

	private button(container: HTMLElement, action: string, hookId?: string, resources: DisposableStore = this._store): Button {
		const button = resources.add(new Button(container, { label: '', presentation: 'secondary' }));
		button.domNode.dataset.hookAction = action;
		if (hookId) button.domNode.dataset.hookId = hookId;
		resources.add(button.onDidClick(() => { void this.performAction(button.domNode); }));
		return button;
	}

	private selectedConfiguration(): HookConfigurationTarget | undefined {
		if (this.scope.value === 'user') return this.sources?.find(source => source.namespace === 'user');
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === this.scope.value);
		if (!folder) return undefined;
		const path = URI.joinPath(folder.uri, '.ash', 'config.toml');
		const configPath = path.scheme === 'file' ? path.fsPath : path.path;
		const discovered = this.sources?.find(source => this.sourceResource(source)?.toString() === path.toString());
		return { configPath, namespace: discovered?.namespace };
	}

	private sourceResource(source: HookConfigurationTarget): URI | undefined {
		if (source.namespace === 'user') return undefined;
		const connection = this.remote.connection;
		return connection?.kind === 'ssh' ? createSshRemoteWorkspaceUri(connection.host, source.configPath) : URI.file(source.configPath);
	}

	private canEditUserConfiguration(): boolean {
		return this.remote.connection?.kind === 'local' && this.hooks.userConfigurationEditor !== undefined;
	}

	private canEdit(source: HookConfigurationTarget): boolean {
		if (source.namespace === 'user') return this.canEditUserConfiguration();
		return this.workspace.getWorkspaceFolder(this.sourceResource(source)!) !== null;
	}

	private updateActions(): void {
		const source = this.selectedConfiguration();
		// Opening Main's fixed profile file does not require a successful catalog read.
		this.edit.enabled = this.scope.value === 'user' ? this.canEditUserConfiguration() : !!source && this.canEdit(source);
		this.ask.enabled = !!source;
		for (const row of this.eventRows.values()) row.ask.enabled = !!source;
		this.edit.domNode.title = source && !this.canEdit(source) ? this.label('editUnavailable', 'Edit this configuration on its owning host, or ask Ash to configure it.') : source?.configPath ?? '';
	}

	private async performAction(button: HTMLButtonElement): Promise<void> {
		if (button.dataset.hookAction === 'refresh') { await this.refresh(); return; }
		const id = button.dataset.hookId;
		const hookSource = id ? this.sources?.find(source => source.hooks.some(hook => hook.id === id)) : undefined;
		const source = id ? hookSource : this.selectedConfiguration();
		let editorResource: URI | undefined;
		try {
			if (button.dataset.hookAction?.startsWith('ask-')) {
				if (!source) return;
				const hook = hookSource?.hooks.find(hook => hook.id === id);
				const trigger = hook?.event ?? button.dataset.hookTrigger as HookEvent | undefined;
				const event = trigger ? eventName(trigger) : this.label('custom', 'custom');
				const prompt = source.namespace
					? this.label('prompt', 'Help me configure {0} Hooks in {1}. Inspect the existing TOML and preserve other settings. Use the source namespace ({2}) for Hook IDs. Explain the trigger, command and scope, then validate the configuration. My requirement: ', [event, source.configPath, source.namespace])
					: this.label('projectPrompt', 'Help me configure {0} Hooks in {1}. Inspect the existing TOML and preserve other settings. Resolve the project directory namespace through App Server before choosing Hook IDs. Explain the trigger, command and scope, then validate the configuration. My requirement: ', [event, source.configPath]);
				await this.prepareChat();
				this.chats.appendToActiveDraft(prompt);
				return;
			}
			if ((button.dataset.hookAction === 'edit-scope' && this.scope.value === 'user') || source?.namespace === 'user') {
				if (!this.canEditUserConfiguration()) return;
				await this.hooks.userConfigurationEditor!();
			} else {
				if (!source || !this.canEdit(source)) return;
				const resource = this.sourceResource(source)!;
				await this.files.createDirectory(dirname(resource));
				await this.files.createFile(resource, 'ignore');
				await this.editors.openEditor({ resource, languageId: 'toml' }, { pinned: true });
				editorResource = resource;
			}
			if (!this.isDisposed) {
				this.setStatus('opened', 'Configuration opened. Save it, then choose Refresh.');
				this.configurationOpened.fire(editorResource);
			}
		} catch (error) {
			if (!this.isDisposed) this.setStatus('actionFailed', 'Could not configure Hooks: {0}', [error instanceof Error ? error.message : String(error)]);
		}
	}

	private accessibleContent(): string {
		return [this.note.textContent, this.status.textContent, ...[...this.eventRows].filter(([event, row]) => this.query.matches({ title: eventName(event), description: row.description.textContent ?? '', keywords: (this.sources ?? []).flatMap(source => source.hooks.filter(hook => hook.event === event).flatMap(hook => [hook.id, source.configPath, hook.program, ...hook.args, ...hook.toolNames])) })).flatMap(([event, row]) => [row.summary.textContent, row.description.textContent, ...(this.sources ?? []).flatMap(source => source.hooks.filter(hook => hook.event === event && !this.hookRows.get(hook.id)?.domNode.hidden).flatMap(hook => [hook.id, ...this.fields(source, hook).map(([label, value]) => `${label}: ${value}`)]))])].join('\n');
	}

	private setStatus(key: string, text: string, parameters?: readonly (string | number)[]): void {
		this.statusMessage = { key, text, parameters };
		this.status.textContent = this.label(key, text, parameters);
	}

	private label(key: string, fallback: string, parameters?: readonly (string | number)[]): string {
		return this.localization.translate('ash.settings', `hooks.${key}`, fallback, parameters === undefined ? undefined : Object.fromEntries(parameters.map((value, index) => [String(index), value])));
	}
}

let nextHooksSettingsId = 0;

function eventName(event: HookEvent): string {
	return event[0]!.toUpperCase() + event.slice(1);
}

const EventDescriptions: Record<HookEvent, string> = {
	preToolUse: 'Before a tool executes.', postToolUse: 'After a tool succeeds.', postToolUseFailure: 'After a tool fails.', postToolBatch: 'After a batch of tool calls.', permissionDenied: 'After tool permission is denied.',
	notification: 'When a notification reaches a client.', userPromptSubmit: 'When the user submits a prompt.', userPromptExpansion: 'When a slash command expands.', sessionStart: 'When a session starts.', stop: 'After a turn completes.', stopFailure: 'When a turn ends with an error.',
	subagentStart: 'When a subagent starts.', subagentStop: 'After a subagent produces its result.', preCompact: 'Before context compaction.', postCompact: 'After context compaction.', preModelSwitch: 'Before a model switch is requested.', postModelSwitch: 'After the session model changes.',
	sessionEnd: 'When a session ends.', permissionRequest: 'Before a permission request is shown.', setup: 'When project setup starts.', teammateIdle: 'When a teammate completes its assigned work.', taskCreated: 'When a plan step is created.', taskCompleted: 'When a plan step completes.',
	elicitation: 'Before MCP requests user input.', elicitationResult: 'After the user answers MCP.', configChange: 'When session configuration changes.', instructionsLoaded: 'When an instruction file is read.', worktreeCreate: 'Before a worktree is created.', worktreeRemove: 'Before a worktree is removed.',
	cwdChanged: 'After the active directory changes.', fileChanged: 'When a watched file changes.', directoryAdded: 'After a directory is added to a session.', messageDisplay: 'When assistant text reaches a client.',
	beforeTool: 'Legacy event before a tool executes.', afterTool: 'Legacy event after a tool succeeds or fails.', turnCompleted: 'Legacy event after a turn completes.',
};
