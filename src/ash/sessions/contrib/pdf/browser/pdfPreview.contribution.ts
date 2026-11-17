import type { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { extname } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { isResourceDiffEditorInput } from '../../../../workbench/common/editor.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IndexedDbWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/browser/indexedDbWorkingCopyBackupService.js';
import { WorkingCopyBackupTracker } from '../../../../workbench/services/workingCopy/browser/workingCopyBackupTracker.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { PdfDocumentModel } from './pdfDocumentModel.js';
import { IPdfEditorService, PdfEditorService } from './pdfEditorService.js';
import './pdfPreviewConfiguration.js';

registerSingleton(IPdfEditorService, PdfEditorService, InstantiationType.Delayed);

const id = 'sessions.editor.pdfPreview';

registerWorkbenchContribution('sessions.pdfPreview.backup', WorkbenchPhase.BlockRestore, accessor => {
	const editors = accessor.get(IEditorPart);
	const copies = accessor.get(IWorkingCopyService);
	const lifecycle = accessor.get(ILifecycleService);
	const log = accessor.get(ILogService);
	const lifetime = new DisposableStore();
	// Recovery needs the original PDF bytes, which can exceed the App Server backup record limit.
	const backups = lifetime.add(new IndexedDbWorkingCopyBackupService('sessions-pdf'));
	const isPdf = (copy: IWorkingCopy): copy is PdfDocumentModel => copy instanceof PdfDocumentModel;
	const pdfEvent = (event: Event<IWorkingCopy>): Event<IWorkingCopy> => (listener, thisArgs, disposables) =>
		event(copy => { if (isPdf(copy)) listener.call(thisArgs, copy); }, undefined, disposables);
	const tracker = lifetime.add(new WorkingCopyBackupTracker({
		getAll: () => copies.getAll().filter(isPdf),
		get: resource => copies.get(resource).filter(isPdf),
		onDidRegister: pdfEvent(copies.onDidRegister),
		onDidUnregister: pdfEvent(copies.onDidUnregister),
	}, backups, editors.domNode.ownerDocument.defaultView!, error => log.error('pdf', 'PDF backup failed', error)));
	lifetime.add(lifecycle.onWillShutdown(event => event.join(() => tracker.shutdown(), 'PDF backup drain', () => tracker.isShutdownCurrent)));
	lifetime.add(lifecycle.onDidShutdown(() => tracker.completeShutdown()));
	lifetime.add(lifecycle.onDidShutdownError(reason => { if (reason !== 'pageHide') tracker.cancelShutdown(); }));
	lifetime.add(lifecycle.onBeforeShutdownError(event => { if (event.reason === 'pageHide') tracker.completeShutdown(); }));

	return Object.assign(lifetime, {
		async onWorkspaceRestored(): Promise<void> {
			for (const backup of await backups.list()) {
				if (lifetime.isDisposed) return;
				if (backup.kind !== 'structuredDocument' || backup.contentType !== 'application/pdf') continue;
				try {
					const model = copies.get(backup.resource).find(isPdf) ?? (await editors.openEditor({
						resource: backup.resource,
						contentType: backup.contentType,
						editorId: id,
					}, { pinned: true, preserveFocus: true })).workingCopy;
					if (lifetime.isDisposed) return;
					if (model instanceof PdfDocumentModel && !model.isDirty) model.restoreBackup(backup.content);
				} catch (error) {
					log.error('pdf', `PDF recovery failed for '${backup.resource.toString()}'`, error);
				}
			}
		},
	});
});

registerEditorPane({
	id,
	get name() { return localize('sessions.pdfPreview.title', 'PDF'); },
	resourceEditor: true,
	canOpen: input => !isResourceDiffEditorInput(input) &&
		(input.contentType === 'application/pdf' || extname(input.resource.path).toLowerCase() === '.pdf')
		? EditorPaneMatch.Default : EditorPaneMatch.None,
	async create({ instantiationService }) {
		if (!instantiationService) throw new Error('PDF Preview requires Workbench instantiation services');
		const { PdfPreviewEditor } = await import('./pdfPreviewEditor.js');
		return instantiationService.createInstance(PdfPreviewEditor, id);
	},
});
