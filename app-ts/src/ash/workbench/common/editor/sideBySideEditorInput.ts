import { Event } from '../../../base/common/event.js';
import { basename } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import type { IResourceEditorInput } from '../editor.js';
import { EditorInput } from './editorInput.js';

/** The comparison borrows both inputs; each subscribing view owns its label listener. */
export abstract class SideBySideEditorInput extends EditorInput {
	public readonly onDidChangeLabel: Event<void>;
	public readonly readOnly = true;

	constructor(
		public readonly resource: URI,
		public readonly secondary: IResourceEditorInput,
		public readonly primary: IResourceEditorInput,
		public readonly preferredName?: string,
	) {
		super();
		// Event.any subscribes only while a view listens, so closing the last view releases both subscriptions.
		this.onDidChangeLabel = Event.any(secondary.onDidChangeLabel ?? Event.None, primary.onDidChangeLabel ?? Event.None);
	}

	public getName(): string {
		return this.preferredName ?? `${this.secondary.label ?? basename(this.secondary.resource)} ↔ ${this.primary.label ?? basename(this.primary.resource)}`;
	}
}
