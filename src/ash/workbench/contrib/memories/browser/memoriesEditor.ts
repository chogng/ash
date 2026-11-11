import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IMemoriesService, type Memory, type MemoryConversationSource, type MemoryNamespace, type MemoryPolicy, type MemoryScopeEntry, type MemorySummary } from '../../../../platform/memories/common/memoriesService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { FileKind, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode, type IFileEntry } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { Button, type ButtonPresentation } from '../../../../base/browser/ui/button/button.js';
import { SelectBox, type SelectOption } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { defaultButtonStyles, defaultSelectBoxStyles, defaultToggleStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IMemorySettingsNavigation, MEMORIES_FOCUS_CONTEXT, type MemorySettingsNavigation } from './memorySettings.js';
import './memories.css';

export class MemoriesEditor extends Disposable {
	public readonly element: HTMLElement;
	private readonly context: SelectBox;
	private readonly scope: SelectBox;
	private readonly modelMemoryEnabled: Record<MemoryNamespace, Switch>;
	private modelMemoryLoaded = false;
	private readonly reading: Switch;
	private readonly saving: Switch;
	private readonly search: HTMLInputElement;
	private readonly list: HTMLUListElement;
	private readonly empty: HTMLElement;
	private readonly manage: Button;
	private readonly manager: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly detailHeading: HTMLElement;
	private readonly create: Button;
	private readonly titleInput: HTMLInputElement;
	private readonly body: HTMLTextAreaElement;
	private readonly reference: HTMLInputElement;
	private readonly status: HTMLDivElement;
	private readonly next: Button;
	private readonly save: Button;
	private readonly remove: Button;
	private readonly openSource: Button;
	private scopes: readonly MemoryScopeEntry[] = [];
	private entries: readonly MemorySummary[] = [];
	private policy: MemoryPolicy | undefined;
	private selected: Memory | undefined;
	private cursor: string | undefined;
	private generation = 0;
	private readGeneration = 0;
	private working = false;
	private operation: Promise<void> | undefined;
	private dirty = false;
	private showingReference = false;
	private referenceOrigin: MemoryConversationSource | undefined;
	private contextId = '';
	private mutationId = generateUuid();

