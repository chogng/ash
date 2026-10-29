import { defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { h, type IDimension } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../../base/browser/ui/selectbox/selectbox.js';
import { DisposableStore, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import type { HookDeclaration, HookEvent, HookSource } from '../../../../../platform/agentHost/common/appServerApi.js';
import { HookEvents } from '../../common/promptSyntax/hookTypes.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { canEditHookConfiguration, getHookConfigurationResource, openHookConfiguration, showConfigureHooksQuickPick, type HookConfigurationTarget } from '../promptSyntax/hookActions.js';
import { AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID, CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR } from './aiCustomizationManagement.js';
import './media/aiCustomizationManagement.css';

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
export class AICustomizationManagementEditor extends EditorPane {
	public readonly id = AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID;
	private domNode!: HTMLElement;
	private status!: HTMLElement;
	private note!: HTMLElement;
	private scope!: SelectBox;
	private edit!: Button;
	private ask!: Button;
	private refreshButton!: Button;
	private search!: InputBox;
	private readonly eventRows = new Map<HookEvent, EventRow>();
	private readonly hookResources = this._register(new DisposableMap<string, DisposableStore>());
	private readonly hookRows = new Map<string, HookRow>();
	private sources: readonly HookSource[] | undefined;
	private loadedSessionId: string | undefined;
	private actionPending = false;
	private readonly refreshAfterSave = this._register(
		new RunOnceScheduler(() => {
			if (this.visible) void this.refresh();
		}, 100),
	);
	private statusMessage: { readonly key: string; readonly text: string; readonly parameters?: readonly (string | number)[] } | undefined;
	private visible = false;
	private loadVersion = 0;

	constructor(
		@IPromptsService private readonly prompts: IPromptsService,
		@ITextFileService private readonly textFiles: ITextFileService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IChatSessionNavigationService private readonly chats: IChatSessionNavigationService,
		@ILocalizationService private readonly localization: ILocalizationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID, theme, storage);
	}

	public override create(container: HTMLElement): void {
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-ai-customization-management';
		container.append(this.domNode);
		super.create(this.domNode);
		this.status = h(document, 'p');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.note = h(document, 'p');
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-hooks-toolbar';
		this.scope = this._register(
			new SelectBox(
				toolbar,
				{
					options: [],
					presentation: 'field',
					contextViewProvider: this.contextView,
				},
				defaultSelectBoxStyles,
			),
		);
		this.edit = this.button(toolbar, 'edit-scope');
		this.ask = this.button(toolbar, 'ask-scope');
		this.refreshButton = this.button(toolbar, 'refresh');
		const title = h(document, 'h2');
		title.textContent = localize('hooks.managementTitle', 'Agent Customizations: Hooks');
		this.search = this._register(
			new InputBox(this.domNode, {
				inputBoxStyles: defaultInputBoxStyles,
				type: 'search',
				ariaLabel: this.label('search', 'Search events, Hooks, commands, or paths'),
				presentation: 'field',
			}),
		);
		this._register(this.search.onDidChange(() => this.filter()));
		const configure = this._register(
			new Button(toolbar, {
				...defaultButtonStyles,
				label: localize('hooks.configureButton', 'Configure Hooks…'),
				presentation: 'secondary',
			}),
		);
		this._register(
			configure.onDidClick(() => {
				void this.instantiation.invokeFunction(showConfigureHooksQuickPick);
			}),
		);
		this.domNode.prepend(title, this.note, toolbar, this.status);
		for (const event of HookEvents) this.createEventRow(event);
		this._register(this.scope.onDidSelect(() => this.updateActions()));
		this._register(
			this.prompts.onDidChangeHooks(() => {
				if (this.visible) void this.refresh();
			}),
		);
		this._register(
			this.textFiles.onDidSave(event => {
				if (
					this.visible &&
					this.sources?.some(source => (source.namespace === 'user' ? source.configPath === event.resource.fsPath : extUri.isEqual(this.sourceResource(source), event.resource)))
				)
					this.refreshAfterSave.schedule();
			}),
		);
		this._register(this.workspace.onDidChangeWorkspace(() => this.changeSourceContext()));
		this._register(
			this.remote.onDidChangeConnectionState(state => {
				this.loadVersion++;
				this.sources = undefined;
				this.render();
				if (this.visible && state === 'connected') void this.refresh();
				else this.setStatus('disconnected', 'App Server is disconnected.');
			}),
		);
		this._register(this.remote.onDidChangeConnection(() => this.changeSourceContext()));
		this._register(
			toDisposable(() => {
				this.loadVersion++;
				this.domNode.remove();
			}),
		);
		const scopedContext = this._register(this.contextKeys.createScoped(this.domNode));
		CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR.bindTo(scopedContext).set(true);
	}

	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		this.render();
	}

	public override clearInput(): void {
		this.loadVersion++;
		this.sources = undefined;
		this.render();
	}

	public override layout(dimension: IDimension): void {
		this.domNode.style.width = `${dimension.width}px`;
		this.domNode.style.height = `${dimension.height}px`;
	}

	public override focus(): void {
		this.search.focus();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) void this.refresh();
		else {
			this.loadVersion++;
			this.refreshAfterSave.cancel();
		}
	}

	private changeSourceContext(): void {
		this.loadVersion++;
		this.sources = undefined;
		this.render();
		if (this.visible) void this.refresh();
	}

	private async refresh(): Promise<void> {
		const version = ++this.loadVersion;
		const sessionId = this.chats.getActiveConversation()?.sessionId;
		if (sessionId !== this.loadedSessionId) this.sources = undefined;
		this.domNode.setAttribute('aria-busy', 'true');
		this.setStatus('loading', 'Loading Hooks…');
		this.render();
		try {
			const sources = await this.prompts.getHooks(CancellationToken.None, sessionId);
			if (version !== this.loadVersion || !this.visible || sessionId !== this.chats.getActiveConversation()?.sessionId) return;
			this.sources = sources;
			this.loadedSessionId = sessionId;
			this.setStatus('loaded', '{0} event types · {1} configured Hooks', [HookEvents.length, sources.reduce((sum, source) => sum + source.hooks.length, 0)]);
			this.render();
		} catch (error) {
			if (version !== this.loadVersion || !this.visible || sessionId !== this.chats.getActiveConversation()?.sessionId) return;
			this.sources = undefined;
			this.setStatus('failed', 'Could not load Hooks: {0}', [error instanceof Error ? error.message : String(error)]);
			this.render();
		} finally {
			if (version === this.loadVersion && !this.isDisposed) this.domNode.setAttribute('aria-busy', 'false');
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
		this.domNode.append(domNode);
		return row;
	}

	private render(): void {
		if (this.statusMessage) this.status.textContent = this.label(this.statusMessage.key, this.statusMessage.text, this.statusMessage.parameters);
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.HooksSettings);
		this.domNode.setAttribute('aria-label', `${this.label('aria', 'Agent Hooks')}${hint ? ` ${hint}` : ''}`);
		this.note.textContent = this.label(
			'note',
			'Choose a scope to edit its TOML or ask Ash to configure it. Hook declarations do not grant execution permission. Save the file, then refresh to check your changes.',
		);
		this.scope.setAriaLabel(this.label('scope', 'Configuration scope'));
		this.edit.label = this.label('edit', 'Edit TOML');
		this.ask.label = this.label('ask', 'Ask Ash to configure');
		this.refreshButton.label = this.label('refresh', 'Refresh');
		this.scope.setOptions([
			{ value: 'user', label: this.label('user', 'User configuration') },
			...this.workspace.getWorkspace().folders.map(folder => ({
				value: folder.id,
				label: this.label('project', 'Project: {0}', [folder.name]),
			})),
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
			row.domNode.hidden = !HookEvents.includes(event as (typeof HookEvents)[number]) && matches.length === 0;
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
		this.filter();
	}

	private filter(): void {
		const terms = this.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const matches = (values: readonly string[]): boolean => terms.every(term => values.join(' ').toLowerCase().includes(term));
		for (const [event, row] of this.eventRows) {
			const entries = (this.sources ?? []).flatMap(source => source.hooks.filter(hook => hook.event === event).map(hook => ({ source, hook })));
			const eventMatches = matches([eventName(event), row.description.textContent ?? '']);
			let hasVisibleHook = false;
			for (const { source, hook } of entries) {
				const hookRow = this.hookRows.get(hook.id)!;
				hookRow.domNode.hidden = !eventMatches && !matches([hook.id, source.configPath, hook.program, ...hook.args, ...hook.toolNames]);
				hasVisibleHook ||= !hookRow.domNode.hidden;
			}
			row.domNode.hidden = (!HookEvents.includes(event as (typeof HookEvents)[number]) && entries.length === 0) || (!eventMatches && !hasVisibleHook);
		}
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
		const button = resources.add(
			new Button(container, {
				...defaultButtonStyles,
				label: '',
				presentation: 'secondary',
			}),
		);
		button.domNode.dataset.hookAction = action;
		if (hookId) button.domNode.dataset.hookId = hookId;
		resources.add(
			button.onDidClick(() => {
				void this.performAction(button.domNode);
			}),
		);
		return button;
	}

	private selectedConfiguration(): HookConfigurationTarget | undefined {
		if (this.scope.value === 'user') return this.sources?.find(source => source.namespace === 'user');
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === this.scope.value);
		if (!folder) return undefined;
		const path = URI.joinPath(folder.uri, '.ash', 'config.toml');
		const configPath = path.scheme === Schemas.file ? path.fsPath : path.path;
		const discovered = this.sources?.find(source => extUri.isEqual(this.sourceResource(source), path));
		return { configPath, namespace: discovered?.namespace };
	}

	private sourceResource(source: HookConfigurationTarget): URI | undefined {
		return this.instantiation.invokeFunction(getHookConfigurationResource, source);
	}

	private canEditUserConfiguration(): boolean {
		return this.canEdit({ namespace: 'user', configPath: '' });
	}

	private canEdit(source: HookConfigurationTarget): boolean {
		return this.instantiation.invokeFunction(canEditHookConfiguration, source);
	}

	private updateActions(): void {
		const source = this.selectedConfiguration();
		// Opening Main's fixed profile file does not require a successful catalog read.
		this.edit.enabled = this.scope.value === 'user' ? this.canEditUserConfiguration() : !!source && this.canEdit(source);
		this.ask.enabled = !!source;
		for (const row of this.eventRows.values()) row.ask.enabled = !!source;
		this.edit.domNode.title =
			source && !this.canEdit(source) ? this.label('editUnavailable', 'Edit this configuration on its owning host, or ask Ash to configure it.') : (source?.configPath ?? '');
	}

	private async performAction(button: HTMLButtonElement): Promise<void> {
		if (this.actionPending || this.isDisposed || !this.visible) return;
		if (button.dataset.hookAction === 'refresh') {
			await this.refresh();
			return;
		}
		if (this.sources && this.loadedSessionId !== this.chats.getActiveConversation()?.sessionId) {
			await this.refresh();
			return;
		}
		const version = this.loadVersion;
		const id = button.dataset.hookId;
		const hookSource = id ? this.sources?.find(source => source.hooks.some(hook => hook.id === id)) : undefined;
		const source = id ? hookSource : this.selectedConfiguration();
		this.actionPending = true;
		button.disabled = true;
		try {
			if (button.dataset.hookAction?.startsWith('ask-')) {
				if (!source) return;
				const hook = hookSource?.hooks.find(hook => hook.id === id);
				const trigger = hook?.event ?? (button.dataset.hookTrigger as HookEvent | undefined);
				const event = trigger ? eventName(trigger) : this.label('custom', 'custom');
				const prompt = source.namespace
					? this.label(
							'prompt',
							'Help me configure {0} Hooks in {1}. Inspect the existing TOML and preserve other settings. Use the source namespace ({2}) for Hook IDs. Explain the trigger, command and scope, then validate the configuration. My requirement: ',
							[event, source.configPath, source.namespace],
						)
					: this.label(
							'projectPrompt',
							'Help me configure {0} Hooks in {1}. Inspect the existing TOML and preserve other settings. Resolve the project directory namespace through App Server before choosing Hook IDs. Explain the trigger, command and scope, then validate the configuration. My requirement: ',
							[event, source.configPath],
						);
				this.chats.appendToActiveDraft(prompt);
				return;
			}
			const target = button.dataset.hookAction === 'edit-scope' && this.scope.value === 'user' ? { namespace: 'user', configPath: '' } : source;
			if (!target) {
				return;
			}
			await this.instantiation.invokeFunction(openHookConfiguration, target);
			if (!this.isDisposed && version === this.loadVersion && this.visible) {
				this.setStatus('opened', 'Configuration opened. Save it, then choose Refresh.');
			}
		} catch (error) {
			if (!isCancellationError(error) && !this.isDisposed && version === this.loadVersion && this.visible)
				this.setStatus('actionFailed', 'Could not configure Hooks: {0}', [error instanceof Error ? error.message : String(error)]);
		} finally {
			this.actionPending = false;
			if (!this.isDisposed) {
				button.disabled = false;
				this.updateActions();
			}
		}
	}

	public getAccessibleContent(): string {
		return [
			this.note.textContent,
			this.status.textContent,
			...[...this.eventRows]
				.filter(([, row]) => !row.domNode.hidden)
				.flatMap(([event, row]) => [
					row.summary.textContent,
					row.description.textContent,
					...(this.sources ?? []).flatMap(source =>
						source.hooks
							.filter(hook => hook.event === event && !this.hookRows.get(hook.id)?.domNode.hidden)
							.flatMap(hook => [hook.id, ...this.fields(source, hook).map(([label, value]) => `${label}: ${value}`)]),
					),
				]),
		].join('\n');
	}

	private setStatus(key: string, text: string, parameters?: readonly (string | number)[]): void {
		this.statusMessage = { key, text, parameters };
		this.status.textContent = this.label(key, text, parameters);
	}

	private label(key: string, fallback: string, parameters?: readonly (string | number)[]): string {
		return this.localization.translate(
			'ash.settings',
			`hooks.${key}`,
			fallback,
			parameters === undefined ? undefined : Object.fromEntries(parameters.map((value, index) => [String(index), value])),
		);
	}
}

