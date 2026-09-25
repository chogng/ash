import "./media/editorTitleControl.css";
import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import {
	EditorTabsModeConfiguration,
	type EditorTabsMode,
} from "../../../services/editor/common/editorConfiguration.js";
import type { EditorInput } from "./editorInput.js";
import type { FileElement } from "./breadcrumbsModel.js";
import { EditorHeaderControl, type EditorHeaderActions } from "./editorHeaderControl.js";
import type { IBreadcrumbsService } from "./breadcrumbs.js";
import type { EditorGroupId } from "../../../services/editor/common/editorState.js";
import type { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import type { LanguageDocumentSymbol } from "../../../../editor/common/languages.js";
import type { Range } from "../../../../editor/common/core/range.js";
import type { IEditorPane } from "./editorPane.js";
import { EditorTabsControl, type EditorTabDescriptor, type EditorTabsDelegate } from "./editorTabsControl.js";
import { MultiEditorTabsControl } from "./multiEditorTabsControl.js";
import { MultiRowEditorControl } from "./multiRowEditorTabsControl.js";
import { NoEditorTabsControl } from "./noEditorTabsControl.js";
import { SingleEditorTabsControl } from "./singleEditorTabsControl.js";
import { h } from "../../../../base/browser/dom.js";
import { localize } from "../../../../nls.js";
import { WorkbenchConfiguration, type WorkbenchLayoutStyle } from '../../../common/configuration.js';

/** Hosts one group's Editor tabs and header in their shared title layout. */
export class EditorTitleControl extends Disposable {
	static readonly HEIGHT = 35;

	readonly domNode: HTMLDivElement;
	private readonly heightEmitter = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this.heightEmitter.event;
	private readonly tabsAndActionsDomNode: HTMLDivElement;
	private readonly lockIndicator: HTMLSpanElement;
	private readonly delegate: EditorTabsDelegate;
	private readonly configurationService: IConfigurationService | undefined;
	private readonly tabsSlot = this._register(new MutableDisposable<EditorTabsControl>());
	private readonly rowsListener = this._register(new MutableDisposable());
	private tabsMode: EditorTabsMode;
	private readonly header: EditorHeaderControl;
	private editors: readonly EditorTabDescriptor[] = [];
	private selectedIds: ReadonlySet<string> | undefined;
	private activeInput: EditorInput | undefined;

	constructor(
		container: HTMLElement,
		delegate: EditorTabsDelegate,
		titleActions?: EditorHeaderActions,
		configurationService?: IConfigurationService,
		onSelectBreadcrumb?: (element: FileElement) => void,
		group?: EditorGroupId,
		breadcrumbsService?: IBreadcrumbsService,
		languageFeatures?: ILanguageFeaturesService,
		showSymbolPicker?: (symbols: readonly LanguageDocumentSymbol[], selected: LanguageDocumentSymbol, reveal: (range: Range) => void) => void,
	) {
		super();
		this.delegate = delegate;
		this.configurationService = configurationService;
		this.tabsMode = configurationService?.getValue<EditorTabsMode>(EditorTabsModeConfiguration) ?? configurationDefault<EditorTabsMode>(EditorTabsModeConfiguration);
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, "div");
		this.domNode.className = "ash-editor-title-control";
		container.append(this.domNode);
		this.tabsAndActionsDomNode = h(ownerDocument, "div");
		this.tabsAndActionsDomNode.className = "ash-editor-tabs-and-actions";
		this.domNode.append(this.tabsAndActionsDomNode);
		this.tabsSlot.value = this.createTabsControl(this.tabsMode);
		this.updateTabsLayoutStyle();
		this.header = this._register(new EditorHeaderControl(
			this.domNode,
			this.tabsAndActionsDomNode,
			titleActions,
			configurationService,
			onSelectBreadcrumb,
			group,
			breadcrumbsService,
			languageFeatures,
			showSymbolPicker,
		));
		this.lockIndicator = h(ownerDocument, "span");
		this.lockIndicator.className = "ash-editor-group-lock-indicator";
		this.lockIndicator.hidden = true;
		this.tabsAndActionsDomNode.append(this.lockIndicator);
		this._register(this.header.onDidChangeHeight(() => this.heightEmitter.fire()));
		if (configurationService) {
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(EditorTabsModeConfiguration)) {
					this.tabsMode = configurationService.getValue<EditorTabsMode>(EditorTabsModeConfiguration);
					this.tabsSlot.value = this.createTabsControl(this.tabsMode);
					this.updateTabsLayoutStyle();
					this.tabs.setEditors(this.editors, this.activeInput, this.selectedIds);
					this.heightEmitter.fire();
				}
				if (event.affectsConfiguration(WorkbenchConfiguration.layoutStyle)) this.updateTabsLayoutStyle();
			}));
		}
		this._register(toDisposable(() => this.domNode.remove()));
	}

	get height(): number {
		const rows = this.tabs instanceof MultiRowEditorControl ? this.tabs.rowCount : 1;
		return EditorTitleControl.HEIGHT * rows + this.header.height;
	}

	setLocked(locked: boolean): void {
		this.lockIndicator.hidden = !locked;
		this.lockIndicator.textContent = locked ? localize("workbench.editorGroupLocked", "Locked") : "";
	}

	setEditors(
		editors: readonly EditorTabDescriptor[],
		activeInput: EditorInput | undefined,
		activePane?: IEditorPane,
		selectedIds?: ReadonlySet<string>,
	): void {
		this.editors = editors;
		this.selectedIds = selectedIds;
		this.activeInput = activeInput;
		this.tabs.setEditors(editors, activeInput, selectedIds);
		this.header.setInput(activeInput, activePane);
	}

	private createTabsControl(mode: EditorTabsMode): EditorTabsControl {
		const firstAction = this.tabsAndActionsDomNode.querySelector(":scope > .ash-editor-title-actions");
		const control = mode === "single"
			? new SingleEditorTabsControl(this.tabsAndActionsDomNode, this.delegate)
			: mode === "none"
				? new NoEditorTabsControl(this.tabsAndActionsDomNode)
				: new MultiRowEditorControl(this.tabsAndActionsDomNode, this.delegate);
		this.rowsListener.value = control instanceof MultiRowEditorControl
			? control.onDidChangeRows(() => {
				this.domNode.style.setProperty("--ash-editor-tab-rows", String(control.rowCount));
				this.heightEmitter.fire();
			})
			: undefined;
		this.domNode.style.setProperty("--ash-editor-tab-rows", control instanceof MultiRowEditorControl ? String(control.rowCount) : "1");
		if (firstAction) this.tabsAndActionsDomNode.insertBefore(control.domNode, firstAction);
		return control;
	}

	private updateTabsLayoutStyle(): void {
		if (!(this.tabs instanceof MultiEditorTabsControl || this.tabs instanceof MultiRowEditorControl)) return;
		const style = this.configurationService?.getValue<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle) ?? configurationDefault<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle);
		this.tabs.setPresentation(style === 'modern' ? 'inset' : 'flush');
	}

	private get tabs(): EditorTabsControl {
		const tabs = this.tabsSlot.value;
		if (!tabs) throw new ReferenceError("Editor tabs control is not available");
		return tabs;
	}
}

function configurationDefault<T>(key: string): T {
	const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key) as IRegisteredConfiguration<T> | undefined;
	if (!configuration) throw new RangeError(`Unknown configuration: ${key}`);
	return configuration.defaultValue;
}
