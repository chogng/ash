import type { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { extUri } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import type { IResourceEditorInput } from '../editor.js';

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

	public matches(other: IResourceEditorInput): boolean {
		return this.editorId === other.editorId && extUri.isEqual(this.resource, other.resource) &&
			(!(other instanceof EditorInput) || this.typeId === other.typeId);
	}
}
