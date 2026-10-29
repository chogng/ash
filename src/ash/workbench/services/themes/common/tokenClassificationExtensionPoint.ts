import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import { getTokenClassificationRegistry, type TokenTypeOrModifierContribution } from '../../../../platform/theme/common/tokenClassificationRegistry.js';

/** Owns extension-defined classifications and their inheritance. */
export class TokenClassificationExtensionPoint extends AbstractDisposable {
	private readonly owner = Symbol('extension semantic tokens');
	public replace(types: readonly TokenTypeOrModifierContribution[], modifiers: readonly TokenTypeOrModifierContribution[]): void {
		getTokenClassificationRegistry().replaceContributions(this.owner, types, modifiers);
	}
	protected override disposeCore(): void {
		getTokenClassificationRegistry().replaceContributions(this.owner, [], []);
	}
}
