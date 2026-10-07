import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { Range } from '../../../../editor/common/core/range.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ITextModelService, type IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import type { IEditorDecorationsCollection, ICodeEditorViewState } from '../../../../editor/common/editorCommon.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { localize } from '../../../../nls.js';
import { addDisposableListener, h, stopEvent } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { ActionViewItem, ActionViewItemOptions } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { DropdownMenuActionViewItem } from "../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js";
import { Separator, SubmenuAction, type IAction } from "../../../../base/common/actions.js";
import type { Icon } from "../../../../base/common/icon.js";
import { MutableDisposable, toDisposable, type IDisposable, type IReference } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import { type IOutputChannel, type IOutputEntry, IOutputService, CONTEXT_IN_OUTPUT, OutputSeverities, OPEN_OUTPUT_IN_EDITOR_COMMAND_ID, EXPORT_OUTPUT_COMMAND_ID, type OutputEntrySeverity, type IOutputViewFilters } from "../../../services/output/common/output.js";

import "./output.css";

const SelectChannelActionId = "ash.output.selectChannel";
const FilterActionId = "ash.output.filter";
const ClearChannelActionId = "ash.output.clear";
const AutoScrollActionId = "ash.output.autoScroll";
const MoreActionId = "ash.output.more";
const AutoScrollStorageKey = "output.autoScroll";