	constructor(private readonly namespace: MemoryNamespace, container: HTMLElement, private readonly closeSettings: () => Promise<boolean | void>, private readonly revealEditor: (() => void | Promise<void>) | undefined,
		@IMemoriesService private readonly memories: IMemoriesService,
		@IChatSessionNavigationService private readonly sessions: IChatSessionNavigationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IMemorySettingsNavigation navigation: MemorySettingsNavigation,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environment: IWorkbenchEnvironmentService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, 'section');
		this.element.className = 'ash-memories';
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		const key = `memorySettings-${generateUuid()}`;
		const scope = this._register(contextKeys.createScoped(this.element));
		scope.createKey(key, true);
		scope.createKey(MEMORIES_FOCUS_CONTEXT, true);
		const save = async (): Promise<void> => {
			if (!this.manager.hidden && !this.detail.hidden && this.element.contains(document.activeElement)) {
				await this.perform(() => this.saveMemory());
			}
		};
		this._register(addDisposableListener(this.element, 'focusin', () => navigation.setFocusedSave(save)));
		this._register(addDisposableListener<FocusEvent>(this.element, 'focusout', event => {
			if (!this.element.contains(event.relatedTarget as Node | null)) { navigation.clearFocusedSave(save); }
		}));
		this._register(toDisposable(() => navigation.clearFocusedSave(save)));
		const verbosity = AccessibilityVerbositySettingId.Memories;
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, name: `${key}-${type}`, priority: 110, when: ContextKeyExpr.has(key),
				getProvider: () => {
					const focused = document.activeElement;
					if (!(focused instanceof HTMLElement) || !this.element.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Memories, { type },
						() => type === AccessibleViewType.Help
							? localize({ bundle: 'ash.settings', key: 'memory.help' }, 'Manage Instructions or AGENTS.md to create or open guidance files in the editor. Chats and Code have separate memory switches. Choose a conversation and scope to control reading and model saving for that scope. Choose Manage under Saved memories, then use Tab to move through memories and Enter to open one. <keybinding:ash.memories.save> saves memory changes. Closing the manager or Settings asks whether to discard unsaved memory changes. Escape closes this help and returns focus.')
							: [this.status.textContent, this.titleInput.value, this.body.value].filter(Boolean).join('\n'),
						() => { if (focused.isConnected) { focused.focus(); } }, verbosity);
				},
			}));
		}
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(verbosity);
			if (hint) { this.element.setAttribute('aria-description', hint); }
			else { this.element.removeAttribute('aria-description'); }
		};
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(verbosity)) { updateHint(); } }));
		updateHint();
		const intro = h(document, 'p');
		intro.className = 'ash-configuration-setting-description memories-intro';
		intro.textContent = localize({ bundle: 'ash.settings', key: 'memory.intro' }, 'Manage the instructions Ash follows and what it remembers.');
		this.element.append(intro);

		const instructions = h(document, 'div', { className: 'ash-settings-card' });
		this.element.append(instructions);
		this.addInstructionManager(instructions, 'instructions',
			localize({ bundle: 'ash.settings', key: 'memory.instructions' }, 'Instructions'),
			localize({ bundle: 'ash.settings', key: 'memory.instructionsDescription' }, 'Create or edit reusable instructions in your Ash profile and workspace.'));
		this.addInstructionManager(instructions, 'agents',
			'AGENTS.md',
			localize({ bundle: 'ash.settings', key: 'memory.agentsDescription' }, 'Create or edit the guidance Ash loads from your profile or workspace root.'));

		const permissions = h(document, 'div', { className: 'ash-settings-card' });
		this.modelMemoryEnabled = {
			chat: this.switchRow(permissions,
				localize({ bundle: 'ash.settings', key: 'memory.chatMemory' }, 'Chats memory'),
				localize({ bundle: 'ash.settings', key: 'memory.chatMemoryDescription' }, 'Allow Chats to use and save memories according to project permissions.')),
			code: this.switchRow(permissions,
				localize({ bundle: 'ash.settings', key: 'memory.codeMemory' }, 'Code memory'),
				localize({ bundle: 'ash.settings', key: 'memory.codeMemoryDescription' }, 'Allow Code to use and save memories according to scope permissions.')),
		};
		this.context = this.selectRow(permissions, localize({ bundle: 'ash.settings', key: 'memory.context' }, 'Conversation context'));
		this.scope = this.selectRow(permissions, localize('memories.scope', 'Memory scope'));
		this.reading = this.switchRow(permissions,
			localize({ bundle: 'ash.settings', key: 'memory.reading' }, 'Use saved memories'),
			localize({ bundle: 'ash.settings', key: 'memory.readingDescription' }, 'Let Ash use saved memories from this scope in conversations.'));
		this.saving = this.switchRow(permissions,
			localize({ bundle: 'ash.settings', key: 'memory.allowSaving' }, 'Let the model save memories'),
			localize({ bundle: 'ash.settings', key: 'memory.savingDescription' }, 'Allow the model to save information from conversations to this scope.'));
		this.element.append(permissions);

		const saved = h(document, 'section');
		saved.className = 'ash-settings-card';
		const overview = this.row(saved,
			localize({ bundle: 'ash.settings', key: 'memory.savedMemories' }, 'Saved memories'),
			localize({ bundle: 'ash.settings', key: 'memory.savedMemoriesDescription' }, 'See what Ash remembers in this scope and make changes.'));
		this.manage = this.button(overview, localize({ bundle: 'ash.settings', key: 'memory.manage' }, 'Manage'), async () => {
			if (this.manager.hidden) {
				this.showManager(true);
				return;
			}
			if (await this.discardDraft() && !this.isDisposed) {
				this.clearDetail();
				this.showManager(false);
			}
		});
		this.status = h(document, 'div');
		this.status.setAttribute('role', 'status');
		this.status.className = 'memories-status';

		const manager = this.manager = h(document, 'div');
		manager.className = 'memories-manager';
		manager.id = `memory-manager-${generateUuid()}`;
		this.manage.domNode.setAttribute('aria-controls', manager.id);
		this.manage.domNode.setAttribute('aria-label', localize({ bundle: 'ash.settings', key: 'memory.manageSaved' }, 'Manage saved memories'));
		this.showManager(false);
		saved.append(this.status, manager);
		this.element.append(saved);

		const toolbar = h(document, 'div');
		toolbar.className = 'memories-toolbar';
		manager.append(toolbar);
		this.search = this.input(toolbar, localize({ bundle: 'ash.settings', key: 'memory.search' }, 'Search memories'), 'search');
		const actions = h(document, 'div');
		actions.className = 'memories-actions';
		toolbar.append(actions);
		this.button(actions, localize({ bundle: 'ash.settings', key: 'memory.searchAction' }, 'Search'), () => this.loadList());
		this.create = this.button(actions, localize({ bundle: 'ash.settings', key: 'memory.new' }, 'New memory'), () => this.newMemory());
		this.button(actions, localize({ bundle: 'ash.settings', key: 'memory.refresh' }, 'Refresh'), () => this.refresh());
		const topics = h(document, 'h3');
		topics.className = 'memories-heading';
		topics.id = `memory-topics-${generateUuid()}`;
		topics.textContent = localize({ bundle: 'ash.settings', key: 'memory.topics' }, 'Topics');
		this.empty = h(document, 'p');
		this.empty.className = 'ash-configuration-setting-description memories-intro';
		this.list = h(document, 'ul');
		this.list.className = 'memories-topics';
		this.list.setAttribute('aria-labelledby', topics.id);
		manager.append(topics, this.empty, this.list);
		this.next = this.button(manager, localize({ bundle: 'ash.settings', key: 'memory.next' }, 'Next page'), () => this.loadList(this.cursor));

		const detail = this.detail = h(document, 'section');
		detail.className = 'memories-detail';
		detail.hidden = true;
		this.detailHeading = h(document, 'h3');
		this.detailHeading.className = 'memories-heading';
		this.detailHeading.id = `memory-detail-${generateUuid()}`;
		detail.setAttribute('aria-labelledby', this.detailHeading.id);
		detail.append(this.detailHeading);
		manager.append(detail);
		this.titleInput = this.input(detail, localize('memories.title', 'Memory title'));
		this.titleInput.maxLength = 256;
		this.body = h(document, 'textarea');
		this.body.rows = 6;
		this.field(detail, localize('memories.body', 'Memory content'), this.body);
		const detailActions = h(document, 'div');
		detailActions.className = 'memories-actions';
		detail.append(detailActions);
		this.save = this.button(detailActions, localize('memories.saveAction', 'Save memory'), () => this.saveMemory(), 'primary');
		this.remove = this.button(detailActions, localize({ bundle: 'ash.settings', key: 'memory.delete' }, 'Delete memory'), () => this.deleteMemory(), 'danger');
		this.openSource = this.button(detailActions, localize('memories.openSource', 'Open source conversation'), async () => {
			const origin = this.selected?.origin ?? this.referenceOrigin;
			if (!origin || !await this.discardDraft()) { return; }
			if (await this.closeSettings() === false) { return; }
			await this.sessions.openConversation(origin.sessionId, origin.threadId);
		});
		const utilities = h(document, 'div');
		utilities.className = 'memories-utilities';
		const reference = h(document, 'details');
		const referenceSummary = h(document, 'summary');
		referenceSummary.textContent = localize({ bundle: 'ash.settings', key: 'memory.referenceTools' }, 'Open a memory reference');
		const referenceForm = h(document, 'div');
		referenceForm.className = 'memories-toolbar';
		this.reference = this.input(referenceForm, localize({ bundle: 'ash.settings', key: 'memory.reference' }, 'Memory reference'));
		this.button(referenceForm, localize({ bundle: 'ash.settings', key: 'memory.openReference' }, 'Open reference'), () => this.readReference(this.reference.value));
		reference.append(referenceSummary, referenceForm);
		utilities.append(reference);
		this.element.append(utilities);
		this._register(new Button(utilities, {
			...defaultButtonStyles, presentation: 'secondary',
			label: localize({ bundle: 'ash.settings', key: 'memory.helpAction' }, 'Help'),
			onClick: () => { accessibleView.show(AccessibleViewType.Help); },
		}));
		this._register(this.context.onDidSelect(({ value }) => {
			void this.perform(async () => {
				if (!await this.discardDraft()) { this.context.value = this.contextId; return; }
				this.contextId = value;
				this.policy = undefined;
				this.clearDetail();
				await this.refresh();
			});
		}));
		this._register(this.scope.onDidSelect(() => { void this.perform(() => this.selectScope()); }));
		this._register(addDisposableListener(this.list, 'click', event => {
			const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-memory-id]');
			if (target) { void this.perform(() => this.selectMemory(target.dataset.memoryId)); }
		}));
		for (const namespace of ['chat', 'code'] as const) {
			const toggle = this.modelMemoryEnabled[namespace];
			this._register(toggle.onDidChange(() => {
				void this.perform(async () => {
					const enabled = toggle.checked;
					try {
						await this.memories.setModelMemoryEnabled(namespace, enabled);
					} catch (error) {
						toggle.checked = await this.memories.readModelMemoryEnabled().then(state => state[namespace], () => !enabled);
						throw error;
					}
				});
			}));
		}
		this._register(this.reading.onDidChange(() => { void this.perform(() => this.changePolicy()); }));
		this._register(this.saving.onDidChange(() => { void this.perform(() => this.changePolicy()); }));
		this._register(addDisposableListener(this.titleInput, 'input', () => { this.dirty = true; }));
		this._register(addDisposableListener(this.body, 'input', () => { this.dirty = true; }));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Enter' && event.target === this.search) { event.preventDefault(); void this.perform(() => this.loadList()); }
		}));
		this._register(memories.onDidChange(() => { if (this.working) { return; } this.status.textContent = localize('memories.changed', 'Memories changed. Refresh to load the latest version. Your draft is kept.'); }));
		this.refreshContexts();
		this.applyEnabled();
	}

	public initialize(): void {
		if (!this.policy) { void this.perform(() => this.refresh()); }
	}

	public hideSelects(): void {
		this.context.hide();
		this.scope.hide();
	}

	public async canClose(): Promise<boolean> {
		if (!this.dirty) { return true; }
		if (this.working) { return false; }
		let confirmed = false;
		await this.perform(async () => { confirmed = await this.discardDraft(); });
		return confirmed;
	}

	public async openReference(reference: string): Promise<void> {
		while (this.operation) { await this.operation; }
		await this.perform(() => this.readReference(reference));
	}

	private async readReference(reference: string): Promise<void> {
		if (!await this.discardDraft()) { return; }
		const result = await this.memories.readReference(reference, this.namespace);
		if (this.isDisposed) { return; }
		this.clearDetail();
		this.openDetail(localize({ bundle: 'ash.settings', key: 'memory.reference' }, 'Memory reference'));
		this.referenceOrigin = result.origin;
		this.showingReference = true;
		this.titleInput.value = result.title;
		this.body.value = result.body;
		this.status.textContent = localize('memories.reference', 'Exact reference, revision {0}.', result.revision);
		this.body.focus();
	}

	private refreshContexts(): void {
		const previous = this.context.value;
		const options = new Map<string, SelectOption>();
		options.set('', {
			value: '', label: this.namespace === 'code'
				? localize('memories.personalContext', 'Personal memories')
				: localize('memories.chooseChatConversation', 'Choose a project conversation')
		});
		for (const conversation of this.sessions.getConversations()) {
			if (conversation.kind !== this.namespace || options.has(conversation.threadId)) { continue; }
			options.set(conversation.threadId, { value: conversation.threadId, label: conversation.title });
		}
		this.context.setOptions([...options.values()]);
		const active = this.namespace === 'chat' ? this.sessions.getActiveConversation()?.threadId : undefined;
		const candidate = previous || active || '';
		this.context.value = this.contextId = options.has(candidate) ? candidate : '';
	}
	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const [availableScopes] = await Promise.all([
			this.namespace === 'chat' && !this.context.value ? [] : this.memories.scopes(this.context.value || undefined),
			this.refreshModelMemory(),
		]);
		if (this.isDisposed || generation !== this.generation) { return; }
		const scopes = this.namespace === 'chat'
			? availableScopes.filter(entry => entry.policy.scope.type === 'chatProject')
			: availableScopes.filter(entry => entry.policy.scope.type !== 'chatProject');
		const current = this.policy && JSON.stringify(this.policy.scope);
		const index = scopes.findIndex(entry => JSON.stringify(entry.policy.scope) === current);
		this.setScopes(scopes, scopes.length ? Math.max(index, 0) : -1);
		await this.loadList();
		const selected = this.selected;
		if (selected && !this.dirty && this.policy && !this.isDisposed) {
			const entry = this.entries.find(entry => entry.id === selected.id);
			if (entry && entry.revision !== selected.revision) {
				const memory = await this.memories.read(entry);
				if (!this.isDisposed) { this.showMemory(memory); }
			}
		}
	}
	private async refreshModelMemory(): Promise<void> {
		const enabled = await this.memories.readModelMemoryEnabled();
		if (this.isDisposed) { return; }
		this.modelMemoryLoaded = true;
		this.modelMemoryEnabled.chat.checked = enabled.chat;
		this.modelMemoryEnabled.code.checked = enabled.code;
	}
	private setScopes(scopes: readonly MemoryScopeEntry[], index: number): void {
		this.scopes = scopes;
		const options = scopes.map((entry, index) => ({ label: entry.label, value: String(index) }));
		if (index < 0) {
			options.unshift({ label: localize('memories.chooseProject', 'Choose a project'), value: '' });
		}
		this.scope.setOptions(options);
		this.scope.value = index < 0 ? '' : String(index);
		this.policy = scopes[index]?.policy;
		this.renderPolicy();
	}
	private async selectScope(): Promise<void> {
		const nextPolicy = this.scope.value ? this.scopes[Number(this.scope.value)]?.policy : undefined;
		if (!await this.discardDraft()) {
			const index = this.scopes.findIndex(entry => JSON.stringify(entry.policy.scope) === JSON.stringify(this.policy?.scope));
			this.scope.value = index < 0 ? '' : String(index);
			return;
		}
		this.policy = nextPolicy;
		this.renderPolicy();
		this.clearDetail();
		await this.loadList();
	}
	private renderPolicy(): void {
		this.reading.checked = this.policy?.reading === true;
		this.saving.checked = this.policy?.saving === true;
	}
	private async loadList(cursor?: string): Promise<void> {
		const generation = ++this.generation;
		const page = this.policy ? await this.memories.list(this.policy.scope, this.search.value, cursor) : undefined;
		if (this.isDisposed || generation !== this.generation) { return; }
		this.entries = page?.memories ?? [];
		this.cursor = page?.cursor;
		const document = this.element.ownerDocument;
		this.list.replaceChildren(...this.entries.map(entry => {
			const item = h(document, 'li');
			const button = h(document, 'button');
			button.type = 'button';
			button.dataset.memoryId = entry.id;
			button.textContent = entry.title;
			item.append(button);
			return item;
		}));
		this.updateCurrentTopic();
		this.empty.hidden = this.entries.length > 0;
		this.list.hidden = !this.empty.hidden;
		if (!page) {
			this.empty.textContent = localize({ bundle: 'ash.settings', key: 'memory.chooseScopeToManage' }, 'Choose a memory scope to see what Ash remembers.');
			return;
		}
		this.empty.textContent = this.search.value.trim()
			? localize({ bundle: 'ash.settings', key: 'memory.noMatches' }, 'No memories match your search.')
			: localize({ bundle: 'ash.settings', key: 'memory.empty' }, 'No saved memories in this scope yet.');
		if (this.manager.hidden) { return; }
		if (!this.empty.hidden) {
			this.status.textContent = this.empty.textContent;
			return;
		}
		this.status.textContent = this.entries.length === 1
			? localize({ bundle: 'ash.settings', key: 'memory.oneResult' }, '1 memory on this page.')
			: localize('memories.count', '{0} memories on this page.', this.entries.length);
	}
	private updateCurrentTopic(): void {
		for (const button of this.list.querySelectorAll('button')) {
			if (button.dataset.memoryId === this.selected?.id) {
				button.setAttribute('aria-current', 'true');
			} else {
				button.removeAttribute('aria-current');
			}
		}
	}
	private async selectMemory(id: string | undefined): Promise<void> {
		const entry = this.entries.find(entry => entry.id === id);
		if (!entry || !await this.discardDraft()) { return; }
		const generation = ++this.readGeneration;
		const memory = await this.memories.read(entry);
		if (this.isDisposed || generation !== this.readGeneration) { return; }
		this.showMemory(memory);
		this.titleInput.focus();
	}
	private showManager(visible: boolean): void {
		this.manager.hidden = !visible;
		this.manage.domNode.setAttribute('aria-expanded', String(visible));
	}
	private openDetail(title: string): void {
		this.showManager(true);
		this.detailHeading.textContent = title;
		this.detail.hidden = false;
	}
	private showMemory(memory: Memory): void {
		this.referenceOrigin = undefined;
		this.mutationId = generateUuid();
		this.selected = memory;
		this.showingReference = false;
		this.dirty = false;
		this.titleInput.readOnly = false;
		this.body.readOnly = false;
		this.titleInput.value = memory.title;
		this.body.value = memory.body;
		this.openDetail(localize({ bundle: 'ash.settings', key: 'memory.edit' }, 'Edit memory'));
		this.updateCurrentTopic();
		this.status.textContent = memory.source === 'model'
			? localize({ bundle: 'ash.settings', key: 'memory.modelSource' }, 'Saved by the model, revision {0}. Editing makes this a user-owned memory.', memory.revision)
			: localize({ bundle: 'ash.settings', key: 'memory.userSource' }, 'Saved by you, revision {0}.', memory.revision);
	}
	private async newMemory(): Promise<void> {
		if (!this.policy || !await this.discardDraft()) { return; }
		this.clearDetail();
		this.openDetail(localize({ bundle: 'ash.settings', key: 'memory.new' }, 'New memory'));
		this.titleInput.focus();
	}
	private clearDetail(): void {
		this.readGeneration++;
		this.mutationId = generateUuid();
		this.selected = undefined;
		this.referenceOrigin = undefined;
		this.showingReference = false;
		this.titleInput.value = '';
		this.body.value = '';
		this.titleInput.readOnly = false;
		this.body.readOnly = false;
		this.detail.hidden = true;
		this.status.textContent = '';
		this.updateCurrentTopic();
	}
	private async saveMemory(): Promise<void> {
		if (!this.policy || this.detail.hidden || this.showingReference) { return; }
		if (!this.titleInput.value.trim() || !this.body.value.trim() || new TextEncoder().encode(this.body.value).length > 16384) {
			throw new Error(localize({ bundle: 'ash.settings', key: 'memory.invalid' }, 'Enter a title and content of at most 16 KiB.'));
		}
		const result = this.selected
			? await this.memories.update(this.selected, this.titleInput.value, this.body.value, this.mutationId)
			: await this.memories.add(this.policy.scope, this.titleInput.value, this.body.value, this.mutationId);
		if (this.isDisposed) { return; }
		this.showMemory(result);
		await this.loadList();
		this.status.textContent = localize('memories.saved', 'Memory saved.');
	}
	private async deleteMemory(): Promise<void> {
		if (!this.selected || !(await this.dialogs.confirm({
			title: localize({ bundle: 'ash.settings', key: 'memory.delete' }, 'Delete memory'),
			message: localize({ bundle: 'ash.settings', key: 'memory.deletePrompt' }, 'Delete “{0}”?', this.selected.title),
			detail: localize({ bundle: 'ash.settings', key: 'memory.deleteDetail' }, 'This removes the saved memory and keeps the conversation history.'),
			primaryButton: localize({ bundle: 'ash.settings', key: 'memory.deleteAction' }, 'Delete'),
		})).confirmed) { return; }
		await this.memories.delete(this.selected, this.mutationId);
		if (this.isDisposed) { return; }
		this.dirty = false;
		this.clearDetail();
		await this.loadList();
		this.search.focus();
	}
	private async changePolicy(): Promise<void> {
		if (!this.policy) { return; }
		try { this.policy = await this.memories.setPolicy(this.policy, this.reading.checked, this.saving.checked); }
		finally { if (!this.isDisposed) { this.renderPolicy(); } }
	}
	private addInstructionManager(group: HTMLElement, kind: 'instructions' | 'agents', title: string, description: string): void {
		const document = this.element.ownerDocument;
		const row = this.row(group, title, description);
		const panel = h(document, 'div');
		panel.className = 'memories-manager';
		panel.id = `instruction-manager-${generateUuid()}`;
		panel.hidden = true;
		const actions = this._register(new DisposableStore());
		const manage = this.button(row, localize({ bundle: 'ash.settings', key: 'memory.manage' }, 'Manage'), async () => {
			if (panel.hidden) {
				const workspace = this.workspace.getWorkspace();
				const entries = await Promise.all(this.instructionScopes().map(async scope => {
					const directory = kind === 'agents' ? scope.root : URI.joinPath(scope.root, ...(scope.profile ? ['instructions'] : ['.ash', 'instructions']));
					return { scope, directory, files: await this.readInstructionFiles(kind, directory) };
				}));
				if (this.isDisposed || workspace !== this.workspace.getWorkspace()) { return; }
				panel.replaceChildren();
				actions.clear();
				if (!entries.length) {
					panel.textContent = localize({ bundle: 'ash.settings', key: 'memory.noInstructionScopes' }, 'Open a workspace folder to manage guidance files.');
				}
				for (const { scope, directory, files } of entries) {
					const heading = h(document, 'h3');
					heading.className = 'memories-heading';
					heading.textContent = scope.label;
					panel.append(heading);
					if (!files) {
						const message = h(document, 'p');
						message.className = 'ash-configuration-setting-description memories-intro';
						message.textContent = localize({ bundle: 'ash.settings', key: 'memory.instructionFilesUnavailable' }, 'This folder could not be read.');
						panel.append(message);
						continue;
					}
					const controls = h(document, 'div');
					controls.className = 'memories-actions';
					panel.append(controls);
					for (const { name, resource } of files) {
						const open = this.button(controls, name, () => this.openInstructionFile(resource), 'secondary', actions);
						open.domNode.setAttribute('aria-label', localize({ bundle: 'ash.settings', key: 'memory.openScopedInstruction' }, 'Open {0} in {1}', name, scope.label));
					}
					if (kind === 'instructions' || files.length === 0) {
						const label = kind === 'agents'
							? localize({ bundle: 'ash.settings', key: 'memory.createAgents' }, 'Create AGENTS.md')
							: localize({ bundle: 'ash.settings', key: 'memory.createInstruction' }, 'New instruction');
						const create = this.button(controls, label, () => this.createInstructionFile(kind, label, scope.root, directory), 'secondary', actions);
						create.domNode.setAttribute('aria-label', localize({ bundle: 'ash.settings', key: 'memory.createScopedInstruction' }, '{0} in {1}', label, scope.label));
					}
				}
			}
			panel.hidden = !panel.hidden;
			manage.domNode.setAttribute('aria-expanded', String(!panel.hidden));
		});
		manage.domNode.setAttribute('aria-label', kind === 'agents'
			? localize({ bundle: 'ash.settings', key: 'memory.manageAgents' }, 'Manage AGENTS.md')
			: localize({ bundle: 'ash.settings', key: 'memory.manageInstructions' }, 'Manage Instructions'));
		manage.domNode.setAttribute('aria-controls', panel.id);
		manage.domNode.setAttribute('aria-expanded', 'false');
		this._register(this.workspace.onDidChangeWorkspaceFolders(() => {
			panel.hidden = true;
			manage.domNode.setAttribute('aria-expanded', 'false');
		}));
		group.append(panel);
	}

	private async readInstructionFiles(kind: 'instructions' | 'agents', directory: URI): Promise<readonly Pick<IFileEntry, 'name' | 'resource'>[] | undefined> {
		try {
			if (kind === 'agents') {
				const resource = URI.joinPath(directory, 'AGENTS.md');
				const stat = await this.files.stat(resource);
				return stat.kind === FileKind.File ? [{ name: 'AGENTS.md', resource }] : undefined;
			}
			const files = await this.files.readDirectory(directory);
			return files.filter(file => file.kind === FileKind.File && file.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			return error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound ? [] : undefined;
		}
	}

	private async createInstructionFile(kind: 'instructions' | 'agents', label: string, root: URI, directory: URI): Promise<void> {
		let name = 'AGENTS.md';
		if (kind === 'instructions') {
			const result = await this.dialogs.input({
				title: label,
				message: localize({ bundle: 'ash.settings', key: 'memory.instructionName' }, 'Enter a name using lowercase letters, numbers, and hyphens.'),
				inputs: [{ placeholder: 'writing-style' }],
				primaryButton: localize({ bundle: 'ash.settings', key: 'memory.createFile' }, 'Create'),
			});
			if (!result.confirmed) { return; }
			const value = result.values?.[0]?.trim() ?? '';
			if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
				throw new Error(localize({ bundle: 'ash.settings', key: 'memory.invalidInstructionName' }, 'Enter 1 to 64 lowercase letters, numbers, or hyphens. Start and end with a letter or number.'));
			}
			name = `${value}.md`;
		}
		if (!await this.discardDraft() || this.isDisposed
			|| !this.instructionScopes().some(scope => scope.root.toString() === root.toString())) { return; }
		if (kind === 'instructions') { await this.files.createDirectory(directory); }
		const resource = URI.joinPath(directory, name);
		const starter = kind === 'instructions' ? '---\nload: global\n---\n\n' : '';
		await this.files.writeFileBytes(resource, new TextEncoder().encode(starter), { create: true, overwrite: false });
		await this.openInstructionFile(resource);
	}

	private instructionScopes(): readonly { readonly label: string; readonly root: URI; readonly profile: boolean; }[] {
		const scopes = this.workspace.getWorkspace().folders.map(folder => ({ label: folder.name, root: folder.uri, profile: false }));
		if (this.environment.userRoamingDataHome) {
			scopes.unshift({ label: localize({ bundle: 'ash.settings', key: 'memory.instructionProfile' }, 'Ash profile'), root: URI.from({ scheme: Schemas.vscodeUserData, path: '/user' }), profile: true });
		}
		return scopes.filter(scope => this.files.hasProvider(scope.root));
	}

	private async openInstructionFile(resource: URI): Promise<void> {
		if (!await this.discardDraft() || this.isDisposed || await this.closeSettings() === false) { return; }
		try {
			await this.editors.openEditor({ resource }, { pinned: true });
			await this.revealEditor?.();
		} catch (error) {
			this.notifications.error(localize({ bundle: 'ash.settings', key: 'memory.openInstructionFailed' }, 'Could not open {0}: {1}', resource.path, String(error)));
		}
	}
	private async discardDraft(): Promise<boolean> {
		if (!this.dirty) { return true; }
		const discard = await this.dialogs.confirm({
			message: localize({ bundle: 'ash.settings', key: 'memory.discardPrompt' }, 'Discard unsaved memory changes?'),
			primaryButton: localize({ bundle: 'ash.settings', key: 'memory.discardAction' }, 'Discard changes'),
		});
		if (discard.confirmed) { this.dirty = false; }
		return discard.confirmed;
	}
	private perform(operation: () => Promise<void>): Promise<void> {
		if (this.working || this.isDisposed) { return Promise.resolve(); }
		this.operation = this.runOperation(operation).finally(() => { this.operation = undefined; });
		return this.operation;
	}
	private async runOperation(operation: () => Promise<void>): Promise<void> {
		const document = this.element.ownerDocument;
		const previousFocus = document.activeElement;
		this.working = true;
		this.applyEnabled();
		this.element.setAttribute('aria-busy', 'true');
		try {
			await operation();
		} catch (error) {
			if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); }
		} finally {
			this.working = false;
			this.element.removeAttribute('aria-busy');
			if (!this.isDisposed) {
				this.applyEnabled();
				if (document.activeElement === document.body && previousFocus instanceof HTMLElement
					&& this.element.contains(previousFocus)) {
					previousFocus.focus();
				}
			}
		}
	}
	private applyEnabled(): void {
		for (const control of this.element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')) {
			if (control === this.reading.input || control === this.saving.input
				|| control === this.modelMemoryEnabled.chat.input || control === this.modelMemoryEnabled.code.input
				|| this.context.element.contains(control) || this.scope.element.contains(control)) { continue; }
			if (control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement) {
				control.disabled = false;
				control.readOnly = this.working || (this.showingReference && (control === this.body || control === this.titleInput));
			} else { control.disabled = this.working; }
		}
		this.save.enabled = !(this.working || !this.policy || this.showingReference);
		this.remove.enabled = !(this.working || !this.selected || this.showingReference);
		this.next.enabled = !(this.working || !this.cursor);
		this.next.domNode.hidden = !this.cursor;
		this.context.enabled = !this.working;
		this.scope.enabled = !this.working && this.scopes.length > 0;
		this.create.enabled = !(this.working || !this.policy);
		this.modelMemoryEnabled.chat.enabled = this.modelMemoryEnabled.code.enabled = this.modelMemoryLoaded && !this.working;
		this.reading.enabled = !(this.working || !this.policy);
		this.saving.enabled = !(this.working || !this.policy);
		this.openSource.enabled = !this.working;
		this.openSource.domNode.hidden = !(this.selected?.origin ?? this.referenceOrigin);
	}
	private field(container: HTMLElement, text: string, control: HTMLElement): void {
		const label = h(this.element.ownerDocument, 'label');
		const caption = h(this.element.ownerDocument, 'span');
		caption.id = `memory-field-${generateUuid()}`;
		caption.textContent = text;
		control.setAttribute('aria-labelledby', caption.id);
		label.append(caption, control);
		label.className = 'memories-field';
		container.append(label);
	}
	private input(container: HTMLElement, label: string, type = 'text'): HTMLInputElement {
		const input = h(this.element.ownerDocument, 'input');
		input.type = type;
		this.field(container, label, input);
		return input;
	}
	private row(container: HTMLElement, title: string, description?: string): HTMLElement {
		const document = container.ownerDocument;
		const row = h(document, 'div', { className: 'ash-settings-field-row' });
		const copy = h(document, 'div', { className: 'ash-settings-field-copy ash-configuration-setting-copy' });
		copy.append(h(document, 'div', { className: 'ash-configuration-setting-title' }, title));
		if (description) { copy.append(h(document, 'p', { className: 'ash-configuration-setting-description' }, description)); }
		row.append(copy);
		container.append(row);
		return row;
	}
	private switchRow(container: HTMLElement, title: string, description: string): Switch {
		const row = this.row(container, title, description);
		const toggle = this._register(new Switch(row, { ...defaultToggleStyles, ariaLabel: title, disabled: true }));
		const hint = row.querySelector('.ash-configuration-setting-description')!;
		hint.id = `memory-description-${generateUuid()}`;
		toggle.input.setAttribute('aria-describedby', hint.id);
		return toggle;
	}
	private selectRow(container: HTMLElement, title: string): SelectBox {
		return this._register(new SelectBox(this.row(container, title), {
			options: [], ariaLabel: title, contextViewProvider: this.contextView, presentation: 'field',
		}, defaultSelectBoxStyles));
	}
	private button(container: HTMLElement, label: string, action: () => Promise<void>, presentation: ButtonPresentation = 'secondary', store?: DisposableStore): Button {
		const button = new Button(container, {
			...defaultButtonStyles, label, presentation,
			onClick: () => { void this.perform(action); },
		});
		return store ? store.add(button) : this._register(button);
	}
}
