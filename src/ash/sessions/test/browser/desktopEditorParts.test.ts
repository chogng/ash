import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { browserEnvironment } from '../../../editor/test/browser/testEditorDom.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { EditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { TerminalEditorInput } from '../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { EditorInputSerializerRegistry } from '../../../workbench/services/editor/common/editorInputSerializer.js';
import { createTestEditorServices } from '../../../workbench/test/common/testEditorServices.js';
import { createDesktopEditorTestServices } from './desktopEditorTestServices.js';

function fixture() {
	const resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, undefined, browserEnvironment.window.document));
	const registry = resources.add(new EditorPaneRegistry());
	for (const id of ['test.tool', TerminalEditorInput.ID]) {
		resources.add(registry.registerEditorPane({
			id, name: 'Tool fixture', canOpen: () => 1,
			create: () => new class extends EditorPane {
				readonly id = id;
				async setInput(): Promise<void> { }
				clearInput(): void { }
				layout(): void { }
				focus(): void { }
			}(id, services.get(IThemeService), services.get(IStorageService)),
		}));
	}
	const inputSerializers = new EditorInputSerializerRegistry();
	for (const [scheme, typeId] of [
		['ash-browser', 'workbench.editorInput.browser'],
		['ash-session-changes', 'sessions.editorInput.changes'],
		['vscode-terminal', TerminalEditorInput.ID],
	]) {
		resources.add(inputSerializers.register({
			typeId: typeId!, canSerialize: input => input.resource.scheme === scheme,
			serialize: input => input.resource.toString(),
			deserialize: value => scheme === 'vscode-terminal' ? new TerminalEditorInput(URI.parse(value as string)) : { resource: URI.parse(value as string) },
		}));
	}
	const hosts = resources.add(createDesktopEditorTestServices(services, { registry, inputSerializers }, browserEnvironment.window.document));
	return Object.assign(resources, { editor: hosts.editor, files: hosts.files, tools: hosts.tools, area: hosts.area });
}

