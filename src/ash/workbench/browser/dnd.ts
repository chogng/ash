import { addDisposableListener } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { localize } from '../../nls.js';
import { DataTransfers } from '../../base/browser/dnd.js';
import { Mimes } from '../../base/common/mime.js';
import { URI } from '../../base/common/uri.js';
import { Schemas } from '../../base/common/network.js';
import { basename } from '../../base/common/resources.js';
import { isWindows } from '../../base/common/platform.js';
import { CodeDataTransfers, type IResourceStat } from '../../platform/dnd/browser/dnd.js';
import { withSelection } from '../../platform/opener/common/opener.js';
import { ILabelService } from '../../platform/label/common/label.js';
import type { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService, ViewContainerLocation, type IViewDescriptor } from '../common/views.js';
import { IViewsService } from '../services/views/common/viewsService.js';

type ViewDropTarget = { readonly element: HTMLElement; readonly containerId: string } | { readonly element: HTMLElement; readonly location: ViewContainerLocation };

/** Writes source identities for native resource drops; captured Chat content stays with its draft. */
export function fillEditorsDragData(accessor: ServicesAccessor, resources: URI[] | IResourceStat[], event: DragEvent, options?: { disableStandardTransfer: boolean }): void {
	const transfer = event.dataTransfer;
	if (!transfer || !resources.length) return;
	const entries = resources.map((entry): IResourceStat => (URI.isUri(entry) ? { resource: entry } : entry));
	const uris = entries.map(entry => (entry.selection ? withSelection(entry.resource, entry.selection) : entry.resource));
	const values = uris.map(resource => resource.toString());
	transfer.setData(DataTransfers.RESOURCES, JSON.stringify(values));
	transfer.setData(Mimes.uriList, values.join('\r\n'));
	const localFiles = entries.filter(entry => !entry.isDirectory && entry.resource.scheme === Schemas.file).map(entry => entry.resource);
	if (localFiles.length) transfer.setData(CodeDataTransfers.FILES, JSON.stringify(localFiles.map(resource => resource.fsPath)));
	if (!options?.disableStandardTransfer) {
		const labels = accessor.get(ILabelService);
		transfer.setData(DataTransfers.TEXT, uris.map(resource => labels.getUriLabel(resource, { noPrefix: true })).join(isWindows ? '\r\n' : '\n'));
		if (localFiles[0]) transfer.setData(DataTransfers.DOWNLOAD_URL, `${Mimes.binary}:${basename(localFiles[0])}:${localFiles[0].toString()}`);
	}
}

/** Routes native view drags within one window; declarations and layout state stay with the descriptor service. */
export class ViewDragAndDropController extends Disposable {
	private draggedViews: readonly IViewDescriptor[] = [];
	private draggedContainerId: string | undefined;
	private dropTarget: ViewDropTarget | undefined;

	constructor(
		private readonly root: HTMLElement,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IViewsService private readonly views: IViewsService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this._register(addDisposableListener(root, 'dragstart', event => this.start(event)));
		this._register(
			addDisposableListener(
				root,
				'dragover',
				event => {
					const target = this.target(event.target);
					this.setTarget(target);
					if (!target) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
				},
				true,
			),
		);
		this._register(
			addDisposableListener(
				root,
				'drop',
				event => {
					const target = this.target(event.target);
					if (!target) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					const dragged = this.draggedViews;
					const sourceContainerId = this.draggedContainerId;
					this.clear();
					if ('containerId' in target) {
						this.descriptors.moveViewsToContainer(dragged, this.descriptors.getViewContainerById(target.containerId)!);
					} else if (sourceContainerId) {
						this.descriptors.moveViewContainerToLocation(this.descriptors.getViewContainerById(sourceContainerId)!, target.location);
					} else {
						for (const view of dragged) this.descriptors.moveViewToLocation(view, target.location);
					}
					void this.views.openView(dragged[0].id, true).catch(onUnexpectedError);
				},
				true,
			),
		);
		this._register(addDisposableListener(root.ownerDocument, 'dragend', () => this.clear(), true));
		this._register(
			addDisposableListener(root, 'dragleave', event => {
				if (!event.relatedTarget || !root.contains(event.relatedTarget as Node)) this.setTarget(undefined);
			}),
		);
		this._register(addDisposableListener(root, 'contextmenu', event => this.showMenu(event)));
		this._register(
			addDisposableListener(root, 'keydown', event => {
				if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showMenu(event);
			}),
		);
	}