function eventName(event: HookEvent): string {
	return event[0]!.toUpperCase() + event.slice(1);
}

const EventDescriptions: Record<HookEvent, string> = {
	preToolUse: localize2({ bundle: 'ash.settings', key: 'hooks.events.preToolUse' }, 'Before a tool executes.').original,
	postToolUse: localize2({ bundle: 'ash.settings', key: 'hooks.events.postToolUse' }, 'After a tool succeeds.').original,
	postToolUseFailure: localize2({ bundle: 'ash.settings', key: 'hooks.events.postToolUseFailure' }, 'After a tool fails.').original,
	postToolBatch: localize2({ bundle: 'ash.settings', key: 'hooks.events.postToolBatch' }, 'After a batch of tool calls.').original,
	permissionDenied: localize2({ bundle: 'ash.settings', key: 'hooks.events.permissionDenied' }, 'After tool permission is denied.').original,
	notification: localize2({ bundle: 'ash.settings', key: 'hooks.events.notification' }, 'When a notification reaches a client.').original,
	userPromptSubmit: localize2({ bundle: 'ash.settings', key: 'hooks.events.userPromptSubmit' }, 'When the user submits a prompt.').original,
	userPromptExpansion: localize2({ bundle: 'ash.settings', key: 'hooks.events.userPromptExpansion' }, 'When a slash command expands.').original,
	sessionStart: localize2({ bundle: 'ash.settings', key: 'hooks.events.sessionStart' }, 'When a session starts.').original,
	stop: localize2({ bundle: 'ash.settings', key: 'hooks.events.stop' }, 'After a turn completes.').original,
	stopFailure: localize2({ bundle: 'ash.settings', key: 'hooks.events.stopFailure' }, 'When a turn ends with an error.').original,
	subagentStart: localize2({ bundle: 'ash.settings', key: 'hooks.events.subagentStart' }, 'When a subagent starts.').original,
	subagentStop: localize2({ bundle: 'ash.settings', key: 'hooks.events.subagentStop' }, 'After a subagent produces its result.').original,
	preCompact: localize2({ bundle: 'ash.settings', key: 'hooks.events.preCompact' }, 'Before context compaction.').original,
	postCompact: localize2({ bundle: 'ash.settings', key: 'hooks.events.postCompact' }, 'After context compaction.').original,
	preModelSwitch: localize2({ bundle: 'ash.settings', key: 'hooks.events.preModelSwitch' }, 'Before a model switch is requested.').original,
	postModelSwitch: localize2({ bundle: 'ash.settings', key: 'hooks.events.postModelSwitch' }, 'After the session model changes.').original,
	sessionEnd: localize2({ bundle: 'ash.settings', key: 'hooks.events.sessionEnd' }, 'When a session ends.').original,
	permissionRequest: localize2({ bundle: 'ash.settings', key: 'hooks.events.permissionRequest' }, 'Before a permission request is shown.').original,
	setup: localize2({ bundle: 'ash.settings', key: 'hooks.events.setup' }, 'When project setup starts.').original,
	teammateIdle: localize2({ bundle: 'ash.settings', key: 'hooks.events.teammateIdle' }, 'When a teammate completes its assigned work.').original,
	taskCreated: localize2({ bundle: 'ash.settings', key: 'hooks.events.taskCreated' }, 'When a plan step is created.').original,
	taskCompleted: localize2({ bundle: 'ash.settings', key: 'hooks.events.taskCompleted' }, 'When a plan step completes.').original,
	elicitation: localize2({ bundle: 'ash.settings', key: 'hooks.events.elicitation' }, 'Before MCP requests user input.').original,
	elicitationResult: localize2({ bundle: 'ash.settings', key: 'hooks.events.elicitationResult' }, 'After the user answers MCP.').original,
	configChange: localize2({ bundle: 'ash.settings', key: 'hooks.events.configChange' }, 'When session configuration changes.').original,
	instructionsLoaded: localize2({ bundle: 'ash.settings', key: 'hooks.events.instructionsLoaded' }, 'When an instruction file is read.').original,
	worktreeCreate: localize2({ bundle: 'ash.settings', key: 'hooks.events.worktreeCreate' }, 'Before a worktree is created.').original,
	worktreeRemove: localize2({ bundle: 'ash.settings', key: 'hooks.events.worktreeRemove' }, 'Before a worktree is removed.').original,
	cwdChanged: localize2({ bundle: 'ash.settings', key: 'hooks.events.cwdChanged' }, 'After the active directory changes.').original,
	fileChanged: localize2({ bundle: 'ash.settings', key: 'hooks.events.fileChanged' }, 'When a watched file changes.').original,
	directoryAdded: localize2({ bundle: 'ash.settings', key: 'hooks.events.directoryAdded' }, 'After a directory is added to a session.').original,
	messageDisplay: localize2({ bundle: 'ash.settings', key: 'hooks.events.messageDisplay' }, 'When assistant text reaches a client.').original,
	beforeTool: localize2({ bundle: 'ash.settings', key: 'hooks.events.beforeTool' }, 'Legacy event before a tool executes.').original,
	afterTool: localize2({ bundle: 'ash.settings', key: 'hooks.events.afterTool' }, 'Legacy event after a tool succeeds or fails.').original,
	turnCompleted: localize2({ bundle: 'ash.settings', key: 'hooks.events.turnCompleted' }, 'Legacy event after a turn completes.').original,
};
