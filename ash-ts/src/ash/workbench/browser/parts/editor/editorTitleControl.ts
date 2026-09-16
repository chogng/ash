import "./media/editorTitleControl.css";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { MenuWorkbenchToolBar, WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { MenuId } from "../../../../platform/actions/common/actions.js";
import type { IMenuService } from "../../../../platform/actions/common/menuService.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import {
	EditorBreadcrumbsEnabledConfiguration,
	EditorTabsModeConfiguration,
	type EditorTabsMode,
} from "../../../services/editor/common/editorConfiguration.js";
import type { EditorInput } from "./editorInput.js";
import { EditorBreadcrumbsControl } from "./breadcrumbsControl.js";
import { EditorTabsControl, type EditorTabDescriptor, type EditorTabsDelegate } from "./editorTabsControl.js";
import { MultiEditorTabsControl } from "./multiEditorTabsControl.js";
import { NoEditorTabsControl } from "./noEditorTabsControl.js";
import { SingleEditorTabsControl } from "./singleEditorTabsControl.js";
import { h } from "../../../../base/browser/dom.js";
import { WorkbenchConfiguration, type WorkbenchLayoutStyle } from '../../../common/configuration.js';

/** Platform services used to populate the Editor title toolbar. */
export interface EditorTitleActions {
	readonly menuService: IMenuService;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly contextKeyService?: IContextKeyService;
}

/** Hosts one group's Editor tabs and its independent action toolbar. */
export class EditorTitleControl extends Disposable {
	static readonly HEIGHT = 35;

	readonly domNode: HTMLDivElement;
	private readonly heightEmitter = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this.heightEmitter.event;
	private readonly tabsAndActionsDomNode: HTMLDivElement;
	private readonly delegate: EditorTabsDelegate;
	private readonly configurationService: IConfigurationService | undefined;
	private readonly tabsSlot = this._register(new MutableDisposable<EditorTabsControl>());
	private tabsMode: EditorTabsMode;
	private readonly breadcrumbs: EditorBreadcrumbsControl;
	private breadcrumbsEnabled: boolean;
	private editors: readonly EditorTabDescriptor[] = [];
	private activeInput: EditorInput | undefined;
	private readonly toolbar: WorkbenchToolBar;

	constructor(
		container: HTMLElement,
		delegate: EditorTabsDelegate,
		titleActions?: EditorTitleActions,
		configurationService?: IConfigurationService,
	) {
		super();
		this.delegate = delegate;
		this.configurationService = configurationService;
		this.tabsMode = configurationService?.getValue<EditorTabsMode>(EditorTabsModeConfiguration) ?? configurationDefault<EditorTabsMode>(EditorTabsModeConfiguration);
		this.breadcrumbsEnabled = configurationService?.getValue<boolean>(EditorBreadcrumbsEnabledConfiguration) ?? configurationDefault<boolean>(EditorBreadcrumbsEnabledConfiguration);
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, "div");
		this.domNode.className = "ash-editor-title-control";
		container.append(this.domNode);
		this.tabsAndActionsDomNode = h(ownerDocument, "div");
		this.tabsAndActionsDomNode.className = "ash-editor-tabs-and-actions";
		this.domNode.append(this.tabsAndActionsDomNode);
		this.tabsSlot.value = this.createTabsControl(this.tabsMode);
		this.updateTabsLayoutStyle();
		const actionsDomNode = h(ownerDocument, "div");
		actionsDomNode.className = "ash-editor-title-actions";
		this.tabsAndActionsDomNode.append(actionsDomNode);
		this.toolbar = this._register(titleActions
			? new MenuWorkbenchToolBar(
				actionsDomNode,
				titleActions.menuService,
				titleActions.contextMenuProvider,
				MenuId.EditorTitle,
				{
					highlightToggledItems: true,
					contextKeyService: titleActions.contextKeyService,
				},
			)
			: new WorkbenchToolBar(
				actionsDomNode,
				emptyEditorToolbarContextMenuProvider,
				{
					ariaLabel: "Editor actions",
					highlightToggledItems: true,
				},
			));
		this.breadcrumbs = this._register(new EditorBreadcrumbsControl(this.domNode));
		this.updateBreadcrumbVisibility();
		if (configurationService) {
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(EditorTabsModeConfiguration)) {
					this.tabsMode = configurationService.getValue<EditorTabsMode>(EditorTabsModeConfiguration);
					this.tabsSlot.value = this.createTabsControl(this.tabsMode);
					this.updateTabsLayoutStyle();
					this.tabs.setEditors(this.editors, this.activeInput);
				}
				if (event.affectsConfiguration(EditorBreadcrumbsEnabledConfiguration)) {
					this.breadcrumbsEnabled = configurationService.getValue<boolean>(EditorBreadcrumbsEnabledConfiguration);
					this.updateBreadcrumbVisibility();
				}
				if (event.affectsConfiguration(WorkbenchConfiguration.layoutStyle)) this.updateTabsLayoutStyle();
			}));
		}
		this._register(toDisposable(() => this.domNode.remove()));
	}

	get height(): number {
		return EditorTitleControl.HEIGHT + (this.breadcrumbsEnabled && this.activeInput && this.activeInput.showBreadcrumbs !== false ? 22 : 0);
	}

	setEditors(
		editors: readonly EditorTabDescriptor[],
		activeInput: EditorInput | undefined,
	): void {
		this.editors = editors;
		this.activeInput = activeInput;
		this.tabs.setEditors(editors, activeInput);
		this.breadcrumbs.setInput(activeInput);
		this.updateBreadcrumbVisibility();
	}

	private createTabsControl(mode: EditorTabsMode): EditorTabsControl {
		const firstAction = this.tabsAndActionsDomNode.querySelector(":scope > .ash-editor-title-actions");
		const control = mode === "single"
			? new SingleEditorTabsControl(this.tabsAndActionsDomNode, this.delegate)
			: mode === "none"
				? new NoEditorTabsControl(this.tabsAndActionsDomNode)
				: new MultiEditorTabsControl(this.tabsAndActionsDomNode, this.delegate);
		if (firstAction) this.tabsAndActionsDomNode.insertBefore(control.domNode, firstAction);
		return control;
	}

	private updateTabsLayoutStyle(): void {
		if (!(this.tabs instanceof MultiEditorTabsControl)) return;
		const style = this.configurationService?.getValue<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle) ?? configurationDefault<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle);
		this.tabs.setPresentation(style === 'modern' ? 'inset' : 'flush');
	}

	private get tabs(): EditorTabsControl {
		const tabs = this.tabsSlot.value;
		if (!tabs) throw new ReferenceError("Editor tabs control is not available");
		return tabs;
	}

	private updateBreadcrumbVisibility(): void {
		const wasVisible = this.domNode.classList.contains("ash-editor-title-with-breadcrumbs");
		this.breadcrumbs.domNode.hidden = !this.breadcrumbsEnabled || !this.activeInput || this.activeInput.showBreadcrumbs === false;
		const visible = !this.breadcrumbs.domNode.hidden;
		this.domNode.classList.toggle("ash-editor-title-with-breadcrumbs", visible);
		if (visible !== wasVisible) this.heightEmitter.fire();
	}
}

function configurationDefault<T>(key: string): T {
	const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key) as IRegisteredConfiguration<T> | undefined;
	if (!configuration) throw new RangeError(`Unknown configuration: ${key}`);
	return configuration.defaultValue;
}

const emptyEditorToolbarContextMenuProvider: IContextMenuProvider = {
	showContextMenu(): never {
		throw new Error(
			"The empty Editor toolbar cannot present secondary actions",
		);
	},
};
