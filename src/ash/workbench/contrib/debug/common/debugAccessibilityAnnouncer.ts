import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import type { IDebugWatchResult } from './debug.js';

/** Presentation-only deduplication; evaluated values remain owned by the caller's inspection. */
export class DebugWatchAccessibilityAnnouncer {
	private sessionId: string | undefined;
	private lastAnnounced = new Map<string, string>();

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {}

	announce(sessionId: string, results: readonly IDebugWatchResult[]): void {
		if (sessionId !== this.sessionId) {
			this.lastAnnounced.clear();
			this.sessionId = sessionId;
		}
		const current = new Map<string, string>();
		const messages: string[] = [];
		for (const value of results) {
			if (!value.result) continue;
			const text = value.result.result;
			current.set(value.expression, text);
			if (this.lastAnnounced.get(value.expression) !== text) messages.push(`${value.expression} = ${text}`);
		}
		this.lastAnnounced = current;
		if (messages.length && this.configuration.getValue<boolean>('accessibility.debugWatchVariableAnnouncements')) {
			this.accessibility.alert(messages.join('\n').slice(0, 4096));
		}
	}
}
