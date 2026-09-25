import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IMemoriesService, type Memory, type MemoryPolicy, type MemoryScopeEntry, type MemorySummary } from '../../../../platform/memories/common/memoriesService.js';
import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import './memories.css';

export class MemoriesViewPane extends ViewPane {
	public static readonly FocusContext = 'memoriesFocus';
	private readonly context: HTMLSelectElement;
	private readonly scope: HTMLSelectElement;
	private readonly reading: HTMLInputElement;
	private readonly saving: HTMLInputElement;
	private readonly search: HTMLInputElement;
	private readonly list: HTMLSelectElement;
	private readonly titleInput: HTMLInputElement;
	private readonly body: HTMLTextAreaElement;
	private readonly reference: HTMLInputElement;
	private readonly status: HTMLDivElement;
	private readonly next: HTMLButtonElement;
	private readonly save: HTMLButtonElement;
	private readonly remove: HTMLButtonElement;
	private scopes: readonly MemoryScopeEntry[] = [];
	private entries: readonly MemorySummary[] = [];
	private policy: MemoryPolicy | undefined;
	private selected: Memory | undefined;
	private cursor: string | undefined;
	private generation = 0;
	private readGeneration = 0;
	private working = false;
	private dirty = false;
	private showingReference = false;
	private contextId = '';
	private mutationId = generateUuid();

