import "./media/multiEditorTabsControl.css";
import { DataTransfers } from "../../../../base/browser/dnd.js";
import { addDisposableListener } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { assertDefined } from "../../../../base/common/types.js";
import { TabList, type TabListPresentation } from "../../../../base/browser/ui/tablist/tabList.js";
import { localize } from "../../../../nls.js";
import { containsExternalEditorDrop } from "./editorDropData.js";
import { clearConnectedTabClipping, updateConnectedTabClipping } from "./connectedTabClipping.js";
import { CONNECTED_EDITOR_TABS_CLASS } from "./editor.js";
import type { EditorInput } from "./editorInput.js";
import { EditorTabsControl, editorInputKey, type EditorTabDescriptor, type EditorTabsDelegate } from "./editorTabsControl.js";

const DRAG_OVER_ACTIVATE_DELAY = 1500;
const DOUBLE_CLICK_MAX_INTERVAL = 500;

/** Renders every open Editor in one reorderable tab list. */
export class MultiEditorTabsControl extends EditorTabsControl {
	private readonly tabList: TabList<EditorTabDescriptor>;
	private readonly viewport: HTMLElement;
	private connectedTab: HTMLElement | undefined;
	private connected = true;
	private previewedInput: EditorInput | undefined;
	private editors: readonly EditorTabDescriptor[] = [];
	private previousLabelClick: { readonly tabId: string; readonly time: number } | undefined;

