import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import './media/keyboardShortcutsEditor.css';
import { h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import { isModifierKey, StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { MAX_KEYBINDING_CHORDS } from '../../../../base/common/keybindings.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { commandActionLabel } from '../../../../platform/action/common/action.js';
import { isMenuItem, MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import type { CommandId } from '../../../../platform/commands/common/commands.js';
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService, type IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { KeybindingContextKeys, IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { isKeyboardShortcutsEditorInput } from '../../../services/preferences/browser/keybindingsEditorInput.js';
import { KeyboardShortcutsEditorModel, type KeyboardShortcutItem } from '../../../services/preferences/browser/keybindingsEditorModel.js';

export const KeyboardShortcutsEditorId = 'workbench.editor.keyboardShortcuts';
let nextRecorderHelpId = 1;

/** A tab-hosted editor for searching and updating the active keybindings resource. */
export class KeyboardShortcutsEditor extends EditorPane implements IEditorPane {
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
	private cancelButton: Button | undefined;
	private scrollable: ScrollableElement | undefined;
	private scopedContext: IScopedContextKeyService | undefined;
	private recordingContext: IContextKey<boolean> | undefined;
	private editingItem: KeyboardShortcutItem | undefined;
	private recorderReturnFocus: HTMLElement | undefined;
	private readonly recordedChords: string[] = [];
	private saving = false;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IKeyboardLayoutService private readonly keyboardLayoutService: IKeyboardLayoutService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(KeyboardShortcutsEditorId, themeService, storageService);
		this.model = this._register(instantiationService.createInstance(KeyboardShortcutsEditorModel, {
			commandLabel: commandLabel,
		}));
		this._register(this.model.onDidChange(items => this.renderRows(items)));
		this._register(toDisposable(() => {
			for (const row of this.rows.values()) row.dispose();
			this.rows.clear();
		}));
	}

	public override create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError('Keyboard Shortcuts editor has already been created');
		const ownerDocument = parent.ownerDocument;
		const container = h(ownerDocument, 'div');
		container.className = 'ash-keybindings-editor';
		container.setAttribute('aria-label', 'Keyboard Shortcuts');
		parent.append(container);
		super.create(container);
		this.container = container;
		this._register(toDisposable(() => container.remove()));

		this.scopedContext = this._register(this.contextKeyService.createScoped(container));
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

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isKeyboardShortcutsEditorInput(input)) throw new RangeError(`Keyboard Shortcuts editor cannot open ${input.resource}`);
		throwIfCancelled(signal, 'Keyboard Shortcuts loading was cancelled');
	}

	public override clearInput(): void {
		this.closeRecorder(false);
	}

	public override layout(_dimension: IDimension): void {
		this.scrollable?.layout();
	}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		if (!visibility) this.recordingContext?.reset();
		else if (this.editingItem) this.recordingContext?.set(true);
	}

	public override focus(): void {
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
		const help = h(ownerDocument, 'p');
		help.className = 'ash-keybindings-recorder-help';
		help.id = `ash-keybindings-recorder-help-${nextRecorderHelpId++}`;
		help.textContent = localize('keybindings.recordingHelp', 'In the recording field, press up to {0} chords in order. Enter saves; Escape clears the binding, then cancels when empty. Tab and Shift+Tab move focus. Modified Enter and Escape are recorded. Use Keyboard Shortcuts (JSON) for bare Enter, Escape, Tab or Shift+Tab. After {0} chords, the next chord starts a new sequence.', MAX_KEYBINDING_CHORDS);
		this.keyInput.inputElement.setAttribute('aria-describedby', help.id);
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
		this.cancelButton = this._register(new Button(actions, {
			label: 'Cancel',
			presentation: 'secondary',
			onClick: () => { if (!this.saving) this.closeRecorder(); },
		}));
		this.cancelButton.toggleClassName('ash-keybindings-cancel', true);
		recorder.append(this.recorderTitle, help, fields, actions);
		this._register(this.keyInput.onKeyDown(event => this.recordKeybinding(event)));
		return recorder;
	}

	private openRecorder(item: KeyboardShortcutItem): void {
		if (this.saving || !this.recorder || !this.recorderTitle || !this.keyInput || !this.whenInput) return;
		if (!this.editingItem) {
			const activeElement = this.container?.ownerDocument.activeElement;
			this.recorderReturnFocus = isHTMLElement(activeElement) ? activeElement : undefined;
		}
		this.editingItem = item;
		// A stored binding is a preview: the first recorded chord replaces it.
		this.recordedChords.length = 0;
		this.recorderTitle.textContent = `${item.source === 'user' ? 'Edit' : 'Add'} keybinding for ${item.commandLabel}`;
		this.keyInput.value = item.source === 'user' ? item.key : '';
		this.whenInput.value = item.source === 'user' ? item.when : '';
		this.recorder.hidden = false;
		this.recordingContext?.set(true);
		this.keyInput.focus();
	}

	private closeRecorder(restoreFocus = true): void {
		this.editingItem = undefined;
		this.recordedChords.length = 0;
		if (this.recorder) this.recorder.hidden = true;
		this.recordingContext?.reset();
		if (restoreFocus) {
			if (this.recorderReturnFocus?.isConnected) this.recorderReturnFocus.focus();
			else this.searchInput?.focus();
		}
		this.recorderReturnFocus = undefined;
	}

	private recordKeybinding(event: KeyboardEvent): void {
		// Keep both directions of focus navigation available in this inline editor.
		if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
		stopEvent(event);
		if (this.saving || event.repeat || isModifierKey(event) || event.isComposing || event.key === 'Process' || !this.keyInput) return;
		const unmodified = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
		if (unmodified && event.key === 'Enter') {
			void this.saveEditingItem();
			return;
		}
		if (unmodified && event.key === 'Escape') {
			if (this.keyInput.value) {
				this.recordedChords.length = 0;
				this.keyInput.value = '';
				this.setStatus(localize('keybindings.recordingCleared', 'Keybinding cleared. Record a new sequence, or press Escape again to cancel.'), false);
			} else this.closeRecorder();
			return;
		}
		const keyboardEvent = new StandardKeyboardEvent(event);
		const resolved = this.keyboardLayoutService.getKeyboardMapper().resolveKeyboardEvent({
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
		const chord = getKeybindingLabel(resolved, KeybindingLabelStyle.UserSettings);
		if (!chord) return;
		const restarting = this.recordedChords.length === MAX_KEYBINDING_CHORDS;
		if (restarting) this.recordedChords.length = 0;
		this.recordedChords.push(chord);
		this.keyInput.value = this.recordedChords.join(' ');
		this.setStatus(restarting
			? localize('keybindings.recordingRestarted', 'Started a new sequence after {0} chords: {1}.', MAX_KEYBINDING_CHORDS, chord)
			: localize('keybindings.recordingChords', 'Recorded {0} of {1} chords: {2}.', this.recordedChords.length, MAX_KEYBINDING_CHORDS, this.keyInput.value), false);
	}

	private async saveEditingItem(): Promise<void> {
		const item = this.editingItem;
		if (!item || !this.keyInput || !this.whenInput || this.saving) return;
		this.setSaving(true);
		this.setStatus(localize('keybindings.recordingSaving', 'Saving keybinding…'), false);
		try {
			await this.model.save(item, this.keyInput.value, this.whenInput.value);
			if (this.isDisposed || this.editingItem !== item) return;
			// The saved row can be replaced by the asynchronous file watcher.
			this.closeRecorder(false);
			if (this.canRestoreRecorderFocus()) this.searchInput?.focus();
			this.setStatus(localize('keybindings.recordingSaved', 'Keybinding saved.'), false);
		} catch (error) {
			if (this.isDisposed || this.editingItem !== item) return;
			this.setStatus(error instanceof Error ? error.message : localize('keybindings.recordingSaveFailed', 'Unable to save the keybinding.'), true);
		} finally {
			if (!this.isDisposed) {
				this.setSaving(false);
				if (this.editingItem === item && this.canRestoreRecorderFocus()) this.keyInput.focus();
			}
		}
	}

	private canRestoreRecorderFocus(): boolean {
		if (!this.isVisible() || !this.container) return false;
		const { activeElement, body } = this.container.ownerDocument;
		// Disabling the focused recorder control can leave focus on body.
		// Completion must not take focus from another editor or Workbench control.
		return activeElement === body || this.container.contains(activeElement);
	}

	private setSaving(saving: boolean): void {
		this.saving = saving;
		this.recorder?.setAttribute('aria-busy', String(saving));
		if (this.keyInput) this.keyInput.enabled = !saving;
		if (this.whenInput) this.whenInput.enabled = !saving;
		if (this.saveButton) this.saveButton.enabled = !saving;
		if (this.cancelButton) this.cancelButton.enabled = !saving;
		for (const row of this.rows.values()) row.setEnabled(!saving);
	}

	private async removeItem(item: KeyboardShortcutItem): Promise<void> {
		if (this.saving) return;
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
			row.setEnabled(!this.saving);
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
	private readonly edit: Button;
	private readonly remove: Button | undefined;

	constructor(container: HTMLElement, item: KeyboardShortcutItem, callbacks: { readonly onEdit: (item: KeyboardShortcutItem) => void; readonly onRemove: (item: KeyboardShortcutItem) => void; }) {
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
		this.edit = this._register(new Button(actions, {
			label: item.source === 'user' ? 'Edit' : 'Add',
			title: item.source === 'user' ? 'Edit keybinding' : 'Add keybinding',
			presentation: 'secondary',
			size: 'small',
			onClick: () => callbacks.onEdit(this.item),
		}));
		this.edit.toggleClassName('ash-keybindings-row-action', true);
		if (item.source === 'user') {
			this.remove = this._register(new Button(actions, {
				label: 'Remove',
				title: 'Remove keybinding',
				presentation: 'danger',
				size: 'small',
				onClick: () => callbacks.onRemove(this.item),
			}));
			this.remove.toggleClassName('ash-keybindings-row-action', true);
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

	public setEnabled(enabled: boolean): void {
		this.edit.enabled = enabled;
		if (this.remove) this.remove.enabled = enabled;
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
