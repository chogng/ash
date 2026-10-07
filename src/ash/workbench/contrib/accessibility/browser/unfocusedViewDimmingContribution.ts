import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { AccessibilityWorkbenchSettingId } from './accessibilityConfiguration.js';

export class UnfocusedViewDimmingContribution extends Disposable implements IWorkbenchContribution {
	private readonly containers = this._register(new DisposableMap<HTMLElement, IDisposable>());

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILayoutService private readonly layout: ILayoutService,
	) {
		super();
		const sheet = createStyleSheet(layout.mainContainer.ownerDocument, `
.ash-dim-unfocused .ash-workbench-part:not(:focus-within) > .ash-workbench-part-content {
	opacity: var(--ash-unfocused-view-opacity);
}`);
		this._register(sheet.registration);
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityWorkbenchSettingId.DimUnfocusedEnabled) || event.affectsConfiguration(AccessibilityWorkbenchSettingId.DimUnfocusedOpacity)) {
				this.update();
			}
		}));
		this._register(layout.onDidChangeActiveContainer(() => this.update()));
		this._register(layout.onDidLayoutContainer(() => this.update()));
		this.update();
	}

	private update(): void {
		const activeContainers = new Set(this.layout.containers);
		for (const container of this.containers.keys()) {
			if (!activeContainers.has(container)) {
				this.containers.deleteAndDispose(container);
			}
		}
		const enabled = this.configuration.getValue<boolean>(AccessibilityWorkbenchSettingId.DimUnfocusedEnabled);
		const opacity = this.configuration.getValue<number>(AccessibilityWorkbenchSettingId.DimUnfocusedOpacity);
		for (const container of activeContainers) {
			if (!this.containers.has(container)) {
				this.containers.set(container, toDisposable(() => {
					container.classList.remove('ash-dim-unfocused');
					container.style.removeProperty('--ash-unfocused-view-opacity');
				}));
			}
			container.classList.toggle('ash-dim-unfocused', enabled);
			container.style.setProperty('--ash-unfocused-view-opacity', String(opacity));
		}
	}
}
