import { localize } from '../../../../../nls.js';
import { isRecord } from '../../../../../base/common/types.js';
import { isUuid } from '../../../../../base/common/uuid.js';
import type { DesignShape } from './document.js';

/** Offsets use UTF-16, matching DOM Selection and JavaScript strings. Ranges never overlap. */
export interface DesignTextRun {
	readonly start: number;
	readonly end: number;
	readonly style: DesignTextStyle;
	readonly styleId?: string;
	readonly overrides?: readonly (keyof DesignTextStyle)[];
}
export interface DesignTextStyle {
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontWeight?: number;
	readonly fontStyle?: 'normal' | 'italic';
	readonly fill?: string;
	readonly lineHeight?: number;
	readonly lineHeightUnit?: 'px' | 'percent';
	readonly letterSpacing?: number;
	readonly letterSpacingUnit?: 'px' | 'percent';
	readonly textDecoration?: 'none' | 'underline' | 'line-through' | 'underline line-through';
	readonly textCase?: 'original' | 'upper' | 'lower' | 'title' | 'small-caps';
	readonly textAlign?: 'left' | 'center' | 'right' | 'justify';
	readonly textWrap?: 'auto' | 'balance' | 'pretty';
	readonly textTrim?: 'none' | 'cap-height';
	readonly textDirection?: 'auto' | 'ltr' | 'rtl';
	readonly paragraphSpacing?: number;
	readonly paragraphIndent?: number;
	readonly listType?: 'none' | 'bullet' | 'number';
	readonly fontFeatures?: Readonly<Record<string, number>>;
	readonly fontVariations?: Readonly<Record<string, number>>;
}
export interface DesignTextProperties extends DesignTextStyle {
	readonly textRuns?: readonly DesignTextRun[];
	/** Missing in older files: preserve their fixed box. */
	readonly textAutoResize?: 'width' | 'height' | 'none';
	readonly textVerticalAlign?: 'top' | 'center' | 'bottom';
	readonly textTruncate?: boolean;
	readonly maxLines?: number;
}
export type DesignTextShape = Extract<DesignShape, { kind: 'text'; }>;
export type DesignTextMeasurer = (shape: DesignTextShape, width: number | undefined) => { width: number; height: number; };
export const designTextStyleKeys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'lineHeight', 'lineHeightUnit', 'letterSpacing', 'letterSpacingUnit', 'textDecoration', 'textCase', 'textAlign', 'textDirection', 'textWrap', 'textTrim', 'paragraphSpacing', 'paragraphIndent', 'listType', 'fontFeatures', 'fontVariations'] as const;
export const designTextKeys = [...designTextStyleKeys, 'textRuns', 'textAutoResize', 'textVerticalAlign', 'textTruncate', 'maxLines'] as const;
const choices: Partial<Record<keyof DesignTextProperties, readonly string[]>> = {
	textWrap: ['auto', 'balance', 'pretty'], textTrim: ['none', 'cap-height'],
	fontStyle: ['normal', 'italic'], lineHeightUnit: ['px', 'percent'], letterSpacingUnit: ['px', 'percent'],
	textDecoration: ['none', 'underline', 'line-through', 'underline line-through'], textCase: ['original', 'upper', 'lower', 'title', 'small-caps'],
	textAlign: ['left', 'center', 'right', 'justify'], textDirection: ['auto', 'ltr', 'rtl'], listType: ['none', 'bullet', 'number'],
	textAutoResize: ['width', 'height', 'none'], textVerticalAlign: ['top', 'center', 'bottom'],
};
function invalid(): never { throw new TypeError(localize('sessions.design.invalidText', 'Invalid design text')); }
function boundary(text: string, index: number): boolean { return !(index > 0 && index < text.length && /[\uD800-\uDBFF]/u.test(text[index - 1]) && /[\uDC00-\uDFFF]/u.test(text[index])); }

