import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import { Colors, type ColorContribution } from '../../../../platform/theme/common/colorRegistry.js';

/** Owns colors contributed by the installed extension catalog. */
export class ColorExtensionPoint extends AbstractDisposable {
	private readonly owner = Symbol('extension colors');
	public replace(contributions: readonly ColorContribution[]): void { Colors.replaceColors(this.owner, contributions); }
	protected override disposeCore(): void { Colors.replaceColors(this.owner, []); }
}
