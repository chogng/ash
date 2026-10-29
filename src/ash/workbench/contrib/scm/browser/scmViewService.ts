import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISCMService, type ISCMRepository, type ISCMViewService } from '../common/scm.js';

/** Tracks the repository selected for SCM views independently of provider state. */
export class SCMViewService extends Disposable implements ISCMViewService {
	private readonly changeEmitter = this._register(new Emitter<ISCMRepository | undefined>());
	public readonly onDidChangeActiveRepository = this.changeEmitter.event;
	private selectedId: string | undefined;

	constructor(@ISCMService private readonly scmService: ISCMService) {
		super();
		this.selectedId = this.scmService.repositories[Symbol.iterator]().next().value?.id;
		this._register(this.scmService.onDidAddRepository(repository => {
			if (this.selectedId === undefined) this.selectRepository(repository.id);
		}));
		this._register(this.scmService.onDidRemoveRepository(repository => {
			if (repository.id !== this.selectedId) return;
			this.selectedId = this.scmService.repositories[Symbol.iterator]().next().value?.id;
			this.changeEmitter.fire(this.activeRepository);
		}));
	}

	public get activeRepository(): ISCMRepository | undefined {
		return this.selectedId === undefined ? undefined : this.scmService.getRepository(this.selectedId);
	}

	public selectRepository(id: string | undefined): void {
		if (id !== undefined && !this.scmService.getRepository(id)) throw new Error(`SCM repository '${id}' is not registered`);
		if (id === this.selectedId) return;
		this.selectedId = id;
		this.changeEmitter.fire(this.activeRepository);
	}
}
