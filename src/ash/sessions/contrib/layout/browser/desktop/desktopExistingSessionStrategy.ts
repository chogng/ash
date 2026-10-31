import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';

/** Coordinates the two retained Parts inside Files; other cards own their own composition. */
export class DesktopExistingSessionStrategy {
	constructor(@ILayoutService private readonly layout: IAgentWorkbenchLayoutService) { }

	public toggleDetails(): boolean {
		const visible = !this.layout.isPartVisible('auxiliarybar');
		this.layout.updateParts(() => {
			// Closing the tree must leave an editor surface inside the same card.
			if (!visible && !this.layout.isPartVisible('editor')) { this.layout.showPart('editor'); }
			if (visible) { this.layout.showPart('auxiliarybar'); }
			else { this.layout.hidePart('auxiliarybar'); }
		});
		return visible;
	}

	public hideEditor(): void {
		this.layout.updateParts(() => {
			this.layout.showPart('auxiliarybar');
			this.layout.hidePart('editor');
		});
	}
}
