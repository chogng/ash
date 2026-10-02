import "./media/multiEditorTabsControl.css";
import { DataTransfers } from "../../../../base/browser/dnd.js";
import { EditorInputCapabilities } from '../../../common/editor.js';
import { TAB_CLOSE_ACTION_ID } from '../../../../base/browser/ui/tablist/tabList.js';
import { addDisposableListener, isElement } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import type { IAction } from "../../../../base/common/actions.js";
import { assertDefined } from "../../../../base/common/types.js";
import { TabList, type TabListPresentation } from "../../../../base/browser/ui/tablist/tabList.js";
import { localize } from "../../../../nls.js";
import { containsExternalEditorDrop } from "./editorDropData.js";
import { clearConnectedTabClipping, updateConnectedTabClipping } from "./connectedTabClipping.js";
import { CONNECTED_EDITOR_TABS_CLASS } from "./editor.js";
import type { EditorInput } from "./editorInput.js";
import { EditorTabsControl, editorInputKey, type EditorTabDescriptor, type EditorTabsDelegate } from "./editorTabsControl.js";
import { IResourceLabelService, type IResourceLabel, type ResourceLabels } from "../../labels.js";
import { DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { IContextKeyService, type IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { ActiveEditorPinnedContext, ActiveEditorStickyContext, EditorTabsFocusContext } from "../../../common/contextkeys.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { EditorShowIconsConfiguration, EditorTitleScrollbarSizingConfiguration, EditorTitleScrollbarVisibilityConfiguration, type EditorTitleScrollbarSizing, type EditorTitleScrollbarVisibility } from "../../../services/editor/common/editorConfiguration.js";

const DRAG_OVER_ACTIVATE_DELAY = 1500;

/** Renders every open Editor in one reorderable tab list. */
export class MultiEditorTabsControl extends EditorTabsControl {
	private readonly tabList: TabList<EditorTabDescriptor>;
	private readonly viewport: HTMLElement;
	private readonly labels: ResourceLabels;
	private connectedTab: HTMLElement | undefined;
	private connected = true;
	private previewedInput: EditorInput | undefined;
	private editors: readonly EditorTabDescriptor[] = [];
	private readonly tabContext: IScopedContextKeyService;
	private readonly renderedLabels = new Map<string, { readonly label: IResourceLabel; readonly context: IScopedContextKeyService; signature: string | undefined }>();
	private readonly unpinActions = new Map<string, IAction>();
	private readonly protectedCloseActions = new Map<string, IAction>();

	constructor(
		container: HTMLElement,
		private readonly delegate: EditorTabsDelegate,
		@IResourceLabelService resourceLabels: IResourceLabelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(container);
		this.domNode.classList.add("ash-multi-editor-tabs-control");
		this.tabContext = this._register(contextKeyService.createScoped(this.domNode));
		this.labels = this._register(resourceLabels.createGroup());
		this.labels.setIconVisibility(configurationService.getValue<boolean>(EditorShowIconsConfiguration));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(EditorShowIconsConfiguration)) this.labels.setIconVisibility(configurationService.getValue<boolean>(EditorShowIconsConfiguration));
			if (event.affectsConfiguration(EditorTitleScrollbarSizingConfiguration) || event.affectsConfiguration(EditorTitleScrollbarVisibilityConfiguration)) this.updateScrollbarOptions();
		}));
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
		}));
		this.updateScrollbarOptions();
		const viewport = this.tabList.scrollableElement;
		this.viewport = viewport;
		this.domNode.classList.add(CONNECTED_EDITOR_TABS_CLASS);
		this._register(this.tabList.onDidScroll(() => this.updateConnectedTab()));
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
		this._register(addDisposableListener(this.tabList.element, "dblclick", event => {
			const label = (event.target as Element).closest<HTMLButtonElement>(".ash-tab-label");
			if (!label || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
				return;
			}
			const editor = this.editors.find(candidate => candidate.tabId === label.id);
			assertDefined(editor, `Editor tab is not available: ${label.id}`);
			event.preventDefault();
			event.stopPropagation();
			this.delegate.pinEditor(editor.input);
		}));
	}

	private updateScrollbarOptions(): void {
		this.tabList.updateScrollbarOptions({
			scrollbarSize: this.configurationService.getValue<EditorTitleScrollbarSizing>(EditorTitleScrollbarSizingConfiguration) === 'large' ? 10 : 3,
			horizontal: this.configurationService.getValue<EditorTitleScrollbarVisibility>(EditorTitleScrollbarVisibilityConfiguration),
		});
	}

	private showTabContextMenu(event: MouseEvent | KeyboardEvent): void {
		const target = event.target;
		if (!isElement(target)) {
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
			let primaryAction = this.unpinActions.get(editor.instanceId);
			if (editor.sticky && !primaryAction) {
				const unpinLabel = localize("workbench.unpinEditor", "Unpin Editor");
				primaryAction = {
					id: "workbench.action.unpinActiveEditor",
					label: unpinLabel,
					tooltip: unpinLabel,
					icon: Lxicon.pinned,
					enabled: true,
					run: () => {
						const current = this.editors.find(candidate => candidate.instanceId === editor.instanceId)!;
						this.delegate.unstickEditor(current.input);
					},
				};
				// Retain the action across state updates so its focused button stays in place.
				this.unpinActions.set(editor.instanceId, primaryAction);
			}
			const state = editor.hasExternalChange ? "conflict" : editor.isDirty ? "dirty" : undefined;
			if (!editor.sticky && ((editor.input.capabilities ?? EditorInputCapabilities.None) & EditorInputCapabilities.CannotClose)) {
				let closeAction = this.protectedCloseActions.get(editor.instanceId);
				if (!closeAction) {
					closeAction = {
						id: TAB_CLOSE_ACTION_ID,
						label: localize('workbench.closeEditor', 'Close editor'),
						tooltip: localize('workbench.closeEditor', 'Close editor'),
						icon: Lxicon.close,
						enabled: false,
						run: () => this.delegate.close(editor.input),
					};
					this.protectedCloseActions.set(editor.instanceId, closeAction);
				}
				primaryAction = closeAction;
			}
			const stateLabel = editor.hasExternalChange ? "conflict with changes on disk" : editor.isDirty ? "unsaved changes" : undefined;
			let ariaDescription = localize("workbench.editorUnpinnedTabHint", "Use Pin Editor to pin this tab.");
			if (editor.sticky) {
				ariaDescription = localize("workbench.editorPinnedTabHint", "Pinned tab. Use Unpin Editor to unpin.");
			} else if (editor.preview) {
				ariaDescription = localize("workbench.editorPreviewTabHint", "Double-click or use Keep Open to keep this tab open. Use Pin Editor to pin this tab.");
			}
			return {
				id: editor.instanceId,
				value: editor,
				label: label.name,
				description: label.description,
				renderLabel: container => {
					const store = new DisposableStore();
					const resourceLabel = store.add(this.labels.create(container));
					store.add(resourceLabel.onDidRender(() => {
						const current = this.editors.find(candidate => candidate.instanceId === editor.instanceId)!;
						this.updateTabAriaLabel(current, resourceLabel);
					}));
					const context = store.add(this.tabContext.createScoped(container));
					EditorTabsFocusContext.bindTo(context).set(true);
					this.renderedLabels.set(editor.instanceId, { label: resourceLabel, context, signature: undefined });
					store.add(toDisposable(() => this.renderedLabels.delete(editor.instanceId)));
					store.add(toDisposable(() => this.unpinActions.delete(editor.instanceId)));
					store.add(toDisposable(() => this.protectedCloseActions.delete(editor.instanceId)));
					return store;
				},
				tooltip: stateLabel ? `${editor.input.resource.toString()} — ${stateLabel}` : editor.input.resource.toString(),
				ariaLabel: stateLabel ? `${label.name}, ${stateLabel}` : label.name,
				ariaDescription,
				...(state ? { state } : {}),
				preview: editor.preview,
				primaryAction,
				tabId: editor.tabId,
				panelId: editor.panelId,
			};
		}), activeKey, selectedIds);
		for (const editor of editors) {
			const rendered = this.renderedLabels.get(editor.instanceId)!;
			rendered.context.bufferChangeEvents(() => {
				rendered.context.setContext(ActiveEditorPinnedContext.key, !editor.preview);
				rendered.context.setContext(ActiveEditorStickyContext.key, editor.sticky);
			});
			const label = editorInputLabel(editor.input);
			const icon = editor.input.getIcon?.();
			const signature = JSON.stringify([editor.input.resource.toString(), label.name, label.description, icon]);
			// Resource labels recreate their text when updated; selection must retain the click target.
			if (rendered.signature !== signature) {
				rendered.signature = signature;
				rendered.label.setResource({ resource: editor.input.resource, name: label.name, description: label.description }, { ariaLabel: label.name, forceLabel: true, icon, fileDecorations: { colors: true, badges: true } });
			}
			this.updateTabAriaLabel(editor, rendered.label);
		}
		clearConnectedTabClipping(this.connectedTab, this.tabList.element);
		this.connectedTab = this.tabList.element.querySelector<HTMLElement>(".ash-tab.checked") ?? undefined;
		this.updateConnectedTab();
		this.tabList.element.hidden = editors.length === 0;
	}

	private updateTabAriaLabel(editor: EditorTabDescriptor, label: IResourceLabel): void {
		const tabLabel = this.domNode.ownerDocument.getElementById(editor.tabId);
		// A newly created label renders before TabList attaches its tab to the document.
		if (!tabLabel) return;
		const state = editor.hasExternalChange ? localize('workbench.editor.externalChange', 'conflict with changes on disk') : editor.isDirty ? localize('workbench.editor.unsavedChanges', 'unsaved changes') : undefined;
		const name = label.element.getAttribute('aria-label') ?? editorInputLabel(editor.input).name;
		tabLabel.setAttribute('aria-label', state ? `${name}, ${state}` : name);
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
		: input.resource.path;
	const normalizedPath = path.replaceAll("\\", "/").replace(/\/+$/, "");
	const separator = normalizedPath.lastIndexOf("/");
	const explicitLabel = input.label?.trim();
	const name = explicitLabel || normalizedPath.slice(separator + 1) || input.resource.authority || input.resource.toString();
	const description = separator > 0 && (!explicitLabel || !/[\\/]/u.test(explicitLabel))
		? normalizedPath.slice(0, separator)
		: undefined;
	return { name, description };
}
