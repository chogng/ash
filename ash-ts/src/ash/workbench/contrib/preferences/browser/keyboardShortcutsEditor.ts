import './media/keyboardShortcutsEditor.css';
import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import { isModifierKey, StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { commandActionLabel } from '../../../../platform/action/common/action.js';
import { isMenuItem, MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import type { CommandId } from '../../../../platform/commands/common/commands.js';
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import type { IContextKeyService, IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { KeybindingContextKeys, type IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { IKeybindingsResourceService } from '../../../../platform/keybinding/common/keybindingsResource.js';
import type { IKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import type { EditorInput } from '../../../browser/parts/editor/editorInput.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { isKeyboardShortcutsEditorInput } from '../../../services/preferences/browser/keybindingsEditorInput.js';
import { KeyboardShortcutsEditorModel, type KeyboardShortcutItem } from '../../../services/preferences/browser/keybindingsEditorModel.js';

export const KeyboardShortcutsEditorId = 'workbench.editor.keyboardShortcuts';

interface KeyboardShortcutsEditorOptions {
	readonly contextKeyService: IContextKeyService;
	readonly keybindingService: IKeybindingService;
	readonly keybindingsResourceService: IKeybindingsResourceService;
	readonly keyboardLayoutService: IKeyboardLayoutService;
}

/** A tab-hosted editor for searching and updating the active keybindings resource. */
export class KeyboardShortcutsEditor extends Disposable implements IEditorPane {
	public readonly id = KeyboardShortcutsEditorId;
	private readonly model: KeyboardShortcutsEditorModel;
	private readonly rows = new Map<string, KeyboardShortcutRow>();
	private container: HTMLDivElement | undefined;
	private searchInput: InputBox | undefined;
	private list: HTMLDivElement | undefined;
	private empty: HTMLParagraphElement | undefined;
	private count: HTMLSpanElement | undefined;
	private status: HTMLParagraphElement | undefined;
	private recorder: HTMLDivElement | undefined;
	private recorderTitle: HTMLHeadingElement | undefined;
	private keyInput: InputBox | undefined;
	private whenInput: InputBox | undefined;
	private saveButton: Button | undefined;
	private scrollable: ScrollableElement | undefined;
	private scopedContext: IScopedContextKeyService | undefined;
	private recordingContext: IContextKey<boolean> | undefined;
	private editingItem: KeyboardShortcutItem | undefined;
	private saving = false;

	constructor(private readonly options: KeyboardShortcutsEditorOptions) {
		super();
		this.model = this._register(new KeyboardShortcutsEditorModel({
			keybindingService: options.keybindingService,
			resourceService: options.keybindingsResourceService,
			commandLabel: commandLabel,
		}));
		this._register(this.model.onDidChange(items => this.renderRows(items)));
		this._register(toDisposable(() => {
			for (const row of this.rows.values()) row.dispose();
			this.rows.clear();
		}));
	}

	public create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError('Keyboard Shortcuts editor has already been created');
		const ownerDocument = parent.ownerDocument;
		const container = h(ownerDocument, 'div');
		container.className = 'ash-keybindings-editor';
		container.setAttribute('aria-label', 'Keyboard Shortcuts');
		parent.append(container);
		this.container = container;
		this._register(toDisposable(() => container.remove()));

		this.scopedContext = this._register(this.options.contextKeyService.createScoped(container));
		this.recordingContext = KeybindingContextKeys.isRecording.bindTo(this.scopedContext);

		const header = h(ownerDocument, 'header');
		header.className = 'ash-keybindings-header';
		const heading = h(ownerDocument, 'h1');
		heading.textContent = 'Keyboard Shortcuts';
		const description = h(ownerDocument, 'p');
		description.textContent = 'Search commands, inspect defaults, and customize user keybindings.';
		header.append(heading, description);

		const toolbar = h(ownerDocument, 'div');
		toolbar.className = 'ash-keybindings-toolbar';
		this.searchInput = this._register(new InputBox(toolbar, {
			type: 'search',
			placeholder: 'Search keybindings',
			ariaLabel: 'Search keybindings',
		}));
		this.searchInput.element.classList.add('ash-keybindings-search');
		this.count = h(ownerDocument, 'span');
		this.count.className = 'ash-keybindings-count';
		toolbar.append(this.searchInput.element, this.count);
		this._register(this.searchInput.onDidChange(value => this.model.setQuery(value)));

		this.recorder = this.createRecorder(ownerDocument);
		this.status = h(ownerDocument, 'p');
		this.status.className = 'ash-keybindings-status';
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;

		const scrollHost = h(ownerDocument, 'div');
		scrollHost.className = 'ash-keybindings-scroll-host';
		this.scrollable = this._register(new ScrollableElement(scrollHost, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
			wheel: { consume: 'when-scrolling' },
		}));
		this.scrollable.element.classList.add('ash-keybindings-scrollable');
		this.list = h(ownerDocument, 'div');
		this.list.className = 'ash-keybindings-list';
		this.list.setAttribute('role', 'table');
		this.list.setAttribute('aria-label', 'Keyboard shortcuts');
		this.list.append(createTableHeader(ownerDocument));
		this.empty = h(ownerDocument, 'p');
		this.empty.className = 'ash-keybindings-empty';
		this.empty.textContent = 'No keyboard shortcuts match this search.';
		this.empty.hidden = true;
		this.scrollable.append(this.list, this.empty);
		scrollHost.append(this.scrollable.element);
		container.append(header, toolbar, this.recorder, this.status, scrollHost);
		this.renderRows(this.model.items);
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isKeyboardShortcutsEditorInput(input)) throw new RangeError(`Keyboard Shortcuts editor cannot open ${input.resource}`);
		try {
			await this.options.keybindingsResourceService.reload();
			throwIfCancelled(signal, 'Keyboard Shortcuts loading was cancelled');
		} catch (error) {
			throwIfCancelled(signal, 'Keyboard Shortcuts loading was cancelled');
			this.setStatus(error instanceof Error ? error.message : 'Unable to load keyboard shortcuts.', true);
		}
	}

	public clearInput(): void {
		this.closeRecorder();
	}

	public layout(_dimension: IDimension): void {
		this.scrollable?.layout();
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		if (this.container) this.container.hidden = visibility === EditorPaneVisibility.Hidden;
		if (visibility === EditorPaneVisibility.Hidden) this.recordingContext?.reset();
		else if (this.editingItem) this.recordingContext?.set(true);
	}

	public focus(): void {
		this.searchInput?.focus();
	}

	private createRecorder(ownerDocument: Document): HTMLDivElement {
		const recorder = h(ownerDocument, 'div');
		recorder.className = 'ash-keybindings-recorder';
		recorder.hidden = true;
		this.recorderTitle = h(ownerDocument, 'h2');
		const fields = h(ownerDocument, 'div');
		fields.className = 'ash-keybindings-recorder-fields';
		const keyField = h(ownerDocument, 'label');
		keyField.textContent = 'Keybinding';
		this.keyInput = this._register(new InputBox(keyField, {
			placeholder: 'Press the desired key combination',
			ariaLabel: 'Record keybinding',
			presentation: 'field',
		}));
		this.keyInput.inputElement.readOnly = true;
		this.keyInput.element.classList.add('ash-keybindings-record-input');
		keyField.append(this.keyInput.element);
		const whenField = h(ownerDocument, 'label');
		whenField.textContent = 'When';
		this.whenInput = this._register(new InputBox(whenField, {
			placeholder: 'Optional context expression',
			ariaLabel: 'Keybinding when condition',
			presentation: 'field',
		}));
		whenField.append(this.whenInput.element);
		fields.append(keyField, whenField);

		const actions = h(ownerDocument, 'div');
		actions.className = 'ash-keybindings-recorder-actions';
		this.saveButton = this._register(new Button(actions, {
			label: 'Save',
			presentation: 'primary',
			onClick: () => void this.saveEditingItem(),
		}));
		this.saveButton.toggleClassName('ash-keybindings-save', true);
		const cancel = this._register(new Button(actions, {
			label: 'Cancel',
			presentation: 'secondary',
			onClick: () => this.closeRecorder(),
		}));
		cancel.toggleClassName('ash-keybindings-cancel', true);
		recorder.append(this.recorderTitle, fields, actions);
		this._register(this.keyInput.onKeyDown(event => this.recordKeybinding(event)));
		return recorder;
	}

	private openRecorder(item: KeyboardShortcutItem): void {
		if (!this.recorder || !this.recorderTitle || !this.keyInput || !this.whenInput) return;
		this.editingItem = item;
		this.recorderTitle.textContent = `${item.source === 'user' ? 'Edit' : 'Add'} keybinding for ${item.commandLabel}`;
		this.keyInput.value = item.source === 'user' ? item.key : '';
		this.whenInput.value = item.source === 'user' ? item.when : '';
		this.recorder.hidden = false;
		this.recordingContext?.set(true);
		this.keyInput.focus();
	}

	private closeRecorder(): void {
		this.editingItem = undefined;
		if (this.recorder) this.recorder.hidden = true;
		this.recordingContext?.reset();
	}

	private recordKeybinding(event: KeyboardEvent): void {
		stopEvent(event);
		if (isModifierKey(event) || event.isComposing || event.key === 'Process') return;
		const keyboardEvent = new StandardKeyboardEvent(event);
		const resolved = this.options.keyboardLayoutService.getKeyboardMapper().resolveKeyboardEvent({
			key: keyboardEvent.key,
			code: keyboardEvent.code,
			keyCode: keyboardEvent.keyCode,
			scanCode: keyboardEvent.scanCode,
			location: keyboardEvent.location,
			ctrlKey: keyboardEvent.ctrlKey,
			shiftKey: keyboardEvent.shiftKey,
			altKey: keyboardEvent.altKey,
			metaKey: keyboardEvent.metaKey,
			altGraphKey: keyboardEvent.altGraphKey,
			isComposing: keyboardEvent.isComposing,
		});
		if (this.keyInput) this.keyInput.value = getKeybindingLabel(resolved, KeybindingLabelStyle.UserSettings);
	}

	private async saveEditingItem(): Promise<void> {
		const item = this.editingItem;
		if (!item || !this.keyInput || !this.whenInput || this.saving) return;
		this.saving = true;
		if (this.saveButton) this.saveButton.enabled = false;
		try {
			await this.model.save(item, this.keyInput.value, this.whenInput.value);
			this.closeRecorder();
			this.setStatus('Keybinding saved.', false);
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : 'Unable to save the keybinding.', true);
		} finally {
			this.saving = false;
			if (this.saveButton) this.saveButton.enabled = true;
		}
	}

	private async removeItem(item: KeyboardShortcutItem): Promise<void> {
		try {
			await this.model.remove(item);
			if (this.editingItem?.id === item.id) this.closeRecorder();
			this.setStatus('Keybinding removed.', false);
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : 'Unable to remove the keybinding.', true);
		}
	}

	private renderRows(items: readonly KeyboardShortcutItem[]): void {
		if (!this.list) return;
		const retained = new Set<string>();
		for (const item of items) {
			retained.add(item.id);
			let row = this.rows.get(item.id);
			if (!row) {
				row = new KeyboardShortcutRow(this.list, item, {
					onEdit: candidate => this.openRecorder(candidate),
					onRemove: candidate => void this.removeItem(candidate),
				});
				this.rows.set(item.id, row);
			} else {
				row.update(item);
			}
			this.list.append(row.element);
		}
		for (const [id, row] of this.rows) {
			if (retained.has(id)) continue;
			row.dispose();
			this.rows.delete(id);
		}
		if (this.count) this.count.textContent = `${items.length} shortcuts`;
		if (this.empty) this.empty.hidden = items.length !== 0;
		this.scrollable?.layout();
	}

	private setStatus(message: string, isError: boolean): void {
		if (!this.status) return;
		this.status.textContent = message;
		this.status.hidden = false;
		this.status.classList.toggle('is-error', isError);
	}
}

