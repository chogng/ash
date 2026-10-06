import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import './media/activitybarpart.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { CompositeBar } from '../compositeBar.js';
import { ActivityBarPosition, WorkbenchConfiguration, type SideBarLocation, type WorkbenchLayoutStyle } from '../../../common/configuration.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
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
		@ILocalizationService private readonly localizationService: ILocalizationService,
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
		const label = (key: string, fallback: string) => this.localizationService.translate('ash', key, fallback);
		const location = this.configurationService.getValue<ActivityBarPosition>(WorkbenchConfiguration.activityBarLocation);
		const compact = this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarCompact);
		const sideBarLocation = this.configurationService.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation);
		const positionActions: IAction[] = [
			{ id: 'workbench.action.activityBar.position.default', label: label('workbench.activityBarPositionDefault', 'Default'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.DEFAULT, run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, ActivityBarPosition.DEFAULT) },
			{ id: 'workbench.action.activityBar.position.top', label: label('workbench.activityBarPositionTop', 'Top'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.TOP, run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, ActivityBarPosition.TOP) },
			{ id: 'workbench.action.activityBar.position.bottom', label: label('workbench.activityBarPositionBottom', 'Bottom'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.BOTTOM, run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, ActivityBarPosition.BOTTOM) },
			{ id: 'workbench.action.activityBar.position.hidden', label: label('workbench.activityBarPositionHidden', 'Hidden'), tooltip: '', enabled: true, checked: location === ActivityBarPosition.HIDDEN, run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, ActivityBarPosition.HIDDEN) },
		];
		const actions: IAction[] = [new SubmenuAction('workbench.action.activityBar.position', label('workbench.activityBarPosition', 'Activity Bar Position'), positionActions)];
		if (location === ActivityBarPosition.DEFAULT) {
			actions.push(new SubmenuAction('workbench.action.activityBar.size', label('workbench.activityBarSize', 'Activity Bar Size'), [
				{ id: 'workbench.action.activityBar.size.default', label: label('workbench.activityBarSizeDefault', 'Default'), tooltip: '', enabled: true, checked: !compact, run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarCompact, false) },
				{ id: 'workbench.action.activityBar.size.compact', label: label('workbench.activityBarSizeCompact', 'Compact'), tooltip: '', enabled: true, checked: compact, run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarCompact, true) },
			]));
		}
		const nextSide = sideBarLocation === 'left' ? 'right' : 'left';
		const moveLabel = nextSide === 'right'
			? label('workbench.movePrimarySideBarRight', 'Move Primary Side Bar Right')
			: label('workbench.movePrimarySideBarLeft', 'Move Primary Side Bar Left');
		actions.push({ id: 'workbench.action.toggleSidebarPosition', label: moveLabel, tooltip: '', enabled: true, run: () => this.configurationService.updateValue(WorkbenchConfiguration.sideBarLocation, nextSide) });
		return Separator.join([...this.globalCompositeBar.getContextMenuActions()], actions);
	}
}
