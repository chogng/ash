import { IActivityService } from '../../../workbench/services/activity/common/activity.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import './media/sidebarPart.css';
import { h } from '../../../base/browser/dom.js';
import { localize } from '../../../nls.js';
import { ActivityBarPosition } from '../../../workbench/common/configuration.js';
import { SidebarPart as WorkbenchSidebarPart } from '../../../workbench/browser/parts/sidebar/sidebarPart.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { isWeb } from '../../../base/common/platform.js';
import { IUpdateService } from '../../../platform/update/common/updateService.js';
import { IHoverService } from '../../../platform/hover/browser/hoverService.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { createLoadingSpinner } from '../../../base/browser/ui/loadingSpinner/loadingSpinner.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';

/** Shared container host with Sessions Activity Bar placement and sizing. */
export class SidebarPart extends WorkbenchSidebarPart {
	private readonly topActivityBarHost: HTMLDivElement;
	private readonly bottomActivityBarHost: HTMLDivElement;
	private readonly updateStatus: HTMLDivElement;
	public get activityBarAccountHost(): HTMLElement { return this.bottomActivityBarHost; }
	override get minimumWidth(): number { return isWeb ? 270 : 170; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get preferredWidth(): number {
		const width = this.activeCompositeId ? this.getComposite(this.activeCompositeId)!.getOptimalWidth() : 0;
		return Math.max(this.minimumWidth, 300, width);
	}
	constructor(
		container: HTMLElement,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@IActivityService activityService: IActivityService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IWorkbenchLayoutService layoutService: Pick<IWorkbenchLayoutService, 'getSideBarPosition'>,
		@IConfigurationService configurationService: IConfigurationService,
		@IUpdateService updateService: IUpdateService,
		@IHoverService hoverService: IHoverService,
		@INotificationService notifications: INotificationService,
	) {
		super(container, {
			viewDescriptorService: descriptors, contextKeyService: contextKeys, compositeBarVisible: false,
			openComposite: (id, preserveFocus) => instantiationService.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
		}, themeService, storage, activityService, layoutService, configurationService, instantiationService);
		this.topActivityBarHost = h(container.ownerDocument, 'div');
		this.topActivityBarHost.className = 'ash-sessions-activity-host top';
		this.topActivityBarHost.hidden = true;
		this.domNode.insertBefore(this.topActivityBarHost, this.titleDomNode);
		this.bottomActivityBarHost = h(container.ownerDocument, 'div');
		this.bottomActivityBarHost.className = 'ash-sessions-activity-host bottom';
		this.bottomActivityBarHost.hidden = true;
		this.updateStatus = h(container.ownerDocument, 'div');
		this.updateStatus.className = 'ash-sessions-update-status';
		this.updateStatus.setAttribute('role', 'status');
		this._register(contextKeys.createScoped(this.updateStatus)).createKey('sessionsActivityBarFocused', true);
		const row = h(container.ownerDocument, 'div');
		row.className = 'ash-sessions-update-row';
		const spinner = createLoadingSpinner(container.ownerDocument, 'large');
		const label = h(container.ownerDocument, 'span');
		label.className = 'ash-sessions-update-label';
		const message = localize('sessions.update.downloading', 'Downloading update...');
		row.append(spinner, label);
		this.updateStatus.append(row);
		this._register(hoverService.setupDelayedHover(row, { content: message }));
		const restartLabel = localize('sessions.update.restart', 'Restart to Update');
		const restart = this._register(new Button(this.updateStatus, {
			...defaultButtonStyles, label: restartLabel, icon: Lxicon.refresh, title: restartLabel,
		}));
		restart.domNode.classList.add('ash-sessions-update-restart');
		const updateStatus = (): void => {
			const state = updateService.state;
			this.updateStatus.hidden = state === 'idle';
			row.hidden = state !== 'downloading';
			label.textContent = state === 'downloading' ? message : '';
			restart.hidden = state !== 'ready' && state !== 'installing';
			restart.enabled = state === 'ready';
			restart.label = state === 'installing' ? localize('sessions.update.restarting', 'Restarting...') : restartLabel;
		};
		this._register(restart.onDidClick(async () => {
			if (!restart.enabled || updateService.state !== 'ready') return;
			const restoreFocus = restart.hasFocus();
			restart.enabled = false;
			try {
				await updateService.installUpdate();
			} catch {
				if (!this.isDisposed) notifications.error(localize('update.installFailed', 'Could not install the update.'));
			} finally {
				if (!this.isDisposed) {
					updateStatus();
					if (restoreFocus && restart.enabled) restart.focus();
				}
			}
		}));
		this._register(updateService.onDidChangeState(updateStatus));
		updateStatus();
		this.contentDomNode.append(this.updateStatus, this.bottomActivityBarHost);
	}
	public override getPaneCompositeOptions(): ReturnType<WorkbenchSidebarPart['getPaneCompositeOptions']> {
		return { paneLayout: 'fill', mergeViewWithContainerWhenSingleView: true };
	}
	public override showComposite(id: string, focus = false): void {
		super.showComposite(id, focus);
		this.contentDomNode.insertBefore(this.getComposite(id)!.element, this.updateStatus);
	}
	override setActivityBarLocation(location: ActivityBarPosition): HTMLElement | undefined {
		const integrated = location === ActivityBarPosition.DEFAULT;
		this.topActivityBarHost.classList.toggle('integrated', integrated);
		this.bottomActivityBarHost.classList.toggle('integrated', integrated);
		this.topActivityBarHost.hidden = !integrated && location !== ActivityBarPosition.TOP;
		this.bottomActivityBarHost.hidden = !integrated && location !== ActivityBarPosition.BOTTOM;
		if (integrated) { return this.topActivityBarHost; }
		if (location === ActivityBarPosition.TOP) { return this.topActivityBarHost; }
		if (location === ActivityBarPosition.BOTTOM) { return this.bottomActivityBarHost; }
		return undefined;
	}
}
