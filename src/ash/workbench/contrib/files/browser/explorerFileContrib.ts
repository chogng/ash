import { Emitter } from '../../../../base/common/event.js';
import { Disposable, type DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const ExplorerExtensions = {
	FileContributionRegistry: 'workbench.registry.explorer.fileContributions',
} as const;

/** Adds content to one Explorer file row; an undefined resource clears its content. */
export interface IExplorerFileContribution extends IDisposable {
	setResource(resource: URI | undefined): void;
}

export interface IExplorerFileContributionDescriptor {
	create(instantiationService: IInstantiationService, container: HTMLElement): IExplorerFileContribution;
}

export interface IExplorerFileContributionRegistry {
	readonly onDidRegisterDescriptor: (listener: (descriptor: IExplorerFileContributionDescriptor) => void) => IDisposable;
	register(descriptor: IExplorerFileContributionDescriptor): void;
	create(instantiationService: IInstantiationService, container: HTMLElement, store: DisposableStore): readonly IExplorerFileContribution[];
}

export class ExplorerFileContributionRegistry extends Disposable implements IExplorerFileContributionRegistry {
	private readonly registerEmitter = this._register(new Emitter<IExplorerFileContributionDescriptor>());
	private readonly descriptors: IExplorerFileContributionDescriptor[] = [];

	public readonly onDidRegisterDescriptor = this.registerEmitter.event;

	public register(descriptor: IExplorerFileContributionDescriptor): void {
		this.descriptors.push(descriptor);
		this.registerEmitter.fire(descriptor);
	}

	public create(instantiationService: IInstantiationService, container: HTMLElement, store: DisposableStore): readonly IExplorerFileContribution[] {
		return this.descriptors.map(descriptor => store.add(descriptor.create(instantiationService, container)));
	}
}

export const explorerFileContribRegistry = new ExplorerFileContributionRegistry();
Registry.add(ExplorerExtensions.FileContributionRegistry, explorerFileContribRegistry);
