import { h } from "../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { RunOnceScheduler } from "../../../../base/common/async.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import type { Position } from "../../../../editor/common/core/position.js";
import type { Range } from "../../../../editor/common/core/range.js";
import type { LanguageDocumentSymbol } from "../../../../editor/common/languages.js";
import type { TextModel } from "../../../../editor/common/model/textModel.js";
import type { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import { OutlineModel } from "../../../../editor/contrib/documentSymbols/browser/outlineModel.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import { MenuWorkbenchToolBar, WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { type IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
	type IRegisteredConfiguration,
} from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { BreadcrumbsEnabledConfiguration, BreadcrumbsFilePathConfiguration, BreadcrumbsSymbolPathConfiguration, type BreadcrumbsPathMode, type IBreadcrumbsService } from "./breadcrumbs.js";
import type { EditorGroupId } from "../../../services/editor/common/editorState.js";
import { EditorBreadcrumbsControl } from "./breadcrumbsControl.js";
import { BreadcrumbsModel, type FileElement, type SymbolElement } from "./breadcrumbsModel.js";
import type { EditorInput } from "./editorInput.js";
import type { IEditorPane } from "./editorPane.js";

export interface EditorHeaderActions {
	readonly menuService: IMenuService;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly contextKeyService?: IContextKeyService;
}

