import './media/multiEditorTabsControl.css';
import { DataTransfers } from '../../../../base/browser/dnd.js';
import { EditorInputCapabilities, EditorResourceAccessor, SideBySideEditor, type IResourceEditorInput } from '../../../common/editor.js';
import { TAB_CLOSE_ACTION_ID, type TabListOptions } from '../../../../base/browser/ui/tablist/tabList.js';
import { addDisposableListener, isElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { IAction } from '../../../../base/common/actions.js';
import { assertDefined } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { containsExternalEditorDrop } from './editorDropData.js';
import { EditorTabsControl, editorInputKey, type EditorTabDescriptor, type EditorTabsDelegate } from './editorTabsControl.js';
import { IResourceLabelService, type IResourceLabel, type ResourceLabels } from '../../labels.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService, type IScopedContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ActiveEditorPinnedContext, ActiveEditorStickyContext, EditorTabsFocusContext } from '../../../common/contextkeys.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { shorten } from '../../../../base/common/labels.js';
import { Schemas } from '../../../../base/common/network.js';
import type { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { EditorLabelFormatConfiguration, EditorShowIconsConfiguration, type EditorLabelFormat } from '../../../services/editor/common/editorConfiguration.js';
import { WorkbenchTabsControl } from './workbenchTabsControl.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

const DRAG_OVER_ACTIVATE_DELAY = 1500;

/** Renders every open Editor in one reorderable tab list. */
export class MultiEditorTabsControl extends EditorTabsControl {
	private readonly tabs: WorkbenchTabsControl<EditorTabDescriptor>;
	private readonly labels: ResourceLabels;
	private previewedInput: IResourceEditorInput | undefined;
	private editors: readonly EditorTabDescriptor[] = [];
	private activeInput: IResourceEditorInput | undefined;
	private selectedIds: ReadonlySet<string> | undefined;
	private readonly tabContext: IScopedContextKeyService;
	private readonly renderedLabels = new Map<string, { readonly label: IResourceLabel; readonly context: IScopedContextKeyService; signature: string | undefined; }>();
	private readonly unpinActions = new Map<string, IAction>();
	private readonly protectedCloseActions = new Map<string, IAction>();

	constructor(
		container: HTMLElement,
		private readonly delegate: EditorTabsDelegate,
		private readonly model: EditorGroupModel,
		@IResourceLabelService resourceLabels: IResourceLabelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(container);
		this.domNode.classList.add('ash-multi-editor-tabs-control');
		this.tabContext = this._register(contextKeyService.createScoped(this.domNode));
		this.labels = this._register(resourceLabels.createGroup());
		this.labels.setIconVisibility(configurationService.getValue<boolean>(EditorShowIconsConfiguration));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(EditorShowIconsConfiguration)) this.labels.setIconVisibility(configurationService.getValue<boolean>(EditorShowIconsConfiguration));
			if (event.affectsConfiguration(EditorLabelFormatConfiguration)) {
				this.setEditors(this.editors, this.activeInput, this.selectedIds);
			}
		}));
		this._register(workspaceContextService.onDidChangeWorkspace(() => this.setEditors(this.editors, this.activeInput, this.selectedIds)));
		this._register(labelService.onDidChangeFormatters(() => this.setEditors(this.editors, this.activeInput, this.selectedIds)));
		this.tabs = this._register(instantiationService.createInstance(WorkbenchTabsControl<EditorTabDescriptor>, this.domNode, {
			ariaLabel: localize({ bundle: 'ash.regions', key: 'openEditors' }, 'Open editors'),
			draggable: true,
			dragAndDrop: {
				canDrop: (event) => delegate.isDragging() || containsExternalEditorDrop(event),
				onDragStart: (editor, event) => {
					event.dataTransfer?.setData(DataTransfers.TEXT, editor.instanceId);
					if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
					delegate.startDrag(editor.input);
				},
				onDragEnter: (_target, _position, event) => {
					this.previewedInput = undefined;
					if (event.dataTransfer) event.dataTransfer.dropEffect = delegate.isDragging() ? 'move' : 'copy';
				},
				onDragOver: (target, _position, event, duration) => {
					if (event.dataTransfer) event.dataTransfer.dropEffect = delegate.isDragging() ? 'move' : 'copy';
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
		} satisfies TabListOptions<EditorTabDescriptor>));
		this._register(addDisposableListener(this.tabs.tabList.element, 'contextmenu', event => {
			this.showTabContextMenu(event);
		}));
		this._register(addDisposableListener(this.tabs.tabList.element, 'keydown', event => {
			if (!event.shiftKey || event.key !== 'F10') {
				return;
			}
			this.showTabContextMenu(event);
		}));
		this._register(addDisposableListener(this.tabs.tabList.element, 'dblclick', event => {
			const label = (event.target as Element).closest<HTMLButtonElement>('.ash-tab-label');
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

	private showTabContextMenu(event: MouseEvent | KeyboardEvent): void {
		const target = event.target;
		if (!isElement(target)) {
			return;
		}
		const tab = target.closest<HTMLElement>('.ash-tab');
		if (!tab || !this.tabs.tabList.element.contains(tab)) {
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

	setEditors(editors: readonly EditorTabDescriptor[], activeInput: IResourceEditorInput | undefined, selectedIds?: ReadonlySet<string>): void {
		this.editors = editors;
		this.activeInput = activeInput;
		this.selectedIds = selectedIds;
		const format = this.configurationService.getValue<EditorLabelFormat>(EditorLabelFormatConfiguration);
		// Both tab rows use the whole group so pinning never removes disambiguation.
		const groupLabels = this.model.getEditors().map(input => editorInputLabel(input, this.labelService));
		const labels = new Map(editors.map(editor => {
			const label = editorInputLabel(editor.input, this.labelService);
			if (format === 'short') {
				label.description = label.description === undefined ? undefined : basename(dirname(editor.input.resource));
			} else if (format === 'long') {
				label.description = label.description === undefined ? undefined : this.labelService.getUriLabel(dirname(editor.input.resource));
			} else if (format === 'default' && label.description !== undefined) {
				const peers = groupLabels.filter(peer => peer.name === label.name && peer.description !== undefined);
				if (peers.length <= 1) {
					label.description = undefined;
				} else {
					let descriptions = peers.map(peer => peer.description!);
					// Relative directories can coincide across workspace roots or remote hosts.
					if (new Set(descriptions).size !== descriptions.length) {
						descriptions = peers.map(peer => this.labelService.getUriLabel(dirname(peer.input.resource)));
					}
					if (new Set(descriptions).size !== descriptions.length) {
						descriptions = peers.map((peer, index) => `${peer.input.resource.authority} • ${descriptions[index]}`);
					}
					label.description = shorten(descriptions, this.labelService.getSeparator(editor.input.resource?.scheme ?? '', editor.input.resource?.authority))[peers.findIndex(peer => peer.input === editor.input)];
				}
			}
			return [editor.input, label] as const;
		}));
		const activeKey = activeInput ? editors.find(editor => editorInputKey(editor.input) === editorInputKey(activeInput))?.instanceId : undefined;
		this.tabs.setTabs(editors.map((editor) => {
			const label = labels.get(editor.input)!;
			let primaryAction = this.unpinActions.get(editor.instanceId);
			if (editor.sticky && !primaryAction) {
				const unpinLabel = localize('workbench.unpinEditor', 'Unpin');
				primaryAction = {
					id: 'workbench.action.unpinActiveEditor',
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
			const state = editor.hasExternalChange ? 'conflict' : editor.isDirty ? 'dirty' : undefined;
			if (!editor.sticky && ((editor.input.capabilities ?? EditorInputCapabilities.None) & EditorInputCapabilities.CannotClose)) {
				let closeAction = this.protectedCloseActions.get(editor.instanceId);
				if (!closeAction) {
					closeAction = {
						id: TAB_CLOSE_ACTION_ID,
						label: localize('workbench.closeEditor', 'Close'),
						tooltip: localize('workbench.closeEditor', 'Close'),
						icon: Lxicon.close,
						enabled: false,
						run: () => this.delegate.close(editor.input),
					};
					this.protectedCloseActions.set(editor.instanceId, closeAction);
				}
				primaryAction = closeAction;
			}
			const stateLabel = editor.hasExternalChange ? 'conflict with changes on disk' : editor.isDirty ? 'unsaved changes' : undefined;
			let ariaDescription = localize('workbench.editorUnpinnedTabHint', 'Use Pin to pin this tab.');
			if (editor.sticky) {
				ariaDescription = localize('workbench.editorPinnedTabHint', 'Pinned tab. Use Unpin to unpin.');
			} else if (editor.preview) {
				ariaDescription = localize('workbench.editorPreviewTabHint', 'Double-click or use Keep Open to keep this tab open. Use Pin to pin this tab.');
			}
			return {
				id: editor.instanceId,
				value: editor,
				label: label.name,
				description: label.description,
				renderLabel: container => {
					const store = new DisposableStore();
					const resourceLabel = store.add(this.labels.create(container, { hoverTargetOverride: container }));
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
				// The resource label owns one hover for the whole tab, including its padding.
				tooltip: '',
				closeActionTooltip: editor.closeActionTooltip,
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
			const label = labels.get(editor.input)!;
			const icon = editor.input.getIcon?.();
			const resource = EditorResourceAccessor.getOriginalUri(editor.input, { supportSideBySide: SideBySideEditor.BOTH });
			const extraClasses = editor.input.getLabelExtraClasses?.();
			const signature = JSON.stringify([resource, label.name, label.description, icon, extraClasses]);
			// Resource labels recreate their text when updated; selection must retain the click target.
			if (rendered.signature !== signature) {
				rendered.signature = signature;
				const ariaLabel = label.description ? `${label.name}, ${label.description}` : label.name;
				rendered.label.setResource({ resource, name: label.name, description: label.description }, { ariaLabel, forceLabel: true, icon, extraClasses, fileDecorations: { colors: true, badges: true } });
			}
			this.updateTabAriaLabel(editor, rendered.label);
		}
		this.tabs.layout();
	}

	private updateTabAriaLabel(editor: EditorTabDescriptor, label: IResourceLabel): void {
		const tabLabel = this.domNode.ownerDocument.getElementById(editor.tabId);
		// A newly created label renders before TabList attaches its tab to the document.
		if (!tabLabel) return;
		const state = editor.hasExternalChange ? localize('workbench.editor.externalChange', 'conflict with changes on disk') : editor.isDirty ? localize('workbench.editor.unsavedChanges', 'unsaved changes') : undefined;
		const name = label.element.getAttribute('aria-label') ?? editorInputLabel(editor.input, this.labelService).name;
		tabLabel.setAttribute('aria-label', state ? `${name}, ${state}` : name);
	}

	setConnectedToContent(touchesContent: boolean): void {
		this.tabs.setConnectedToContent(touchesContent);
	}
}

function editorInputLabel(input: IResourceEditorInput, labelService: ILabelService): { readonly input: IResourceEditorInput; readonly name: string; description: string | undefined; } {
	const explicitLabel = input.label?.trim();
	const name = explicitLabel || labelService.getUriBasenameLabel(input.resource);
	const parent = dirname(input.resource);
	const hasDirectory = input.resource.scheme !== Schemas.untitled || parent.path !== '/';
	const description = hasDirectory && input.showBreadcrumbs !== false && (!explicitLabel || !/[\\/]/u.test(explicitLabel))
		? labelService.getUriLabel(parent, { relative: true })
		: undefined;
	return { input, name, description };
}
