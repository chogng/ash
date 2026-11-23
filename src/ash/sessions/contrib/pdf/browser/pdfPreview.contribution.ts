import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { extname } from '../../../../base/common/path.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { isResourceDiffEditorInput } from '../../../../workbench/common/editor.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { PdfDocumentModel } from './pdfDocumentModel.js';
import { IPdfEditorService, PdfEditorService } from './pdfEditorService.js';
import './pdfPreviewConfiguration.js';

registerSingleton(IPdfEditorService, PdfEditorService, InstantiationType.Delayed);

const id = 'sessions.editor.pdfPreview';

registerWorkbenchContribution('sessions.pdfPreview.backup', WorkbenchPhase.BlockRestore, accessor => {
	const editors = accessor.get(IEditorPart);
	const copies = accessor.get(IWorkingCopyService);
	const pdfEditors = accessor.get(IPdfEditorService);
	const { backups } = pdfEditors;
	const lifecycle = accessor.get(ILifecycleService);
	const log = accessor.get(ILogService);
	const notifications = accessor.get(INotificationService);
	const lifetime = new DisposableStore();
	const reportFailure = (error: unknown, logMessage: string, message: string): void => {
		if (lifetime.isDisposed || isCancellationError(error)) return;
		log.error('pdf', logMessage, error);
		notifications.error(message);
	};
	const reportBackupFailure = (error: unknown): void => reportFailure(error, 'PDF backup failed',
		localize('sessions.pdfPreview.backupFailed', 'Could not back up PDF changes.'));
	const isPdf = (copy: IWorkingCopy): copy is PdfDocumentModel => copy instanceof PdfDocumentModel;
	const tracker = lifetime.add(pdfEditors.trackBackups(editors.domNode.ownerDocument.defaultView!, reportBackupFailure));
	lifetime.add(lifecycle.onWillShutdown(event => event.join(async () => {
		try { await tracker.shutdown(); }
		catch (error) {
			if (event.reason !== 'pageHide') reportBackupFailure(error);
			throw error;
		}
	}, 'PDF backup drain', () => tracker.isShutdownCurrent)));
	lifetime.add(lifecycle.onDidShutdown(() => tracker.completeShutdown()));
	lifetime.add(lifecycle.onDidShutdownError(reason => { if (reason !== 'pageHide') tracker.cancelShutdown(); }));
	lifetime.add(lifecycle.onBeforeShutdownError(event => { if (event.reason === 'pageHide') tracker.completeShutdown(); }));

	return Object.assign(lifetime, {
		async onWorkspaceRestored(): Promise<void> {
			const pending = await backups.list().catch(error => {
				reportFailure(error, 'PDF backups could not be read', localize('sessions.pdfPreview.backupReadFailed', 'Could not read PDF recovery backups.'));
				return [];
			});
			for (const backup of pending) {
				if (lifetime.isDisposed) return;
				if (backup.kind !== 'structuredDocument' || backup.contentType !== 'application/pdf') continue;
				try {
					const model = copies.get(backup.resource).find(isPdf) ?? (await editors.openEditor({
						resource: backup.resource,
						contentType: backup.contentType,
						editorId: id,
					}, { pinned: true, preserveFocus: true })).workingCopy;
					if (lifetime.isDisposed) return;
					if (model instanceof PdfDocumentModel && !model.isDirty) await model.restoreBackup(backup.content);
				} catch (error) {
					reportFailure(error, `PDF recovery failed for '${backup.resource.toString()}'`,
						localize('sessions.pdfPreview.recoveryFailed', 'Could not recover PDF changes for {0}.', basename(backup.resource)));
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
	createInput: input => input.readOnly && !input.initialBytes ? { ...input, readOnly: undefined } : input,
	async create({ instantiationService }) {
		if (!instantiationService) throw new Error('PDF Preview requires Workbench instantiation services');
		const { PdfPreviewEditor } = await import('./pdfPreviewEditor.js');
		return instantiationService.createInstance(PdfPreviewEditor, id);
	},
});
