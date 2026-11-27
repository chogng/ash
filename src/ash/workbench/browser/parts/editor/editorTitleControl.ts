import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import './media/editorTitleControl.css';
import { DragAndDropObserver } from '../../../../base/browser/dnd.js';
import { DndCssClasses } from '../../../../base/browser/ui/dnd/dnd.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { autorun } from '../../../../base/common/observable.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	EditorLabelFormatConfiguration,
	EditorShowIconsConfiguration,
	EditorTabSizingConfiguration,
	EditorTabSizingFixedMaxWidthConfiguration,
	EditorTabSizingFixedMinWidthConfiguration,
	EditorTabsModeConfiguration,
	type EditorTabsMode,
} from '../../../services/editor/common/editorConfiguration.js';

import type { FileElement } from './breadcrumbsModel.js';
import { EditorHeaderControl, type EditorHeaderActions } from './editorHeaderControl.js';
import type { IBreadcrumbsService } from './breadcrumbs.js';
import type { EditorGroupId } from '../../../services/editor/common/editorState.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { LanguageDocumentSymbol } from '../../../../editor/common/languages.js';
import type { Range } from '../../../../editor/common/core/range.js';

import { EditorTabsControl, type EditorTabDescriptor, type EditorTabsDelegate } from './editorTabsControl.js';
import { MultiRowEditorControl } from './multiRowEditorTabsControl.js';
import { NoEditorTabsControl } from './noEditorTabsControl.js';
import { SingleEditorTabsControl } from './singleEditorTabsControl.js';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import type { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import type { IEditorPaneDescriptor } from '../../editor.js';

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEditorGroupViewOptions } from './editor.js';
import { containsExternalEditorDrop } from './editorDropData.js';
import { isEditorTabCopyRequested } from './editorTabDragAndDrop.js';

/** Hosts one group's Editor tabs and header in their shared title layout. */
export class EditorTitleControl extends Disposable {
	static readonly HEIGHT = 35;

	readonly domNode: HTMLDivElement;
	readonly tabStrip?: HTMLDivElement;
	private readonly headerElement: HTMLDivElement;
	private readonly headerLabel?: HTMLSpanElement;
	private readonly sizeEmitter = this._register(new Emitter<void>());
	readonly onDidChangeSize: Event<void> = this.sizeEmitter.event;
	private readonly lockIndicator: HTMLSpanElement;
	private readonly delegate: EditorTabsDelegate;
	private readonly tabsSlot = this._register(new MutableDisposable<EditorTabsControl>());
	private readonly rowsListener = this._register(new MutableDisposable());
	private tabsMode: EditorTabsMode;
	private readonly header: EditorHeaderControl;
	private editors: readonly EditorTabDescriptor[] = [];
	private selectedIds: ReadonlySet<string> | undefined;
	private activeInput: IResourceEditorInput | undefined;
	private titleVisible = true;
	private hasTitle: boolean;

