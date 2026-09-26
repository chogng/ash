import { AsyncDataTree, type AsyncDataTreeOptions } from "../../../base/browser/ui/tree/asyncDataTree.js";
import { StandardMouseEvent } from "../../../base/browser/mouseEvent.js";
import { ObjectTree, type ObjectTreeAcceptEvent, type ObjectTreeOptions, type ObjectTreePointerEvent, type ObjectTreeSelectionChangeEvent } from "../../../base/browser/ui/tree/objectTree.js";
import type { AsyncTreeDataSource } from "../../../base/browser/ui/tree/tree.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import type { IConfigurationService } from "../../configuration/common/configuration.js";
import type { IEditorOptions } from "../../editor/common/editor.js";
import { toOpenEditorOptions, type IOpenEditorOptions } from "../../editor/browser/editor.js";
import { ListConfiguration, type ListOpenMode } from "../common/listConfiguration.js";

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
		super(container, treeOptions);
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
		super(container, dataSource, treeOptions);
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
		this.open(event.element, toOpenEditorOptions(new StandardMouseEvent(event.browserEvent)), event.browserEvent);
	}

	private onDoubleClick(event: ObjectTreePointerEvent<T>): void {
		this.open(event.element, toOpenEditorOptions(new StandardMouseEvent(event.browserEvent), true), event.browserEvent);
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
