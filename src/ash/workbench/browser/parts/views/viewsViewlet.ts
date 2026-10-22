import type { Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IViewDescriptor } from '../../../common/views.js';
import { PaneComposite, type PaneCompositeOptions } from '../../panecomposite.js';
import type { ViewPane } from './viewPane.js';

/** Filters the owning model's active views without writing the user's visibility preference. */
export abstract class FilterViewPaneContainer extends PaneComposite {
	constructor(
		container: HTMLElement,
		private readonly filterOptions: PaneCompositeOptions,
		onDidChangeFilterValue: Event<string[]>,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IConfigurationService configuration: IConfigurationService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(container, filterOptions, storage, theme, menus, configuration, instantiation, contextKeys);
		this._register(onDidChangeFilterValue(values => {
			const accepted = new Set(values);
			filterOptions.model.setFilter(view => {
				const category = this.getFilterOn(view);
				return category === undefined || accepted.has(category);
			});
		}));
		this._register(toDisposable(() => filterOptions.model.setFilter(undefined)));
	}

	protected abstract getFilterOn(viewDescriptor: IViewDescriptor): string | undefined;
	protected abstract setFilter(viewDescriptor: IViewDescriptor): void;

	public override openView(id: string, focus?: boolean): ViewPane | undefined {
		if (!this.filterOptions.model.activeViewDescriptors.some(view => view.id === id)) {
			const descriptor = this.filterOptions.model.allViewDescriptors.find(view => view.id === id);
			if (descriptor) { this.setFilter(descriptor); }
		}
		return super.openView(id, focus);
	}
}
