import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CanvasInput, type ICanvasService } from '../../../../../workbench/contrib/canvases/common/canvas.js';
import { SessionCanvasSerializer } from '../../electron-browser/sessionCanvasSerializer.js';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorPaneRegistry } from '../../../../../workbench/browser/editor.js';
import { EditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { EditorPane, EditorPaneMatch } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { BrowserEditorService } from '../../../../../workbench/services/editor/browser/browserEditorService.js';
import { EditorInputSerializerRegistry } from '../../../../../workbench/services/editor/common/editorInputSerializer.js';
import { createTestEditorServices } from '../../../../../workbench/test/common/testEditorServices.js';

suite('Session Canvas persistence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('only admitted live identities round-trip and cold restoration cannot recreate a source', () => {
		const owner = { providerId: 'local-agent-host', session: URI.parse('ash-session:/source'), chat: URI.parse('ash-thread:/source') };
		using input = new CanvasInput({ ...owner, canvas: URI.parse('agent-host-canvas:/page') }, { resource: URI.parse('agent-host-canvas:/page'), instanceId: 'board', title: 'Board', source: URI.parse('https://example.test/private?token=secret') }, {} as IEditorGroupsService);
		let admitted = false;
		const serializer = new SessionCanvasSerializer({ restoreCanvasInput: id => admitted && id === input.serializationId ? input : undefined } as ICanvasService);
		assert.equal(serializer.canSerialize(input), true, 'intercept unadmitted inputs before the generic URI serializer');
		assert.equal(serializer.serialize(input), null);
		admitted = true;
		const value = serializer.serialize(input);
		assert.deepEqual(value, { version: 1, id: input.serializationId });
		assert.equal(JSON.stringify(value).includes('secret'), false);
		assert.equal(serializer.deserialize(value), input);
		admitted = false;
		assert.throws(() => serializer.deserialize(value));
	});

	test('invalid versions, identities and extra fields are rejected before admission lookup', () => {
		let lookups = 0;
		const serializer = new SessionCanvasSerializer({ restoreCanvasInput: () => { lookups++; return undefined; } } as unknown as ICanvasService);
		const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		for (const value of [undefined, null, [], id, { version: 2, id }, { version: 1, id: 'canvas:/page' }, { version: 1, id, source: 'https://example.test' }]) { assert.throws(() => serializer.deserialize(value)); }
		assert.equal(lookups, 0);
	});

	test('A → B → A restores the same live Canvas alongside the other editor and respects dismissal', async () => {
		const document = browserEnvironment.window.document;
		using services = createTestEditorServices(undefined, undefined, document);
		using panes = new EditorPaneRegistry();
		using registrations = new DisposableStore();
		for (const [id, scheme] of [[CanvasInput.EDITOR_ID, 'session-canvas'], ['test.file', 'file']] as const) {
			registrations.add(panes.registerEditorPane({
				id, name: id,
				canOpen: input => input.resource.scheme === scheme ? EditorPaneMatch.Default : EditorPaneMatch.None,
				create: () => new WorkingSetTestPane(id, services.get(IThemeService), services.get(IStorageService)),
			}));
		}
		const serializers = new EditorInputSerializerRegistry();
		using part = services.createInstance(EditorPart, document.createElement('div'), { registry: panes, inputSerializers: serializers });
		using groups = new BrowserEditorService(part);
		part.layout({ width: 900, height: 600 });
		const resource = URI.parse('agent-host-canvas:/board');
		using canvas = new CanvasInput({
			providerId: 'local-agent-host', session: URI.parse('ash-session:/a'), chat: URI.parse('ash-thread:/a'), canvas: resource,
		}, { resource, instanceId: 'board', title: 'Board', source: URI.parse('https://example.test/board') }, groups);
		using serializer = serializers.register(new SessionCanvasSerializer({
			restoreCanvasInput: id => id === canvas.serializationId ? canvas : undefined,
		} as ICanvasService));
		const fileA = { resource: URI.file('/a.txt') };
		const fileB = { resource: URI.file('/b.txt') };
		await part.openEditor(fileB, { pinned: true });
		const savedB = part.saveWorkingSet('b');
		await part.applyWorkingSet('empty');
		await part.openEditor(fileA, { pinned: true });
		await part.openEditor(canvas, { pinned: true });
		const savedA = part.saveWorkingSet('a');

		await part.applyWorkingSet(savedB, { preserveFocus: true });
		assert.deepEqual(part.activeGroup.inputs.map(input => input.resource.path), [fileB.resource.path]);
		await part.applyWorkingSet(savedA, { preserveFocus: true });
		assert.deepEqual(part.activeGroup.inputs.map(input => input.resource.path), [fileA.resource.path, canvas.resource.path]);
		assert.equal(part.activeInput, canvas, 'Restoration must reuse the live input');

		await part.closeEditor(canvas);
		const dismissedA = part.saveWorkingSet('a');
		await part.applyWorkingSet(savedB, { preserveFocus: true });
		await part.applyWorkingSet(dismissedA, { preserveFocus: true });
		assert.deepEqual(part.activeGroup.inputs.map(input => input.resource.path), [fileA.resource.path]);
	});
});

class WorkingSetTestPane extends EditorPane {
	constructor(readonly id: string, theme: IThemeService, storage: IStorageService) { super(id, theme, storage); }
	async setInput(): Promise<void> { }
	clearInput(): void { }
	layout(): void { }
	focus(): void { }
}