class KeyboardShortcutRow extends Disposable {
	public readonly element: HTMLDivElement;
	private item: KeyboardShortcutItem;
	private readonly command: HTMLSpanElement;
	private readonly commandId: HTMLSpanElement;
	private readonly key: HTMLSpanElement;
	private readonly when: HTMLSpanElement;
	private readonly source: HTMLSpanElement;

	constructor(container: HTMLElement, item: KeyboardShortcutItem, callbacks: { readonly onEdit: (item: KeyboardShortcutItem) => void; readonly onRemove: (item: KeyboardShortcutItem) => void }) {
		super();
		this.item = item;
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'ash-keybindings-row';
		this.element.setAttribute('role', 'row');
		this.element.dataset.keybindingId = item.id;
		const commandCell = h(ownerDocument, 'div');
		commandCell.className = 'ash-keybindings-command';
		commandCell.setAttribute('role', 'cell');
		this.command = h(ownerDocument, 'span');
		this.command.className = 'ash-keybindings-command-label';
		this.commandId = h(ownerDocument, 'span');
		this.commandId.className = 'ash-keybindings-command-id';
		commandCell.append(this.command, this.commandId);
		this.key = cell(ownerDocument, 'ash-keybindings-key');
		this.when = cell(ownerDocument, 'ash-keybindings-when');
		this.source = cell(ownerDocument, 'ash-keybindings-source');
		const actions = h(ownerDocument, 'div');
		actions.className = 'ash-keybindings-row-actions';
		actions.setAttribute('role', 'cell');
		const edit = this._register(new Button(actions, {
			label: item.source === 'user' ? 'Edit' : 'Add',
			title: item.source === 'user' ? 'Edit keybinding' : 'Add keybinding',
			presentation: 'secondary',
			size: 'small',
			onClick: () => callbacks.onEdit(this.item),
		}));
		edit.toggleClassName('ash-keybindings-row-action', true);
		if (item.source === 'user') {
			const remove = this._register(new Button(actions, {
				label: 'Remove',
				title: 'Remove keybinding',
				presentation: 'danger',
				size: 'small',
				onClick: () => callbacks.onRemove(this.item),
			}));
			remove.toggleClassName('ash-keybindings-row-action', true);
		}
		this.element.append(commandCell, this.key, this.when, this.source, actions);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.update(item);
	}

