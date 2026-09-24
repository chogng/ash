import { Emitter, type Event } from '../../../base/common/event.js';
import type { IMarkdownString } from '../../../base/common/htmlContent.js';
import type { IDisposable, IReference } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { IResolvableEditorModel } from '../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { ITextModel, ITextSnapshot } from '../model.js';

export const ITextModelService = createDecorator<ITextModelService>('textModelService');

/** Resolves URI-backed text models without owning persistence or dirty state. */
export interface ITextModelService {
	readonly _serviceBrand: undefined;
	createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>>;
	registerTextModelContentProvider(scheme: string, provider: ITextModelContentProvider): IDisposable;
	canHandleResource(resource: URI): boolean;
}

export interface ITextModelContentProvider {
	provideTextContent(resource: URI): Promise<ITextModel | null> | null;
}

export interface ITextEditorModel extends IResolvableEditorModel {
	readonly onWillDispose: Event<void>;
	readonly textEditorModel: ITextModel | null;
	createSnapshot(this: IResolvedTextEditorModel): ITextSnapshot;
	createSnapshot(this: ITextEditorModel): ITextSnapshot | null;
	isReadonly(): boolean | IMarkdownString;
	getLanguageId(): string | undefined;
	isDisposed(): boolean;
}

export interface IResolvedTextEditorModel extends ITextEditorModel {
	readonly textEditorModel: ITextModel;
}

export function isResolvedTextEditorModel(model: ITextEditorModel): model is IResolvedTextEditorModel {
	return !!model.textEditorModel;
}

/** Keeps the model's ownership with its host while tying this view to one reference. */
export function createResolvedTextEditorModelReference(model: ITextModel, release: () => void): IReference<IResolvedTextEditorModel> {
	let released = false;
	let notified = false;
	const willDispose = new Emitter<void>();
	const notify = (): void => {
		if (notified) return;
		notified = true;
		willDispose.fire();
	};
	const modelListener = model.onWillDispose(notify);
	const dispose = (): void => {
		if (released) return;
		released = true;
		notify();
		modelListener.dispose();
		willDispose.dispose();
		release();
	};
	const object: IResolvedTextEditorModel = {
		textEditorModel: model,
		onWillDispose: willDispose.event,
		resolve: async () => {},
		isResolved: () => !released && !model.isDisposed(),
		createSnapshot: () => model.createSnapshot(),
		isReadonly: () => false,
		getLanguageId: () => model.getLanguageId(),
		isDisposed: () => released || model.isDisposed(),
		dispose,
		[Symbol.dispose]: dispose,
	};
	return { object, dispose, [Symbol.dispose]: dispose };
}
