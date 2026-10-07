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

/** Produces SVG markup for the browser renderer. */
export type IconDefinition = () => string;
