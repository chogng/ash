import type { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { extUri, type IExtUri } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import type { IResourceEditorInput } from '../editor.js';
import type { IEditorIdentifier } from '../editor.js';
import type { ConfirmResult } from '../../../platform/dialogs/common/dialogs.js';

/** A custom resource can confirm closing without pretending to be a dirty file. */
export interface IEditorCloseHandler {
	showConfirm(): boolean;
	confirm(editors: ReadonlyArray<IEditorIdentifier>): Promise<ConfirmResult>;
}

/** Live inputs own metadata and acquired references; resolving services own shared models. */
export abstract class EditorInput extends Disposable implements IResourceEditorInput {
	public abstract readonly typeId: string;
	public abstract readonly resource: URI;
	public abstract readonly onDidChangeLabel: Event<void> | undefined;
	public readonly editorId?: string;

	public abstract getName(): string;

	public get label(): string {
		return this.getName();
	}

	public matches(other: IResourceEditorInput, resourceIdentity: IExtUri = extUri): boolean {
		return (
			this.editorId === other.editorId &&
			resourceIdentity.isEqual(this.resource, other.resource) &&
			(!(other instanceof EditorInput) || this.typeId === other.typeId)
		);
	}
}
