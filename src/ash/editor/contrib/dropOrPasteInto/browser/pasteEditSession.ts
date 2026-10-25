import { AbstractDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentPasteEdit } from '../../../common/languages.js';

/** Keeps provider resources alive while a paste edit can still be selected. */
export class PasteEditSession<T extends DocumentPasteEdit = DocumentPasteEdit> extends AbstractDisposable {
	constructor(readonly edits: readonly T[], private resources: IDisposable | undefined) {
		super();
	}

	/** Moves the provider lifetime; releasing the previous handle then has no effect. */
	take(): PasteEditSession<T> {
		this.assertNotDisposed();
		const resources = this.resources;
		this.resources = undefined;
		return new PasteEditSession(this.edits, resources);
	}

	protected override disposeCore(): void {
		const resources = this.resources;
		this.resources = undefined;
		resources?.dispose();
	}
}