suite('Desktop tool EditorParts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('splitting Files creates a local group without changing other tool hosts', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const files = hosts.editor.activeGroup;
		await hosts.editor.openEditor({ resource: URI.parse('ash-browser:/fixture') }, { pinned: true });
		const browser = hosts.editor.activeGroup;
		const pane = browser.activePane;
		const split = hosts.editor.addGroup(files.id, Direction.Down);
		await hosts.editor.openEditor({ resource: URI.file('/fixture/b.txt') }, { pinned: true }, { groupId: split.id });
		assert.equal(hosts.editor.parts.length, 5);
		assert.equal(hosts.editor.getEditorState().groups.length, hosts.editor.groups.length);
		assert.deepEqual(hosts.files.fileGroups.map(group => group.id), [files.id, split.id]);
		assert.equal(hosts.tools.get('browser')!.groups.length, 1);
		assert.equal(browser.activePane, pane);
		hosts.editor.hideTool(split.id);
		assert.ok(hosts.files.fileGroups.every(group => !hosts.editor.isGroupVisible(group.id)));
		assert.equal(hosts.editor.isGroupVisible(browser.id), true);
	});

	test('round-trips Part and group geometry with globally unique restored identities', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const file = hosts.editor.activeGroup;
		const split = hosts.editor.addGroup(file.id, Direction.Down);
		await hosts.editor.openEditor({ resource: URI.file('/fixture/b.txt') }, { pinned: true }, { groupId: split.id });
		await hosts.editor.openEditor({ resource: URI.parse('ash-browser:/fixture') }, { pinned: true });
		const browser = hosts.editor.activeGroup;
		hosts.area.moveTool('browser', 'files', Direction.Right);
		hosts.editor.setGroupVisible(browser.id, false);
		const saved = hosts.editor.saveWorkingSet('session:a');
		assert.equal(saved.groups.flatMap(group => group.editors).length, 3);
		assert.ok(saved.toolParts!.parts.files.groups.length === 2);
		assert.ok(!('editors' in saved.toolParts!.parts.files));
		await hosts.editor.applyWorkingSet(saved);
		const ids = hosts.editor.groups.map(group => group.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(hosts.editor.groups.some(group => group.id === hosts.editor.pageGroupId));
		assert.equal(hosts.files.isGroupVisible(hosts.editor.pageGroupId), false);
		assert.equal(hosts.files.fileGroups.length, 2);
		assert.equal(hosts.tools.get('browser')!.activeInput?.resource.toString(), 'ash-browser:/fixture');
		assert.equal(hosts.tools.get('browser')!.isGroupVisible(hosts.tools.get('browser')!.activeGroup.id), false);
		assert.deepEqual(hosts.area.saveLayout(), saved.toolParts!.layout);
	});

	test('restores tool layouts saved before the Chat workspace was added', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const saved = hosts.editor.saveWorkingSet('before-side-chat');
		const { chat, ...parts } = saved.toolParts!.parts;
		const layout = saved.toolParts!.layout;
		assert.ok(layout.type === 'branch');
		const children = layout.children.filter(node => node.type !== 'leaf' || node.data !== 'chat');
		assert.equal(children.length, layout.children.length - 1);
		const legacy = {
			...saved, groups: saved.groups.filter(group => !chat.groups.includes(group.id!)), toolParts: {
				version: 1, parts, layout: children.length === 1 ? children[0] : { ...layout, children },
			}
		};
		await hosts.editor.applyWorkingSet(legacy);
		assert.equal(hosts.editor.activeGroup.activeInput?.resource.toString(), 'file:///fixture/a.txt');
		assert.ok(hosts.tools.get('chat')!.groups.every(group => !hosts.editor.isGroupVisible(group.id)));
		assert.deepEqual(hosts.area.saveLayout(), layout);
	});

	test('migrates a legacy mixed group to separate hosts while retaining all tabs', async () => {
		using hosts = fixture();
		await hosts.editor.applyWorkingSet({
			id: 'legacy', activeGroupIndex: 0, groups: [{
				id: 1, size: 1, activeEditorIndex: 1, editors: [
					{ input: { typeId: 'workbench.editorInput.resource', value: { resource: 'file:///fixture/a.txt' } }, preview: false },
					{ input: { typeId: 'workbench.editorInput.browser', value: 'ash-browser:/fixture' }, preview: false },
					{ input: { typeId: TerminalEditorInput.ID, value: 'vscode-terminal:/fixture/1' }, preview: false },
				],
			}],
		});
		assert.equal(hosts.files.fileGroups.flatMap(group => group.inputs).length, 1);
		assert.equal(hosts.tools.get('browser')!.activeInput?.resource.scheme, 'ash-browser');
		assert.equal(hosts.editor.activePart, hosts.tools.get('browser'));
		assert.ok(hosts.tools.get('terminal')!.activeInput instanceof TerminalEditorInput);
		assert.equal(new Set(hosts.editor.groups.map(group => group.id)).size, hosts.editor.groups.length);
	});

	test('rejects duplicate Part membership before replacing live panes', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const pane = hosts.editor.activePane;
		const saved = hosts.editor.saveWorkingSet('session:a');
		const invalid = structuredClone(saved);
		(invalid.toolParts!.parts.browser.groups as number[]).push(invalid.toolParts!.parts.files.groups[0]!);
		await assert.rejects(hosts.editor.applyWorkingSet(invalid), /Invalid tool editor group identity/);
		assert.equal(hosts.editor.activePane, pane);
	});

	test('migrates legacy group identities and vertical tool geometry together', async () => {
		using hosts = fixture();
		await hosts.editor.applyWorkingSet({
			id: 'legacy-geometry', activeGroupIndex: 1,
			groups: [
				{ id: 'files', size: 2, activeEditorIndex: 0, editors: [{ input: { typeId: 'workbench.editorInput.resource', value: { resource: 'file:///fixture/a.txt' } }, preview: false }] },
				{ id: 'browser', size: 1, activeEditorIndex: 0, editors: [{ input: { typeId: 'workbench.editorInput.browser', value: 'ash-browser:/fixture' }, preview: false }] },
			],
			layout: {
				type: 'branch', orientation: 0, size: 900, priority: 0, children: [
					{ type: 'leaf', data: { groupId: 'files' }, size: 600, priority: 0, visible: true },
					{ type: 'leaf', data: { groupId: 'browser' }, size: 300, priority: 0, visible: true },
				]
			},
		} as unknown as import('../../../workbench/services/editor/common/editorWorkingSet.js').EditorWorkingSet);
		const layout = hosts.area.saveLayout();
		const leaves = new Map<string, number>();
		let vertical = false;
		const visit = (node: typeof layout): void => {
			if (node.type === 'leaf') leaves.set(node.data as string, node.size);
			else {
				if (node.orientation === 0) vertical = true;
				node.children.forEach(visit);
			}
		};
		visit(layout);
		assert.equal(vertical, true);
		assert.ok(leaves.get('files')! > leaves.get('browser')!);
		assert.equal(hosts.editor.activePart, hosts.tools.get('browser'));
	});

	test('validates every saved Part before changing an earlier Part', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const pane = hosts.files.activePane;
		await hosts.editor.openEditor({ resource: URI.parse('ash-browser:/fixture') }, { pinned: true });
		const saved = structuredClone(hosts.editor.saveWorkingSet('invalid-later-part'));
		const entry = saved.groups.find(group => group.editors.some(editor => editor.input.typeId === 'workbench.editorInput.browser'))!.editors[0]!;
		(entry as unknown as Record<string, unknown>).preview = 'invalid';
		await assert.rejects(hosts.editor.applyWorkingSet(saved), /Invalid editor working set entry/);
		assert.equal(hosts.files.activePane, pane);
	});
});
