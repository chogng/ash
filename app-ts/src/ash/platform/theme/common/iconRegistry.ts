import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { type Icon, type IconDefinition } from '../../../base/common/icon.js';
import { getLxiconDefinition } from '../../../base/common/lxiconsUtil.js';
import { getAllLxicons } from '../../../base/common/lxicons.js';

export interface IconFontDefinition { readonly id: string; readonly src: string; readonly weight?: string; readonly style?: string; }

export type IconDefaults = Icon | IconDefinition;

export interface IconContribution {
	readonly id: string;
	readonly defaults: IconDefaults;
	readonly description: string | undefined;
}

export interface IIconRegistry {
	readonly onDidChange: Event<void>;
	getFonts(): readonly IconFontDefinition[];
	replaceIcons(owner: symbol, contributions: readonly IconContribution[], fonts: readonly IconFontDefinition[]): void;
	registerIcon(id: string, defaults: IconDefaults, description: string): Icon;
	getIcon(id: string): IconContribution | undefined;
	getIcons(): readonly IconContribution[];
}

class IconRegistry extends Disposable implements IIconRegistry {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly groups = new Map<symbol, { ids: readonly string[]; fonts: readonly IconFontDefinition[] }>();
	private readonly contributions = new Map<string, IconContribution>();

	constructor() {
		super();
		for (const icon of getAllLxicons()) {
			this.contributions.set(icon.id, { id: icon.id, defaults: getLxiconDefinition(icon.id)!, description: undefined });
		}
	}

	public registerIcon(id: string, defaults: IconDefaults, description: string): Icon {
		if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(id)) throw new TypeError(`Invalid icon ID '${id}'`);
		if (this.contributions.has(id)) throw new TypeError(`Icon '${id}' is already registered`);
		this.contributions.set(id, { id, defaults, description });
		this.changed.fire();
		return { id };
	}

	public getFonts(): readonly IconFontDefinition[] { return [...this.groups.values()].flatMap(group => group.fonts); }
	public replaceIcons(owner: symbol, contributions: readonly IconContribution[], fonts: readonly IconFontDefinition[]): void {
		const previous = this.groups.get(owner)?.ids ?? [];
		if (!previous.length && !contributions.length) { return; }
		const next = new Map([...this.contributions].filter(([id]) => !previous.includes(id)));
		for (const contribution of contributions) {
			if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(contribution.id) || next.has(contribution.id)) { throw new TypeError(`Invalid or duplicate icon: ${contribution.id}`); }
			next.set(contribution.id, contribution);
		}
		for (const contribution of contributions) {
			let current: IconContribution | undefined = contribution;
			const visited = new Set<string>();
			while (typeof current.defaults !== 'function') {
				if (visited.has(current.id)) { throw new TypeError(`Icon default cycle: ${contribution.id}`); }
				visited.add(current.id);
				const reference: string = current.defaults.id;
				current = next.get(reference);
				if (!current) { throw new TypeError(`Unknown icon default: ${reference}`); }
			}
		}
		this.contributions.clear();
		for (const [id, contribution] of next) { this.contributions.set(id, contribution); }
		if (contributions.length) { this.groups.set(owner, { ids: contributions.map(icon => icon.id), fonts }); } else { this.groups.delete(owner); }
		this.changed.fire();
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
