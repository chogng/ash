import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { UntitledTextEditorModel, type IUntitledTextEditorModel } from './untitledTextEditorModel.js';

export interface INewUntitledTextEditorOptions {
	readonly initialValue?: string;
	readonly languageId?: string;
}

export interface IExistingUntitledTextEditorOptions extends INewUntitledTextEditorOptions {
	readonly untitledResource?: URI;
	/** Display name persisted with an Ash working-copy backup. */
	readonly label?: string;
}

/** Owns unsaved text identities and their references to the shared text model owner. */
export interface IUntitledTextEditorService extends IDisposable {
	readonly onDidCreate: Event<IUntitledTextEditorModel>;
	readonly onDidChangeLabel: Event<IUntitledTextEditorModel>;
	readonly onWillDispose: Event<IUntitledTextEditorModel>;
	create(options?: IExistingUntitledTextEditorOptions): IUntitledTextEditorModel;
	get(resource: URI): IUntitledTextEditorModel | undefined;
	resolve(options?: IExistingUntitledTextEditorOptions): Promise<IUntitledTextEditorModel>;
	rename(resource: URI, label: string): IUntitledTextEditorModel | undefined;
	isUntitled(resource: URI): boolean;
	reset(): void;
}

export const IUntitledTextEditorService = createServiceIdentifier<IUntitledTextEditorService>('untitledTextEditorService');

export class UntitledTextEditorService extends Disposable implements IUntitledTextEditorService {
	private readonly editors = this._register(new DisposableMap<string, UntitledTextEditorEntry>());
	private readonly created = this._register(new Emitter<IUntitledTextEditorModel>());
	private readonly labelChanged = this._register(new Emitter<IUntitledTextEditorModel>());
	private readonly willDispose = this._register(new Emitter<IUntitledTextEditorModel>());
	private nextUntitledNumber = 1;
	public readonly onDidCreate = this.created.event;
	public readonly onDidChangeLabel = this.labelChanged.event;
	public readonly onWillDispose = this.willDispose.event;

	constructor(
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(workingCopies.onDidUnregister(copy => {
			if (this.isUntitled(copy.resource) && this.workingCopies.get(copy.resource).length === 0) {
				this.release(extUri.getComparisonKey(copy.resource));
			}
		}));
	}

	public create(options: IExistingUntitledTextEditorOptions = {}): IUntitledTextEditorModel {
		this.assertNotDisposed();
		let resource = options.untitledResource;
		if (resource) {
			if (!this.isUntitled(resource)) {
				throw new TypeError('Untitled editor resource must use the untitled scheme');
			}
			const existing = this.get(resource);
			if (existing) {
				return existing;
			}
			const number = /^\/Untitled-(\d+)$/u.exec(resource.path);
			if (number) {
				this.nextUntitledNumber = Math.max(this.nextUntitledNumber, Number(number[1]) + 1);
			}
		} else {
			do {
				resource = URI.parse(`${Schemas.untitled}:/Untitled-${this.nextUntitledNumber++}`);
			} while (this.editors.has(extUri.getComparisonKey(resource)));
		}
		const name = options.label ?? (basename(resource) || resource.authority || resource.toString());
		const model = this.instantiationService.createInstance(UntitledTextEditorModel, resource, name, options.initialValue ?? '', options.languageId);
		const key = extUri.getComparisonKey(resource);
		const entry = new UntitledTextEditorEntry(model, () => this.release(key));
		this.editors.set(key, entry);
		this.created.fire(model);
		return model;
	}

	public get(resource: URI): IUntitledTextEditorModel | undefined {
		return this.editors.get(extUri.getComparisonKey(resource))?.model;
	}

	public async resolve(options?: IExistingUntitledTextEditorOptions): Promise<IUntitledTextEditorModel> {
		const model = this.create(options);
		await model.resolve();
		return model;
	}

	public rename(resource: URI, label: string): IUntitledTextEditorModel | undefined {
		const model = this.editors.get(extUri.getComparisonKey(resource))?.model;
		if (model && model.name !== label) {
			model.setName(label);
			this.labelChanged.fire(model);
		}
		return model;
	}

	public isUntitled(resource: URI): boolean {
		return resource.scheme === Schemas.untitled;
	}

	public reset(): void {
		for (const key of [...this.editors.keys()]) {
			this.release(key);
		}
		this.nextUntitledNumber = 1;
	}

	protected override disposeCore(): void {
		this.reset();
		super.disposeCore();
	}

	private release(key: string): void {
		const entry = this.editors.deleteAndLeak(key);
		if (entry) {
			this.willDispose.fire(entry.model);
			entry.dispose();
		}
	}
}

class UntitledTextEditorEntry extends Disposable {
	constructor(public readonly model: UntitledTextEditorModel, onDispose: () => void) {
		super();
		this._register(model);
		this._register(model.onWillDispose(onDispose));
	}
}
