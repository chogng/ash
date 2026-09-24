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

/** Produces the SVG markup used by the browser renderer for an icon. */
export type IconDefinition = () => string;

type IconDefaults = Icon | IconDefinition;

const iconDefaultsById = new Map<string, IconDefaults>();
const iconIdPattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/**
 * Registers the default artwork or semantic fallback for an icon ID.
 *
 * Product code should register an icon for the meaning it presents and use the
 * returned reference. Icon-library factories stay behind this boundary.
 */
export function register(id: string, defaults: IconDefaults): Icon {
	if (!iconIdPattern.test(id)) {
		throw new TypeError(`Invalid icon ID '${id}'`);
	}
	if (iconDefaultsById.has(id)) {
		throw new TypeError(`Icon '${id}' is already registered`);
	}
	iconDefaultsById.set(id, defaults);
	return Icon.fromId(id);
}

/** Returns a registered icon reference without crossing into the renderer. */
export function getRegisteredIcon(id: string): Icon | undefined {
	return iconDefaultsById.has(id) ? Icon.fromId(id) : undefined;
}

/** Resolves an icon reference to the SVG factory used by the browser layer. */
export function resolveIconDefinition(icon: Icon): IconDefinition {
	const visited = new Set<string>();
	let current = icon;

	while (true) {
		if (visited.has(current.id)) {
			throw new Error(
				`Circular icon defaults: ${[...visited, current.id].join(" -> ")}`,
			);
		}
		visited.add(current.id);

		const defaults = iconDefaultsById.get(current.id);
		if (!defaults) {
			throw new ReferenceError(`Unknown icon '${current.id}'`);
		}
		if (typeof defaults === "function") return defaults;
		current = defaults;
	}
}
