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

/** A native font glyph, with SVG artwork retained for a failed font load. */
export interface FontIconDefinition {
	readonly fontCharacter: string;
	readonly font?: { readonly id: string; readonly definition: { readonly weight?: string; readonly style?: string; }; };
	readonly fallback?: () => string;
}

/** Font glyphs are the default; fixed-color artwork can supply its own SVG. */
export type IconDefinition = FontIconDefinition | (() => string);