/** Used at file, clipboard and typed-property input boundaries. No arbitrary CSS is accepted. */
export function parseDesignTextStyle(value: unknown): DesignTextStyle {
	if (!isRecord(value) || Object.keys(value).some(key => !(designTextStyleKeys as readonly string[]).includes(key))) { invalid(); }
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) { continue; }
		if (choices[key as keyof DesignTextProperties]) { if (!choices[key as keyof DesignTextProperties]!.includes(item as string)) { invalid(); } }
		else if (key === 'fontFamily') { if (typeof item !== 'string' || !item.trim() || item.length > 256 || /[\u0000-\u001f]/u.test(item)) { invalid(); } }
		else if (key === 'fill') { if (typeof item !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(item)) { invalid(); } }
		else if (key === 'fontFeatures' || key === 'fontVariations') {
			if (!isRecord(item) || Object.keys(item).length > 64 || Object.entries(item).some(([tag, number]) => !/^[a-z\d]{4}$/iu.test(tag) || typeof number !== 'number' || !Number.isFinite(number) || (key === 'fontFeatures' && (!Number.isInteger(number) || number < 0)))) { invalid(); }
		} else if (typeof item !== 'number' || !Number.isFinite(item) || (['fontSize', 'fontWeight'].includes(key) && item <= 0) || (key === 'fontWeight' && item > 1000) || (['lineHeight', 'paragraphSpacing'].includes(key) && item < 0)) { invalid(); }
	}
	return { ...value } as DesignTextStyle;
}
export function parseDesignTextProperties(value: Record<string, unknown>): DesignTextProperties {
	const style = parseDesignTextStyle(Object.fromEntries(Object.entries(value).filter(([key]) => (designTextStyleKeys as readonly string[]).includes(key))));
	for (const key of ['textAutoResize', 'textVerticalAlign'] as const) { if (value[key] !== undefined && !choices[key]!.includes(value[key] as string)) { invalid(); } }
	if (value.textTruncate !== undefined && typeof value.textTruncate !== 'boolean') { invalid(); }
	if (value.maxLines !== undefined && (typeof value.maxLines !== 'number' || !Number.isInteger(value.maxLines) || value.maxLines < 1 || value.maxLines > 10000)) { invalid(); }
	let end = 0;
	if (value.textRuns !== undefined) {
		if (!Array.isArray(value.textRuns) || value.textRuns.length > 10000 || typeof value.text !== 'string') { invalid(); }
		for (const run of value.textRuns) {
			if (!isRecord(run) || Object.keys(run).some(key => !['start', 'end', 'style', 'styleId', 'overrides'].includes(key)) || !Number.isInteger(run.start) || !Number.isInteger(run.end) || (run.start as number) < end || (run.end as number) <= (run.start as number) || (run.end as number) > value.text.length || !boundary(value.text, run.start as number) || !boundary(value.text, run.end as number)) { invalid(); }
			parseDesignTextStyle(run.style);
			if (run.styleId !== undefined && !isUuid(run.styleId)) { invalid(); }
			if (run.overrides !== undefined && (!run.styleId || !Array.isArray(run.overrides) || run.overrides.some(key => !(designTextStyleKeys as readonly unknown[]).includes(key)))) { invalid(); }
			end = run.end as number;
		}
	}
	return { ...style, ...Object.fromEntries(Object.entries(value).filter(([key]) => (designTextKeys as readonly string[]).includes(key))) } as DesignTextProperties;
}

