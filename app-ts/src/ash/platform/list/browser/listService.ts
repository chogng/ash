import { AsyncDataTree, type AsyncDataTreeOptions } from "../../../base/browser/ui/tree/asyncDataTree.js";
import { ObjectTree, type ObjectTreeAcceptEvent, type ObjectTreeOptions, type ObjectTreePointerEvent, type ObjectTreeSelectionChangeEvent } from "../../../base/browser/ui/tree/objectTree.js";
import type { AsyncTreeDataSource, TreeIndentGuides } from "../../../base/browser/ui/tree/tree.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { localize } from "../../../nls.js";
import type { IConfigurationService } from "../../configuration/common/configuration.js";
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../configuration/common/configurationRegistry.js";
import type { IEditorOptions } from "../../editor/common/editor.js";
import { toOpenEditorOptions, type IOpenEditorOptions } from "../../editor/browser/editor.js";
import { Registry } from "../../registry/common/platform.js";

type ListOpenMode = "doubleClick" | "singleClick";
export type TreeExpandMode = "doubleClick" | "singleClick";

export interface ResourceOpenEvent<T> {
	readonly element: T;
	readonly editorOptions: IEditorOptions;
	readonly sideBySide: boolean;
	readonly browserEvent: MouseEvent | KeyboardEvent;
}

export interface ResourceNavigatorOptions {
	readonly configurationService: IConfigurationService;
	/** Overrides the configured open mode for widgets whose interaction requires a fixed policy. */
	readonly openOnSingleClick?: boolean;
}

export interface WorkbenchObjectTreeOptions<T> extends ObjectTreeOptions<T>, ResourceNavigatorOptions {}

/** Platform-integrated ObjectTree with canonical resource-opening semantics. */
export class WorkbenchObjectTree<T> extends ObjectTree<T> {
	private readonly navigator: TreeResourceNavigator<T>;

	readonly onDidOpen: Event<ResourceOpenEvent<T>>;

	constructor(container: HTMLElement, options: WorkbenchObjectTreeOptions<T>) {
		const { configurationService, openOnSingleClick, ...treeOptions } = options;
		super(container, {
			...treeOptions,
			smoothScrolling: treeOptions.smoothScrolling ?? configurationService.getValue<boolean>(ListConfiguration.smoothScrolling),
			indent: treeOptions.indent ?? configurationService.getValue<number>(ListConfiguration.treeIndent),
			indentGuides: treeOptions.indentGuides ?? configurationService.getValue<TreeIndentGuides>(ListConfiguration.treeRenderIndentGuides),
		});
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ListConfiguration.smoothScrolling) && options.smoothScrolling === undefined) this.updateOptions({ smoothScrolling: configurationService.getValue<boolean>(ListConfiguration.smoothScrolling) });
			if (event.affectsConfiguration(ListConfiguration.treeIndent) && options.indent === undefined) this.updateOptions({ indent: configurationService.getValue<number>(ListConfiguration.treeIndent) });
			if (event.affectsConfiguration(ListConfiguration.treeRenderIndentGuides) && options.indentGuides === undefined) this.updateOptions({ indentGuides: configurationService.getValue<TreeIndentGuides>(ListConfiguration.treeRenderIndentGuides) });
		}));
		this.navigator = this._register(new TreeResourceNavigator(this, configurationService, openOnSingleClick));
		this.onDidOpen = this.navigator.onDidOpen;
	}
}

export interface WorkbenchAsyncDataTreeOptions<T> extends AsyncDataTreeOptions<T>, ResourceNavigatorOptions {}

/** Platform-integrated AsyncDataTree with the same open contract as other Workbench trees. */
export class WorkbenchAsyncDataTree<TInput, T> extends AsyncDataTree<TInput, T> {
	private readonly navigator: TreeResourceNavigator<T>;

	readonly onDidOpen: Event<ResourceOpenEvent<T>>;

