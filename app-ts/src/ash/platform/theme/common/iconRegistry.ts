import { type Icon, type IconDefinition } from '../../../base/common/icon.js';
import { getLxiconDefinition } from '../../../base/common/lxiconsUtil.js';
import { getAllLxicons } from '../../../base/common/lxicons.js';

export type IconDefaults = Icon | IconDefinition;

export interface IconContribution {
	readonly id: string;
	readonly defaults: IconDefaults;
	readonly description: string | undefined;
}

export interface IIconRegistry {
	registerIcon(id: string, defaults: IconDefaults, description: string): Icon;
	getIcon(id: string): IconContribution | undefined;
	getIcons(): readonly IconContribution[];
}

class IconRegistry implements IIconRegistry {
	private readonly contributions = new Map<string, IconContribution>();

	constructor() {
		for (const icon of getAllLxicons()) {
			this.contributions.set(icon.id, { id: icon.id, defaults: getLxiconDefinition(icon.id)!, description: undefined });
		}
	}

	public registerIcon(id: string, defaults: IconDefaults, description: string): Icon {
		if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(id)) throw new TypeError(`Invalid icon ID '${id}'`);
		if (this.contributions.has(id)) throw new TypeError(`Icon '${id}' is already registered`);
		this.contributions.set(id, { id, defaults, description });
		return { id };
	}

	public getIcon(id: string): IconContribution | undefined { return this.contributions.get(id); }
	public getIcons(): readonly IconContribution[] { return [...this.contributions.values()]; }
}

const registry = new IconRegistry();

export function registerIcon(id: string, defaults: IconDefaults, description: string): Icon {
	return registry.registerIcon(id, defaults, description);
}

export function getIconRegistry(): IIconRegistry { return registry; }

/** Resolves product theme artwork before following a semantic icon's default chain. */
export function getIconDefinition(icon: Icon, themedDefinitions?: ReadonlyMap<string, IconDefinition>): IconDefinition | undefined {
	const visited = new Set<string>();
	let current = icon;
	while (true) {
		if (visited.has(current.id)) throw new Error(`Circular icon defaults: ${[...visited, current.id].join(' -> ')}`);
		visited.add(current.id);
		const contribution = registry.getIcon(current.id);
		if (!contribution) return undefined;
		const themed = themedDefinitions?.get(current.id);
		if (themed) return themed;
		if (typeof contribution.defaults === 'function') return contribution.defaults;
		current = contribution.defaults;
	}
}

export function resolveIconDefinition(icon: Icon, themedDefinitions?: ReadonlyMap<string, IconDefinition>): IconDefinition {
	const definition = getIconDefinition(icon, themedDefinitions);
	if (!definition) throw new ReferenceError(`Unknown icon '${icon.id}'`);
	return definition;
}
