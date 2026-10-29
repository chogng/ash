import {
	ContextKeyExpr,
	IContextKeyService,
	type ContextKeyExpression,
} from '../../../../platform/contextkey/common/contextkey.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IExtensionService } from '../../../services/extensions/common/extensionService.js';

/** Language/when policy; runtime breakpoint definitions remain with DebugService. */
class Breakpoints {
	private readonly expression: ContextKeyExpression | undefined;
	readonly language: string;

	constructor(
		contribution: { language: string; when?: string },
		@IContextKeyService private readonly context: IContextKeyService,
	) {
		this.language = contribution.language;
		this.expression = contribution.when === undefined ? undefined : ContextKeyExpr.deserialize(contribution.when);
	}

	get enabled(): boolean {
		return this.context.contextMatchesRules(this.expression);
	}
}

export function canSetBreakpointsIn(
	language: string,
	extensions: IExtensionService,
	configuration: IConfigurationService,
	context: IContextKeyService,
): boolean {
	if (configuration.getValue<boolean>('debug.allowBreakpointsEverywhere') !== false) return true;
	return extensions
		.getExtensionPointContributions<readonly { language: string; when?: string }[]>('breakpoints')
		.some(entry =>
			entry.value.some(contribution => {
				const policy = new Breakpoints(contribution, context);
				return policy.language === language && policy.enabled;
			}),
		);
}
