import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import { getTokenClassificationRegistry, type TokenTypeOrModifierContribution } from '../../../../platform/theme/common/tokenClassificationRegistry.js';

export interface SemanticTokenScopeContribution {
	readonly language?: string;
	readonly scopes: Readonly<Record<string, readonly string[]>>;
}

/** Owns extension-defined classifications and their language-specific TextMate mappings. */
export class TokenClassificationExtensionPoint extends AbstractDisposable {
	private readonly owner = Symbol('extension semantic tokens');
	public replace(types: readonly TokenTypeOrModifierContribution[], modifiers: readonly TokenTypeOrModifierContribution[], scopes: readonly SemanticTokenScopeContribution[]): void {
		getTokenClassificationRegistry().replaceContributions(this.owner, types, modifiers, scopes);
	}
	protected override disposeCore(): void { getTokenClassificationRegistry().replaceContributions(this.owner, [], [], []); }
}
