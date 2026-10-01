import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import { getIconRegistry, type IconContribution, type IconFontDefinition } from '../../../../platform/theme/common/iconRegistry.js';

/** Owns registered product icon defaults and their fonts for the installed extension catalog. */
export class IconExtensionPoint extends AbstractDisposable {
	private readonly owner = Symbol('extension icons');
	public replace(icons: readonly IconContribution[], fonts: readonly IconFontDefinition[]): void { getIconRegistry().replaceIcons(this.owner, icons, fonts); }
	protected override disposeCore(): void { getIconRegistry().replaceIcons(this.owner, [], []); }
}
