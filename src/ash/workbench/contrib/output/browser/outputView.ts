import { IDefaultLogLevelsService } from '../../../services/log/common/defaultLogLevels.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CursorChangeReason, type ICursorPositionChangedEvent } from '../../../../editor/common/cursorEvents.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
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
import { MutableDisposable, DisposableStore, toDisposable, type IDisposable, type IReference } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { LogLevel } from '../../../../platform/log/common/log.js';
import { CONTEXT_SAVED_LOGS_AVAILABLE, OPEN_SAVED_LOGS_COMMAND_ID } from '../../../services/output/common/output.js';
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
	private readonly loadingProgress = this._register(new MutableDisposable());
	private readonly activeChannelListener = this._register(new MutableDisposable<IDisposable>());
	private readonly modelReference = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly editor: CodeEditorWidget;
	private readonly decorations: IEditorDecorationsCollection;
	private readonly viewStates = new Map<string, ICodeEditorViewState>();
	private loadedModel: TextModel | null = null;
	private boundChannel: IOutputChannel | undefined;
	private changingContent = false;
	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.render(), 0));
	private focusRequested = false;
	private readonly filters: IOutputViewFilters;
	private readonly filterInput: HTMLInputElement;
	private readonly filterBar: HTMLDivElement;
	private readonly filterWidget: HTMLDivElement;
	private readonly filterToolbar: ActionBar;
	private readonly titleControls: HTMLDivElement;
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
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDefaultLogLevelsService private readonly defaultLogLevels: IDefaultLogLevelsService,
	) {
		super(container, options);
		this.contentElement.classList.add("ash-output");
		this.filters = outputService.filters;
		this._register(defaultLogLevels.onDidChangeDefaultLogLevels(() => this.renderScheduler.schedule()));
		this.autoScroll = storageService.getBoolean(AutoScrollStorageKey, StorageScope.WORKSPACE, true);
		this.titleControls = h(container.ownerDocument, "div");
		this.titleControls.className = "ash-output-title-actions";
		this.headerActionsElement.append(this.titleControls);
		this._register(toDisposable(() => this.titleControls.remove()));
		this.titleActions = this._register(new ActionBar(this.titleControls, { actionViewItemOptions: { buttonStyles: defaultButtonStyles }, ariaLabel: localize('output.actions', 'Output actions'), highlightToggledItems: true, actionViewItemProvider: (action, actionOptions) => this.createActionViewItem(action, actionOptions) }));
		this.titleActions.element.classList.add("ash-toolbar");
		this.filterBar = h(container.ownerDocument, "div");
		this.filterBar.className = "ash-output-filter-bar";
		this.filterBar.hidden = true;
		this.filterWidget = h(container.ownerDocument, "div");
		this.filterWidget.className = "ash-output-filter-widget";
		this.filterInput = h(container.ownerDocument, "input");
		this.filterInput.className = "ash-output-filter-input";
		this.filterInput.type = "search";
		this.filterInput.placeholder = localize('output.filterPlaceholder', 'Filter Output (text1,text2,!exclude)');
		this.filterInput.setAttribute("aria-label", localize('output.filter', 'Filter Output'));
		this.filterInput.value = this.filters.text;
		this.filterWidget.append(this.filterInput);
		this.filterToolbar = this._register(new ActionBar(this.filterWidget, { actionViewItemOptions: { buttonStyles: defaultButtonStyles }, ariaLabel: localize('output.filter', 'Filter Output'), highlightToggledItems: true, actionViewItemProvider: (action, actionOptions) => this.createActionViewItem(action, actionOptions) }));
		this.filterToolbar.element.classList.add("ash-toolbar");
		this.titleControls.prepend(this.filterWidget);
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
		for (const root of [this.contentElement, this.titleControls]) {
			this._register(addDisposableListener(root, 'focusin', () => focused.set(true)));
			this._register(addDisposableListener<FocusEvent>(root, 'focusout', event => {
				const next = event.relatedTarget as Node | null;
				if (!this.contentElement.contains(next) && !this.titleControls.contains(next)) focused.set(false);
			}));
		}
		this.contentElement.append(this.filterBar, this.content);
		this._register(addDisposableListener(this.filterInput, "input", () => this.filters.setText(this.filterInput.value)));
		this._register(addDisposableListener(this.filterInput, "keydown", event => {
			if (event.key !== "Escape" || !this.filterInput.value) return;
			stopEvent(event);
			this.filterInput.value = "";
			this.filters.setText("");
		}));
		this._register(this.editor.onDidChangeCursorPosition(event => this.handleCursorPosition(event)));
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

	override get partTitleProjection(): PartTitleProjection { return { actions: this.titleControls }; }

	public override focus(): void {
		this.focusRequested = this.editor.getModel() === null;
		this.editor.focus();
	}

	protected override layoutBody(height: number, width: number): void {
		// Match the Output layout policy: narrow panes reserve a body row unless height is scarce.
		const inHeader = width >= 600 || height <= 100;
		const host = inHeader ? this.titleControls : this.filterBar;
		this.filterBar.hidden = inHeader;
		if (this.filterWidget.parentElement !== host) {
			const active = this.filterWidget.ownerDocument.activeElement;
			const focused = this.filterWidget.contains(active) ? active as HTMLElement : undefined;
			const { selectionStart, selectionEnd, selectionDirection } = this.filterInput;
			host.insertBefore(this.filterWidget, inHeader ? this.titleActions.element : null);
			// Reparent the existing control so its value, caret and keyboard focus survive resizing.
			focused?.focus({ preventScroll: true });
			if (focused === this.filterInput) this.filterInput.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
		}
		this.editor.layout({ width, height: Math.max(0, height - this.filterBar.offsetHeight) });
	}

	private async bindActiveChannel(channel: IOutputChannel | undefined): Promise<void> {
		this.loadingProgress.clear();
		const viewState = this.editor.saveViewState();
		if (this.boundChannel && viewState) this.viewStates.set(this.boundChannel.id, viewState);
		this.changeContent(() => {
			this.boundChannel = channel;
			this.editor.setModel(null);
			this.loadedModel = null;
			this.modelReference.clear();
			// Rendering can itself emit diagnostics. Coalesce channel events and yield
			// between passes; disposing this pane cancels the owned pending refresh.
			const listeners = new DisposableStore();
			if (channel) {
				listeners.add(channel.onDidChange(() => this.renderScheduler.schedule()));
				if (channel.descriptor.logger) listeners.add(channel.descriptor.logger.control.onDidChangeLogLevel(() => this.renderScheduler.schedule()));
			}
			this.activeChannelListener.value = listeners;
		});
		this.render();
		if (!channel) {
			return;
		}
		try {
			const loading = this.textModels.createModelReference(channel.uri);
			const progress = this.getProgressIndicator().show(true, 150);
			const handle = toDisposable(() => progress.done());
			this.loadingProgress.value = handle;
			const finish = (): void => { if (this.loadingProgress.value === handle) this.loadingProgress.clear(); };
			void loading.then(finish, finish);
			const reference = await loading;
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
			this.changeContent(() => {
				this.loadedModel = model;
				this.editor.setModel(model);
				this.editor.restoreViewState(this.viewStates.get(channel.id) ?? null);
			});
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

	private changeContent(change: () => void): void {
		// Nested channel changes must leave the outer editor operation guarded.
		const changingContent = this.changingContent;
		this.changingContent = true;
		try { change(); }
		finally { this.changingContent = changingContent; }
	}

	private render(): void {
		if (this.changingContent) { this.renderScheduler.schedule(); return; }
		this.renderScheduler.cancel();
		// Guard title updates as well as model operations: both can emit logs.
		this.changeContent(() => this.renderContent());
	}

	private renderContent(): void {
		const active = this.outputService.activeChannel;
		const categories = active ? categoriesOf(active.entries) : [];
		const titleStateKey = [this.outputService.channels.map(channel => channel.id).join("\0"), active?.id ?? "", (active?.entries.length ?? 0) > 0, this.autoScroll, active?.descriptor.logger?.control.getLevel() ?? "", this.filters.text, this.defaultLogLevels.getDefaultLogLevel(active?.descriptor.extensionId), ...OutputSeverities.map(severity => this.filters.isSeverityVisible(severity)), ...categories.map(category => `${category}:${this.filters.isCategoryVisible(category, active!.id)}`)].join("\u0001");
		if (titleStateKey !== this.titleStateKey) {
			this.titleStateKey = titleStateKey;
			this.titleActions.updateActions(this.createTitleActions(active));
			this.titleActions.element.querySelector<HTMLElement>(`[data-action-id="${SelectChannelActionId}"]`)?.classList.add('ash-output-channel-picker');
			const filtered = OutputSeverities.some(severity => !this.filters.isSeverityVisible(severity)) || categories.some(category => !this.filters.isCategoryVisible(category, active!.id));
			this.filterWidget.classList.toggle('filtered', filtered);
			const filterLabel = filtered ? localize('output.filterActive', 'Filter Output (Filters Active)') : localize('output.filter', 'Filter Output');
			this.filterToolbar.updateActions([this.action(FilterActionId, filterLabel, filterLabel, Lxicon.filter, Boolean(active), undefined, () => undefined)]);
		}
		this.filterInput.value = this.filters.text;
		let description: string | undefined;
		switch (this.filters.textFilterNotice) {
			case 'restored': description = localize('output.filterRestored', 'Saved filter restored. Edit or clear to use comma-separated filters.'); break;
			case 'unsupported': description = localize('output.filterUnsupported', 'A newer saved filter is preserved. Changes in this window are not saved.'); break;
		}
		if (description) {
			this.filterInput.title = description;
			this.filterInput.setAttribute('aria-description', description);
		} else {
			this.filterInput.removeAttribute('title');
			this.filterInput.removeAttribute('aria-description');
		}
		const model = this.loadedModel;
		if (!active || !model) return;
		const visibleLines = new Map<number, boolean>();
		const severities = new Map<number, OutputEntrySeverity>();
		let line = 1;
		let previousEndedWithCarriageReturn = false;
		for (const entry of active.entries) {
			const recordMatches = active.kind === 'log' && this.filters.matches(entry, active.id);
			const text = previousEndedWithCarriageReturn && entry.text.startsWith('\n') ? entry.text.slice(1) : entry.text;
			previousEndedWithCarriageReturn = entry.text.endsWith('\r');
			const count = (text.match(/\r\n|\r|\n/g) ?? []).length;
			const end = line + count - (/[\r\n]$/.test(entry.text) || text.length === 0 ? 1 : 0);
			for (let number = line; number <= end; number++) {
				// Ordinary output is a stream: one model line may span or share producer writes.
				const matches = active.kind === 'log' ? recordMatches : this.filters.matches({ ...entry, text: model.getLineContent(number) }, active.id);
				visibleLines.set(number, Boolean(visibleLines.get(number)) || matches);
				severities.set(number, entry.severity);
			}
			line += count;
		}
		this.changeContent(() => {
			const hasVisibleContent = [...visibleLines.values()].some(Boolean);
			if (!hasVisibleContent && active.entries.length > 0) { this.editor.setModel(null); return; }
			if (this.editor.getModel() !== model) this.editor.setModel(model);
			this.editor.setHiddenAreas([...visibleLines].filter(([, visible]) => !visible).map(([number]) => new Range(number, 1, number, model.getLineMaxColumn(number))));
			this.decorations.set([...severities].filter(([, severity]) => severity === 'error' || severity === 'warning').map(([number, severity]) => ({ range: new Range(number, 1, number, model.getLineMaxColumn(number)), options: { description: 'output-severity', inlineClassName: `ash-output-${severity}` } })));
			if (this.autoScroll) this.scrollToEnd();
		});
	}

	private createActionViewItem(action: IAction, options: ActionViewItemOptions): ActionViewItem | undefined {
		if (action.id === SelectChannelActionId) return new DropdownMenuActionViewItem(action, () => this.channelActions(), this.contextMenuService, options);
		if (action.id === FilterActionId) return new DropdownMenuActionViewItem(action, () => this.filterActions(), this.contextMenuService, options);
		if (action.id === MoreActionId) return new DropdownMenuActionViewItem(action, () => this.moreActions(), this.contextMenuService, options);
		return undefined;
	}

	private createTitleActions(active: IOutputChannel | undefined): readonly IAction[] {
		return [
			this.action(SelectChannelActionId, active?.label ?? localize('output.selectChannel', 'Select Output Channel'), active ? localize('output.selectNamedChannel', 'Select Output Channel: {0}', active.label) : localize('output.selectChannel', 'Select Output Channel'), undefined, this.outputService.channels.length > 0, undefined, () => undefined),
			this.action(ClearChannelActionId, localize('output.clear', 'Clear Output'), active ? localize('output.clearChannel', 'Clear {0}', active.label) : localize('output.clear', 'Clear Output'), Lxicon.clearAll, (active?.entries.length ?? 0) > 0, undefined, () => active?.clear()),
			this.action(AutoScrollActionId, localize('output.autoScroll', 'Auto Scroll'), this.autoScroll ? localize('output.pauseFollow', 'Pause Following Output') : localize('output.resumeFollow', 'Follow New Output'), Lxicon.follow, Boolean(active), this.autoScroll, () => this.toggleAutoScroll()),
			this.action(MoreActionId, localize('output.more', 'More Output Actions'), localize('output.more', 'More Output Actions'), Lxicon.ellipsis, Boolean(active), undefined, () => undefined),
		];
	}

	private channelActions(): readonly IAction[] {
		const activeId = this.outputService.activeChannel?.id;
		return this.outputService.channels.map(channel => this.action(`ash.output.channel.${channel.id}`, channel.label, channel.label, undefined, true, channel.id === activeId, () => this.outputService.selectChannel(channel.id)));
	}

	private filterActions(): readonly IAction[] {
		const channel = this.outputService.activeChannel;
		const categories = categoriesOf(channel?.entries ?? []);
		const levelActions = (["trace", "debug", "information", "warning", "error"] as const).map(severity => this.action(`ash.output.filter.minimum.${severity}`, severityLabel(severity), localize('output.showMinimum', 'Show {0} and above', severityLabel(severity)), undefined, true, undefined, () => this.filters.setMinimumSeverity(severity)));
		const logLevel = new SubmenuAction("ash.output.filter.minimum", localize('output.displayLevel', 'Minimum Display Level'), levelActions);
		const severityActions = OutputSeverities.map(severity => this.action(`ash.output.filter.severity.${severity}`, severityLabel(severity), localize('output.showSeverity', 'Show {0}', severityLabel(severity)), undefined, true, this.filters.isSeverityVisible(severity), () => this.filters.setSeverityVisible(severity, !this.filters.isSeverityVisible(severity))));
		const categoryActions = categories.map(category => this.action(`ash.output.filter.category.${category}`, category, localize('output.showCategory', 'Show category {0} in this channel. Changing an older saved global choice moves only that category to this channel.', category), undefined, true, this.filters.isCategoryVisible(category, channel!.id), () => this.filters.setCategoryVisible(category, !this.filters.isCategoryVisible(category, channel!.id), channel!.id)));
		return [logLevel, new Separator(), ...severityActions, ...(categoryActions.length ? [new Separator(), ...categoryActions] : []), new Separator(), this.action("ash.output.filter.reset", localize('output.reset', 'Reset Filters'), localize('output.resetTooltip', 'Reset Output Filters'), undefined, true, undefined, () => { this.filterInput.value = ""; this.filters.reset(); })];
	}

	private moreActions(): readonly IAction[] {
		const active = this.outputService.activeChannel;
		if (!active) return [];
		const logger = active.descriptor.logger;
		const recordingLevels = logger ? Object.values(LogLevel).map(level => this.action(
			`ash.output.recordingLevel.${level}`,
			level === LogLevel.Off ? localize('output.levelOff', 'Off') : severityLabel(level),
			localize('output.recordingLevelTooltip', 'Change which messages this producer records'),
			undefined, true, logger.control.getLevel() === level, () => logger.control.setLevel(level),
		)) : [];
		return [
			...(logger ? [new SubmenuAction('ash.output.recordingLevel', localize('output.recordingLevel', 'Set {0} Recording Level', logger.label), [
				...recordingLevels, new Separator(),
				this.action('workbench.action.output.activeOutputLogLevelDefault', localize('logLevelDefault.label', 'Set As Default'), localize('output.defaultLevelTooltip', 'Save this recording level for future windows and loggers'), undefined, logger.control.getLevel() !== this.defaultLogLevels.getDefaultLogLevel(active.descriptor.extensionId), undefined, () => this.commands.executeCommand('workbench.action.output.activeOutputLogLevelDefault')),
			])] : []),
			this.action("ash.output.openInEditor", localize('output.openEditor', 'Open Output in Editor'), localize('output.openChannel', 'Open {0} in Editor', active.label), Lxicon.linkExternal, true, undefined, () => this.commands.executeCommand(OPEN_OUTPUT_IN_EDITOR_COMMAND_ID)),
			this.action("ash.output.export", localize('output.export', 'Export Output…'), localize('output.exportChannel', 'Export {0}', active.label), Lxicon.download, true, undefined, () => this.commands.executeCommand(EXPORT_OUTPUT_COMMAND_ID)),
			...(this.contextKeys.getValue<boolean>(CONTEXT_SAVED_LOGS_AVAILABLE.key) ? [this.action(OPEN_SAVED_LOGS_COMMAND_ID, localize('output.openSavedLogs', 'Open Saved Logs…'), localize('output.openSavedLogs', 'Open Saved Logs…'), undefined, true, undefined, () => this.commands.executeCommand(OPEN_SAVED_LOGS_COMMAND_ID))] : []),
		];
	}

	private toggleAutoScroll(): void {
		this.setAutoScroll(!this.autoScroll);
		if (this.autoScroll) this.scrollToEnd();
		this.render();
	}

	private acceptScrollPosition(): void {
		const atEnd = this.editor.getContentHeight() - this.editor.getScrollTop() - this.editor.getLayoutInfo().height <= 2;
		this.setAutoScroll(atEnd);
	}

	private handleCursorPosition(event: ICursorPositionChangedEvent): void {
		// Restoration and content updates also move cursors; only user gestures change reading intent.
		if (event.reason !== CursorChangeReason.Explicit || this.changingContent || !this.configurationService.getValue<boolean>('output.smartScroll.enabled')) {
			return;
		}
		const model = this.editor.getModel();
		if (model) {
			this.setAutoScroll(event.position.lineNumber === model.getLineCount());
		}
	}

	private setAutoScroll(autoScroll: boolean): void {
		if (this.autoScroll === autoScroll) {
			return;
		}
		this.autoScroll = autoScroll;
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