	private start(event: DragEvent): void {
		this.clear();
		const element = event.target as HTMLElement;
		const pane = element.closest<HTMLElement>('[data-view-id]');
		if (pane && element.closest('.ash-pane-view-header') && !element.closest('.ash-pane-view-header-actions')) {
			const view = this.descriptors.getViewDescriptorById(pane.dataset.viewId!);
			if (view?.canMoveView) this.draggedViews = [view];
		} else {
			const item = element.closest<HTMLElement>('.ash-composite-bar-destination[data-action-id]');
			const id = item?.dataset.actionId;
			if (id && this.descriptors.getViewContainerById(id)) {
				const views = this.descriptors.getViewContainerModel(id).allViewDescriptors;
				if (views.length === 1 && views[0].canMoveView) {
					this.draggedViews = views;
					this.draggedContainerId = id;
				}
			}
		}
		if (!this.draggedViews.length) return;
		// Only drags originating in this window are accepted; external payloads cannot move views.
		event.dataTransfer?.setData('application/vnd.ash.view', this.draggedViews[0].id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	private target(target: EventTarget | null): ViewDropTarget | undefined {
		if (!this.draggedViews.length || !(target instanceof this.root.ownerDocument.defaultView!.Element)) return;
		const bar = target.closest<HTMLElement>('.ash-composite-bar[data-view-container-location]');
		// Reordering an entry within its own selector remains owned by CompositeBar.
		if (bar && this.draggedContainerId && this.descriptors.getViewContainerById(this.draggedContainerId)?.location === bar.dataset.viewContainerLocation) return;
		const container = target.closest<HTMLElement>('[data-view-container-id]');
		const item = target.closest<HTMLElement>('.ash-composite-bar-destination[data-action-id]');
		const containerId = container?.dataset.viewContainerId ?? item?.dataset.actionId;
		if (containerId) {
			const descriptor = this.descriptors.getViewContainerById(containerId);
			if (!descriptor || descriptor.rejectAddedViews || this.draggedViews.every(view => this.descriptors.getViewContainerForView(view.id)?.id === containerId)) return;
			return { element: container ?? item!, containerId };
		}
		const part = target.closest<HTMLElement>('[data-part]');
		const location = bar?.dataset.viewContainerLocation ?? (part?.dataset.part === 'activitybar' ? ViewContainerLocation.Sidebar : part?.dataset.part);
		if (location === ViewContainerLocation.Sidebar || location === ViewContainerLocation.Panel || location === ViewContainerLocation.AuxiliaryBar) {
			return { element: bar ?? part!, location };
		}
		return undefined;
	}

	private setTarget(target: ViewDropTarget | undefined): void {
		if (this.dropTarget?.element !== target?.element) {
			this.dropTarget?.element.classList.remove('ash-view-drop-target');
			target?.element.classList.add('ash-view-drop-target');
		}
		this.dropTarget = target;
	}

	private clear(): void {
		this.setTarget(undefined);
		this.draggedViews = [];
		this.draggedContainerId = undefined;
	}

	private showMenu(event: MouseEvent | KeyboardEvent): void {
		if (event.defaultPrevented) return;
		const element = event.target as HTMLElement;
		const header = element.closest<HTMLElement>('.ash-pane-view-header');
		const id = header?.closest<HTMLElement>('[data-view-id]')?.dataset.viewId;
		if (!id || !this.descriptors.getViewDescriptorById(id)?.canMoveView) return;
		event.preventDefault();
		event.stopPropagation();
		const moveLabel = localize('views.moveView', 'Move View...');
		const resetLabel = localize('views.resetLocation', 'Reset Location');
		this.contextMenus.showContextMenu({
			getAnchor: () => ('clientX' in event ? { x: event.clientX, y: event.clientY } : header!),
			getActions: () => [
				{
					id: 'workbench.action.moveFocusedView',
					label: moveLabel,
					tooltip: moveLabel,
					enabled: true,
					run: () => this.commands.executeCommand('workbench.action.moveFocusedView', id),
				},
				{
					id: 'workbench.action.resetFocusedViewLocation',
					label: resetLabel,
					tooltip: resetLabel,
					enabled: true,
					run: () => this.commands.executeCommand('workbench.action.resetFocusedViewLocation', id),
				},
			],
		});
	}

	public override dispose(): void {
		this.clear();
		super.dispose();
	}
}
