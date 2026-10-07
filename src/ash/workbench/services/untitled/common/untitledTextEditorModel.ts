import { Emitter, type Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel, ITextSnapshot } from '../../../../editor/common/model.js';
import type { IResolvedTextEditorModel, ITextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { EditorModel } from '../../../common/editor/editorModel.js';
import { ITextModelResourceService, type TextModelReference } from '../../textmodelResolver/common/textModelResourceService.js';

export interface IUntitledTextEditorModel extends ITextEditorModel {
	readonly resource: URI;
	readonly name: string;
	readonly initialValue: string;
	readonly onDidChangeName: Event<void>;
	readonly onDidChangeDirty: Event<void>;
	isDirty(): boolean;
	isResolved(): this is IResolvedUntitledTextEditorModel;
}

export interface IResolvedUntitledTextEditorModel extends IUntitledTextEditorModel {
	readonly textEditorModel: ITextModel;
}

/** Holds a draft reference; text, undo history and dirty comparison stay with the shared model service. */
export class UntitledTextEditorModel extends EditorModel implements IUntitledTextEditorModel {
	private readonly nameChanged = this._register(new Emitter<void>());
	private readonly dirtyChanged = this._register(new Emitter<void>());
	private readonly resolutionController = new AbortController();
	private resolution: Promise<void> | undefined;
	private reference: TextModelReference | undefined;
	public readonly onDidChangeName = this.nameChanged.event;
	public readonly onDidChangeDirty = this.dirtyChanged.event;

	constructor(
		public readonly resource: URI,
		private currentName: string,
		public readonly initialValue: string,
		private readonly languageId: string | undefined,
		@ITextModelResourceService private readonly models: ITextModelResourceService,
	) {
		super();
		this._register(toDisposable(() => this.resolutionController.abort()));
	}

	public get name(): string {
		return this.currentName;
	}

	public get textEditorModel(): ITextModel | null {
		return this.isDisposed() ? null : this.reference?.model ?? null;
	}

	public override resolve(): Promise<void> {
		this.resolution ??= this.acquireModel().catch(error => {
			this.resolution = undefined;
			throw error;
		});
		return this.resolution;
	}

	public override isResolved(): this is IResolvedUntitledTextEditorModel {
		return this.textEditorModel !== null;
	}

	public isDirty(): boolean {
		return this.reference?.isDirty ?? this.initialValue.length > 0;
	}

	public isReadonly(): boolean {
		return false;
	}

	public getLanguageId(): string | undefined {
		return this.textEditorModel?.getLanguageId() ?? this.languageId;
	}

	public createSnapshot(this: IResolvedTextEditorModel): ITextSnapshot;
	public createSnapshot(this: ITextEditorModel): ITextSnapshot | null;
	public createSnapshot(): ITextSnapshot | null {
		return this.textEditorModel?.createSnapshot() ?? null;
	}

	public setName(name: string): void {
		if (this.currentName === name) {
			return;
		}
		this.currentName = name;
		this.nameChanged.fire();
	}

	private async acquireModel(): Promise<void> {
		const reference = await this.models.acquire({ resource: this.resource, initialText: this.initialValue, languageId: this.languageId }, this.resolutionController.signal);
		this._register(reference);
		this.reference = reference;
		this._register(reference.model.onWillDispose(() => this.dispose()));
		this._register(reference.onDidChangeDirty(() => this.dirtyChanged.fire()));
		await super.resolve();
	}
}
