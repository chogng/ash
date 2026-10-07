import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyHistoryService, type IWorkingCopyHistoryEntry } from '../../../services/workingCopy/common/workingCopyHistory.js';
import { WorkingCopyHistoryTracker } from '../../../services/workingCopy/common/workingCopyHistoryTracker.js';
import '../../../services/workingCopy/common/workingCopyHistoryService.js';
import { LocalHistoryTimeline } from './localHistoryTimeline.js';
import { URI } from '../../../../base/common/uri.js';
import { createDiffEditorInput } from '../../../common/editor/diffEditorInput.js';

registerWorkbenchContribution('workbench.contrib.workingCopyHistoryTracker', WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(WorkingCopyHistoryTracker));
registerWorkbenchContribution(LocalHistoryTimeline.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(LocalHistoryTimeline));

registerAction2(class OpenLocalHistoryAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.localHistory.open', title: localize2('localHistory.open', 'Local History: Open Entry'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, resource?: unknown, entryId?: unknown): Promise<void> {
		const editors = accessor.get(IEditorService);
		if (resource !== undefined && (!URI.isUri(resource) || typeof entryId !== 'string')) throw new TypeError(localize('timeline.localHistory.invalidEntry', 'Local history entry requires a resource and entry ID.'));
		const input: IResourceEditorInput | undefined = resource instanceof URI ? { resource } : editors.activeEditor;
		if (!input) return;
		const entries = await accessor.get(IWorkingCopyHistoryService).getEntries(input.resource, CancellationToken.None);
		if (typeof entryId === 'string') {
			const entry = entries.find(candidate => candidate.id === entryId);
			if (entry) await editors.openEditor(createDiffEditorInput({ resource: entry.location, readOnly: true }, input, localize('timeline.localHistory.compareLabel', '{0} (Local History)', entry.workingCopy.name)), { pinned: true });
			return;
		}
		using lifetime = new DisposableStore();
		type HistoryItem = IQuickPickItem & { readonly entry?: IWorkingCopyHistoryEntry; };
		const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<HistoryItem>());
		picker.items = entries.length ? entries.map(entry => ({ label: new Date(entry.timestamp).toLocaleString(), description: entry.workingCopy.name, entry })) : [{ label: localize('localHistory.empty', 'No local history entries for this file') }];
		picker.ariaLabel = localize('localHistory.select', 'Select a saved version to open');
		picker.placeholder = picker.ariaLabel;
		const selected = await new Promise<IWorkingCopyHistoryEntry | undefined>(resolve => {
			lifetime.add(picker.onDidAccept(item => resolve(item.entry)));
			lifetime.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
		picker.hide();
		if (selected) {
			const content = await accessor.get(IFileService).readFile(selected.location);
			await editors.openEditor({ resource: selected.location, initialText: content.content, readOnly: true, languageId: input.languageId ?? 'plaintext', label: localize('localHistory.entryLabel', '{0} — {1}', selected.workingCopy.name, new Date(selected.timestamp).toLocaleString()) }, { pinned: true });
		}
	}
});
