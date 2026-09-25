import { h } from "../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
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
import { EditorBreadcrumbsEnabledConfiguration } from "../../../services/editor/common/editorConfiguration.js";
import { EditorBreadcrumbsControl } from "./breadcrumbsControl.js";
import type { EditorInput } from "./editorInput.js";

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
	private activeInput: EditorInput | undefined;

	constructor(
		private readonly titleContainer: HTMLElement,
		tabsRow: HTMLElement,
		actions?: EditorHeaderActions,
		configurationService?: IConfigurationService,
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
		this.breadcrumbs = this._register(new EditorBreadcrumbsControl(titleContainer));
		const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
			.getConfiguration(EditorBreadcrumbsEnabledConfiguration) as IRegisteredConfiguration<boolean> | undefined;
		if (!configuration) throw new RangeError(`Unknown configuration: ${EditorBreadcrumbsEnabledConfiguration}`);
		this.breadcrumbsEnabled = configurationService?.getValue<boolean>(EditorBreadcrumbsEnabledConfiguration)
			?? configuration.defaultValue;
		this.updateBreadcrumbVisibility();
		if (configurationService) {
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(EditorBreadcrumbsEnabledConfiguration)) {
					this.breadcrumbsEnabled = configurationService.getValue<boolean>(EditorBreadcrumbsEnabledConfiguration);
					this.updateBreadcrumbVisibility();
				}
			}));
		}
	}

	get height(): number {
		return this.breadcrumbs.domNode.hidden ? 0 : 22;
	}

	setInput(input: EditorInput | undefined): void {
		this.activeInput = input;
		this.breadcrumbs.setInput(input);
		this.updateBreadcrumbVisibility();
	}

	private updateBreadcrumbVisibility(): void {
		const wasVisible = this.titleContainer.classList.contains("ash-editor-title-with-breadcrumbs");
		const visible = this.breadcrumbsEnabled && !!this.activeInput && this.activeInput.showBreadcrumbs !== false;
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
