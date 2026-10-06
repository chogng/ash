import { Event } from '../../../base/common/event.js';
import { basename } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { EditorInput } from './editorInput.js';

export abstract class AbstractResourceEditorInput extends EditorInput {
	public readonly onDidChangeLabel = Event.None;

	constructor(public readonly resource: URI) {
		super();
	}

	public getName(): string {
		return basename(this.resource);
	}
}