/** Generic Output channel projection with filtering, navigation, and export. */
export class OutputViewPane extends ViewPane {
	private readonly activeChannelListener = this._register(new MutableDisposable<IDisposable>());
	private readonly modelReference = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly editor: CodeEditorWidget;
	private readonly decorations: IEditorDecorationsCollection;
	private readonly viewStates = new Map<string, ICodeEditorViewState>();
	private loadedModel: TextModel | null = null;
	private boundChannel: IOutputChannel | undefined;
	private changingContent = false;
	private focusRequested = false;
	private readonly filters: IOutputViewFilters;
	private readonly filterInput: HTMLInputElement;
	private readonly content: HTMLDivElement;
	private readonly titleActions: ActionBar;
	private autoScroll: boolean;
	private titleStateKey = "";

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IOutputService private readonly outputService: IOutputService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@ITextModelService private readonly textModels: ITextModelService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super(container, options);
		this.contentElement.classList.add("ash-output");
		this.filters = outputService.filters;
		this.autoScroll = storageService.getBoolean(AutoScrollStorageKey, StorageScope.WORKSPACE, true);
		this.titleActions = this._register(new ActionBar(this.headerActionsElement, { ariaLabel: localize('output.actions', 'Output actions'), highlightToggledItems: true, actionViewItemProvider: (action, actionOptions) => this.createActionViewItem(action, actionOptions) }));
		this.titleActions.element.classList.add("ash-toolbar", "ash-output-title-actions");
		const filterBar = h(container.ownerDocument, "div");
		filterBar.className = "ash-output-filter-bar";
		this.filterInput = h(container.ownerDocument, "input");
		this.filterInput.className = "ash-output-filter-input";
		this.filterInput.type = "search";
		this.filterInput.placeholder = localize('output.filterPlaceholder', 'Filter Output (prefix with ! to exclude)');
		this.filterInput.setAttribute("aria-label", localize('output.filter', 'Filter Output'));
		this.filterInput.value = this.filters.text;
		filterBar.append(this.filterInput);
		this.content = h(container.ownerDocument, "div");
		this.content.className = "ash-output-content";
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Output);
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container: this.content, model: null, readOnly: true,
			ariaLabel: [localize('output.editorLabel', 'Output'), hint].filter(Boolean).join('. '),
			lineNumbers: 'off', minimap: { enabled: false }, wordWrap: 'on',
			suggestions: { enabled: false }, inlineCompletions: { enabled: false },
		}));
		this.decorations = this.editor.createDecorationsCollection();
		const focused = CONTEXT_IN_OUTPUT.bindTo(contextKeys);
		this._register(toDisposable(() => focused.reset()));
		this._register(addDisposableListener(this.contentElement, 'focusin', () => focused.set(true)));
		this._register(addDisposableListener<FocusEvent>(this.contentElement, 'focusout', event => {
			if (!this.contentElement.contains(event.relatedTarget as Node | null)) focused.set(false);
		}));
		this.contentElement.append(filterBar, this.content);
		this._register(addDisposableListener(this.filterInput, "input", () => this.filters.setText(this.filterInput.value)));
		this._register(addDisposableListener(this.filterInput, "keydown", event => {
			if (event.key !== "Escape" || !this.filterInput.value) return;
			stopEvent(event);
			this.filterInput.value = "";
			this.filters.setText("");
		}));
		this._register(this.editor.onDidScrollChange(event => { if (event.scrollTopChanged && !this.changingContent) this.acceptScrollPosition(); }));
		this._register(outputService.onDidChangeChannels(() => {
			for (const id of this.viewStates.keys()) {
				if (!outputService.getChannel(id)) {
					this.viewStates.delete(id);
				}
			}
			this.render();
		}));
		this._register(outputService.onDidChangeActiveChannel(channel => { void this.bindActiveChannel(channel); }));
		this._register(this.filters.onDidChange(() => this.render()));
		void this.bindActiveChannel(outputService.activeChannel);
	}

	override get partTitleProjection(): PartTitleProjection { return { actions: this.titleActions.element }; }

	public override focus(): void {
		this.focusRequested = this.editor.getModel() === null;
		this.editor.focus();
	}

	protected override layoutBody(height: number, width: number): void {
		this.editor.layout({ width, height: Math.max(0, height - this.filterInput.parentElement!.offsetHeight) });
	}

	private async bindActiveChannel(channel: IOutputChannel | undefined): Promise<void> {
		const viewState = this.editor.saveViewState();
		if (this.boundChannel && viewState) this.viewStates.set(this.boundChannel.id, viewState);
		this.boundChannel = channel;
		this.editor.setModel(null);
		this.loadedModel = null;
		this.modelReference.clear();
		this.activeChannelListener.value = channel?.onDidChange(() => this.render());
		this.render();
		if (!channel) {
			return;
		}
		try {
			const reference = await this.textModels.createModelReference(channel.uri);
			if (this.isDisposed || this.boundChannel !== channel) {
				reference.dispose();
				return;
			}
			const model = reference.object.textEditorModel;
			if (!(model instanceof TextModel)) {
				reference.dispose();
				throw new TypeError('Output requires a TextModel');
			}
			this.modelReference.value = reference;
			this.loadedModel = model;
			this.editor.setModel(model);
			this.editor.restoreViewState(this.viewStates.get(channel.id) ?? null);
			this.render();
			if (this.focusRequested && this.isVisible()) {
				this.focusRequested = false;
				this.editor.focus();
			}
		} catch (error) {
			if (!this.isDisposed && this.boundChannel === channel) {
				onUnexpectedError(error);
			}
		}
	}

	private render(): void {
		const active = this.outputService.activeChannel;
		const categories = active ? categoriesOf(active.entries) : [];
		const titleStateKey = [this.outputService.channels.map(channel => channel.id).join("\0"), active?.id ?? "", (active?.entries.length ?? 0) > 0, this.autoScroll, this.filters.text, ...OutputSeverities.map(severity => this.filters.isSeverityVisible(severity)), ...categories.map(category => `${category}:${this.filters.isCategoryVisible(category)}`)].join("\u0001");
		if (titleStateKey !== this.titleStateKey) {
			this.titleStateKey = titleStateKey;
			this.titleActions.updateActions(this.createTitleActions(active));
		}
		this.filterInput.value = this.filters.text;
		const model = this.loadedModel;
		if (!active || !model) return;
		const visibleLines = new Map<number, boolean>();
		const severities = new Map<number, OutputEntrySeverity>();
		let line = 1;
		let previousEndedWithCarriageReturn = false;
		for (const entry of active.entries) {
			const recordMatches = active.kind === 'log' && this.filters.matches(entry);
			const text = previousEndedWithCarriageReturn && entry.text.startsWith('\n') ? entry.text.slice(1) : entry.text;
			previousEndedWithCarriageReturn = entry.text.endsWith('\r');
			const count = (text.match(/\r\n|\r|\n/g) ?? []).length;
			const end = line + count - (/[\r\n]$/.test(entry.text) || text.length === 0 ? 1 : 0);
			for (let number = line; number <= end; number++) {
				// Ordinary output is a stream: one model line may span or share producer writes.
				const matches = active.kind === 'log' ? recordMatches : this.filters.matches({ ...entry, text: model.getLineContent(number) });
				visibleLines.set(number, Boolean(visibleLines.get(number)) || matches);
				severities.set(number, entry.severity);
			}
			line += count;
		}
		this.changingContent = true;
		try {
			const hasVisibleContent = [...visibleLines.values()].some(Boolean);
			if (!hasVisibleContent && active.entries.length > 0) { this.editor.setModel(null); return; }
			if (this.editor.getModel() !== model) this.editor.setModel(model);
			this.editor.setHiddenAreas([...visibleLines].filter(([, visible]) => !visible).map(([number]) => new Range(number, 1, number, model.getLineMaxColumn(number))));
			this.decorations.set([...severities].filter(([, severity]) => severity === 'error' || severity === 'warning').map(([number, severity]) => ({ range: new Range(number, 1, number, model.getLineMaxColumn(number)), options: { description: 'output-severity', inlineClassName: `ash-output-${severity}` } })));
			if (this.autoScroll) this.scrollToEnd();
		} finally { this.changingContent = false; }
	}

	private createActionViewItem(action: IAction, options: ActionViewItemOptions): ActionViewItem | undefined {
		if (action.id === SelectChannelActionId) return new DropdownMenuActionViewItem(action, () => this.channelActions(), this.contextMenuService, options);
		if (action.id === FilterActionId) return new DropdownMenuActionViewItem(action, () => this.filterActions(), this.contextMenuService, options);
		if (action.id === MoreActionId) return new DropdownMenuActionViewItem(action, () => this.moreActions(), this.contextMenuService, options);
		return undefined;
	}

	private createTitleActions(active: IOutputChannel | undefined): readonly IAction[] {
		return [
			this.action(SelectChannelActionId, active?.label ?? localize('output.selectChannel', 'Select Output Channel'), localize('output.selectChannel', 'Select Output Channel'), undefined, this.outputService.channels.length > 0, undefined, () => undefined),
			this.action(FilterActionId, localize('output.filter', 'Filter Output'), localize('output.filter', 'Filter Output'), Lxicon.filter, Boolean(active), undefined, () => undefined),
			this.action(ClearChannelActionId, localize('output.clear', 'Clear Output'), active ? localize('output.clearChannel', 'Clear {0}', active.label) : localize('output.clear', 'Clear Output'), Lxicon.eraser, (active?.entries.length ?? 0) > 0, undefined, () => active?.clear()),
			this.action(AutoScrollActionId, localize('output.autoScroll', 'Auto Scroll'), this.autoScroll ? localize('output.autoScrollOn', 'Auto Scroll: On') : localize('output.autoScrollOff', 'Auto Scroll: Off'), Lxicon.pinned, Boolean(active), this.autoScroll, () => this.toggleAutoScroll()),
			this.action(MoreActionId, localize('output.more', 'More Output Actions'), localize('output.more', 'More Output Actions'), Lxicon.ellipsis, Boolean(active), undefined, () => undefined),
		];
	}

	private channelActions(): readonly IAction[] {
		const activeId = this.outputService.activeChannel?.id;
		return this.outputService.channels.map(channel => this.action(`ash.output.channel.${channel.id}`, channel.label, channel.label, undefined, true, channel.id === activeId, () => this.outputService.selectChannel(channel.id)));
	}

	private filterActions(): readonly IAction[] {
		const categories = categoriesOf(this.outputService.activeChannel?.entries ?? []);
		const levelActions = (["trace", "debug", "information", "warning", "error"] as const).map(severity => this.action(`ash.output.filter.minimum.${severity}`, severityLabel(severity), localize('output.showMinimum', 'Show {0} and above', severityLabel(severity)), undefined, true, undefined, () => this.filters.setMinimumSeverity(severity)));
		const logLevel = new SubmenuAction("ash.output.filter.minimum", localize('output.logLevel', 'Log Level'), levelActions);
		const severityActions = OutputSeverities.map(severity => this.action(`ash.output.filter.severity.${severity}`, severityLabel(severity), localize('output.showSeverity', 'Show {0}', severityLabel(severity)), undefined, true, this.filters.isSeverityVisible(severity), () => this.filters.setSeverityVisible(severity, !this.filters.isSeverityVisible(severity))));
		const categoryActions = categories.map(category => this.action(`ash.output.filter.category.${category}`, category, localize('output.showCategory', 'Show category {0}', category), undefined, true, this.filters.isCategoryVisible(category), () => this.filters.setCategoryVisible(category, !this.filters.isCategoryVisible(category))));
		return [logLevel, new Separator(), ...severityActions, ...(categoryActions.length ? [new Separator(), ...categoryActions] : []), new Separator(), this.action("ash.output.filter.reset", localize('output.reset', 'Reset Filters'), localize('output.resetTooltip', 'Reset Output Filters'), undefined, true, undefined, () => { this.filterInput.value = ""; this.filters.reset(); })];
	}

	private moreActions(): readonly IAction[] {
		const active = this.outputService.activeChannel;
		if (!active) return [];
		return [
			this.action("ash.output.openInEditor", localize('output.openEditor', 'Open Output in Editor'), localize('output.openChannel', 'Open {0} in Editor', active.label), Lxicon.linkExternal, true, undefined, () => this.commands.executeCommand(OPEN_OUTPUT_IN_EDITOR_COMMAND_ID)),
			this.action("ash.output.export", localize('output.export', 'Export Output…'), localize('output.exportChannel', 'Export {0}', active.label), Lxicon.download, true, undefined, () => this.commands.executeCommand(EXPORT_OUTPUT_COMMAND_ID)),
		];
	}

	private toggleAutoScroll(): void {
		this.autoScroll = !this.autoScroll;
		this.persistAutoScroll();
		this.titleStateKey = "";
		if (this.autoScroll) this.scrollToEnd();
		this.render();
	}

	private acceptScrollPosition(): void {
		const atEnd = this.editor.getContentHeight() - this.editor.getScrollTop() - this.editor.getLayoutInfo().height <= 2;
		if (this.autoScroll === atEnd) return;
		this.autoScroll = atEnd;
		this.persistAutoScroll();
		this.titleStateKey = "";
		this.titleActions.updateActions(this.createTitleActions(this.outputService.activeChannel));
	}

	private persistAutoScroll(): void {
		this.storageService.store(AutoScrollStorageKey, this.autoScroll, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private scrollToEnd(): void { this.editor.setScrollTop(this.editor.getContentHeight()); }

	private action(id: string, label: string, tooltip: string, icon: Icon | undefined, enabled: boolean, checked: boolean | undefined, run: () => unknown): IAction {
		return { id, label, tooltip, icon, enabled, checked, run };
	}
}

function categoriesOf(entries: readonly IOutputEntry[]): readonly string[] {
	return [...new Set(entries.map(entry => entry.category).filter((value): value is string => Boolean(value)))].sort();
}

function severityLabel(severity: OutputEntrySeverity): string {
	return {
		trace: localize('output.severity.trace', 'Trace'),
		debug: localize('output.severity.debug', 'Debug'),
		information: localize('output.severity.information', 'Info'),
		warning: localize('output.severity.warning', 'Warning'),
		error: localize('output.severity.error', 'Error'),
		log: localize('output.severity.log', 'Log'),
	}[severity];
}
