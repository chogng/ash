import { DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IActivityService } from '../../../workbench/services/activity/common/activity.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { IViewDescriptorService, type IViewContainerDescriptor, type IViewDescriptor, type WorkbenchViewRegistry } from '../../../workbench/common/views.js';
import { PaneComposite } from '../../../workbench/browser/panecomposite.js';
import { AuxiliaryBarPart } from './auxiliaryBarPart.js';
import './media/desktopAuxiliaryBarPart.css';

/** A retained, title-free Auxiliary Bar docked and sized by its EditorPart. */
export class DesktopAuxiliaryBarPart extends AuxiliaryBarPart {
	private readonly factories = new Map<string, () => void>();
	private readonly requestClose = this._register(new Emitter<void>());
	public readonly onDidRequestClose = this.requestClose.event;

	constructor(
		container: HTMLElement,
		private readonly registry: WorkbenchViewRegistry,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@IActivityService activity: IActivityService,
		@IInstantiationService private readonly services: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IViewsService private readonly views: IViewsService,
	) {
		super(container, { id: 'editor-details' }, descriptors, contextKeys, storage, activity, services, theme, menus, contextMenus);
		this.domNode.classList.add('ash-desktop-auxiliarybar');
	}

	public override get minimumWidth(): number { return 220; }

	/** Contributions supply ordinary views; this Part owns their composites and window-command registration. */
	public registerViewContainer(container: IViewContainerDescriptor, descriptors: readonly IViewDescriptor[], open: () => Promise<void>): IDisposable {
		const registration = new DisposableStore();
		try {
			registration.add(this.registry.registerViewContainer(container));
			registration.add(this.registry.registerViews(container.id, descriptors));
			for (const descriptor of descriptors) registration.add(this.views.registerViewOpener(descriptor.id, open));
			this.factories.set(container.id, () => {
				const composite = this.services.createInstance(PaneComposite, this.domNode, {
					viewContainer: container, model: this.descriptors.getViewContainerModel(container.id),
					...this.getPaneCompositeOptions(),
				});
				this.addComposite(composite);
				for (const pane of composite.panes) {
					const descriptor = descriptors.find(view => view.id === pane.id)!;
					registration.add(this.views.registerView(pane, descriptor, open, () => this.requestClose.fire()));
				}
			});
			registration.add(toDisposable(() => {
				this.factories.delete(container.id);
				this.removeComposite(container.id);
			}));
			return registration;
		} catch (error) {
			registration.dispose();
			throw error;
		}
	}

	public override showComposite(id: string, focus = false): void {
		if (!this.getComposite(id)) this.factories.get(id)?.();
		super.showComposite(id, focus);
	}

	public focus(): void { this.getActiveComposite()?.focus(); }
}
