export type SizeUnit = 'px' | 'rem' | 'em' | '%' | 'ms' | 'unitless';

export interface SizeValue {
	readonly value: number;
	readonly unit: SizeUnit;
}

export function size(value: number, unit: SizeUnit = 'px'): SizeValue {
	if (!Number.isFinite(value)) {
		throw new TypeError('Size token value must be finite');
	}
	return Object.freeze({ value, unit });
}

export function sizeValueToCss(value: SizeValue): string {
	return value.unit === 'unitless' ? String(value.value) : `${value.value}${value.unit}`;
}

export function asCssVariableName(id: string): string {
	return `--ash-${id.replaceAll('.', '-').replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)}`;
}