	constructor(container: HTMLElement, dataSource: AsyncTreeDataSource<TInput, T>, options: WorkbenchAsyncDataTreeOptions<T>) {
		const { configurationService, openOnSingleClick, ...treeOptions } = options;
		super(container, dataSource, {
			...treeOptions,
			smoothScrolling: treeOptions.smoothScrolling ?? configurationService.getValue<boolean>(ListConfiguration.smoothScrolling),
			indent: treeOptions.indent ?? configurationService.getValue<number>(ListConfiguration.treeIndent),
			indentGuides: treeOptions.indentGuides ?? configurationService.getValue<TreeIndentGuides>(ListConfiguration.treeRenderIndentGuides),
		});
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ListConfiguration.smoothScrolling) && options.smoothScrolling === undefined) this.updateOptions({ smoothScrolling: configurationService.getValue<boolean>(ListConfiguration.smoothScrolling) });
			if (event.affectsConfiguration(ListConfiguration.treeIndent) && options.indent === undefined) this.updateOptions({ indent: configurationService.getValue<number>(ListConfiguration.treeIndent) });
			if (event.affectsConfiguration(ListConfiguration.treeRenderIndentGuides) && options.indentGuides === undefined) this.updateOptions({ indentGuides: configurationService.getValue<TreeIndentGuides>(ListConfiguration.treeRenderIndentGuides) });
		}));
		this.navigator = this._register(new TreeResourceNavigator(this, configurationService, openOnSingleClick));
		this.onDidOpen = this.navigator.onDidOpen;
	}
}

interface ResourceNavigationTree<T> {
	readonly onPointer: Event<ObjectTreePointerEvent<T>>;
	readonly onDidDoubleClick: Event<ObjectTreePointerEvent<T>>;
	readonly onDidAccept: Event<ObjectTreeAcceptEvent<T>>;
	readonly onDidChangeSelection: Event<ObjectTreeSelectionChangeEvent<T>>;
}

/** Shared interaction policy behind every Platform List resource-capable wrapper. */
class TreeResourceNavigator<T> extends Disposable {
	private readonly _onDidOpen = this._register(new Emitter<ResourceOpenEvent<T>>());

	readonly onDidOpen: Event<ResourceOpenEvent<T>> = this._onDidOpen.event;

	constructor(tree: ResourceNavigationTree<T>, private readonly configurationService: IConfigurationService, private readonly openOnSingleClick: boolean | undefined) {
		super();
		this._register(tree.onPointer((event) => this.onPointer(event)));
		this._register(tree.onDidDoubleClick((event) => this.onDoubleClick(event)));
		this._register(tree.onDidAccept((event) => this.onAccept(event)));
		this._register(tree.onDidChangeSelection((event) => this.onSelection(event)));
	}

	private onPointer(event: ObjectTreePointerEvent<T>): void {
		if (!this.shouldOpenOnSingleClick() || event.browserEvent.detail === 2) return;
		this.open(event.element, toOpenEditorOptions(event.browserEvent), event.browserEvent);
	}

	private onDoubleClick(event: ObjectTreePointerEvent<T>): void {
		this.open(event.element, toOpenEditorOptions(event.browserEvent, true), event.browserEvent);
	}

	private onAccept(event: ObjectTreeAcceptEvent<T>): void {
		this.open(event.element, {
			editorOptions: { pinned: event.browserEvent.key !== " ", preserveFocus: event.browserEvent.key === " " },
			openToSide: event.browserEvent.ctrlKey || event.browserEvent.metaKey || event.browserEvent.altKey,
		}, event.browserEvent);
	}

	private onSelection(event: ObjectTreeSelectionChangeEvent<T>): void {
		if (!isKeyboardEvent(event.browserEvent) || event.elements.length !== 1 || event.browserEvent.key === "Enter" || event.browserEvent.key === " ") return;
		this.open(event.elements[0]!, { editorOptions: { pinned: false, preserveFocus: true }, openToSide: false }, event.browserEvent);
	}

