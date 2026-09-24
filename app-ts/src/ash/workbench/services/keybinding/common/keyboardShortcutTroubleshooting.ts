import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/**
 * Window-scoped diagnostic stream for tracing native keyboard events through
 * layout mapping and keybinding resolution.
 */
export interface IKeyboardShortcutTroubleshootingService {
	readonly enabled: boolean;
	readonly onDidLog: Event<string>;
	toggle(): boolean;
}

export const IKeyboardShortcutTroubleshootingService =
	createServiceIdentifier<IKeyboardShortcutTroubleshootingService>(
		"keyboardShortcutTroubleshootingService",
	);
