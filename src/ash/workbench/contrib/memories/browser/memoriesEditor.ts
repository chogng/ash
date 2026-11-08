import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IMemoriesService, type Memory, type MemoryConversationSource, type MemoryNamespace, type MemoryPolicy, type MemoryScopeEntry, type MemorySummary, type MemoryTurnSource } from '../../../../platform/memories/common/memoriesService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IMemorySettingsNavigation, MEMORIES_FOCUS_CONTEXT, type MemorySettingsNavigation } from './memorySettings.js';
import './memories.css';

export class MemoriesEditor extends Disposable {
	public readonly element: HTMLElement;
	private readonly context: HTMLSelectElement;
	private readonly scope: HTMLSelectElement;
	private readonly modelMemoryEnabled: HTMLInputElement | undefined;
	private readonly reading: HTMLInputElement;
	private readonly saving: HTMLInputElement;
	private readonly search: HTMLInputElement;
	private readonly list: HTMLSelectElement;
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
	private draftOrigin: MemoryTurnSource | undefined;
	private contextId = '';
	private mutationId = generateUuid();

	constructor(private readonly namespace: MemoryNamespace, container: HTMLElement, closeSettings: () => Promise<boolean | void>,
		@IMemoriesService private readonly memories: IMemoriesService,
		@IChatSessionNavigationService private readonly sessions: IChatSessionNavigationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IMemorySettingsNavigation navigation: MemorySettingsNavigation,
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
			if (this.element.contains(document.activeElement)) { await this.perform(() => this.saveMemory()); }
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
							? localize({ bundle: 'ash.settings', key: 'memory.help' }, 'Choose a conversation and memory scope. Use Tab to move between controls and arrow keys to browse saved memories. <keybinding:ash.memories.save> saves a memory. Closing the Settings dialog with unsaved memory changes asks whether to discard them. Reading and model saving are separate permissions. Escape closes this help and returns focus.')
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
		const options = h(document, 'div');
		options.className = 'memories-options';
		this.element.append(options);
		this.context = h(document, 'select');
		this.field(options, localize({ bundle: 'ash.settings', key: 'memory.context' }, 'Conversation context'), this.context);
		this.scope = h(document, 'select');
		this.field(options, localize('memories.scope', 'Memory scope'), this.scope);
		this.modelMemoryEnabled = namespace === 'code' ? this.input(options, localize('memories.modelMemoryEnabled', 'Enable Code model memory'), 'checkbox') : undefined;
		this.reading = this.input(options, localize('memories.allowReading', 'Allow memory reading'), 'checkbox');
		this.saving = this.input(options, localize({ bundle: 'ash.settings', key: 'memory.allowSaving' }, 'Allow model saving'), 'checkbox');
		this.status = h(document, 'div');
		this.status.setAttribute('role', 'status');
		this.status.className = 'memories-status';
		this.element.append(this.status);
		const columns = h(document, 'div');
		columns.className = 'memories-columns';
		const records = h(document, 'div');
		const detail = h(document, 'div');
		columns.append(records, detail);
		this.element.append(columns);

		this.search = this.input(records, localize({ bundle: 'ash.settings', key: 'memory.search' }, 'Search memories'), 'search');
		const toolbar = h(document, 'div');
		toolbar.className = 'memories-actions';
		records.append(toolbar);
		this.button(toolbar, localize({ bundle: 'ash.settings', key: 'memory.searchAction' }, 'Search'), () => this.loadList());
		this.button(toolbar, localize({ bundle: 'ash.settings', key: 'memory.new' }, 'New memory'), () => this.newMemory());
		this.button(toolbar, localize({ bundle: 'ash.settings', key: 'memory.refresh' }, 'Refresh'), () => this.refresh());
		this.list = h(document, 'select');
		this.list.size = 6;
		this.field(records, localize({ bundle: 'ash.settings', key: 'memory.savedMemories' }, 'Saved memories'), this.list);
		this.next = this.button(records, localize({ bundle: 'ash.settings', key: 'memory.next' }, 'Next page'), () => this.loadList(this.cursor));
		this.titleInput = this.input(detail, localize('memories.title', 'Memory title'));
		this.titleInput.maxLength = 256;
		this.body = h(document, 'textarea');
		this.body.rows = 8;
		this.field(detail, localize('memories.body', 'Memory content'), this.body);
		const actions = h(document, 'div');
		actions.className = 'memories-actions';
		detail.append(actions);
		this.save = this.button(actions, localize('memories.saveAction', 'Save memory'), () => this.saveMemory());
		this.remove = this.button(actions, localize({ bundle: 'ash.settings', key: 'memory.delete' }, 'Delete memory'), () => this.deleteMemory());
		this.openSource = this.button(actions, localize('memories.openSource', 'Open source conversation'), async () => {
			const origin = this.selected?.origin ?? this.referenceOrigin ?? this.draftOrigin;
			if (!origin || !await this.discardDraft()) { return; }
			if (await closeSettings() === false) { return; }
			await this.sessions.openConversation(origin.sessionId, origin.threadId);
		});
		this.reference = this.input(detail, localize({ bundle: 'ash.settings', key: 'memory.reference' }, 'Memory reference'));
		this.button(detail, localize({ bundle: 'ash.settings', key: 'memory.openReference' }, 'Open reference'), () => this.readReference(this.reference.value));
		this._register(new Button(detail, {
			...defaultButtonStyles, presentation: 'secondary',
			label: localize({ bundle: 'ash.settings', key: 'memory.helpAction' }, 'Help'),
			onClick: () => { accessibleView.show(AccessibleViewType.Help); },
		}));
		this._register(addDisposableListener(this.context, 'change', () => { void this.perform(async () => { if (!await this.discardDraft()) { this.context.value = this.contextId; return; } this.contextId = this.context.value; this.policy = undefined; await this.newMemory(); await this.refresh(); }); }));
		this._register(addDisposableListener(this.scope, 'change', () => { void this.perform(() => this.selectScope()); }));
		this._register(addDisposableListener(this.list, 'change', () => { void this.perform(() => this.selectMemory()); }));
		const modelMemoryEnabled = this.modelMemoryEnabled;
		if (modelMemoryEnabled) {
			this._register(addDisposableListener(modelMemoryEnabled, 'change', () => {
				void this.perform(async () => {
					const enabled = modelMemoryEnabled.checked;
					try {
						await this.memories.setModelMemoryEnabled(enabled);
					} catch (error) {
						modelMemoryEnabled.checked = await this.memories.readModelMemoryEnabled().catch(() => !enabled);
						throw error;
					}
				});
			}));
		}
		this._register(addDisposableListener(this.reading, 'change', () => { void this.perform(() => this.changePolicy()); }));
		this._register(addDisposableListener(this.saving, 'change', () => { void this.perform(() => this.changePolicy()); }));
		this._register(addDisposableListener(this.titleInput, 'input', () => { this.dirty = true; }));
		this._register(addDisposableListener(this.body, 'input', () => { this.dirty = true; }));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Enter' && event.target === this.search) { event.preventDefault(); void this.perform(() => this.loadList()); }
		}));
		this._register(memories.onDidChange(() => { if (this.working) { return; } this.status.textContent = localize('memories.changed', 'Memories changed. Refresh to load the latest version; your draft is kept.'); }));
		this.refreshContexts();
		this.applyEnabled();
	}

	public initialize(): void {
		if (!this.policy) { void this.perform(() => this.refresh()); }
	}

	public async canClose(): Promise<boolean> {
		if (!this.dirty) { return true; }
		if (this.working) { return false; }
		let confirmed = false;
		await this.perform(async () => { confirmed = await this.discardDraft(); });
		return confirmed;
	}

	public async openProjectDraft(origin: MemoryTurnSource, text: string): Promise<void> {
		while (this.operation) { await this.operation; }
		await this.perform(async () => {
			const scopes = await this.memories.scopes(origin.threadId);
			const projects = scopes.filter(entry => this.isProjectScope(entry.policy.scope));
			if (!projects.length) {
				this.status.textContent = localize('memories.projectRequired', 'This conversation needs to belong to a project before you can save a project memory.');
				return;
			}
			if (!await this.discardDraft() || this.isDisposed) { return; }
			this.refreshContexts();
			if (!Array.from(this.context.options).some(option => option.value === origin.threadId)) {
				this.context.append(this.option(localize('memories.sourceConversation', 'Source conversation'), origin.threadId));
			}
			this.context.value = this.contextId = origin.threadId;
			this.setScopes(projects, projects.length === 1 ? 0 : -1);
			await this.newMemory();
			this.draftOrigin = origin;
			this.body.value = text;
			this.dirty = true;
			await this.loadList();
			this.status.textContent = localize('memories.projectDraft', 'Confirm the project, enter a title, and review the text before saving.');
		});
	}

	public async openReference(reference: string): Promise<void> {
		while (this.operation) { await this.operation; }
		await this.perform(() => this.readReference(reference));
	}

	private async readReference(reference: string): Promise<void> {
		if (!await this.discardDraft()) { return; }
		const result = await this.memories.readReference(reference, this.namespace);
		if (this.isDisposed) { return; }
		this.selected = undefined;
		this.draftOrigin = undefined;
		this.referenceOrigin = result.origin;
		this.showingReference = true;
		this.titleInput.value = result.title;
		this.body.value = result.body;
		this.status.textContent = localize('memories.reference', 'Exact reference, revision {0}.', result.revision);
		this.body.focus();
	}

	private refreshContexts(): void {
		const document = this.element.ownerDocument;
		const previous = this.context.value;
		this.context.replaceChildren(this.option(this.namespace === 'code'
			? localize('memories.personalContext', 'Personal memories')
			: localize('memories.chooseChatConversation', 'Choose a project conversation'), ''));
		for (const conversation of this.sessions.getConversations()) {
			if (conversation.kind !== this.namespace) { continue; }
			const option = h(document, 'option');
			option.value = conversation.threadId;
			option.textContent = conversation.title;
			this.context.append(option);
		}
		const active = this.namespace === 'chat' ? this.sessions.getActiveConversation()?.threadId : undefined;
		const candidate = previous || active || '';
		this.context.value = this.contextId = Array.from(this.context.options).some(option => option.value === candidate)
			? candidate : '';
	}
	private isProjectScope(scope: MemoryPolicy['scope']): boolean {
		return scope.type === (this.namespace === 'chat' ? 'chatProject' : 'project');
	}
	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const [availableScopes, enabled] = await Promise.all([
			this.namespace === 'chat' && !this.context.value ? [] : this.memories.scopes(this.context.value || undefined),
			this.modelMemoryEnabled ? this.memories.readModelMemoryEnabled() : false,
		]);
		if (this.isDisposed || generation !== this.generation) { return; }
		if (this.modelMemoryEnabled) { this.modelMemoryEnabled.checked = enabled; }
		const scopes = this.draftOrigin || this.namespace === 'chat'
			? availableScopes.filter(entry => this.isProjectScope(entry.policy.scope))
			: availableScopes.filter(entry => entry.policy.scope.type !== 'chatProject');
		const current = this.policy && JSON.stringify(this.policy.scope);
		const index = scopes.findIndex(entry => JSON.stringify(entry.policy.scope) === current);
		this.setScopes(scopes, !scopes.length || this.draftOrigin ? index : Math.max(index, 0));
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
	private setScopes(scopes: readonly MemoryScopeEntry[], index: number): void {
		this.scopes = scopes;
		this.scope.replaceChildren(...scopes.map((entry, index) => this.option(entry.label, String(index))));
		if (index < 0) {
			this.scope.prepend(this.option(localize('memories.chooseProject', 'Choose a project'), ''));
		}
		this.scope.value = index < 0 ? '' : String(index);
		this.policy = scopes[index]?.policy;
		this.renderPolicy();
	}
	private async selectScope(): Promise<void> {
		const nextPolicy = this.scope.value ? this.scopes[Number(this.scope.value)]?.policy : undefined;
		if (this.draftOrigin && (!nextPolicy || this.isProjectScope(nextPolicy.scope))) {
			this.policy = nextPolicy;
			this.mutationId = generateUuid();
			this.renderPolicy();
			await this.loadList();
			return;
		}
		if (!await this.discardDraft()) { this.scope.value = String(this.scopes.findIndex(entry => JSON.stringify(entry.policy.scope) === JSON.stringify(this.policy?.scope))); return; }
		this.policy = nextPolicy;
		this.renderPolicy();
		await this.newMemory();
		await this.loadList();
	}
	private renderPolicy(): void {
		this.reading.checked = this.policy?.reading === true;
		this.saving.checked = this.policy?.saving === true;
		this.reading.disabled = !this.policy;
		this.saving.disabled = !this.policy;
	}
	private async loadList(cursor?: string): Promise<void> {
		if (!this.policy) { return; }
		const generation = ++this.generation;
		const page = await this.memories.list(this.policy.scope, this.search.value, cursor);
		if (this.isDisposed || generation !== this.generation) { return; }
		this.entries = page.memories;
		this.cursor = page.cursor;
		this.next.enabled = !(!page.cursor);
		this.list.replaceChildren(...page.memories.map(entry => this.option(entry.title, entry.id)));
		this.list.value = this.selected?.id ?? '';
		this.status.textContent = page.memories.length === 1
			? localize({ bundle: 'ash.settings', key: 'memory.oneResult' }, '1 memory on this page.')
			: localize('memories.count', '{0} memories on this page.', page.memories.length);
	}
	private async selectMemory(): Promise<void> {
		const entry = this.entries.find(entry => entry.id === this.list.value);
		if (!entry || !await this.discardDraft()) { this.list.value = this.selected?.id ?? ''; return; }
		const generation = ++this.readGeneration;
		const memory = await this.memories.read(entry);
		if (this.isDisposed || generation !== this.readGeneration) { return; }
		this.showMemory(memory);
	}
	private showMemory(memory: Memory): void {
		this.draftOrigin = undefined;
		this.referenceOrigin = undefined;
		this.mutationId = generateUuid();
		this.selected = memory;
		this.showingReference = false;
		this.dirty = false;
		this.titleInput.readOnly = false;
		this.body.readOnly = false;
		this.titleInput.value = memory.title;
		this.body.value = memory.body;
		this.save.enabled = true;
		this.remove.enabled = true;
		this.status.textContent = localize('memories.source', 'Saved by {0}, revision {1}. Editing makes this a user-owned memory.', memory.source, memory.revision);
	}
	private async newMemory(): Promise<void> {
		if (!await this.discardDraft()) { return; }
		this.readGeneration++;
		this.mutationId = generateUuid();
		this.selected = undefined;
		this.draftOrigin = undefined;
		this.referenceOrigin = undefined;
		this.showingReference = false;
		this.titleInput.value = '';
		this.body.value = '';
		this.titleInput.readOnly = false;
		this.body.readOnly = false;
		this.save.enabled = !(!this.policy);
		this.remove.enabled = false;
		this.list.value = '';
		this.titleInput.focus();
	}
	private async saveMemory(): Promise<void> {
		if (!this.policy || this.showingReference) { return; }
		if (!this.titleInput.value.trim() || !this.body.value.trim() || new TextEncoder().encode(this.body.value).length > 16384) {
			throw new Error('Enter a title and content of at most 16 KiB.');
		}
		const result = this.selected
			? await this.memories.update(this.selected, this.titleInput.value, this.body.value, this.mutationId)
			: await this.memories.add(this.policy.scope, this.titleInput.value, this.body.value, this.mutationId, this.draftOrigin);
		if (this.isDisposed) { return; }
		this.showMemory(result);
		await this.loadList();
		this.status.textContent = localize('memories.saved', 'Memory saved.');
	}
	private async deleteMemory(): Promise<void> {
		if (!this.selected || !(await this.dialogs.confirm({ title: 'Delete memory', message: `Delete “${this.selected.title}”?`, detail: 'This removes the saved memory. Existing conversation history is retained.', primaryButton: 'Delete' })).confirmed) { return; }
		await this.memories.delete(this.selected, this.mutationId);
		this.dirty = false;
		await this.newMemory();
		await this.loadList();
	}
	private async changePolicy(): Promise<void> {
		if (!this.policy) { return; }
		try { this.policy = await this.memories.setPolicy(this.policy, this.reading.checked, this.saving.checked); }
		finally { if (!this.isDisposed) { this.renderPolicy(); } }
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
		for (const control of this.element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>('input, textarea, button, select')) {
			if (control instanceof HTMLTextAreaElement || (control instanceof HTMLInputElement && control.type !== 'checkbox')) {
				control.disabled = false;
				control.readOnly = this.working || (this.showingReference && (control === this.body || control === this.titleInput));
			} else { control.disabled = this.working; }
		}
		this.save.enabled = !(this.working || !this.policy || this.showingReference);
		this.remove.enabled = !(this.working || !this.selected || this.showingReference);
		this.next.enabled = !(this.working || !this.cursor);
		this.reading.disabled = this.working || !this.policy;
		this.saving.disabled = this.working || !this.policy;
		this.openSource.enabled = !this.working;
		this.openSource.domNode.hidden = !(this.selected?.origin ?? this.referenceOrigin ?? this.draftOrigin);
	}
	private option(label: string, value: string): HTMLOptionElement {
		const option = h(this.element.ownerDocument, 'option'); option.textContent = label; option.value = value; return option;
	}
	private field(container: HTMLElement, text: string, control: HTMLElement): void {
		const label = h(this.element.ownerDocument, 'label');
		const caption = h(this.element.ownerDocument, 'span');
		caption.id = `memory-field-${generateUuid()}`;
		caption.textContent = text;
		control.setAttribute('aria-labelledby', caption.id);
		label.append(caption, control);
		if (control instanceof HTMLInputElement && control.type === 'checkbox') { label.className = 'memories-permission'; }
		container.append(label);
	}
	private input(container: HTMLElement, label: string, type = 'text'): HTMLInputElement {
		const input = h(this.element.ownerDocument, 'input');
		input.type = type;
		this.field(container, label, input);
		return input;
	}
	private button(container: HTMLElement, label: string, action: () => Promise<void>): Button {
		return this._register(new Button(container, {
			...defaultButtonStyles, label, presentation: 'secondary',
			onClick: () => { void this.perform(action); },
		}));
	}
}
