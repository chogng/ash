import "./media/editorTitleControl.css";
import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { Event } from "../../../../base/common/event.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import {
	EditorTabsModeConfiguration,
	type EditorTabsMode,
} from "../../../services/editor/common/editorConfiguration.js";
import type { EditorInput } from "./editorInput.js";
import { EditorHeaderControl, type EditorHeaderActions } from "./editorHeaderControl.js";
import { EditorTabsControl, type EditorTabDescriptor, type EditorTabsDelegate } from "./editorTabsControl.js";
import { MultiEditorTabsControl } from "./multiEditorTabsControl.js";
import { NoEditorTabsControl } from "./noEditorTabsControl.js";
import { SingleEditorTabsControl } from "./singleEditorTabsControl.js";
import { h } from "../../../../base/browser/dom.js";
import { WorkbenchConfiguration, type WorkbenchLayoutStyle } from '../../../common/configuration.js';

/** Hosts one group's Editor tabs and header in their shared title layout. */
export class EditorTitleControl extends Disposable {
	static readonly HEIGHT = 35;

	readonly domNode: HTMLDivElement;
	readonly onDidChangeHeight: Event<void>;
	private readonly tabsAndActionsDomNode: HTMLDivElement;
	private readonly delegate: EditorTabsDelegate;
	private readonly configurationService: IConfigurationService | undefined;
	private readonly tabsSlot = this._register(new MutableDisposable<EditorTabsControl>());
	private tabsMode: EditorTabsMode;
	private readonly header: EditorHeaderControl;
	private editors: readonly EditorTabDescriptor[] = [];
	private activeInput: EditorInput | undefined;

	constructor(
		container: HTMLElement,
		delegate: EditorTabsDelegate,
		titleActions?: EditorHeaderActions,
		configurationService?: IConfigurationService,
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
		));
		this.onDidChangeHeight = this.header.onDidChangeHeight;
		if (configurationService) {
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(EditorTabsModeConfiguration)) {
					this.tabsMode = configurationService.getValue<EditorTabsMode>(EditorTabsModeConfiguration);
					this.tabsSlot.value = this.createTabsControl(this.tabsMode);
					this.updateTabsLayoutStyle();
					this.tabs.setEditors(this.editors, this.activeInput);
				}
				if (event.affectsConfiguration(WorkbenchConfiguration.layoutStyle)) this.updateTabsLayoutStyle();
			}));
		}
		this._register(toDisposable(() => this.domNode.remove()));
	}

	get height(): number {
		return EditorTitleControl.HEIGHT + this.header.height;
	}

	setEditors(
		editors: readonly EditorTabDescriptor[],
		activeInput: EditorInput | undefined,
	): void {
		this.editors = editors;
		this.activeInput = activeInput;
		this.tabs.setEditors(editors, activeInput);
		this.header.setInput(activeInput);
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
}

function configurationDefault<T>(key: string): T {
	const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key) as IRegisteredConfiguration<T> | undefined;
	if (!configuration) throw new RangeError(`Unknown configuration: ${key}`);
	return configuration.defaultValue;
}