	constructor(container: HTMLElement, options: IViewPaneOptions,
		private readonly memories: IMemoriesService,
		private readonly sessions: IChatSessionNavigationService,
		private readonly dialogs: IDialogService,
		private readonly configuration: IConfigurationService,
		contextKeys: IContextKeyService,
	) {
		super(container, options);
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-memories');
		const focus = contextKeys.createKey<boolean>(MemoriesViewPane.FocusContext, false);
		this._register(toDisposable(() => focus.reset()));
		this._register(addDisposableListener(this.contentElement, 'focusin', () => focus.set(true)));
		this._register(addDisposableListener<FocusEvent>(this.contentElement, 'focusout', event => { if (!this.contentElement.contains(event.relatedTarget as Node | null)) { focus.reset(); } }));
		this.context = h(document, 'select');
		this.field('Conversation context', this.context);
		this.scope = h(document, 'select');
		this.field('Memory scope', this.scope);
		this.reading = this.input('Allow memory reading', 'checkbox');
		this.saving = this.input('Allow model saving', 'checkbox');
		this.search = this.input('Search memories', 'search');
		const toolbar = h(document, 'div');
		toolbar.className = 'memories-actions';
		toolbar.append(this.button('Search', () => this.loadList()), this.button('New memory', () => this.newMemory()), this.button('Refresh', () => this.refresh()));
		this.next = this.button('Next page', () => this.loadList(this.cursor));
		toolbar.append(this.next, this.button('Help', () => this.showHelp()));
		this.contentElement.append(toolbar);
		this.status = h(document, 'div');
		this.status.setAttribute('role', 'status');
		this.status.className = 'memories-status';
		this.contentElement.append(this.status);
		this.list = h(document, 'select');
		this.list.size = 6;
		this.field('Saved memories', this.list);
		this.titleInput = this.input('Memory title');
		this.titleInput.maxLength = 256;
		this.body = h(document, 'textarea');
		this.body.rows = 8;
		this.field('Memory content', this.body);
		const actions = h(document, 'div');
		actions.className = 'memories-actions';
		this.save = this.button('Save memory', () => this.saveMemory());
		this.remove = this.button('Delete memory', () => this.deleteMemory());
		actions.append(this.save, this.remove);
		this.contentElement.append(actions);
		this.reference = this.input('Memory reference');
		this.contentElement.append(this.button('Open reference', () => this.openReference(this.reference.value)));
		this._register(addDisposableListener(this.context, 'change', () => { void this.perform(async () => { if (!await this.discardDraft()) { this.context.value = this.contextId; return; } this.contextId = this.context.value; this.policy = undefined; await this.newMemory(); await this.refresh(); }); }));
		this._register(addDisposableListener(this.scope, 'change', () => { void this.perform(() => this.selectScope()); }));
		this._register(addDisposableListener(this.list, 'change', () => { void this.perform(() => this.selectMemory()); }));
		this._register(addDisposableListener(this.reading, 'change', () => { void this.perform(() => this.changePolicy()); }));
		this._register(addDisposableListener(this.saving, 'change', () => { void this.perform(() => this.changePolicy()); }));
		this._register(addDisposableListener(this.titleInput, 'input', () => { this.dirty = true; }));
		this._register(addDisposableListener(this.body, 'input', () => { this.dirty = true; }));
		this._register(addDisposableListener(this.contentElement, 'keydown', event => {
			if (event.altKey && event.key === 'F1') { event.preventDefault(); void this.showHelp(); }
			if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void this.perform(() => this.saveMemory()); }
			if (event.key === 'Enter' && event.target === this.search) { event.preventDefault(); void this.perform(() => this.loadList()); }
		}));
		this._register(memories.onDidChange(() => { if (this.working) { return; } this.status.textContent = localize('memories.changed', 'Memories changed. Refresh to load the latest version; your draft is kept.'); }));
		this.refreshContexts();
		this.applyEnabled();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible && !this.policy) { void this.perform(() => this.refresh()); }
	}
	public override focus(): void {
		this.scope.focus();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.memories')) {
			this.status.textContent = localize('memories.hint', 'Memories. Use Tab to navigate, Ctrl or Command+S to save, and Alt+F1 for help.');
		}
		if (!this.policy) { void this.perform(() => this.refresh()); }
	}

	public saveDraft(): Promise<void> { return this.perform(() => this.saveMemory()); }

	public async openReference(reference: string): Promise<void> {
		if (!await this.discardDraft()) { return; }
		const generation = ++this.readGeneration;
		const result = await this.memories.readReference(reference);
		if (this.isDisposed || generation !== this.readGeneration) { return; }
		this.selected = undefined;
		this.showingReference = true;
		this.titleInput.value = result.title;
		this.body.value = result.body;
		this.titleInput.readOnly = true;
		this.body.readOnly = true;
		this.save.disabled = true;
		this.remove.disabled = true;
		this.status.textContent = localize('memories.reference', 'Exact reference, revision {0}.', result.revision);
		this.body.focus();
	}

	private refreshContexts(): void {
		const document = this.element.ownerDocument;
		this.context.replaceChildren(this.option('Personal memories', ''));
		for (const conversation of this.sessions.getConversations()) {
			const option = h(document, 'option');
			option.value = conversation.threadId;
			option.textContent = conversation.title;
			this.context.append(option);
		}
	}
	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const scopes = await this.memories.scopes(this.context.value || undefined);
		if (this.isDisposed || generation !== this.generation) { return; }
		const current = this.policy && JSON.stringify(this.policy.scope);
		this.scopes = scopes;
		this.scope.replaceChildren(...scopes.map((entry, index) => this.option(entry.label, String(index))));
		const index = scopes.findIndex(entry => JSON.stringify(entry.policy.scope) === current);
		this.scope.value = String(Math.max(index, 0));
		this.policy = scopes[Math.max(index, 0)]?.policy;
		this.renderPolicy();
		await this.loadList();
		if (this.selected && !this.dirty) {
			const entry = this.entries.find(entry => entry.id === this.selected?.id);
			if (entry) { this.showMemory(await this.memories.read(entry)); }
		}
	}
	private async selectScope(): Promise<void> {
		if (!await this.discardDraft()) { this.scope.value = String(this.scopes.findIndex(entry => JSON.stringify(entry.policy.scope) === JSON.stringify(this.policy?.scope))); return; }
		this.policy = this.scopes[Number(this.scope.value)]?.policy;
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
		this.next.disabled = !page.cursor;
		this.list.replaceChildren(...page.memories.map(entry => this.option(entry.title, entry.id)));
		this.list.value = this.selected?.id ?? '';
		this.status.textContent = localize('memories.count', '{0} memories on this page.', page.memories.length);
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
		this.mutationId = generateUuid();
		this.selected = memory;
		this.showingReference = false;
		this.dirty = false;
		this.titleInput.readOnly = false;
		this.body.readOnly = false;
		this.titleInput.value = memory.title;
		this.body.value = memory.body;
		this.save.disabled = false;
		this.remove.disabled = false;
		this.status.textContent = localize('memories.source', 'Saved by {0}, revision {1}. Editing makes this a user-owned memory.', memory.source, memory.revision);
	}
	private async newMemory(): Promise<void> {
		if (!await this.discardDraft()) { return; }
		this.readGeneration++;
		this.mutationId = generateUuid();
		this.selected = undefined;
		this.showingReference = false;
		this.titleInput.value = '';
		this.body.value = '';
		this.titleInput.readOnly = false;
		this.body.readOnly = false;
		this.save.disabled = !this.policy;
		this.remove.disabled = true;
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
			: await this.memories.add(this.policy.scope, this.titleInput.value, this.body.value, this.mutationId);
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
		const discard = await this.dialogs.confirm({ message: 'Discard unsaved memory changes?', primaryButton: 'Discard changes' });
		if (discard.confirmed) { this.dirty = false; }
		return discard.confirmed;
	}
	private async perform(operation: () => Promise<void>): Promise<void> {
		if (this.working || this.isDisposed) { return; }
		const previousFocus = this.element.ownerDocument.activeElement;
		this.working = true;
		this.applyEnabled();
		this.contentElement.setAttribute('aria-busy', 'true');
		try { await operation(); }
		catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } }
		finally { this.working = false; this.contentElement.removeAttribute('aria-busy'); if (!this.isDisposed) { this.applyEnabled(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected && this.contentElement.contains(previousFocus) && !this.contentElement.contains(this.element.ownerDocument.activeElement)) { previousFocus.focus(); } } }
	}
	private async showHelp(): Promise<void> {
		const focus = this.element.ownerDocument.activeElement;
		await this.dialogs.showMessage({ title: localize('memories.helpTitle', 'Memories help'), severity: DialogSeverity.Info, message: localize('memories.help', 'Choose a conversation context and memory scope. Reading and model saving are independent permissions and start disabled. Use Tab and Shift+Tab to move between controls, arrow keys to browse the list, and Ctrl or Command+S to save. Memory content is plain text and can be selected and copied. Open reference shows an exact, read-only excerpt. Editing a model memory gives you ownership and prevents later model overwrites. Escape closes this help dialog.') });
		if (focus instanceof HTMLElement && focus.isConnected) { focus.focus(); }
	}
	private applyEnabled(): void {
		for (const control of this.contentElement.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>('input, textarea, button, select')) {
			if (control instanceof HTMLTextAreaElement || (control instanceof HTMLInputElement && control.type !== 'checkbox')) {
				control.disabled = false;
				control.readOnly = this.working || (this.showingReference && (control === this.body || control === this.titleInput));
			} else { control.disabled = this.working; }
		}
		this.save.disabled = this.working || !this.policy || this.showingReference;
		this.remove.disabled = this.working || !this.selected || this.showingReference;
		this.next.disabled = this.working || !this.cursor;
		this.reading.disabled = this.working || !this.policy;
		this.saving.disabled = this.working || !this.policy;
	}
	private option(label: string, value: string): HTMLOptionElement {
		const option = h(this.element.ownerDocument, 'option'); option.textContent = label; option.value = value; return option;
	}
	private field(text: string, control: HTMLElement): void {
		const label = h(this.element.ownerDocument, 'label');
		const caption = h(this.element.ownerDocument, 'span');
		caption.id = `memory-field-${generateUuid()}`;
		caption.textContent = text;
		control.setAttribute('aria-labelledby', caption.id);
		label.append(caption, control);
		this.contentElement.append(label);
	}
	private input(label: string, type = 'text'): HTMLInputElement {
		const input = h(this.element.ownerDocument, 'input');
		input.type = type;
		this.field(label, input);
		return input;
	}
	private button(label: string, action: () => Promise<void>): HTMLButtonElement {
		const button = h(this.element.ownerDocument, 'button');
		button.type = 'button';
		button.textContent = label;
		this._register(addDisposableListener(button, 'click', () => { void this.perform(action); }));
		return button;
	}
}
