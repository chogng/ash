import { getActiveElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SessionsPageRegistry } from '../../../browser/pages.js';
import { DesignCanvasView } from './designCanvasView.js';

SessionsPageRegistry.registerPage('design', new SyncDescriptor(DesignCanvasView));

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.DesignCanvas,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Design canvas accessibility verbosity must be boolean');
		}
		return value;
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'sessionsDesignCanvasHelp',
	when: ContextKeyExpr.has('sessionsDesignCanvasFocused'),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DesignCanvas,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.design.help', 'Design canvas\nThe Design page offers an infinite canvas. Drag with the mouse or touch, or use the arrow keys, to pan. Hold Ctrl and scroll, or press Plus or Minus, to zoom toward the pointer or the center. Press 0 to reset the view. Sessions Settings > Design lets you choose a pointer or hand cursor.'),
			() => focused.focus(),
			AccessibilityVerbositySettingId.DesignCanvas,
		);
	},
});
