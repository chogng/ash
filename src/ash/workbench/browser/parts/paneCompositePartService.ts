import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ViewContainerLocation } from '../../common/views.js';
import { IWorkbenchLayoutService, type WorkbenchPartId } from '../../services/layout/browser/layoutService.js';
import { ILocalizationService } from '../../services/localization/common/localizationService.js';
import { IViewDescriptorService } from '../../common/views.js';
import { type IPaneCompositePartService, type PaneCompositeEvent } from '../../services/panecomposite/browser/panecomposite.js';
import type { PaneCompositePart } from './paneCompositePart.js';
import { PaneComposite } from './views/paneComposite.js';

/** Parts own instances and selection; this service owns opening, focus and location routing. */
export class PaneCompositePartService extends Disposable implements IPaneCompositePartService {
	private readonly opened = this._register(new Emitter<PaneCompositeEvent>());
	private readonly closed = this._register(new Emitter<PaneCompositeEvent>());
	public readonly onDidPaneCompositeOpen = this.opened.event;
	public readonly onDidPaneCompositeClose = this.closed.event;

	constructor(
		private readonly parts: ReadonlyMap<ViewContainerLocation, PaneCompositePart>,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ILocalizationService private readonly localization: ILocalizationService,
	) {
		super();
		for (const [viewContainerLocation, part] of parts) {
			// Parts publish close before removing the retained instance from their collection.
			this._register(part.onDidCompositeOpen(({ composite }) => this.opened.fire({ composite: part.getComposite(composite.getId())!, viewContainerLocation })));
			this._register(part.onDidCompositeClose(composite => this.closed.fire({ composite: part.getComposite(composite.getId())!, viewContainerLocation })));
		}
	}

	public async openPaneComposite(id: string | undefined, location: ViewContainerLocation, focus = false): Promise<PaneComposite | undefined> {
		const part = this.getPart(location);
		const containerId = id ?? part.getCompositeIdToRestore();
		const container = this.descriptors.getViewContainers(location).find(candidate => candidate.id === containerId);
		if (!container) { return undefined; }
		let composite = part.getComposite(container.id);
		if (!composite) {
			const options = {
				viewContainer: container,
				model: this.descriptors.getViewContainerModel(container.id),
				instantiationService: this.instantiation,
				contextKeyService: this.contextKeys,
				localizationService: this.localization,
				onDidFailCreateView: (error: unknown) => { throw error; },
				...part.getPaneCompositeOptions(),
			};
			const created = container.ctorDescriptor
				? this.instantiation.createInstance(container.ctorDescriptor, part.domNode, options)
				: this.instantiation.createInstance(PaneComposite, part.domNode, options);
			if (!(created instanceof PaneComposite)) { throw new TypeError(`View container did not create a PaneComposite: ${container.id}`); }
			composite = created;
			part.addComposite(composite);
		}
		part.showComposite(container.id, focus);
		this.layout.showPart(this.getPartId(location));
		return composite;
	}

	public getActivePaneComposite(location: ViewContainerLocation): PaneComposite | undefined {
		const part = this.getPart(location);
		const id = part.activeCompositeId;
		const composite = id ? part.getComposite(id) : undefined;
		return composite?.isVisible() ? composite : undefined;
	}

	public getPartId(location: ViewContainerLocation): WorkbenchPartId {
		switch (location) {
			case ViewContainerLocation.Sidebar: return 'sidebar';
			case ViewContainerLocation.Panel: return 'panel';
			case ViewContainerLocation.AuxiliaryBar: return 'auxiliarybar';
			case ViewContainerLocation.AgentSidebar: return 'agentSidebar';
		}
	}

	public hideActivePaneComposite(location: ViewContainerLocation): void {
		this.layout.hidePart(this.getPartId(location));
	}

	public getLastActivePaneCompositeId(location: ViewContainerLocation): string | undefined {
		const part = this.getPart(location);
		return part.activeCompositeId ?? part.getCompositeIdToRestore();
	}

	private getPart(location: ViewContainerLocation): PaneCompositePart {
		const part = this.parts.get(location);
		if (!part) { throw new Error(`No Part hosts view container location: ${location}`); }
		return part;
	}
}