	private shouldOpenOnSingleClick(): boolean {
		return this.openOnSingleClick ?? this.configurationService.getValue<ListOpenMode>(ListConfiguration.openMode) === "singleClick";
	}

	private open(element: T, options: IOpenEditorOptions, browserEvent: MouseEvent | KeyboardEvent): void {
		this._onDidOpen.fire(Object.freeze({ element, editorOptions: Object.freeze(options.editorOptions), sideBySide: options.openToSide, browserEvent }));
	}
}

function isKeyboardEvent(event: UIEvent | undefined): event is KeyboardEvent {
	return event !== undefined && typeof (event as KeyboardEvent).key === "string";
}

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const ListConfiguration = Object.freeze({
	smoothScrolling: configurationRegistry.registerConfiguration<boolean>({
		key: "workbench.list.smoothScrolling",
		defaultValue: false,
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'boolean' },
		parse(value: unknown): boolean {
			if (typeof value !== "boolean") throw new TypeError(localize('list.smoothScrollingInvalid', 'List smooth scrolling must be a boolean'));
			return value;
		},
		setting: {
			valueType: 'boolean',
			get title() { return localize('list.smoothScrollingTitle', 'Smooth scrolling in lists'); },
			get description() { return localize('list.smoothScrollingDescription', 'Controls whether lists and trees scroll with a short animation.'); },
		},
	}),
	treeIndent: configurationRegistry.registerConfiguration<number>({
		key: "workbench.tree.indent",
		defaultValue: 8,
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'number', minimum: 4, maximum: 40 },
		parse(value: unknown): number {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 4 || value > 40) throw new TypeError(localize('list.treeIndentInvalid', 'Tree indent must be between 4 and 40 pixels'));
			return value;
		},
		setting: {
			valueType: 'number',
			get title() { return localize('list.treeIndentTitle', 'Tree indentation'); },
			get description() { return localize('list.treeIndentDescription', 'Controls tree indentation in pixels.'); },
			minimum: 4,
			maximum: 40,
		},
	}),
	treeRenderIndentGuides: configurationRegistry.registerConfiguration<"none" | "onHover" | "always">({
		key: "workbench.tree.renderIndentGuides",
		defaultValue: "onHover",
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'string', enum: ['none', 'onHover', 'always'] },
		parse(value: unknown): "none" | "onHover" | "always" {
			if (value !== "none" && value !== "onHover" && value !== "always") throw new TypeError(localize('list.treeGuidesInvalid', 'Unknown tree indent guide mode: {0}', String(value)));
			return value;
		},
		setting: {
			valueType: 'select',
			get title() { return localize('list.treeGuidesTitle', 'Tree indent guides'); },
			get description() { return localize('list.treeGuidesDescription', 'Controls when tree indent guides are visible.'); },
			get options() {
				return [
					{ value: 'none', label: localize('list.treeGuidesNone', 'None') },
					{ value: 'onHover', label: localize('list.treeGuidesOnHover', 'On hover') },
					{ value: 'always', label: localize('list.treeGuidesAlways', 'Always') },
				] as const;
			},
		},
	}),
	openMode: configurationRegistry.registerConfiguration<ListOpenMode>({
		key: "workbench.list.openMode",
		defaultValue: "singleClick",
		parse(value: unknown): ListOpenMode {
			if (value !== "singleClick" && value !== "doubleClick") throw new TypeError(`Unknown list open mode: ${String(value)}`);
			return value;
		},
	}),
	treeExpandMode: configurationRegistry.registerConfiguration<TreeExpandMode>({
		key: "workbench.tree.expandMode",
		defaultValue: "singleClick",
		parse(value: unknown): TreeExpandMode {
			if (value !== "singleClick" && value !== "doubleClick") throw new TypeError(`Unknown tree expand mode: ${String(value)}`);
			return value;
		},
	}),
});
