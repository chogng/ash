import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createTestFileService, registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { BinaryEditorTestFileSystemProvider } from '../../../../test/common/binaryEditorTestServices.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { Event } from '../../../../../base/common/event.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { BinaryFileEditor } from '../../browser/editors/binaryFileEditor.js';
import { CODE_EDITOR_ID } from '../../../../common/editor/codeEditorId.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { IEditorService, type EditorOpenOptions } from '../../../../services/editor/common/editorService.js';

test('Binary file editor opens a bounded read-only text preview', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const resource = URI.file('C:\\project\\sample.bin');
	let opened: IResourceEditorInput | undefined;
	let openOptions: EditorOpenOptions | undefined;
	const dialogs: IDialogService = {
		onWillShowDialog: Event.None,
		onDidShowDialog: Event.None,
		about: async () => { throw new Error('Unexpected about dialog'); },
		showMessage: async () => { },
		info: async () => { },
		warn: async () => { },
		error: async () => { },
		confirm: async () => { throw new Error('Unexpected confirm'); },
		prompt: async () => { throw new Error('Unexpected prompt'); },
		input: async () => { throw new Error('Unexpected input'); },
	};
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(new BinaryEditorTestFileSystemProvider(new Uint8Array([0x48, 0x69, 0x00, 0xff]))));
	registerTestComponentServices(services, dom.window.document);
	services.registerInstance(IEditorService, {
		...emptyEditorServiceState,
		openEditor: async (input, options) => { opened = input; openOptions = options; },
		focusActiveEditor: () => { },
	});
	services.registerInstance(IDialogService, dialogs);
	const pane = services.createInstance(BinaryFileEditor);
	pane.create(dom.window.document.body);
	await pane.setInput({ resource }, new AbortController().signal);
	dom.window.document.querySelector<HTMLButtonElement>('.ash-binary-open-as-text')!.click();
	await waitFor(() => opened !== undefined);
	assert.equal(opened?.resource.toString(), resource.toString());
	assert.equal(opened?.readOnly, true);
	assert.equal(opened?.initialText, 'Hi\u0000�');
	assert.equal(openOptions?.preferredEditorId, CODE_EDITOR_ID);
	pane.dispose();
	dom.window.close();
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) { return; }
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for binary text preview');
}
