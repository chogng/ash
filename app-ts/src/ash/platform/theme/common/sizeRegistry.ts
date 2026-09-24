import { validateTokenId } from "./colorRegistry.js";

export type SizeUnit = "px" | "rem" | "em" | "%" | "ms" | "unitless";

export interface SizeValue {
	readonly value: number;
	readonly unit: SizeUnit;
}

export interface SizeContribution {
	readonly id: string;
	readonly value: SizeValue;
	readonly description: string;
	readonly owner: string;
	readonly deprecated?: string;
}

export interface SizeRegistrationMetadata {
	readonly description: string;
	readonly owner: string;
	readonly deprecated?: string;
}

export function size(value: number, unit: SizeUnit = "px"): SizeValue {
	if (!Number.isFinite(value)) throw new TypeError("Size token value must be finite");
	return Object.freeze({ value, unit });
}

export function sizeToCss(value: SizeValue): string {
	return value.unit === "unitless" ? String(value.value) : `${value.value}${value.unit}`;
}

export class SizeRegistry {
	private readonly sizes = new Map<string, SizeContribution>();
	private sealed = false;

	registerSize(id: string, value: SizeValue, metadata: SizeRegistrationMetadata): string {
		if (this.sealed) throw new Error(`Size registry is sealed; cannot register: ${id}`);
		validateTokenId(id, "size");
		if (this.sizes.has(id)) throw new Error(`Size token is already registered: ${id}`);
		this.sizes.set(id, Object.freeze({ id, value: Object.freeze({ ...value }), ...metadata }));
		return id;
	}

	getSizes(): readonly SizeContribution[] {
		return Object.freeze([...this.sizes.values()]);
	}

	seal(): void {
		this.sealed = true;
	}
}

export const Sizes = new SizeRegistry();

export function registerSize(id: string, value: SizeValue, metadata: SizeRegistrationMetadata): string {
	return Sizes.registerSize(id, value, metadata);
}

export function sizeCssVariable(id: string): string {
	return `--ash-${id.replaceAll(".", "-").replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}
