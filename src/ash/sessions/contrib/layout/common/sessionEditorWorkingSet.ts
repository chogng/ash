import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';

export interface ISessionEditorWorkingSetRestoreState {
	readonly owner: { readonly sessionResource: URI; readonly chatResource: URI | undefined; } | undefined;
	readonly restoring: boolean;
	readonly applying: boolean;
}

export const ISessionEditorWorkingSetService = createServiceIdentifier<ISessionEditorWorkingSetService>('sessionEditorWorkingSetService');

export interface ISessionEditorWorkingSetService {
	readonly restoreState: IObservable<ISessionEditorWorkingSetRestoreState>;
	setRestoreState(state: ISessionEditorWorkingSetRestoreState): void;
	/** Retain a live editor while its Part is hidden. Its owner still handles session switches. */
	registerEditorToRetain(input: IResourceEditorInput): IDisposable;
	shouldRetainEditor(input: IResourceEditorInput): boolean;
}

/** Shares working-set restore progress and live editor retention within one window. */
export class SessionEditorWorkingSetService implements ISessionEditorWorkingSetService {
	private readonly state = observableValue<ISessionEditorWorkingSetRestoreState>(this, { owner: undefined, restoring: false, applying: false });
	readonly restoreState: IObservable<ISessionEditorWorkingSetRestoreState> = this.state;
	private readonly retainedEditors = new Set<IResourceEditorInput>();

	setRestoreState(state: ISessionEditorWorkingSetRestoreState): void {
		this.state.set(state, undefined);
	}

	registerEditorToRetain(input: IResourceEditorInput): IDisposable {
		this.retainedEditors.add(input);
		return toDisposable(() => this.retainedEditors.delete(input));
	}

	shouldRetainEditor(input: IResourceEditorInput): boolean {
		return this.retainedEditors.has(input);
	}
}