export function designTextSegments(shape: DesignTextShape, start = 0, end = shape.text.length): DesignTextRun[] {
	const result: DesignTextRun[] = [];
	let cursor = start;
	for (const run of shape.textRuns ?? []) {
		if (run.end <= start || run.start >= end) { continue; }
		if (run.start > cursor) { result.push({ start: cursor, end: Math.min(end, run.start), style: {} }); }
		result.push({ ...run, start: Math.max(start, run.start), end: Math.min(end, run.end) });
		cursor = Math.min(end, run.end);
	}
	if (cursor < end) { result.push({ start: cursor, end, style: {} }); }
	return result;
}
function mergeRuns(runs: readonly DesignTextRun[]): DesignTextRun[] {
	const result: DesignTextRun[] = [];
	for (const input of runs) {
		const run = { ...input, style: Object.fromEntries(Object.entries(input.style).filter(([, value]) => value !== undefined)) };
		if (run.end <= run.start || (!run.styleId && !Object.keys(run.style).length)) { continue; }
		const previous = result.at(-1);
		if (previous?.end === run.start && previous.styleId === run.styleId && designTextStyleKeys.every(key => JSON.stringify(previous.style[key]) === JSON.stringify(run.style[key])) && designTextStyleKeys.every(key => !!previous.overrides?.includes(key) === !!run.overrides?.includes(key))) { result[result.length - 1] = { ...previous, end: run.end }; }
		else { result.push(run); }
	}
	return result;
}
export function designTextStyleAt(shape: DesignTextShape, offset: number): DesignTextStyle {
	return { ...Object.fromEntries(designTextStyleKeys.filter(key => shape[key] !== undefined).map(key => [key, shape[key]])), ...shape.textRuns?.find(run => run.start <= offset && offset < run.end)?.style };
}
/** Switching px/% keeps the rendered distance, including differently sized rich runs. */
export function convertDesignTextUnits(current: DesignTextStyle, patch: DesignTextStyle): DesignTextStyle {
	const result = { ...patch };
	for (const key of ['lineHeight', 'letterSpacing'] as const) {
		const unit = `${key}Unit` as const;
		if (patch[unit] && patch[key] === undefined && current[key] !== undefined && (current[unit] ?? 'px') !== patch[unit]) {
			Reflect.set(result, key, patch[unit] === 'percent' ? current[key]! * 100 / (current.fontSize ?? 24) : current[key]! * (current.fontSize ?? 24) / 100);
		}
	}
	return result;
}
/** Split only at edit boundaries. Other characters keep both their appearance and linked style. */
export function formatDesignText(shape: DesignTextShape, start: number, end: number, style: DesignTextStyle, styleId?: string): DesignTextShape {
	if (start === end) { return shape; }
	const formatted = designTextSegments(shape, start, end).map(run => {
		const patch = convertDesignTextUnits({ ...shape, ...run.style }, style);
		return { ...run, style: { ...run.style, ...patch }, ...(styleId ? { styleId, overrides: [] } : run.styleId ? { overrides: [...new Set([...(run.overrides ?? []), ...Object.keys(patch) as (keyof DesignTextStyle)[]])] } : {}) };
	});
	const runs = [...designTextSegments(shape, 0, start), ...formatted, ...designTextSegments(shape, end)];
	return { ...shape, textRuns: mergeRuns(runs) };
}
export function replaceDesignText(shape: DesignTextShape, start: number, end: number, text: string, style?: DesignTextStyle, insertedRuns?: readonly DesignTextRun[]): DesignTextShape {
	const delta = text.length - (end - start);
	const inherited = shape.textRuns?.find(run => run.start <= Math.max(0, start - 1) && Math.max(0, start - 1) < run.end);
	const inserted = insertedRuns ? insertedRuns.map(run => ({ ...run, start: start + run.start, end: start + run.end })) : text ? [{ ...(inherited ?? {}), start, end: start + text.length, style: { ...inherited?.style, ...style }, ...(inherited?.styleId && style ? { overrides: [...new Set([...(inherited.overrides ?? []), ...Object.keys(style) as (keyof DesignTextStyle)[]])] } : {}) }] : [];
	return { ...shape, text: shape.text.slice(0, start) + text + shape.text.slice(end), textRuns: mergeRuns([...designTextSegments(shape, 0, start), ...inserted, ...designTextSegments(shape, end).map(run => ({ ...run, start: run.start + delta, end: run.end + delta }))]) };
}
/** A text replacement must keep surrogate pairs intact, including when two emoji share a high surrogate. */
export function designTextReplacement(previous: string, text: string): { start: number; end: number; text: string; } {
	let start = 0;
	while (start < previous.length && start < text.length && previous[start] === text[start]) { start++; }
	if (!boundary(previous, start) || !boundary(text, start)) { start--; }
	let end = previous.length;
	let nextEnd = text.length;
	while (end > start && nextEnd > start && previous[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
	if (!boundary(previous, end) || !boundary(text, nextEnd)) { end++; nextEnd++; }
	return { start, end, text: text.slice(start, nextEnd) };
}
/** External full-string edits (properties and variables) preserve styles outside the changed span. */
export function updateDesignText(shape: DesignTextShape, text: string): DesignTextShape {
	const replacement = designTextReplacement(shape.text, text);
	return replaceDesignText(shape, replacement.start, replacement.end, replacement.text);
}

/** Ungrouping bakes the group's uniform scale into all authored text distances. */
export function scaleDesignText(shape: DesignTextShape, scale: number): DesignTextShape {
	const scaled = (style: DesignTextStyle): DesignTextStyle => ({
		...style,
		...(style.fontSize === undefined ? {} : { fontSize: style.fontSize * scale }),
		...(style.lineHeight === undefined || style.lineHeightUnit === 'percent' ? {} : { lineHeight: style.lineHeight * scale }),
		...(style.letterSpacing === undefined || style.letterSpacingUnit === 'percent' ? {} : { letterSpacing: style.letterSpacing * scale }),
		...(style.paragraphSpacing === undefined ? {} : { paragraphSpacing: style.paragraphSpacing * scale }),
		...(style.paragraphIndent === undefined ? {} : { paragraphIndent: style.paragraphIndent * scale }),
	});
	return { ...shape, ...scaled(shape), fontSize: shape.fontSize * scale, ...(shape.textRuns ? { textRuns: shape.textRuns.map(run => { const style = scaled(run.style); return { ...run, style, ...(run.styleId ? { overrides: [...new Set([...(run.overrides ?? []), ...designTextStyleKeys.filter(key => JSON.stringify(style[key]) !== JSON.stringify(run.style[key]))])] } : {}) }; }) } : {}) };
}
