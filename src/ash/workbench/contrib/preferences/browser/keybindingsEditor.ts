import {
	defaultButtonStyles,
	defaultInputBoxStyles,
	defaultKeybindingLabelStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerColor, transparent } from '../../../../platform/theme/common/colorUtils.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import './media/keybindingsEditor.css';
import type { IKeybindingsEditorPane } from '../../../services/preferences/common/preferences.js';
import { addDisposableListener, h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import { isModifierKey, StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import { Table } from '../../../../base/browser/ui/table/tableWidget.js';
import type { ITableColumn, ITableRenderer } from '../../../../base/browser/ui/table/table.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { Keybinding, KeybindingChordKind, logicalKey, MAX_KEYBINDING_CHORDS } from '../../../../base/common/keybindings.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { getHoverDelegate, type IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService, type IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { KeybindingContextKeys, IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IKeybindingEditingService } from '../../../services/keybinding/common/keybindingEditing.js';
import { isKeybindingsEditorInput, KeybindingsEditorInput } from '../../../services/preferences/browser/keybindingsEditorInput.js';
import { type KeybindingsEditorModel, type KeyboardShortcutItem } from '../../../services/preferences/browser/keybindingsEditorModel.js';
import {
	CONTEXT_KEYBINDINGS_EDITOR, CONTEXT_KEYBINDINGS_SEARCH_FOCUS, CONTEXT_KEYBINDINGS_SEARCH_HAS_VALUE,
	KEYBINDINGS_EDITOR_COMMAND_RECORD_SEARCH_KEYS, KEYBINDINGS_EDITOR_COMMAND_SORTBY_PRECEDENCE, KEYBINDINGS_EDITOR_COMMAND_CLEAR_SEARCH_RESULTS,
} from '../common/preferences.js';

let nextRecorderHelpId = 1;

/** Editor pane for searching and updating the active keybindings resource in modal or group hosts. */
export class KeybindingsEditor extends EditorPane implements IKeybindingsEditorPane {
	public static readonly ID = 'workbench.editor.keybindings';
	public readonly id = KeybindingsEditor.ID;
	private input: KeybindingsEditorInput | undefined;
	private model: KeybindingsEditorModel | undefined;
	private readonly inputReference = this._register(new MutableDisposable<IDisposable>());
	private readonly modelListener = this._register(new MutableDisposable<IDisposable>());
	private readonly actionButtons = new Set<Button>();
	private container: HTMLDivElement | undefined;
	private searchInput: InputBox | undefined;
	private recordSearchButton: Button | undefined;
	private sortSearchButton: Button | undefined;
	private recordingBadge: HTMLSpanElement | undefined;
	private searchRecordingContext: IContextKey<boolean> | undefined;
	private editorContext: IContextKey<boolean> | undefined;
	private searchFocusContext: IContextKey<boolean> | undefined;
	private searchHasValueContext: IContextKey<boolean> | undefined;
	private readonly searchChords: string[] = [];
	private clearSearchButton: Button | undefined;
	private table: Table<KeyboardShortcutItem> | undefined;
	private tableContainer: HTMLDivElement | undefined;
	private empty: HTMLParagraphElement | undefined;
	private count: HTMLSpanElement | undefined;
	private status: HTMLParagraphElement | undefined;
	private recorder: HTMLDivElement | undefined;
	private recorderTitle: HTMLParagraphElement | undefined;
	private recorderPreview: HTMLDivElement | undefined;
	private recorderError: HTMLParagraphElement | undefined;
	private readonly recorderLabel = this._register(new MutableDisposable<KeybindingLabel>());
	private keyInput: InputBox | undefined;
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
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKeybindingEditingService private readonly keybindingEditingService: IKeybindingEditingService,
		@ICommandService private readonly commandService: ICommandService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(KeybindingsEditor.ID, themeService, storageService);
		this._register(toDisposable(() => this.clearInput()));
	}

	public override create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError('Keyboard Shortcuts editor has already been created');
		const ownerDocument = parent.ownerDocument;
		const container = h(ownerDocument, 'div');
		container.className = 'ash-keybindings-editor';
		container.setAttribute('aria-label', localize('workbench.manageKeyboardShortcuts', 'Keyboard Shortcuts'));
		parent.append(container);
		super.create(container);
		this.container = container;
		this._register(toDisposable(() => container.remove()));

		this.scopedContext = this._register(this.contextKeyService.createScoped(container));
		this.recordingContext = KeybindingContextKeys.isRecording.bindTo(this.scopedContext);
		this.editorContext = CONTEXT_KEYBINDINGS_EDITOR.bindTo(this.scopedContext);

		const toolbar = h(ownerDocument, 'div');
		toolbar.className = 'ash-keybindings-toolbar';
		this.searchInput = this._register(new InputBox(toolbar, {
			inputBoxStyles: defaultInputBoxStyles,
			type: 'search',
			presentation: 'field',
			placeholder: localize('keybindings.search', 'Search keybindings'),
			ariaLabel: localize('keybindings.search', 'Search keybindings'),
		}));
		this.searchInput.element.classList.add('ash-keybindings-search');
		const searchContext = this._register(this.scopedContext.createScoped(this.searchInput.inputElement));
		this.searchRecordingContext = KeybindingContextKeys.isRecording.bindTo(searchContext);
		this.searchFocusContext = CONTEXT_KEYBINDINGS_SEARCH_FOCUS.bindTo(searchContext);
		this.searchHasValueContext = CONTEXT_KEYBINDINGS_SEARCH_HAS_VALUE.bindTo(searchContext);
		const searchActions = h(ownerDocument, 'div');
		searchActions.className = 'ash-keybindings-search-actions';
		this.searchInput.element.append(searchActions);
		this.recordingBadge = h(ownerDocument, 'span');
		this.recordingBadge.className = 'ash-keybindings-recording-badge';
		this.recordingBadge.textContent = localize('keybindings.recordingKeys', 'Recording Keys');
		this.recordingBadge.hidden = true;
		searchActions.append(this.recordingBadge);
		this.recordSearchButton = this._register(new Button(searchActions, {
			...defaultButtonStyles,
			label: localize('keybindings.recordKeys', 'Record Keys'),
			icon: Lxicon.recordKeys,
			iconOnly: true,
			checked: false,
			onClick: () => this.recordSearchButton?.checked ? this.setSearchRecording(false) : this.recordSearchKeys(),
		}));
		this.sortSearchButton = this._register(new Button(searchActions, {
			...defaultButtonStyles,
			label: localize('keybindings.sortByPrecedence', 'Sort by Precedence (Highest first)'),
			icon: Lxicon.sortPrecedence,
			iconOnly: true,
			checked: false,
			onClick: () => this.toggleSortByPrecedence(),
		}));
		this.clearSearchButton = this._register(new Button(searchActions, {
			...defaultButtonStyles,
			label: localize('keybindings.clearSearch', 'Clear Keybindings Search Input'),
			icon: Lxicon.clearAll,
			iconOnly: true,
			onClick: () => this.clearSearchResults(),
		}));
		for (const button of [this.recordSearchButton, this.sortSearchButton, this.clearSearchButton]) {
			button.toggleClassName('ash-keybindings-search-action', true);
		}
		this.clearSearchButton.toggleClassName('ash-keybindings-clear-search', true);
		this.count = h(ownerDocument, 'span');
		this.count.className = 'ash-keybindings-count';
		this.count.setAttribute('aria-live', 'polite');
		this.count.setAttribute('aria-atomic', 'true');
		toolbar.append(this.searchInput.element, this.count);
		this._register(this.searchInput.onDidChange(() => {
			if (!this.recordSearchButton?.checked || !this.searchInput?.value) this.searchChords.length = 0;
			this.searchHasValueContext?.set(!!this.searchInput?.value);
			this.renderRows();
		}));
		this._register(this.searchInput.onDidFocus(() => {
			this.searchFocusContext?.set(true);
			this.updateSearchActionTooltips();
		}));
		this._register(this.searchInput.onDidBlur(() => this.searchFocusContext?.set(false)));
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.updateSearchActionTooltips()));
		this.updateSearchActionTooltips();
		this._register(this.searchInput.onKeyDown(event => this.handleSearchKeyDown(event)));
		this.searchInput.inputElement.setAttribute('aria-description', localize('keybindings.searchHelp', 'Use Record Keys to search for an exact shortcut, Sort by Precedence to show higher priority rules first, and Clear to reset the query. Escape exits recording. Each action shows its current shortcut in its tooltip. Tab reaches the search actions.'));

		this.recorder = this.createRecorder(ownerDocument);
		this.status = h(ownerDocument, 'p');
		this.status.className = 'ash-keybindings-status';
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;

		const tableContainer = this.tableContainer = h(ownerDocument, 'div');
		tableContainer.className = 'ash-keybindings-list';
		this.table = this._register(this.createTable(tableContainer));
		this.empty = h(ownerDocument, 'p');
		this.empty.className = 'ash-keybindings-empty';
		this.empty.textContent = localize('keybindings.empty', 'No keyboard shortcuts match this search.');
		this.empty.hidden = true;
		tableContainer.append(this.empty);
		container.append(toolbar, this.recorder, this.status, tableContainer);
		this._register(observeElementSize(tableContainer, size => this.table?.layout(size.height, size.width)));
		this._register(addDisposableListener(this.table.domNode, 'dblclick', event => {
			if (isHTMLElement(event.target) && event.target.closest('.ash-table-row') && !event.target.closest('button')) this.editFocusedShortcut();
		}));
		this._register(addDisposableListener(this.table.domNode, 'keydown', event => {
			if (event.key !== 'Enter' || !isHTMLElement(event.target) || !event.target.closest('.ash-table-row') || event.target.closest('button,input,textarea')) return;
			stopEvent(event);
			this.editFocusedShortcut();
		}));
		this.renderRows();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isKeybindingsEditorInput(input)) throw new RangeError(`Keyboard Shortcuts editor cannot open ${input.resource}`);
		throwIfCancelled(signal, 'Keyboard Shortcuts loading was cancelled');
		// Working-set restoration produces plain resource inputs. Rehydrate at this
		// entrance so restored panes use the same input-owned model and release rule.
		const editorInput = KeybindingsEditorInput.getOrCreate(input, this.instantiationService);
		const reference = editorInput.acquire();
		this.clearInput();
		this.inputReference.value = reference;
		this.input = editorInput;
		try {
			const model = await editorInput.resolve();
			throwIfCancelled(signal, 'Keyboard Shortcuts loading was cancelled');
			// Cancellation belongs to this request, even if a replacement reuses the input.
			if (this.isDisposed || this.inputReference.value !== reference) return;
			this.model = model;
			this.editorContext?.set(this.isVisible());
			this.searchFocusContext?.set(this.isVisible() && this.searchInput?.inputElement === this.container?.ownerDocument.activeElement);
			this.modelListener.value = model.onDidChange(() => this.renderRows());
			this.renderRows();
		} catch (error) {
			if (this.inputReference.value === reference) this.clearInput();
			throw error;
		}
	}

	public override clearInput(): void {
		this.editorContext?.reset();
		this.searchFocusContext?.reset();
		this.setSearchRecording(false, false);
		this.closeRecorder(false);
		this.modelListener.clear();
		this.model = undefined;
		this.input = undefined;
		this.inputReference.clear();
		this.renderRows();
	}

	public override layout(_dimension: IDimension): void {
		if (this.tableContainer) this.table?.layout(this.tableContainer.clientHeight, this.tableContainer.clientWidth);
	}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		this.editorContext?.set(visibility && !!this.input);
		this.searchFocusContext?.set(visibility && this.searchInput?.inputElement === this.container?.ownerDocument.activeElement);
		if (!visibility) this.recordingContext?.reset();
		else if (this.editingItem) this.recordingContext?.set(true);
		this.searchRecordingContext?.set(visibility && !!this.recordSearchButton?.checked);
	}

	public override focus(): void {
		(this.editingItem ? this.keyInput : this.searchInput)?.focus();
	}

	public override getActions(): readonly IAction[] {
		const label = localize('keybindings.openJsonEditor', 'Open Keyboard Shortcuts (JSON)');
		return [{
			id: 'workbench.action.openGlobalKeybindingsFile',
			label,
			tooltip: label,
			icon: Lxicon.code,
			enabled: true,
			run: () => this.commandService.executeCommand('workbench.action.openGlobalKeybindingsFile'),
		}];
	}

	public override getSecondaryActions(): readonly IAction[] {
		const source = /@source:\s*(system|default|user|extension|unassigned)\b/i.exec(this.searchInput?.value ?? '')?.[1].toLowerCase();
		return [
			...[
				['system', 'keybindings.editor.showDefaultKeybindings', localize('keybindings.showSystem', 'Show System Keybindings')],
				['user', 'keybindings.editor.showUserKeybindings', localize('keybindings.showUser', 'Show User Keybindings')],
				['extension', 'keybindings.editor.showExtensionKeybindings', localize('keybindings.showExtension', 'Show Extension Keybindings')],
				['unassigned', 'keybindings.editor.showUnassignedKeybindings', localize('keybindings.showUnassigned', 'Show Unassigned Commands')],
			].map(([value, id, label]) => ({
				id,
				label,
				tooltip: label,
				enabled: true,
				checked: source === value || value === 'system' && source === 'default',
				run: () => this.search(`@source:${value}`),
			})),
			new Separator(),
			{
				id: 'keybindings.editor.clearSearchResults',
				label: localize('keybindings.showAll', 'Show All Keybindings'),
				tooltip: localize('keybindings.showAll', 'Show All Keybindings'),
				enabled: true,
				checked: !source,
				run: () => this.search(''),
			},
		];
	}

	public search(filter: string): void {
		this.searchChords.length = 0;
		if (this.searchInput) this.searchInput.value = filter;
		this.renderRows();
		this.focus();
	}

	public recordSearchKeys(): void {
		if (!this.recordSearchButton?.checked) this.setSearchRecording(true);
		else this.focus();
	}

	public toggleSortByPrecedence(): void {
		if (!this.sortSearchButton) return;
		this.sortSearchButton.checked = !this.sortSearchButton.checked;
		this.renderRows();
		this.focus();
	}

	public clearSearchResults(): void {
		this.search('');
	}

	private updateSearchActionTooltips(): void {
		for (const [button, command] of [
			[this.recordSearchButton, KEYBINDINGS_EDITOR_COMMAND_RECORD_SEARCH_KEYS],
			[this.sortSearchButton, KEYBINDINGS_EDITOR_COMMAND_SORTBY_PRECEDENCE],
			[this.clearSearchButton, KEYBINDINGS_EDITOR_COMMAND_CLEAR_SEARCH_RESULTS],
		] as const) {
			if (!button) continue;
			const binding = this.keybindingService.lookupKeybinding(command, this.contextKeyService.getContext(this.searchInput?.inputElement));
			const tooltip = binding
				? localize('keybindings.actionWithKeybinding', '{0} ({1})', button.label, getKeybindingLabel(binding))
				: button.label;
			button.setTitle(tooltip);
			button.domNode.setAttribute('aria-label', tooltip);
		}
	}

	private setSearchRecording(recording: boolean, focus = true): void {
		if (this.recordSearchButton) this.recordSearchButton.checked = recording;
		this.searchChords.length = 0;
		this.searchRecordingContext?.set(recording);
		if (this.recordingBadge) this.recordingBadge.hidden = !recording;
		if (this.searchInput) {
			const label = recording
				? localize('keybindings.recordingSearch', 'Recording Keys. Press Escape to exit')
				: localize('keybindings.search', 'Search keybindings');
			this.searchInput.placeholder = label;
			this.searchInput.inputElement.setAttribute('aria-label', label);
			this.searchInput.inputElement.readOnly = recording;
		}
		if (focus) this.focus();
	}

	private handleSearchKeyDown(event: KeyboardEvent): void {
		const recording = this.recordSearchButton?.checked;
		if (recording && event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
			stopEvent(event);
			this.setSearchRecording(false);
			return;
		}
		if (!recording || event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
		stopEvent(event);
		if (event.repeat || event.isComposing || isModifierKey(event) || event.key === 'Process') return;
		const keyboardEvent = new StandardKeyboardEvent(event);
		const resolved = this.keyboardLayoutService.getKeyboardMapper().resolveKeyboardEvent(keyboardEvent);
		const chord = getKeybindingLabel(resolved, KeybindingLabelStyle.UserSettings);
		if (!chord || !this.searchInput) return;
		if (this.searchChords.length === MAX_KEYBINDING_CHORDS) this.searchChords.length = 0;
		this.searchChords.push(chord);
		this.searchInput.value = `"${this.searchChords.join(' ')}"`;
	}

	private createTable(container: HTMLElement): Table<KeyboardShortcutItem> {
		const actions: ITableRenderer<KeyboardShortcutItem, ShortcutActionsTemplate> = {
			templateId: 'shortcut-actions',
			renderTemplate: element => {
				const store = new DisposableStore();
				element.classList.add('ash-keybindings-row-actions');
				const template: ShortcutActionsTemplate = {
					element, store, item: undefined,
					edit: store.add(new Button(element, {
						...defaultButtonStyles,
						label: localize('keybindings.edit', 'Edit'),
						icon: Lxicon.edit,
						iconOnly: true,
						size: 'small',
						onClick: () => { if (template.item) this.openRecorder(template.item); },
					})),
					remove: store.add(new Button(element, {
						...defaultButtonStyles,
						label: localize('keybindings.remove', 'Remove'),
						icon: Lxicon.trash,
						iconOnly: true,
						size: 'small',
						onClick: () => { if (template.item) void this.removeItem(template.item); },
					})),
				};
				for (const button of [template.edit, template.remove]) {
					button.toggleClassName('ash-keybindings-row-action', true);
					this.actionButtons.add(button);
				}
				return template;
			},
			renderElement: (item, index, template) => {
				template.item = item;
				// Decorate Table's retained content; Table remains the only row owner.
				const row = template.element.parentElement!;
				row.classList.add('ash-keybindings-row');
				row.classList.toggle('is-odd', index % 2 === 1);
				row.dataset.keybindingId = item.id;
				const editLabel = item.key
					? localize('keybindings.editTitle', 'Edit keybinding for {0}', item.commandLabel)
					: localize('keybindings.addTitle', 'Add keybinding for {0}', item.commandLabel);
				template.edit.label = item.key ? localize('keybindings.edit', 'Edit') : localize('keybindings.add', 'Add');
				template.edit.icon = item.key ? Lxicon.edit : Lxicon.add;
				template.edit.setTitle(editLabel);
				template.edit.domNode.setAttribute('aria-label', editLabel);
				const removeLabel = localize('keybindings.removeTitle', 'Remove keybinding for {0}', item.commandLabel);
				template.remove.setTitle(removeLabel);
				template.remove.domNode.setAttribute('aria-label', removeLabel);
				template.remove.hidden = item.source !== 'user';
				template.edit.enabled = template.remove.enabled = !this.saving;
			},
			disposeTemplate: template => {
				this.actionButtons.delete(template.edit);
				this.actionButtons.delete(template.remove);
				template.store.dispose();
			},
		};
		const command: ITableRenderer<KeyboardShortcutItem, { label: HTMLElement; id: HTMLElement; hovers: DisposableStore; }> = {
			templateId: 'shortcut-command',
			renderTemplate: element => {
				const content = h(element.ownerDocument, 'div');
				content.className = 'ash-keybindings-command';
				const label = h(element.ownerDocument, 'span');
				label.className = 'ash-keybindings-command-label';
				const id = h(element.ownerDocument, 'span');
				id.className = 'ash-keybindings-command-id';
				content.append(label, id);
				element.append(content);
				return { label, id, hovers: new DisposableStore() };
			},
			renderElement: (item, _index, template) => {
				template.label.textContent = item.commandLabel;
				template.id.textContent = item.command ?? '';
				template.id.hidden = !commandIdMatches(item, this.searchInput?.value ?? '');
				template.hovers.clear();
				for (const [target, content] of [[template.label, `${item.commandLabel}${item.command ? ` (${item.command})` : ''}`], [template.id, item.command ?? '']] as const) {
					if (content) template.hovers.add(getHoverDelegate().setupHover({ target, content }));
				}
			},
			disposeTemplate: template => template.hovers.dispose(),
		};
		const keybinding: ITableRenderer<KeyboardShortcutItem, { element: HTMLElement; label: MutableDisposable<KeybindingLabel>; hover: MutableDisposable<IManagedHover>; }> = {
			templateId: 'shortcut-keybinding',
			renderTemplate: element => {
				element.classList.add('ash-keybindings-key');
				return { element, label: new MutableDisposable<KeybindingLabel>(), hover: new MutableDisposable<IManagedHover>() };
			},
			renderElement: (item, _index, template) => {
				const resolved = item.keybindingItem.resolvedKeybinding;
				template.hover.value = item.keyLabel ? getHoverDelegate().setupHover({ target: template.element, content: item.keyLabel }) : undefined;
				if (!resolved) {
					template.label.clear();
					template.element.textContent = item.keyLabel;
				} else if (template.label.value) {
					template.label.value.keybinding = resolved;
				} else {
					template.element.textContent = '';
					template.label.value = new KeybindingLabel(template.element, {
						...defaultKeybindingLabelStyles,
						keybinding: resolved,
						presentation: 'keycap',
					});
				}
			},
			disposeTemplate: template => {
				template.label.dispose();
				template.hover.dispose();
			},
		};
		const columns: ITableColumn<KeyboardShortcutItem, KeyboardShortcutItem>[] = [
			{
				label: '', tooltip: localize('keybindings.actions', 'Actions'),
				templateId: actions.templateId,
				weight: 0, minimumWidth: 48, maximumWidth: 48,
				project: item => item,
			},
			{
				label: localize('keybindings.command', 'Command'),
				templateId: command.templateId,
				weight: 3.2, minimumWidth: 180,
				project: item => item,
			},
			{
				label: localize('keybindings.keybinding', 'Keybinding'),
				templateId: keybinding.templateId,
				weight: 2.2, minimumWidth: 180,
				project: item => item,
			},
			{
				label: localize('keybindings.when', 'When'),
				templateId: 'shortcut-when',
				weight: 3.3, minimumWidth: 160,
				project: item => item,
			},
			{
				label: localize('keybindings.source', 'Source'),
				templateId: 'shortcut-source',
				weight: 1.3, minimumWidth: 90,
				project: item => item,
			},
		];
		const renderers = [actions, command, keybinding, shortcutTextRenderer('when'), shortcutTextRenderer('source')];
		const table = new Table('KeybindingsEditor', container, {
			headerRowHeight: 30,
			getHeight: item => commandIdMatches(item, this.searchInput?.value ?? '') ? 40 : 24,
		}, columns, renderers, {
			ariaLabel: localize('workbench.manageKeyboardShortcuts', 'Keyboard Shortcuts'),
			scrolling: 'managed',
			identityProvider: { getId: item => item.id },
			accessibilityProvider: {
				getAriaLabel: item => localize('keybindings.rowLabel', '{0}, {1}, {2}, {3}',
					item.commandLabel,
					item.keyLabel || localize('keybindings.sourceUnassigned', 'Unassigned'),
					item.when || localize('keybindings.always', 'Always'),
					item.sourceLabel,
				),
			},
		});
		table.domNode.setAttribute('aria-description', localize('keybindings.tableHelp', 'Use arrow keys to navigate shortcuts and Enter to edit. Tab reaches row actions and column separators. Drag a column separator, or focus it and use arrow keys, to resize columns. Double-click a separator to reset its column width.'));
		return table;
	}

	private editFocusedShortcut(): void {
		const index = this.table?.getFocus()[0];
		if (index !== undefined) this.openRecorder(this.table!.row(index));
	}

	private createRecorder(ownerDocument: Document): HTMLDivElement {
		const recorder = h(ownerDocument, 'div');
		recorder.className = 'ash-keybindings-recorder';
		recorder.hidden = true;
		const dialog = h(ownerDocument, 'div');
		dialog.className = 'ash-keybindings-recorder-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		this.recorderTitle = h(ownerDocument, 'p');
		this.recorderTitle.className = 'ash-keybindings-recorder-message';
		this.recorderTitle.textContent = localize('keybindings.recordingPrompt', 'Press desired key combination and then press ENTER.');
		const help = h(ownerDocument, 'p');
		help.className = 'ash-keybindings-recorder-help';
		help.id = `ash-keybindings-recorder-help-${nextRecorderHelpId++}`;
		help.textContent = localize('keybindings.recordingHelp', 'Press up to {0} chords in order. Enter saves; Escape clears the binding, then cancels when empty. Tab and Shift+Tab keep focus in the recorder. Modified Enter and Escape are recorded. Use Keyboard Shortcuts (JSON) for bare Enter, Escape, Tab or Shift+Tab. After {0} chords, the next chord starts a new sequence.', MAX_KEYBINDING_CHORDS);
		dialog.setAttribute('aria-describedby', help.id);
		this.keyInput = this._register(new InputBox(dialog, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('keybindings.record', 'Record keybinding'),
			presentation: 'field',
		}));
		this.keyInput.inputElement.readOnly = true;
		this.keyInput.element.classList.add('ash-keybindings-record-input');
		this.keyInput.inputElement.setAttribute('aria-describedby', help.id);
		this.recorderPreview = h(ownerDocument, 'div');
		this.recorderPreview.className = 'ash-keybindings-recorder-preview';
		this.recorderPreview.setAttribute('aria-hidden', 'true');
		this.recorderError = h(ownerDocument, 'p');
		this.recorderError.className = 'ash-keybindings-recorder-error';
		this.recorderError.setAttribute('role', 'alert');
		this.recorderError.hidden = true;
		dialog.append(this.recorderTitle, this.keyInput.element, this.recorderPreview, this.recorderError, help);
		recorder.append(dialog);
		this._register(addDisposableListener(recorder, 'mousedown', event => {
			if (event.target === recorder && !this.saving) this.closeRecorder();
		}));
		this._register(this.keyInput.onKeyDown(event => this.recordKeybinding(event)));
		return recorder;
	}

	private openRecorder(item: KeyboardShortcutItem): void {
		if (this.isDisposed || !this.input || this.saving || !this.recorder || !this.recorderTitle || !this.keyInput) return;
		if (!this.editingItem) {
			const activeElement = this.container?.ownerDocument.activeElement;
			this.recorderReturnFocus = isHTMLElement(activeElement) ? activeElement : undefined;
		}
		this.editingItem = item;
		// Record a replacement without changing the selected rule's context or arguments.
		this.recordedChords.length = 0;
		this.recorder.querySelector('[role="dialog"]')?.setAttribute('aria-label', item.key
			? localize('keybindings.editTitle', 'Edit keybinding for {0}', item.commandLabel)
			: localize('keybindings.addTitle', 'Add keybinding for {0}', item.commandLabel));
		this.keyInput.value = '';
		this.recorderLabel.clear();
		if (this.recorderError) this.recorderError.hidden = true;
		this.recorder.hidden = false;
		this.setRecorderBackgroundInert(true);
		this.recordingContext?.set(true);
		this.keyInput.focus();
	}

	private closeRecorder(restoreFocus = true): void {
		this.editingItem = undefined;
		this.recordedChords.length = 0;
		if (this.recorder) this.recorder.hidden = true;
		this.recorderLabel.clear();
		this.setRecorderBackgroundInert(false);
		this.recordingContext?.reset();
		if (restoreFocus) {
			if (this.recorderReturnFocus?.isConnected) this.recorderReturnFocus.focus();
			else this.searchInput?.focus();
		}
		this.recorderReturnFocus = undefined;
	}

	private setRecorderBackgroundInert(inert: boolean): void {
		this.container?.classList.toggle('is-recording-keybinding', inert);
		for (const child of this.container?.children ?? []) {
			if (isHTMLElement(child) && child !== this.recorder && child !== this.status) child.inert = inert;
		}
	}

	private recordKeybinding(event: KeyboardEvent): void {
		// An outer modal host can move focus during capture; keep this nested
		// dialog's only focus target active after that handler has run.
		if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
			stopEvent(event);
			this.keyInput?.focus();
			return;
		}
		stopEvent(event);
		if (this.saving || event.repeat || event.isComposing || event.key === 'Process' || !this.keyInput) return;
		const unmodified = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
		if (unmodified && event.key === 'Enter') {
			if (this.recordedChords.length) void this.saveEditingItem();
			return;
		}
		if (unmodified && event.key === 'Escape') {
			if (this.keyInput.value) {
				this.recordedChords.length = 0;
				this.keyInput.value = '';
				this.recorderLabel.clear();
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
		if (isModifierKey(event)) {
			if (!this.recordedChords.length) {
				const keys = [
					event.ctrlKey ? 'ctrl' : '',
					event.shiftKey ? 'shift' : '',
					event.altKey ? 'alt' : '',
					event.metaKey ? 'meta' : '',
				].filter(Boolean);
				if (keys.length && this.recorderPreview) {
					const modifiers = this.keybindingService.resolveKeybinding(new Keybinding(keys.map(key => logicalKey(key))));
					this.keyInput.value = modifiers.chords.map(chord => getKeybindingLabel(
						{ chords: [chord], operatingSystem: modifiers.operatingSystem }, KeybindingLabelStyle.UserSettings,
					)).join('+');
					this.recorderLabel.value = new KeybindingLabel(this.recorderPreview, { ...defaultKeybindingLabelStyles, keybinding: modifiers, presentation: 'keycap' });
				}
			}
			return;
		}
		const chord = getKeybindingLabel(resolved, KeybindingLabelStyle.UserSettings);
		if (!chord) return;
		const restarting = this.recordedChords.length === MAX_KEYBINDING_CHORDS;
		if (restarting) this.recordedChords.length = 0;
		this.recordedChords.push(chord);
		this.keyInput.value = this.recordedChords.join(' ');
		const binding = this.keybindingService.resolveUserBinding(this.recordedChords.join(' '));
		if (binding && this.recorderPreview) {
			// Show layout labels in the field while retaining physical keys for persistence.
			this.keyInput.value = getKeybindingLabel({
				chords: binding.chords.map(chord => ({ ...chord, kind: KeybindingChordKind.Logical, key: (chord.label ?? chord.key).toLocaleLowerCase() })),
				operatingSystem: binding.operatingSystem,
			}, KeybindingLabelStyle.UserSettings);
			this.recorderLabel.value = new KeybindingLabel(this.recorderPreview, {
				...defaultKeybindingLabelStyles, keybinding: binding, presentation: 'keycap',
			});
		}
		this.setStatus(restarting
			? localize('keybindings.recordingRestarted', 'Started a new sequence after {0} chords: {1}.', MAX_KEYBINDING_CHORDS, chord)
			: localize('keybindings.recordingChords', 'Recorded {0} of {1} chords: {2}.', this.recordedChords.length, MAX_KEYBINDING_CHORDS, this.keyInput.value), false);
	}

	private async saveEditingItem(): Promise<void> {
		const item = this.editingItem;
		if (!item || !this.keyInput || this.saving) return;
		this.setSaving(true);
		this.setStatus(localize('keybindings.recordingSaving', 'Saving keybinding…'), false);
		try {
			const key = this.recordedChords.join(' ');
			if (!this.keybindingService.resolveUserBinding(key)) throw new TypeError(localize('keybindings.invalidKey', 'Enter a valid keybinding before saving.'));
			await this.keybindingEditingService.editKeybinding(item.keybindingItem, key, item.when || undefined);
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
		for (const button of this.actionButtons) button.enabled = !saving;
	}

	private async removeItem(item: KeyboardShortcutItem): Promise<void> {
		if (this.saving || !this.input) return;
		const reference = this.inputReference.value;
		try {
			if (item.source !== 'user') throw new TypeError('Only user shortcuts can be removed.');
			await this.keybindingEditingService.removeKeybinding(item.keybindingItem);
			if (this.isDisposed || this.inputReference.value !== reference) return;
			if (this.editingItem?.id === item.id) this.closeRecorder();
			this.setStatus(localize('keybindings.removed', 'Keybinding removed.'), false);
		} catch (error) {
			if (this.isDisposed || this.inputReference.value !== reference) return;
			this.setStatus(error instanceof Error ? error.message : localize('keybindings.removeFailed', 'Unable to remove the keybinding.'), true);
		}
	}

	private renderRows(): void {
		if (!this.table) return;
		// A split editor shares the input/model, but each pane owns its search field.
		const items = this.model?.fetch(this.searchInput?.value ?? '', !!this.sortSearchButton?.checked) ?? [];
		if (this.clearSearchButton) this.clearSearchButton.enabled = !!this.searchInput?.value;
		this.table.splice(0, this.table.length, items);
		const countLabel = this.sortSearchButton?.checked
			? localize('keybindings.countByPrecedence', '{0} shortcuts, sorted by precedence, highest first', items.length)
			: localize('keybindings.countAlphabetically', '{0} shortcuts, sorted alphabetically', items.length);
		if (this.count && this.count.textContent !== countLabel) this.count.textContent = countLabel;
		if (this.empty) this.empty.hidden = items.length !== 0;
		this.updateTitleArea();
	}

	private setStatus(message: string, isError: boolean): void {
		if (!this.status) return;
		if (this.recorderError && this.editingItem) {
			this.recorderError.textContent = isError ? message : '';
			this.recorderError.hidden = !isError;
		}
		this.status.textContent = message;
		this.status.hidden = false;
		this.status.classList.toggle('is-error', isError);
	}
}

interface ShortcutActionsTemplate {
	readonly element: HTMLElement;
	readonly store: DisposableStore;
	readonly edit: Button;
	readonly remove: Button;
	item: KeyboardShortcutItem | undefined;
}

function shortcutTextRenderer(column: 'when' | 'source'): ITableRenderer<KeyboardShortcutItem, { element: HTMLElement; hover: MutableDisposable<IManagedHover>; }> {
	return {
		templateId: `shortcut-${column}`,
		renderTemplate: container => {
			const element = h(container.ownerDocument, 'span');
			element.className = `ash-keybindings-${column}`;
			container.append(element);
			return { element, hover: new MutableDisposable<IManagedHover>() };
		},
		renderElement: (item, _index, template) => {
			const content = column === 'when' ? item.when : item.sourceLabel;
			template.element.textContent = content;
			template.hover.value = content ? getHoverDelegate().setupHover({ target: template.element, content }) : undefined;
		},
		disposeTemplate: template => template.hover.dispose(),
	};
}

/** Command IDs supplement names only when the free-text query matches the ID. */
function commandIdMatches(item: KeyboardShortcutItem, query: string): boolean {
	const command = item.command?.toLocaleLowerCase();
	if (!command) return false;
	const label = item.commandLabel.toLocaleLowerCase();
	const text = query.toLocaleLowerCase().replace(/@(?:source|command):\s*\S+/g, '');
	return text.split(/\s+/).some(term => term && command.includes(term) && !label.includes(term));
}

registerColor('keybindingTable.headerBackground', {
	dark: transparent('foreground', 0.04),
	light: transparent('foreground', 0.04),
	hcDark: 'editor.background',
	hcLight: 'editor.background',
}, { description: 'Background color for the keyboard shortcuts table header.', owner: 'workbench.preferences' });

registerColor('keybindingTable.rowsBackground', {
	dark: transparent('foreground', 0.04),
	light: transparent('foreground', 0.04),
	hcDark: 'editor.background',
	hcLight: 'editor.background',
}, { description: 'Background color for the keyboard shortcuts table alternating rows.', owner: 'workbench.preferences' });
