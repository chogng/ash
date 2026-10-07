import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { Event } from '../../../base/common/event.js';
import type { Constructor } from '../../instantiation/common/descriptors.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IQuickPick, IQuickPickItem, IQuickPickSeparator } from './quickInput.js';

export interface IQuickAccessProviderRunOptions {
	readonly handleAccept?: (item: IQuickPickItem, isBackgroundAccept: boolean) => void;
}

export interface AnythingQuickAccessProviderRunOptions extends IQuickAccessProviderRunOptions {
	readonly includeFolders?: boolean;
	readonly additionPicks?: readonly (IQuickPickItem | IQuickPickSeparator)[];
	readonly filter?: (item: IQuickPickItem) => boolean;
}

export interface IQuickAccessOptions {
	readonly placeholder?: string;
	readonly enabledProviderPrefixes?: readonly string[];
	readonly providerOptions?: IQuickAccessProviderRunOptions;
}

/** One search mode hosted by the shared Quick Access picker. */
export interface IQuickAccessProvider {
	provide(picker: IQuickPick<IQuickPickItem>, prefix: string, signal: AbortSignal, options?: IQuickAccessProviderRunOptions): IDisposable;
}

export interface IQuickAccessProviderDescriptor {
	readonly prefix: string;
	/** Read when shown so a long-lived registration can use the current language. */
	readonly placeholder: string;
	readonly helpLabel: string;
	readonly ctor: Constructor<IQuickAccessProvider>;
}

/** Registered search modes are resolved by the longest matching prefix. */
export class QuickAccessRegistry {
	private static readonly descriptors: IQuickAccessProviderDescriptor[] = [];

	static register(descriptor: IQuickAccessProviderDescriptor): IDisposable {
		if (this.descriptors.some(candidate => candidate.prefix === descriptor.prefix)) {
			throw new Error(`Quick Access prefix is already registered: ${descriptor.prefix}`);
		}
		this.descriptors.push(descriptor);
		return toDisposable(() => {
			const index = this.descriptors.indexOf(descriptor);
			if (index !== -1) this.descriptors.splice(index, 1);
		});
	}

	static get(value: string): IQuickAccessProviderDescriptor | undefined {
		let match: IQuickAccessProviderDescriptor | undefined;
		for (const descriptor of this.descriptors) {
			if (value.startsWith(descriptor.prefix) && (!match || descriptor.prefix.length > match.prefix.length)) match = descriptor;
		}
		return match;
	}

	static all(): readonly IQuickAccessProviderDescriptor[] {
		return [...this.descriptors];
	}
}

export interface IQuickAccessController {
	readonly onDidChangeVisibility: Event<boolean>;
	show(value?: string, options?: IQuickAccessOptions): void;
}

export const IQuickAccessController = createServiceIdentifier<IQuickAccessController>('quickAccessController');
