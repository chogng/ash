export interface ThemeColor { readonly id: string; }

export namespace ThemeColor {
	export function isThemeColor(value: unknown): value is ThemeColor {
		return typeof value === 'object' && value !== null && typeof (value as ThemeColor).id === 'string';
	}
}

export function themeColorFromId(id: string): ThemeColor { return { id }; }

export interface ThemeIcon {
	readonly id: string;
	readonly color?: ThemeColor;
}

export namespace ThemeIcon {
	const idPattern = /^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:~([A-Za-z]+))?$/;

	export function isThemeIcon(value: unknown): value is ThemeIcon {
		return typeof value === 'object' && value !== null
			&& typeof (value as ThemeIcon).id === 'string'
			&& ((value as ThemeIcon).color === undefined || ThemeColor.isThemeColor((value as ThemeIcon).color));
	}

	export function fromString(value: string): ThemeIcon | undefined {
		const match = /^\$\(([^)]+)\)$/.exec(value);
		return match && idPattern.test(match[1]!) ? { id: match[1]! } : undefined;
	}

	export function fromId(id: string): ThemeIcon { return { id }; }
	export function getModifier(icon: ThemeIcon): string | undefined { return idPattern.exec(icon.id)?.[2]; }
	export function modify(icon: ThemeIcon, modifier: 'disabled' | 'spin' | undefined): ThemeIcon {
		const base = icon.id.replace(/~[A-Za-z]+$/, '');
		return { id: modifier ? `${base}~${modifier}` : base, color: icon.color };
	}
	export function isEqual(left: ThemeIcon, right: ThemeIcon): boolean { return left.id === right.id && left.color?.id === right.color?.id; }
	export function asClassNameArray(icon: ThemeIcon): string[] {
		const match = idPattern.exec(icon.id);
		if (!match) return ['ash-icon', 'ash-icon-error'];
		return ['ash-icon', `ash-icon-${match[1]}`, ...(match[2] ? [`ash-icon-modifier-${match[2]}`] : [])];
	}
	export function asClassName(icon: ThemeIcon): string { return asClassNameArray(icon).join(' '); }
	export function asCSSSelector(icon: ThemeIcon): string { return `.${asClassNameArray(icon).join('.')}`; }
}
