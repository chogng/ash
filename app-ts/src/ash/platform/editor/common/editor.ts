import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';

/** Lifecycle shared by editor models whose backing data resolves asynchronously. */
export interface IResolvableEditorModel extends IDisposable {
	resolve(): Promise<void>;
	isResolved(): boolean;
}

export function isResolvedEditorModel(model: IDisposable | undefined | null): model is IResolvableEditorModel {
	const candidate = model as IResolvableEditorModel | undefined | null;
	return typeof candidate?.resolve === 'function' && typeof candidate.isResolved === 'function';
}

/** Editor activation preferences shared by resource-navigation surfaces. */
export interface EditorActivationOptions {
	/** Keeps the opened resource as a durable tab instead of a replaceable preview. */
	readonly pinned?: boolean;
	/** Leaves DOM focus with the navigation surface that requested the open. */
	readonly preserveFocus?: boolean;
}

export interface ITextEditorOptions extends EditorActivationOptions {
	readonly selection?: {
		readonly startLineNumber: number;
		readonly startColumn: number;
		readonly endLineNumber?: number;
		readonly endColumn?: number;
	};
}

export interface ITextResourceEditorInput {
	readonly resource: URI;
	readonly options?: ITextEditorOptions;
}
