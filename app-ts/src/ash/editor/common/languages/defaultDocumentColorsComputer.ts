import { type IPosition } from '../core/position.js';
import { Range } from '../core/range.js';
import { type IColor, type IColorInformation } from '../languages.js';

export interface IDocumentColorComputerTarget {
	getValue(): string;
	positionAt(offset: number): IPosition;
	findMatches(regex: RegExp): RegExpMatchArray[];
}

/** Scans CSS literals using the caller's text and coordinate source. */
export function computeDefaultDocumentColors(model: IDocumentColorComputerTarget): IColorInformation[] {
	const colors: IColorInformation[] = [];
	for (const match of model.findMatches(COLOR_LITERAL_PATTERN)) {
		const color = parseColorLiteral(match[0]);
		if (!color || match.index === undefined) {
			continue;
		}
		colors.push(Object.freeze({ range: Range.fromPositions(model.positionAt(match.index), model.positionAt(match.index + match[0].length)), color }));
	}
	return colors;
}

const COLOR_LITERAL_PATTERN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])|\b(?:rgba?|hsla?)\([^)]*\)|\btransparent\b/giu;

function parseColorLiteral(value: string): IColor | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === 'transparent') return normalizedColor(0, 0, 0, 0);
	if (normalized.startsWith('#')) return parseHex(normalized);
	if (normalized.startsWith('rgb')) return parseRgb(normalized);
	if (normalized.startsWith('hsl')) return parseHsl(normalized);
	return undefined;
}

function parseHex(value: string): IColor | undefined {
	const hex = value.slice(1);
	if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/u.test(hex)) return undefined;
	const expanded = hex.length <= 4 ? [...hex].map(digit => digit + digit).join('') : hex;
	return normalizedColor(
		Number.parseInt(expanded.slice(0, 2), 16) / 255,
		Number.parseInt(expanded.slice(2, 4), 16) / 255,
		Number.parseInt(expanded.slice(4, 6), 16) / 255,
		expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
	);
}

function parseRgb(value: string): IColor | undefined {
	const parts = colorFunctionParts(value);
	if (!parts || parts.channels.length !== 3) return undefined;
	const channels = parts.channels.map(parseRgbChannel);
	const alpha = parseAlpha(parts.alpha);
	if (channels.some(channel => channel === undefined) || alpha === undefined) return undefined;
	return normalizedColor(channels[0]! / 255, channels[1]! / 255, channels[2]! / 255, alpha / 255);
}

function parseHsl(value: string): IColor | undefined {
	const parts = colorFunctionParts(value);
	if (!parts || parts.channels.length !== 3) return undefined;
	const hue = parseHue(parts.channels[0]!);
	const saturation = parsePercentage(parts.channels[1]!);
	const lightness = parsePercentage(parts.channels[2]!);
	const alpha = parseAlpha(parts.alpha);
	if (hue === undefined || saturation === undefined || lightness === undefined || alpha === undefined) return undefined;
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const section = hue / 60;
	const secondary = chroma * (1 - Math.abs(section % 2 - 1));
	const [red, green, blue] = section < 1 ? [chroma, secondary, 0]
		: section < 2 ? [secondary, chroma, 0]
			: section < 3 ? [0, chroma, secondary]
				: section < 4 ? [0, secondary, chroma]
					: section < 5 ? [secondary, 0, chroma]
						: [chroma, 0, secondary];
	const match = lightness - chroma / 2;
	return normalizedColor(red + match, green + match, blue + match, alpha / 255);
}

function colorFunctionParts(value: string): { readonly channels: readonly string[]; readonly alpha?: string } | undefined {
	const start = value.indexOf('(');
	const end = value.lastIndexOf(')');
	if (start < 0 || end <= start) return undefined;
	const body = value.slice(start + 1, end).trim();
	if (!body) return undefined;
	if (body.includes(',')) {
		if (body.includes('/')) return undefined;
		const items = body.split(',').map(item => item.trim());
		if ((items.length !== 3 && items.length !== 4) || items.some(item => item.length === 0)) return undefined;
		return { channels: items.slice(0, 3), ...(items[3] ? { alpha: items[3] } : {}) };
	}
	const slashParts = body.split('/').map(item => item.trim());
	if (slashParts.length > 2 || slashParts.some(item => item.length === 0)) return undefined;
	const channels = slashParts[0]!.split(/\s+/u);
	if (channels.length !== 3) return undefined;
	return { channels, ...(slashParts[1] ? { alpha: slashParts[1] } : {}) };
}

function parseRgbChannel(value: string): number | undefined {
	if (value.endsWith('%')) {
		const percent = parseNumber(value.slice(0, -1));
		return Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(0, percent)) * 2.55) : undefined;
	}
	const channel = parseNumber(value);
	return Number.isFinite(channel) ? Math.round(Math.min(255, Math.max(0, channel))) : undefined;
}

function parseAlpha(value: string | undefined): number | undefined {
	if (value === undefined) return 255;
	if (value.endsWith('%')) {
		const percent = parseNumber(value.slice(0, -1));
		return Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(0, percent)) * 2.55) : undefined;
	}
	const alpha = parseNumber(value);
	return Number.isFinite(alpha) ? Math.round(Math.min(1, Math.max(0, alpha)) * 255) : undefined;
}

function parseHue(value: string): number | undefined {
	const unit = /(?:deg|grad|rad|turn)$/u.exec(value)?.[0] ?? '';
	const hue = parseNumber(unit ? value.slice(0, -unit.length) : value);
	if (!Number.isFinite(hue)) return undefined;
	const degrees = unit === 'turn' ? hue * 360 : unit === 'rad' ? hue * 180 / Math.PI : unit === 'grad' ? hue * 0.9 : hue;
	return (degrees % 360 + 360) % 360;
}

function parsePercentage(value: string): number | undefined {
	if (!value.endsWith('%')) return undefined;
	const percent = parseNumber(value.slice(0, -1));
	return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) / 100 : undefined;
}

function parseNumber(value: string): number {
	return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) ? Number(value) : Number.NaN;
}

function normalizedColor(red: number, green: number, blue: number, alpha: number): IColor {
	return Object.freeze({ red, green, blue, alpha });
}