	public update(item: KeyboardShortcutItem): void {
		this.item = item;
		this.command.textContent = item.commandLabel;
		this.commandId.textContent = item.command ?? '';
		this.key.textContent = item.keyLabel || '—';
		this.when.textContent = item.when || '—';
		this.source.textContent = item.sourceLabel;
		this.element.classList.toggle('is-user', item.source === 'user');
	}
}

function createTableHeader(ownerDocument: Document): HTMLDivElement {
	const header = h(ownerDocument, 'div');
	header.className = 'ash-keybindings-table-header';
	header.setAttribute('role', 'row');
	for (const label of ['Command', 'Keybinding', 'When', 'Source', 'Actions']) {
		const heading = h(ownerDocument, 'span');
		heading.setAttribute('role', 'columnheader');
		heading.textContent = label;
		header.append(heading);
	}
	return header;
}

function cell(ownerDocument: Document, className: string): HTMLSpanElement {
	const element = h(ownerDocument, 'span');
	element.className = className;
	element.setAttribute('role', 'cell');
	return element;
}

function commandLabel(command: CommandId): string {
	for (const item of MenusRegistry.getMenuItems(MenuId.CommandPalette)) {
		if (!isMenuItem(item) || item.command.id !== command) continue;
		return commandActionLabel(item.command.title);
	}
	const segment = command.split('.').at(-1) ?? command;
	const words = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
	return words ? words[0].toLocaleUpperCase() + words.slice(1) : command;
}
