import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import './media/activitybarpart.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { CompositeBar } from '../compositeBar.js';
import { WorkbenchConfiguration, type SideBarLocation, type WorkbenchLayoutStyle } from '../../../common/configuration.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { ActivityBarContextMenu } from '../../actions/layoutActions.js';
import type { GlobalCompositeBar } from '../globalCompositeBar.js';
import { Part } from '../../part.js';

/** Fixed rail for the primary sidebar's View Container selector. */
export class ActivitybarPart extends Part {
	private layoutStyle: WorkbenchLayoutStyle;
	private compact: boolean;
	private sideBarLocation: SideBarLocation;
	public override get minimumWidth(): number {
		if (this.layoutStyle === 'modern') return this.compact ? 36 : 44;
		return this.compact ? 36 : 48;
	}
	public override get maximumWidth(): number { return this.minimumWidth; }

	constructor(
		container: HTMLElement,
		private readonly compositeBar: CompositeBar,
		private readonly globalCompositeBar: Pick<GlobalCompositeBar, 'domNode' | 'getContextMenuActions'>,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMenuService private readonly menuService: IMenuService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(container, 'activitybar', themeService, storageService);
		this.contentDomNode.classList.add('ash-activity-bar-content');
		this.layoutStyle = this.configurationService.getValue<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle);
		this.compact = this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarCompact);
		this.sideBarLocation = this.configurationService.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation);
		this.contentDomNode.append(compositeBar.domNode, globalCompositeBar.domNode);
		this.applyPosition();
		compositeBar.setBadgesEnabled(this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarBadges));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.activityBarBadges)) {
				compositeBar.setBadgesEnabled(this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarBadges));
			}
		}));
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(addDisposableListener(compositeBar.domNode, 'contextmenu', event => {
			if (!this.domNode.contains(compositeBar.domNode)) compositeBar.showContextMenu(event, this.getContextMenuActions());
		}));
		this._register(addDisposableListener(globalCompositeBar.domNode, 'contextmenu', event => {
			if (!this.domNode.contains(globalCompositeBar.domNode)) this.showContextMenu(event);
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showContextMenu(event);
		}));
		for (const domNode of [compositeBar.domNode, globalCompositeBar.domNode]) {
			this._register(addDisposableListener(domNode, 'keydown', event => {
				if (!this.domNode.contains(domNode) && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) this.showContextMenu(event);
			}));
		}
	}

	public hostCompositeBar(): void {
		this.contentDomNode.prepend(this.compositeBar.domNode);
		this.applyPosition();
	}

	public hostGlobalActions(): void {
		this.contentDomNode.append(this.globalCompositeBar.domNode);
	}

	public showContextMenu(event: MouseEvent | KeyboardEvent): void {
		this.compositeBar.showContextMenu(event, this.getContextMenuActions());
	}

	public setCompact(compact: boolean): void {
		if (this.compact === compact) return;
		this.compact = compact;
		this.domNode.classList.toggle('compact', compact);
		this.notifyConstraintsChanged();
	}

	public setSideBarLocation(location: SideBarLocation): void {
		if (this.sideBarLocation === location) return;
		this.sideBarLocation = location;
		this.domNode.classList.toggle('sidebar-right', location === 'right');
	}

	public setLayoutStyle(style: WorkbenchLayoutStyle): void {
		if (this.layoutStyle === style) return;
		this.layoutStyle = style;
		this.notifyConstraintsChanged();
	}

	public setSidebarVisible(visible: boolean): void {
		this.domNode.classList.toggle('sidebar-open', visible);
	}

	private applyPosition(): void {
		this.domNode.classList.toggle('compact', this.compact);
		this.domNode.classList.toggle('sidebar-right', this.sideBarLocation === 'right');
		this.compositeBar.setOrientation('vertical');
	}

	private getContextMenuActions(): readonly IAction[] {
		const actions = this.menuService.getMenuActions(ActivityBarContextMenu);
		return Separator.join([...this.globalCompositeBar.getContextMenuActions()], ...actions.map(([, group]) => [...group]));
	}
}
