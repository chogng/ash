import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type ISCMService, type ISCMProvider, type ISCMRepository } from './scm.js';

/** Owns the Workbench repository registry; each provider owns its history state. */
export class SCMService extends Disposable implements ISCMService {
	private readonly repositoryMap = new Map<string, ISCMRepository>();
	private readonly addEmitter = this._register(new Emitter<ISCMRepository>());
	private readonly removeEmitter = this._register(new Emitter<ISCMRepository>());
	public readonly onDidAddRepository = this.addEmitter.event;
	public readonly onDidRemoveRepository = this.removeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			for (const repository of [...this.repositoryMap.values()]) repository.dispose();
		}));
	}

	public get repositories(): Iterable<ISCMRepository> {
		return this.repositoryMap.values();
	}

	public registerSCMProvider(provider: ISCMProvider): ISCMRepository {
		if (this.repositoryMap.has(provider.id)) throw new Error(`SCM repository '${provider.id}' is already registered`);
		const repository: ISCMRepository = {
			id: provider.id,
			provider,
			dispose: () => {
				if (this.repositoryMap.get(provider.id) !== repository) return;
				this.repositoryMap.delete(provider.id);
				this.removeEmitter.fire(repository);
			},
			[Symbol.dispose]: () => repository.dispose(),
		};
		this.repositoryMap.set(provider.id, repository);
		this.addEmitter.fire(repository);
		return repository;
	}

	public getRepository(id: string): ISCMRepository | undefined {
		return this.repositoryMap.get(id);
	}

}
