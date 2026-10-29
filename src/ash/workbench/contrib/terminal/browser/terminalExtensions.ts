import type { Constructor } from '../../../../platform/instantiation/common/descriptors.js';
import type { ITerminalContribution, ITerminalInstance } from './terminal.js';

export interface ITerminalContributionContext {
	readonly instance: ITerminalInstance;
}

export interface ITerminalContributionDescription {
	readonly id: string;
	readonly ctor: Constructor<ITerminalContribution>;
}

const contributions = new Map<string, ITerminalContributionDescription>();

/** Registers a feature once; each instance creates it through its own service scope. */
export function registerTerminalContribution(id: string, ctor: Constructor<ITerminalContribution>): void {
	if (contributions.has(id)) { throw new Error(`Terminal contribution already registered: ${id}`); }
	contributions.set(id, { id, ctor });
}

export namespace TerminalExtensionsRegistry {
	export function getTerminalContributions(): readonly ITerminalContributionDescription[] {
		return [...contributions.values()];
	}
}
