import { toDisposable } from "../../../../base/common/lifecycle.js";
import { AccessibilityService } from "../../../../platform/accessibility/browser/accessibilityService.js";
import { AccessibilitySupport } from "../../../../platform/accessibility/common/accessibility.js";
import type { INativeHostApi } from "../../../../platform/native/common/nativeHost.js";
import { INativeHostService } from '../../../common/services.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/** Publishes Electron screen-reader detection to the shared Workbench accessibility policy. */
export class NativeAccessibilityService extends AccessibilityService {
	constructor(
		root: HTMLElement,
		@INativeHostService host: INativeHostApi,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super({ root, contextKeyService, configurationService });
		let active = true;
		let supportChangedByEvent = false;
		const subscription = host.onDidChangeAccessibilitySupport((enabled) => {
			supportChangedByEvent = true;
			if (active) this.setAccessibilitySupport(enabled ? AccessibilitySupport.Enabled : AccessibilitySupport.Disabled);
		});
		this._register(toDisposable(() => {
			active = false;
			subscription.dispose();
		}));
		void host.isAccessibilitySupportEnabled()
			.then((enabled) => {
				if (active && !supportChangedByEvent) this.setAccessibilitySupport(enabled ? AccessibilitySupport.Enabled : AccessibilitySupport.Disabled);
			})
			.catch((error: unknown) => console.error("Failed to read Electron accessibility support", error));
	}
}