	constructor(
		container: HTMLElement,
		delegate: EditorTabsDelegate,
		private readonly model: EditorGroupModel,
		titleActions: EditorHeaderActions | undefined,
		configurationService: IConfigurationService | undefined,
		onSelectBreadcrumb: ((element: FileElement) => void) | undefined,
		group: EditorGroupId | undefined,
		breadcrumbsService: IBreadcrumbsService | undefined,
		languageFeatures: ILanguageFeaturesService | undefined,
		showSymbolPicker: ((symbols: readonly LanguageDocumentSymbol[], selected: LanguageDocumentSymbol, reveal: (range: Range) => void) => void) | undefined,
		private readonly viewOptions: IEditorGroupViewOptions = {},
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.delegate = delegate;
		this.tabsMode = model.editorLimit === 1 ? 'single' : configurationService?.getValue<EditorTabsMode>(EditorTabsModeConfiguration) ?? configurationDefault<EditorTabsMode>(EditorTabsModeConfiguration);
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'div');
		this.domNode.className = 'ash-editor-title-control';
		container.append(this.domNode);
		this.headerElement = h(ownerDocument, 'div');
		this.headerElement.className = 'ash-editor-tabs-and-actions';
		this.domNode.append(this.headerElement);
		if (viewOptions.showHeader || viewOptions.menuIds?.tabsBarAddTab) {
			this.tabStrip = h(ownerDocument, 'div', { className: 'ash-editor-tab-strip' });
			this.headerElement.append(this.tabStrip);
			const context = titleActions?.contextKeyService?.createScoped(this.tabStrip);
			if (context) this._register(context);
			this._register(toDisposable(() => this.tabStrip?.remove()));
		}
		if (viewOptions.showHeader) {
			this.headerLabel = h(ownerDocument, 'span', { className: 'ash-editor-header-label' });
			(this.tabStrip ?? this.headerElement).append(this.headerLabel);
		}
		this.tabsSlot.value = this.createTabsControl(this.tabsMode);
		this.header = this._register(this.instantiationService.createInstance(EditorHeaderControl,
			this.domNode,
			this.headerElement,
			titleActions,
			configurationService,
			onSelectBreadcrumb,
			group,
			breadcrumbsService,
			languageFeatures,
			showSymbolPicker,
			viewOptions,
			this.tabStrip,
		));
		if (this.header.addTabElement) this.registerAddTabDropTarget(this.header.addTabElement);
		this.lockIndicator = h(ownerDocument, 'span');
		this.lockIndicator.className = 'ash-editor-group-lock-indicator';
		this.lockIndicator.hidden = true;
		this.headerElement.append(this.lockIndicator);
		this._register(this.header.onDidChangeHeight(() => this.sizeEmitter.fire()));
		if (viewOptions.headerRowHeight) {
			this._register(autorun(reader => {
				const height = viewOptions.headerRowHeight!.read(reader);
				for (const node of [this.domNode, this.headerElement]) {
					if (height === undefined) node.style.removeProperty('--ash-pane-titleHeight');
					else node.style.setProperty('--ash-pane-titleHeight', `${height}px`);
				}
				this.sizeEmitter.fire();
			}));
		}
		if (configurationService) {
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (model.editorLimit !== 1 && event.affectsConfiguration(EditorTabsModeConfiguration)) {
					this.tabsMode = configurationService.getValue<EditorTabsMode>(EditorTabsModeConfiguration);
					this.tabsSlot.value = this.createTabsControl(this.tabsMode);
					this.tabs.setEditors(this.editors, this.activeInput, this.selectedIds);
					this.updateRows();
					this.sizeEmitter.fire();
				} else if (this.tabStrip && (
					event.affectsConfiguration(EditorTabSizingConfiguration)
					|| event.affectsConfiguration(EditorTabSizingFixedMinWidthConfiguration)
					|| event.affectsConfiguration(EditorTabSizingFixedMaxWidthConfiguration)
					|| event.affectsConfiguration(EditorLabelFormatConfiguration)
					|| event.affectsConfiguration(EditorShowIconsConfiguration)
				)) {
					this.sizeEmitter.fire();
				}
			}));
		}
		this.hasTitle = model.editorLimit === 1 || !!viewOptions.showHeader;
		this.updateVisibility();
		this._register(toDisposable(() => this.domNode.remove()));
	}

	get height(): number {
		if (this.domNode.hidden) return 0;
		return this.tabsHeight + this.header.height;
	}

	get editorToolbarHost(): HTMLElement | undefined {
		return this.domNode.hidden ? undefined : this.header.editorToolbarHost;
	}

	get tabsHeight(): number {
		if (this.domNode.hidden) return 0;
		const rows = this.tabs instanceof MultiRowEditorControl ? this.tabs.rowCount : 1;
		const rowHeight = this.viewOptions.headerRowHeight?.get()
			?? (this.viewOptions.showHeader ? EditorHeaderControl.HEIGHT : EditorTitleControl.HEIGHT);
		return Math.max(rowHeight * rows, this.header.toolbarRowHeight);
	}

	setVisible(visible: boolean): boolean {
		if (this.titleVisible === visible) return false;
		this.titleVisible = visible;
		this.updateVisibility();
		return true;
	}

	get singleRowTabStripSize(): IDimension | undefined {
		const strip = this.tabStrip;
		if (!strip || strip.hidden || (this.tabs instanceof MultiRowEditorControl && this.tabs.rowCount > 1)) return undefined;

		const ownerWindow = strip.ownerDocument.defaultView!;
		const activeTab = strip.querySelector<HTMLElement>('.ash-tab.checked');
		const label = this.headerLabel?.hidden ? undefined : this.headerLabel;
		const addTab = this.header.addTabElement;
		const items = [activeTab ?? label, addTab].filter((item): item is HTMLElement => !!item?.getClientRects().length);
		if (!items.length) return undefined;

		const gap = parseFloat(ownerWindow.getComputedStyle(strip).columnGap) || 0;
		const layoutActionsWidth = this.viewOptions.hostLayoutActionsWithTabs ? this.header.layoutActionsWidth : 0;
		let width = gap * (items.length - 1) + (layoutActionsWidth ? layoutActionsWidth + gap : 0);
		let height = this.tabs.domNode.getBoundingClientRect().height;
		for (const item of items) {
			const bounds = item.getBoundingClientRect();
			if (item === activeTab) {
				// Shrink and fixed sizing modes already declare their minimum usable tab width.
				width += parseFloat(ownerWindow.getComputedStyle(item).minWidth) || bounds.width;
			} else {
				width += item === label ? Math.max(bounds.width, item.scrollWidth) : bounds.width;
			}
			height = Math.max(height, bounds.height);
		}
		return { width, height };
	}

	get tabsHosted(): boolean {
		return !!this.tabStrip && this.tabStrip.parentElement !== this.headerElement;
	}

	setTabStripHost(host: HTMLElement | undefined): void {
		const strip = this.tabStrip;
		const target = host ?? this.headerElement;
		if (!strip || strip.parentElement === target) return;
		const previousHeight = this.height;
		const focused = strip.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = strip.contains(focused);
		strip.classList.toggle('ash-editor-tab-strip-hosted', !!host);
		this.domNode.classList.toggle('ash-editor-title-tabs-hosted', !!host);
		target.prepend(strip);
		if (this.viewOptions.hostLayoutActionsWithTabs) this.header.setLayoutActionsHost(host);
		this.updateVisibility();
		if (restoreFocus && focused?.isConnected) focused.focus({ preventScroll: true });
		if (this.viewOptions.hostLayoutActionsWithTabs || this.height !== previousHeight) this.sizeEmitter.fire();
	}

	setEditorTypes(choices: readonly IEditorPaneDescriptor[], select: (id: string) => Promise<unknown>): void {
		this.header.setEditorTypes(choices, select);
	}

	setLocked(locked: boolean): void {
		this.lockIndicator.hidden = !locked;
		this.lockIndicator.textContent = locked ? localize('workbench.editorGroupLocked', 'Locked') : '';
	}

	setEditors(
		editors: readonly EditorTabDescriptor[],
		activeInput: IResourceEditorInput | undefined,
		activePane?: IEditorPane,
		selectedIds?: ReadonlySet<string>,
	): void {
		const previousHeight = this.height;
		const wasHidden = this.domNode.hidden;
		this.editors = editors;
		this.selectedIds = selectedIds;
		this.activeInput = activeInput;
		this.tabs.setEditors(editors, activeInput, selectedIds);
		this.header.setInput(activeInput, activePane);
		// Single-content hosts retain their group controls even without an editor.
		this.hasTitle = (this.viewOptions.showHeader || this.model.editorLimit === 1 || editors.length > 0)
			&& !(editors.length === 1 && activePane?.prefersEditorTitleHidden === true);
		this.updateVisibility();
		if (this.domNode.hidden !== wasHidden || this.height !== previousHeight) this.sizeEmitter.fire();
	}

	private updateVisibility(): void {
		const visible = this.titleVisible && this.hasTitle;
		const showHeader = !this.tabsHosted || this.viewOptions.showHeaderFor?.(this.activeInput) !== false;
		this.domNode.hidden = this.headerElement.hidden = !visible || !showHeader;
		if (this.tabStrip) this.tabStrip.hidden = !visible;
		this.updateRows();
	}

	private updateRows(): void {
		if (this.headerLabel) {
			const hasTabs = this.tabsMode === 'single'
				? this.activeInput !== undefined
				: this.tabsMode === 'multiple' && this.editors.length > 0;
			const label = this.activeInput?.label ?? this.viewOptions.emptyHeaderLabel ?? '';
			this.headerLabel.hidden = hasTabs || !label;
			if (this.headerLabel.textContent !== label) this.headerLabel.textContent = label;
		}
		const rows = this.headerElement.hidden ? 0 : this.tabs instanceof MultiRowEditorControl ? this.tabs.rowCount : 1;
		this.domNode.style.setProperty('--ash-editor-tab-rows', String(rows));
	}

	private registerAddTabDropTarget(element: HTMLElement): void {
		const clearFeedback = (): void => { element.classList.remove(DndCssClasses.DropBefore); };
		// Add Tab sits outside the scrollable tab list but shares its end insertion point.
		this._register(new DragAndDropObserver(element, {
			onDragOver: event => {
				const local = this.delegate.isDragging();
				const accepted = local || containsExternalEditorDrop(event);
				element.classList.toggle(DndCssClasses.DropBefore, accepted);
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = local
						? this.delegate.getDragOperation?.(isEditorTabCopyRequested(event)) ?? 'move'
						: accepted ? 'copy' : 'none';
				}
			},
			onDragLeave: clearFeedback,
			onDrop: event => {
				clearFeedback();
				const local = this.delegate.isDragging();
				if (!local && !containsExternalEditorDrop(event)) return;
				event.preventDefault();
				event.stopPropagation();
				if (local) this.delegate.drop(undefined, 'after', isEditorTabCopyRequested(event));
				else this.delegate.dropExternal(event, undefined, 'after');
			},
		}));
	}

	private createTabsControl(mode: EditorTabsMode): EditorTabsControl {
		this.headerElement.classList.toggle('multiple', mode === 'multiple');
		const parent = this.tabStrip ?? this.headerElement;
		const firstAction = parent.querySelector(':scope > :is(.ash-editor-add-tab, .ash-editor-tabs-trailing, .ash-editor-header-primary, .ash-editor-title-actions)');
		const control = mode === 'single'
			? this.instantiationService.createInstance(SingleEditorTabsControl, parent, this.delegate, this.model)
			: mode === 'none'
				? new NoEditorTabsControl(parent)
				: this.instantiationService.createInstance(MultiRowEditorControl, parent, this.delegate, this.model);
		this.rowsListener.value = control instanceof MultiRowEditorControl
			? control.onDidChangeRows(() => {
				this.updateRows();
				this.sizeEmitter.fire();
			})
			: undefined;
		if (firstAction) parent.insertBefore(control.domNode, firstAction);
		return control;
	}

	private get tabs(): EditorTabsControl {
		const tabs = this.tabsSlot.value;
		if (!tabs) throw new ReferenceError('Editor tabs control is not available');
		return tabs;
	}
}

function configurationDefault<T>(key: string): T {
	const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key) as IRegisteredConfiguration<T> | undefined;
	if (!configuration) throw new RangeError(`Unknown configuration: ${key}`);
	return configuration.defaultValue;
}
