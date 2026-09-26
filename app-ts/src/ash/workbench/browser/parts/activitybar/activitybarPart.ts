import './media/activitybarpart.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { CompositeBar } from '../compositebar/compositeBar.js';
import { WorkbenchConfiguration, type ActivityBarLocation, type SideBarLocation, type WorkbenchLayoutStyle } from '../../../common/configuration.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { GlobalCompositeBar } from '../globalCompositeBar.js';
import { WorkbenchPart } from '../../part.js';

/** Fixed rail for the primary sidebar's View Container selector. */
export class ActivitybarPart extends WorkbenchPart {
	private layoutStyle: WorkbenchLayoutStyle;
	private location: ActivityBarLocation;
	private compact: boolean;
	private sideBarLocation: SideBarLocation;
	public override get minimumWidth(): number {
		if (this.isHorizontal) return 36;
		if (this.layoutStyle === 'modern') return this.compact ? 28 : 36;
		return this.compact ? 36 : 48;
	}
	public override get maximumWidth(): number { return this.isHorizontal ? Number.POSITIVE_INFINITY : this.minimumWidth; }
	public override get minimumHeight(): number { return this.isHorizontal ? 36 : 0; }
	public override get maximumHeight(): number { return this.isHorizontal ? 36 : Number.POSITIVE_INFINITY; }
	private get isHorizontal(): boolean { return this.location === 'top' || this.location === 'bottom'; }

	constructor(
		container: HTMLElement,
		private readonly compositeBar: CompositeBar,
		private readonly globalCompositeBar: Pick<GlobalCompositeBar, 'domNode' | 'setOrientation' | 'getContextMenuActions'>,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILocalizationService private readonly localizationService: ILocalizationService,
	) {
		super(container, 'activitybar');
		this.layoutStyle = this.configurationService.getValue<WorkbenchLayoutStyle>(WorkbenchConfiguration.layoutStyle);
		this.location = this.configurationService.getValue<ActivityBarLocation>(WorkbenchConfiguration.activityBarLocation);
		this.compact = this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarCompact);
		this.sideBarLocation = this.configurationService.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation);
		this.contentDomNode.append(compositeBar.domNode, globalCompositeBar.domNode);
		this.applyPosition();
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => compositeBar.showContextMenu(event, this.getContextMenuActions())));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) compositeBar.showContextMenu(event, this.getContextMenuActions());
		}));
	}

	public setLocation(location: ActivityBarLocation): void {
		if (this.location === location) return;
		this.location = location;
		this.applyPosition();
		this.notifyConstraintsChanged();
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
		this.domNode.classList.toggle('horizontal', this.isHorizontal);
		this.domNode.classList.toggle('location-top', this.location === 'top');
		this.domNode.classList.toggle('location-bottom', this.location === 'bottom');
		this.domNode.classList.toggle('compact', this.compact);
		this.domNode.classList.toggle('sidebar-right', this.sideBarLocation === 'right');
		this.compositeBar.setOrientation(this.isHorizontal ? 'horizontal' : 'vertical');
		this.globalCompositeBar.setOrientation(this.isHorizontal ? 'horizontal' : 'vertical');
	}

	private getContextMenuActions(): readonly IAction[] {
		const label = (key: string, fallback: string) => this.localizationService.translate('ash', key, fallback);
		const location = this.configurationService.getValue<ActivityBarLocation>(WorkbenchConfiguration.activityBarLocation);
		const compact = this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarCompact);
		const sideBarLocation = this.configurationService.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation);
		const positionActions: IAction[] = [
			{ id: 'workbench.action.activityBar.position.default', label: label('workbench.activityBarPositionSide', 'Move Activity Bar to Side'), tooltip: '', enabled: true, checked: location === 'default', run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, 'default') },
			{ id: 'workbench.action.activityBar.position.top', label: label('workbench.activityBarPositionTop', 'Move Activity Bar to Top'), tooltip: '', enabled: true, checked: location === 'top', run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, 'top') },
			{ id: 'workbench.action.activityBar.position.bottom', label: label('workbench.activityBarPositionBottom', 'Move Activity Bar to Bottom'), tooltip: '', enabled: true, checked: location === 'bottom', run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, 'bottom') },
			{ id: 'workbench.action.activityBar.position.hidden', label: label('workbench.activityBarPositionHidden', 'Hide Activity Bar'), tooltip: '', enabled: true, checked: location === 'hidden', run: () => this.configurationService.updateValue(WorkbenchConfiguration.activityBarLocation, 'hidden') },
		];
		const actions: IAction[] = [new SubmenuAction('workbench.action.activityBar.position', label('workbench.activityBarPosition', 'Activity Bar Position'), positionActions)];
		if (location === 'default') {
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
