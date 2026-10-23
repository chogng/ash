/** A stable, renderer-independent reference to an icon. */
export interface Icon {
	readonly id: string;
}

export namespace Icon {
	/** Creates an icon reference for an ID supplied by configuration or data. */
	export function fromId(id: string): Icon {
		return { id };
	}
}

/** A native font glyph resolved by the product icon theme. */
export interface IconDefinition {
	readonly fontCharacter: string;
	readonly font?: { readonly id: string; readonly definition: { readonly weight?: string; readonly style?: string; }; };
	/** Prepared glyph layers retain independent animation without carrying SVG artwork. */
	readonly layers?: readonly { readonly id: string; readonly fontCharacter: string; readonly origin: readonly [number, number]; }[];
}
