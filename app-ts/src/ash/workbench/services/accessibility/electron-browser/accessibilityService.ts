import { toDisposable } from "../../../../base/common/lifecycle.js";
import { AccessibilityService, type AccessibilityServiceOptions } from "../../../../platform/accessibility/browser/accessibilityService.js";
import { AccessibilitySupport } from "../../../../platform/accessibility/common/accessibility.js";
import type { INativeHostApi } from "../../../../platform/native/common/nativeHost.js";

/** Browser accessibility inputs extended with Electron's native detection bridge. */
export interface NativeAccessibilityServiceOptions extends AccessibilityServiceOptions {
	readonly nativeHostApi: INativeHostApi;
}

/** Publishes Electron screen-reader detection to the shared Workbench accessibility policy. */
export class NativeAccessibilityService extends AccessibilityService {
	constructor(options: NativeAccessibilityServiceOptions) {
		super(options);
		let active = true;
		let supportChangedByEvent = false;
		const subscription = options.nativeHostApi.onDidChangeAccessibilitySupport((enabled) => {
			supportChangedByEvent = true;
			if (active) this.setAccessibilitySupport(enabled ? AccessibilitySupport.Enabled : AccessibilitySupport.Disabled);
		});
		this._register(toDisposable(() => {
			active = false;
			subscription.dispose();
		}));
		void options.nativeHostApi.isAccessibilitySupportEnabled()
			.then((enabled) => {
				if (active && !supportChangedByEvent) this.setAccessibilitySupport(enabled ? AccessibilitySupport.Enabled : AccessibilitySupport.Disabled);
			})
			.catch((error: unknown) => console.error("Failed to read Electron accessibility support", error));
	}
}
