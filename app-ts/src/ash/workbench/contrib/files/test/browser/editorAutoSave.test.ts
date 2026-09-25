import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { EditorAutoSave } from '../../../../browser/parts/editor/editorAutoSave.js';
import { EditorAutoSaveConfiguration, EditorAutoSaveDelayConfiguration } from '../../../../services/editor/common/editorConfiguration.js';
import { BrowserWorkingCopyService } from '../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import type { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopyService.js';

test('File auto save writes a dirty working copy after the configured delay', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
	using configuration = new InMemoryConfigurationService();
	using workingCopies = new BrowserWorkingCopyService();
	using dirtyChanges = new Emitter<void>();
	using contentChanges = new Emitter<void>();
	let dirty = false;
	let saves = 0;
	const copy: IWorkingCopy = {
		resource: URI.file('/project/main.ts'),
		backupKind: 'text',
		get isDirty() { return dirty; },
		hasExternalChange: false,
		onDidChangeDirty: dirtyChanges.event,
		onDidChangeExternalChange: Event.None,
		onDidChangeContent: contentChanges.event,
		backup: () => 'edited',
		restoreBackup() {},
		async save() {
			saves++;
			dirty = false;
			dirtyChanges.fire();
		},
		saveAs: async () => {},
		revert: async () => {},
		dispose() {},
		[Symbol.dispose]() {},
	};
	const editorPart = {
		domNode: browser.window.document.body,
		activePane: undefined,
		onDidChangeEditors: Event.None,
	} as unknown as IEditorPart;
	try {
		await configuration.updateValue(EditorAutoSaveDelayConfiguration, 100);
		await configuration.updateValue(EditorAutoSaveConfiguration, 'afterDelay');
		using autoSave = new EditorAutoSave(editorPart, workingCopies, configuration);
		using registration = workingCopies.register(copy);
		dirty = true;
		dirtyChanges.fire();
		contentChanges.fire();
		await waitFor(() => saves === 1);
		assert.equal(dirty, false);
	} finally {
		browser.window.close();
	}
});

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (condition()) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail('File was not auto saved');
}
