import { Colors, type ColorDefaults, type ColorIdentifier, type ColorRegistrationMetadata, type ColorTransform, type ColorValue } from "./colorRegistry.js";

export function registerColor(id: ColorIdentifier, defaults: ColorDefaults, metadata: ColorRegistrationMetadata): ColorIdentifier {
	return Colors.registerColor(id, defaults, metadata);
}

export function transparent(value: ColorValue, factor: number): ColorTransform {
	return { op: "transparent", value, factor };
}

export function lighten(value: ColorValue, factor: number): ColorTransform {
	return { op: "lighten", value, factor };
}

export function darken(value: ColorValue, factor: number): ColorTransform {
	return { op: "darken", value, factor };
}

export function mix(value: ColorValue, other: ColorValue, factor: number): ColorTransform {
	return { op: "mix", value, other, factor };
}

export function opaque(value: ColorValue, background: ColorValue): ColorTransform {
	return { op: "opaque", value, background };
}

export function colorCssVariable(id: ColorIdentifier): string {
	return `--ash-${id.replaceAll(".", "-").replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}