	constructor(container: HTMLElement, private readonly delegate: EditorTabsDelegate) {
		super(container);
		this.domNode.classList.add("ash-multi-editor-tabs-control");
		this.tabList = this._register(new TabList(this.domNode, {
			ariaLabel: "Open editors",
			presentation: "inset",
			draggable: true,
			dragAndDrop: {
				canDrop: (event) => delegate.isDragging() || containsExternalEditorDrop(event),
				onDragStart: (editor, event) => {
					event.dataTransfer?.setData(DataTransfers.TEXT, editor.instanceId);
					if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
					delegate.startDrag(editor.input);
				},
				onDragEnter: (_target, _position, event) => {
					this.previewedInput = undefined;
					if (event.dataTransfer) event.dataTransfer.dropEffect = delegate.isDragging() ? "move" : "copy";
				},
				onDragOver: (target, _position, event, duration) => {
					if (event.dataTransfer) event.dataTransfer.dropEffect = delegate.isDragging() ? "move" : "copy";
					if (target && duration >= DRAG_OVER_ACTIVATE_DELAY && target.input !== this.previewedInput) {
						this.previewedInput = target.input;
						delegate.preview(target.input);
					}
				},
				onDragLeave: () => {
					this.previewedInput = undefined;
				},
				onDrop: (target, position, event) => {
					this.previewedInput = undefined;
					event.stopPropagation();
					if (delegate.isDragging()) delegate.drop(target?.input, position);
					else delegate.dropExternal(event, target?.input, position);
				},
				onDragEnd: () => {
					this.previewedInput = undefined;
					delegate.endDrag();
				},
			},
			onActivate: (editor) => delegate.activate(editor.input),
			onSelect: (editor, event) => delegate.select?.(editor.input, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }) ?? false,
			onClose: (editor) => delegate.close(editor.input),
			onSecondaryActivate: (editor) => delegate.toggleSticky(editor.input),
		}));
		const viewport = this.tabList.element.querySelector<HTMLElement>(".ash-scrollbar-viewport");
		if (!viewport) throw new Error("Editor tabs require a scroll viewport");
		this.viewport = viewport;
		this.domNode.classList.add(CONNECTED_EDITOR_TABS_CLASS);
		this._register(addDisposableListener(viewport, "scroll", () => this.updateConnectedTab()));
		this._register(observeResize(viewport, () => this.updateConnectedTab()));
		this._register(addDisposableListener(this.tabList.element, "contextmenu", event => {
			this.showTabContextMenu(event);
		}));
		this._register(addDisposableListener(this.tabList.element, "keydown", event => {
			if (!event.shiftKey || event.key !== "F10") {
				return;
			}
			this.showTabContextMenu(event);
		}));
		// Activation rebuilds tabs, so the browser's dblclick event may lose its original target.
		this._register(addDisposableListener(this.domNode, "click", event => {
			if (event.detail === 0) return;
			const label = (event.target as Element).closest<HTMLButtonElement>(".ash-tab-label");
			if (!label || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
				this.previousLabelClick = undefined;
				return;
			}
			const previous = this.previousLabelClick;
			this.previousLabelClick = { tabId: label.id, time: event.timeStamp };
			if (previous?.tabId !== label.id || event.timeStamp - previous.time > DOUBLE_CLICK_MAX_INTERVAL) return;
			this.previousLabelClick = undefined;
			const editor = this.editors.find(candidate => candidate.tabId === label.id);
			assertDefined(editor, `Editor tab is not available: ${label.id}`);
			event.preventDefault();
			event.stopPropagation();
			this.delegate.toggleSticky(editor.input);
		}, true));
	}

	private showTabContextMenu(event: MouseEvent | KeyboardEvent): void {
		const target = event.target;
		if (!(target instanceof this.domNode.ownerDocument.defaultView!.Element)) {
			return;
		}
		const tab = target.closest<HTMLElement>(".ash-tab");
		if (!tab || !this.tabList.element.contains(tab)) {
			return;
		}
		const editor = this.editors.find(candidate => candidate.instanceId === tab.dataset.actionId);
		if (!editor || !this.delegate.showContextMenu) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.delegate.showContextMenu(editor.input, event, tab);
	}

	setEditors(editors: readonly EditorTabDescriptor[], activeInput: EditorInput | undefined, selectedIds?: ReadonlySet<string>): void {
		this.editors = editors;
		const activeKey = activeInput ? editors.find(editor => editorInputKey(editor.input) === editorInputKey(activeInput))?.instanceId : undefined;
		this.tabList.setTabs(editors.map((editor) => {
			const label = editorInputLabel(editor.input);
			const state = editor.hasExternalChange ? "conflict" : editor.isDirty ? "dirty" : undefined;
			const stateLabel = editor.hasExternalChange ? "conflict with changes on disk" : editor.isDirty ? "unsaved changes" : undefined;
			return {
				id: editor.instanceId,
				value: editor,
				label: label.name,
				description: label.description,
				tooltip: stateLabel ? `${editor.input.resource.toString()} — ${stateLabel}` : editor.input.resource.toString(),
				ariaLabel: stateLabel ? `${label.name}, ${stateLabel}` : label.name,
				ariaDescription: editor.sticky
					? localize("workbench.editorPinnedTabHint", "Pinned tab. Double-click or press Alt+Enter to unpin.")
					: localize("workbench.editorUnpinnedTabHint", "Double-click or press Alt+Enter to pin this tab."),
				...(state ? { state } : {}),
				preview: editor.preview,
				closeActionIndicatorIcon: editor.sticky ? Lxicon.pinned : undefined,
				tabId: editor.tabId,
				panelId: editor.panelId,
			};
		}), activeKey, selectedIds);
		clearConnectedTabClipping(this.connectedTab, this.tabList.element);
		this.connectedTab = this.tabList.element.querySelector<HTMLElement>(".ash-tab.checked") ?? undefined;
		this.updateConnectedTab();
		this.tabList.element.hidden = editors.length === 0;
	}

	setPresentation(presentation: TabListPresentation): void {
		this.tabList.setPresentation(presentation);
		this.connected = presentation === "inset";
		this.domNode.classList.toggle(CONNECTED_EDITOR_TABS_CLASS, this.connected);
		this.updateConnectedTab();
	}

	private updateConnectedTab(): void {
		const tab = this.connectedTab;
		if (!tab || !this.connected) {
			clearConnectedTabClipping(tab, this.tabList.element);
			return;
		}
		const tabBounds = tab.getBoundingClientRect();
		const viewportBounds = this.viewport.getBoundingClientRect();
		updateConnectedTabClipping({
			tab,
			overflowEdge: this.tabList.element,
			fillLeft: tabBounds.left - viewportBounds.left + this.viewport.scrollLeft,
			fillRight: tabBounds.right - viewportBounds.left + this.viewport.scrollLeft,
			viewportLeft: 0,
			viewportRight: this.viewport.clientWidth,
			shoulderExtent: 6,
		}, this.viewport.scrollLeft);
	}
}

function editorInputLabel(input: EditorInput): { readonly name: string; readonly description?: string } {
	const path = input.resource.scheme === "file"
		? input.resource.fsPath
		: decodeURIComponent(input.resource.path);
	const normalizedPath = path.replaceAll("\\", "/").replace(/\/+$/, "");
	const separator = normalizedPath.lastIndexOf("/");
	const explicitLabel = input.label?.trim();
	const name = explicitLabel || normalizedPath.slice(separator + 1) || input.resource.authority || input.resource.toString();
	const description = separator > 0 && (!explicitLabel || !/[\\/]/u.test(explicitLabel))
		? normalizedPath.slice(0, separator)
		: undefined;
	return { name, description };
}
