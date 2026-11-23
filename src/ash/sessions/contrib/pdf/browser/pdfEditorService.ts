import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { PdfDocumentModel } from './pdfDocumentModel.js';

export const IPdfEditorService = createServiceIdentifier<IPdfEditorService>('pdfEditorService');
export interface IPdfEditorService {
	acquire(input: IResourceEditorInput): { readonly model: PdfDocumentModel; readonly ready: Promise<void>; readonly release: IDisposable; };
}

interface Entry { readonly model: PdfDocumentModel; readonly ready: Promise<void>; readonly registration: IDisposable; references: number; }

/** One window owns one editable working copy per canonical resource, with pane-scoped leases. */
export class PdfEditorService extends Disposable implements IPdfEditorService {
	private readonly documents = new Map<string, Entry>();

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IWorkingCopyService private readonly copies: IWorkingCopyService,
		@IUriIdentityService private readonly identity: IUriIdentityService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this.documents.values()) { entry.registration.dispose(); entry.model.dispose(); }
			this.documents.clear();
		}));
	}

	public acquire(input: IResourceEditorInput): ReturnType<IPdfEditorService['acquire']> {
		// An immutable snapshot can name the same resource as a writable file.
		if (input.readOnly || input.initialBytes) {
			const model = this.instantiation.createInstance(PdfDocumentModel, input);
			return { model, ready: model.open(), release: model };
		}
		const key = this.identity.asCanonicalUri(input.resource).toString();
		let entry = this.documents.get(key);
		if (!entry) {
			const model = this.instantiation.createInstance(PdfDocumentModel, input);
			entry = { model, ready: model.open(), registration: this.copies.register(model), references: 0 };
			this.documents.set(key, entry);
		}
		const owned = entry;
		owned.references++;
		return {
			model: owned.model, ready: owned.ready, release: toDisposable(() => {
				if (--owned.references === 0 && this.documents.get(key) === owned) {
					this.documents.delete(key); owned.registration.dispose(); owned.model.dispose();
				}
			})
		};
	}
}