/** Owns the actions and breadcrumbs alongside one group's editor tabs. */
export class EditorHeaderControl extends Disposable {
	private readonly heightEmitter = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this.heightEmitter.event;
	private readonly breadcrumbs: EditorBreadcrumbsControl;
	private breadcrumbsEnabled: boolean;
	private filePath: BreadcrumbsPathMode;
	private symbolPath: BreadcrumbsPathMode;
	private activeInput: EditorInput | undefined;
	private activePane: IEditorPane | undefined;
	private outline: OutlineModel | null = null;
	private readonly symbolListeners = this._register(new DisposableStore());
	private readonly symbolRequest = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly titleContainer: HTMLElement,
		tabsRow: HTMLElement,
		actions?: EditorHeaderActions,
		configurationService?: IConfigurationService,
		onSelectBreadcrumb?: (element: FileElement) => void,
		group?: EditorGroupId,
		breadcrumbsService?: IBreadcrumbsService,
		private readonly languageFeatures?: ILanguageFeaturesService,
		private readonly showSymbolPicker?: (symbols: readonly LanguageDocumentSymbol[], selected: LanguageDocumentSymbol, reveal: (range: Range) => void) => void,
	) {
		super();
		const actionsContainer = h(titleContainer.ownerDocument, "div");
		actionsContainer.className = "ash-editor-title-actions";
		tabsRow.append(actionsContainer);
		this._register(actions
			? new MenuWorkbenchToolBar(
				actionsContainer,
				actions.menuService,
				actions.contextMenuProvider,
				MenuId.EditorTitle,
				{
					highlightToggledItems: true,
					contextKeyService: actions.contextKeyService,
				},
			)
			: new WorkbenchToolBar(
				actionsContainer,
				emptyEditorToolbarContextMenuProvider,
				{
					ariaLabel: "Editor actions",
					highlightToggledItems: true,
				},
			));
		this._register(toDisposable(() => actionsContainer.remove()));
		this.breadcrumbs = this._register(new EditorBreadcrumbsControl(titleContainer, onSelectBreadcrumb, element => this.selectSymbol(element)));
		if (group !== undefined && breadcrumbsService) this._register(breadcrumbsService.register(group, this.breadcrumbs));
		const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
			.getConfiguration(BreadcrumbsEnabledConfiguration) as IRegisteredConfiguration<boolean> | undefined;
		if (!configuration) throw new RangeError(`Unknown configuration: ${BreadcrumbsEnabledConfiguration}`);
		this.breadcrumbsEnabled = configurationService?.getValue<boolean>(BreadcrumbsEnabledConfiguration)
			?? configuration.defaultValue;
		this.filePath = configurationService?.getValue<BreadcrumbsPathMode>(BreadcrumbsFilePathConfiguration) ?? "on";
		this.symbolPath = configurationService?.getValue<BreadcrumbsPathMode>(BreadcrumbsSymbolPathConfiguration) ?? "on";
		this.breadcrumbs.setPathModes(this.filePath, this.symbolPath);
		this.updateBreadcrumbVisibility();
		if (configurationService) {
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(BreadcrumbsEnabledConfiguration)) {
					this.breadcrumbsEnabled = configurationService.getValue<boolean>(BreadcrumbsEnabledConfiguration);
					this.updateBreadcrumbVisibility();
				}
				if (event.affectsConfiguration(BreadcrumbsFilePathConfiguration) || event.affectsConfiguration(BreadcrumbsSymbolPathConfiguration)) {
					this.filePath = configurationService.getValue<BreadcrumbsPathMode>(BreadcrumbsFilePathConfiguration);
					this.symbolPath = configurationService.getValue<BreadcrumbsPathMode>(BreadcrumbsSymbolPathConfiguration);
					this.breadcrumbs.setPathModes(this.filePath, this.symbolPath);
					this.updateBreadcrumbVisibility();
				}
			}));
		}
	}

	get height(): number {
		return this.breadcrumbs.domNode.hidden ? 0 : 22;
	}

	setInput(input: EditorInput | undefined, pane?: IEditorPane): void {
		const changed = input !== this.activeInput || pane !== this.activePane;
		this.activeInput = input;
		this.activePane = pane;
		if (changed) {
			this.symbolListeners.clear();
			this.symbolRequest.clear();
			this.outline = null;
			this.breadcrumbs.setInput(input);
			if (input && pane && this.languageFeatures) this.watchSymbols(pane);
		}
		this.updateBreadcrumbVisibility();
	}

	private watchSymbols(pane: IEditorPane): void {
		const control = pane.getControl?.() as Partial<{
			getModel(): TextModel | null;
			getPosition(): Position | null;
			onDidChangeCursorSelection: Event<unknown>;
		}> | undefined;
		if (!control || typeof control.getModel !== "function" || typeof control.getPosition !== "function" || typeof control.onDidChangeCursorSelection !== "function") return;
		const model = control.getModel();
		if (!model) return;
		const scheduler = this.symbolListeners.add(new RunOnceScheduler(() => void this.loadSymbols(model, control), 150));
		this.symbolListeners.add(model.onDidChangeContent(() => scheduler.schedule()));
		this.symbolListeners.add(this.languageFeatures!.documentSymbolProvider.onDidChange(() => scheduler.schedule()));
		this.symbolListeners.add(control.onDidChangeCursorSelection(() => this.updateCurrentSymbol(control.getPosition?.() ?? null)));
		void this.loadSymbols(model, control);
	}

	private async loadSymbols(model: TextModel, control: { getModel?: () => TextModel | null; getPosition?: () => Position | null }): Promise<void> {
		const controller = new AbortController();
		this.symbolRequest.value = toDisposable(() => controller.abort());
		try {
			const outline = await OutlineModel.create(this.languageFeatures!.documentSymbolProvider, model, controller.signal, error => console.error("Could not load editor breadcrumb symbols", error));
			if (controller.signal.aborted || control.getModel?.() !== model) return;
			this.outline = outline;
			this.updateCurrentSymbol(control.getPosition?.() ?? null);
		} catch (error) {
			if (!controller.signal.aborted) console.error("Could not build editor breadcrumbs", error);
		}
	}

	private updateCurrentSymbol(position: Position | null): void {
		const symbols = this.outline?.getTopLevelSymbols() ?? [];
		this.breadcrumbs.setSymbols(position ? BreadcrumbsModel.symbolPath(symbols, position) : []);
		this.updateBreadcrumbVisibility();
	}

	private selectSymbol(element: SymbolElement): void {
		const pane = this.activePane;
		const symbols = this.outline?.getTopLevelSymbols();
		if (!pane || !symbols || !this.showSymbolPicker || !pane.revealRange) return;
		this.showSymbolPicker(symbols, element.symbol, range => pane.revealRange?.(range));
	}

	private updateBreadcrumbVisibility(): void {
		const wasVisible = this.titleContainer.classList.contains("ash-editor-title-with-breadcrumbs");
		const visible = this.breadcrumbsEnabled && !!this.activeInput && this.activeInput.showBreadcrumbs !== false && this.breadcrumbs.domNode.childElementCount > 0;
		this.breadcrumbs.domNode.hidden = !visible;
		this.titleContainer.classList.toggle("ash-editor-title-with-breadcrumbs", visible);
		if (visible !== wasVisible) this.heightEmitter.fire();
	}
}

const emptyEditorToolbarContextMenuProvider: IContextMenuProvider = {
	showContextMenu(): never {
		throw new Error("The empty Editor toolbar cannot present secondary actions");
	},
};
