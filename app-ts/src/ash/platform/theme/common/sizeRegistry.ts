import { validateTokenId } from "./colorRegistry.js";
import type { SizeValue } from "./sizeUtils.js";

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
