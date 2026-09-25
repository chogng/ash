import { Color, RGBA } from "../../../base/common/color.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { localize, onDidChangeNls } from "../../../nls.js";
import { ColorScheme } from "./theme.js";

export type ColorIdentifier = string;

export interface ColorDefaults {
	readonly dark: ColorValue;
	readonly light: ColorValue;
	readonly highContrastDark: ColorValue;
	readonly highContrastLight: ColorValue;
}

export type ColorTransform =
	| { readonly op: "transparent"; readonly value: ColorValue; readonly factor: number }
	| { readonly op: "lighten"; readonly value: ColorValue; readonly factor: number }
	| { readonly op: "darken"; readonly value: ColorValue; readonly factor: number }
	| { readonly op: "mix"; readonly value: ColorValue; readonly other: ColorValue; readonly factor: number }
	| { readonly op: "opaque"; readonly value: ColorValue; readonly background: ColorValue };

export type ColorValue = Color | string | ColorTransform | null;

export interface ColorRegistrationMetadata {
	readonly description: string;
	readonly owner: string;
	readonly needsTransparency?: boolean;
	readonly deprecated?: string;
}

export interface ColorContribution extends ColorRegistrationMetadata {
	readonly id: ColorIdentifier;
	readonly defaults: ColorDefaults;
}

export interface ResolvedColorContribution extends ColorContribution {
	readonly value: Color | null;
}

export class ColorRegistry extends Disposable {
	private readonly colors = new Map<ColorIdentifier, ColorContribution>();
	private catalog: readonly ColorContribution[] = Object.freeze([]);
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;

	constructor() {
		super();
		this._register(onDidChangeNls(() => this.publishCatalog()));
	}

	registerColor(id: ColorIdentifier, defaults: ColorDefaults, metadata: ColorRegistrationMetadata): ColorIdentifier {
		this.assertNotDisposed();
		validateTokenId(id, "color");
		if (this.colors.has(id)) throw new Error(`Color token is already registered: ${id}`);
		const contribution = Object.freeze({ id, defaults: Object.freeze({ ...defaults }), ...metadata });
		this.colors.set(id, contribution);
		this.publishCatalog();
		this.changed.fire();
		return id;
	}

	/** Color modules load before the locale service, so descriptions are resolved again when the language changes. */
	private publishCatalog(): void {
		this.catalog = Object.freeze([...this.colors.values()].map(contribution => Object.freeze({
			...contribution,
			description: localize(`color.${contribution.id}`, contribution.description),
		})));
	}

	getColors(): readonly ColorContribution[] {
		return this.catalog;
	}

	resolve(scheme: ColorScheme, overrides: Readonly<Record<string, ColorValue>> = {}): readonly ResolvedColorContribution[] {
		const cache = new Map<string, Color | null>();
		const resolving: string[] = [];
		const resolveIdentifier = (id: string): Color | null => {
			if (cache.has(id)) return cache.get(id) ?? null;
			const cycleStart = resolving.indexOf(id);
			if (cycleStart >= 0) throw new Error(`Color token cycle: ${[...resolving.slice(cycleStart), id].join(" -> ")}`);
			const contribution = this.colors.get(id);
			if (!contribution) throw new Error(`Unknown color token reference: ${id}`);
			resolving.push(id);
			const source = Object.hasOwn(overrides, id) ? overrides[id] : defaultsForScheme(contribution.defaults, scheme);
			const value = resolveColorValue(source, resolveIdentifier);
			resolving.pop();
			if (contribution.needsTransparency && value?.rgba.a === 1) {
				throw new Error(`Color token '${id}' must be transparent`);
			}
			cache.set(id, value);
			return value;
		};
		for (const id of Object.keys(overrides)) {
			if (!this.colors.has(id)) throw new Error(`Unknown color token override: ${id}`);
		}
		return Object.freeze(this.getColors().map((contribution) => Object.freeze({ ...contribution, value: resolveIdentifier(contribution.id) })));
	}
}

function defaultsForScheme(defaults: ColorDefaults, scheme: ColorScheme): ColorValue {
	switch (scheme) {
		case ColorScheme.Dark: return defaults.dark;
		case ColorScheme.Light: return defaults.light;
		case ColorScheme.HighContrastDark: return defaults.highContrastDark;
		case ColorScheme.HighContrastLight: return defaults.highContrastLight;
	}
}

function resolveColorValue(value: ColorValue, resolveIdentifier: (id: string) => Color | null): Color | null {
	if (value === null) return null;
	if (value instanceof Color) return value;
	if (typeof value === "string") return value.startsWith("#") ? Color.fromHex(value) : resolveIdentifier(value);
	const source = resolveColorValue(value.value, resolveIdentifier);
	if (!source) return null;
	switch (value.op) {
		case "transparent": return source.transparent(value.factor);
		case "lighten": return mixColor(source, Color.white, value.factor);
		case "darken": return mixColor(source, Color.black, value.factor);
		case "mix": {
			const other = resolveColorValue(value.other, resolveIdentifier);
			return other ? mixColor(source, other, value.factor) : null;
		}
		case "opaque": {
			const background = resolveColorValue(value.background, resolveIdentifier);
			return background ? source.makeOpaque(background) : null;
		}
	}
}

function mixColor(source: Color, other: Color, factor: number): Color {
	const amount = Math.min(Math.max(factor, 0), 1);
	const start = source.rgba;
	const end = other.rgba;
	return new Color(new RGBA(
		Math.round(start.r + (end.r - start.r) * amount),
		Math.round(start.g + (end.g - start.g) * amount),
		Math.round(start.b + (end.b - start.b) * amount),
		start.a + (end.a - start.a) * amount,
	));
}

export function validateTokenId(id: string, kind: string): void {
	if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(id)) {
		throw new TypeError(`Invalid ${kind} token ID '${id}'`);
	}
}

export const Colors = new ColorRegistry();
