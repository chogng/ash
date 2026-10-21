import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../browser/parts/views/paneComposite.js';
import './media/scm.css';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export class SCMViewPaneContainer extends PaneComposite {
	constructor(
		container: HTMLElement,
		options: PaneCompositeOptions,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
		@IMenuService menuService: IMenuService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(container, { ...options, mergeViewWithContainerWhenSingleView: true }, storageService, themeService, menuService, configurationService);
		this.element.classList.add('ash-scm-viewlet');
	}

	override getOptimalWidth(): number {
		return 400;
	}
}
