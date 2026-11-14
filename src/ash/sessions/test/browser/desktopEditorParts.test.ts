import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Direction, Orientation, type SerializedGridDescriptor } from '../../../base/browser/ui/grid/grid.js';
import { URI } from '../../../base/common/uri.js';
import { constObservable } from '../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { browserEnvironment } from '../../../editor/test/browser/testEditorDom.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { EditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { TerminalEditorInput } from '../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { SearchEditorID } from '../../../workbench/contrib/searchEditor/browser/constants.js';
import { EditorInputSerializerRegistry } from '../../../workbench/services/editor/common/editorInputSerializer.js';
import { IAuxiliaryWindowService } from '../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { createTestEditorServices } from '../../../workbench/test/common/testEditorServices.js';
import { createDesktopEditorTestServices } from './desktopEditorTestServices.js';
import { EditorParts } from '../../browser/parts/editorParts.js';

function fixture() {
	const resources = new DisposableStore();
	const services = resources.add(createTestEditorServices(undefined, undefined, browserEnvironment.window.document));
	const registry = resources.add(new EditorPaneRegistry());
	for (const id of ['test.tool', TerminalEditorInput.ID, SearchEditorID]) {
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
	test('retains separate Chat and Code browser groups in the existing browser Part', async () => {
		using hosts = fixture();
		const code = { resource: URI.parse('ash-browser:/code') };
		const chat = { resource: URI.parse('ash-browser:/chat') };
		await hosts.editor.openEditor(code, { pinned: true });
		const codeGroup = hosts.editor.activeGroup;
		const chatGroup = hosts.editor.createRetainedGroup('browser');
		using scope = hosts.editor.setGroupScope(id => id === chatGroup.id);
		hosts.editor.setGroupVisible(codeGroup.id, false);
		await hosts.editor.openEditor(chat, { pinned: true }, { groupId: chatGroup.id });
		assert.equal(hosts.editor.activeGroup, chatGroup);
		assert.equal(hosts.tools.get('browser')!.groups.length, 2);
		assert.deepEqual(codeGroup.inputs, [code]);
		assert.deepEqual(chatGroup.inputs, [chat]);
		assert.equal(hosts.editor.isGroupVisible(codeGroup.id), false);
		await hosts.editor.openEditor({ resource: URI.parse('ash-browser:/chat-popup') }, { pinned: true });
		assert.equal(chatGroup.inputs.length, 2);
		assert.equal(codeGroup.inputs.length, 1);
		const saved = hosts.editor.saveWorkingSet('chat-browser', hosts.editor.groups.filter(group => group !== chatGroup).map(group => group.id));
		const restored = await hosts.editor.restoreRetainedGroup('browser', saved);
		assert.notEqual(restored.id, chatGroup.id);
		assert.deepEqual(restored.inputs.map(input => input.resource.toString()), chatGroup.inputs.map(input => input.resource.toString()));
		assert.deepEqual(codeGroup.inputs, [code]);
		assert.equal(hosts.editor.isGroupVisible(restored.id), false);
	});

	test('requires the window context service before mounting any tool Parts', () => {
		using services = createTestEditorServices(undefined, undefined, browserEnvironment.window.document);
		using hosts = createDesktopEditorTestServices(services, {}, browserEnvironment.window.document);
		using incompleteServices = new InstantiationService();
		incompleteServices.registerInstance(IAuxiliaryWindowService, services.get(IAuxiliaryWindowService));
		incompleteServices.registerInstance(IAccessibilityService, services.get(IAccessibilityService));
		incompleteServices.registerInstance(IConfigurationService, services.get(IConfigurationService));
		incompleteServices.registerInstance(IStorageService, services.get(IStorageService));
		const before = hosts.area.domNode.childElementCount;
		assert.throws(() => incompleteServices.createInstance(EditorParts, hosts.area, {}, constObservable(false)), /Unknown service: contextKeyService/);
		assert.equal(hosts.area.domNode.childElementCount, before);
	});

	test('reopens a product editor in its retained group after closing the last tab', async () => {
		using hosts = fixture();
		const editor = hosts.editor;
		const groupId = editor.pageGroupId;
		const pages = editor.groups.find(group => group.id === groupId)!;
		const input = { resource: URI.parse('ash-symphony:/monitor') };
		await editor.openEditor(input, { pinned: true }, { groupId });
		assert.equal(await pages.closeEditor(input), true);
		editor.setGroupVisible(groupId, false);
		assert.equal(await editor.removeGroup(groupId), false);
		await editor.openEditor(input, { pinned: true }, { groupId });
		assert.equal(editor.activeGroup, pages);
		assert.equal(pages.activeInput, input);
	});

	test('lays out a product page flush and restores the Files card when switching back', async () => {
		using hosts = fixture();
		const { editor, files } = hosts;
		const frame = files.domNode.parentElement!;
		const workspace = frame.parentElement!;
		await editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		assert.equal(frame.style.paddingTop, '6px');
		assert.equal(workspace.style.getPropertyValue('--ash-sessions-editor-tool-inset'), '6px');

		const pageGroupId = editor.pageGroupId;
		await editor.openEditor({ resource: URI.parse('ash-chatgpt:/page') }, { pinned: true }, { groupId: pageGroupId });
		assert.equal(workspace.classList.contains('ash-product-page-host'), true);
		assert.equal(frame.style.paddingTop, '0px');
		assert.equal(frame.style.paddingLeft, '0px');
		assert.equal(workspace.style.getPropertyValue('--ash-sessions-editor-tool-inset'), '0px');

		editor.setGroupVisible(pageGroupId, false);
		assert.equal(workspace.classList.contains('ash-product-page-host'), false);
		assert.equal(frame.style.paddingTop, '6px');
		assert.equal(frame.style.paddingLeft, '6px');
		assert.equal(workspace.style.getPropertyValue('--ash-sessions-editor-tool-inset'), '6px');
	});

	test('Files side opens use the current tab group without changing other tool hosts', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const files = hosts.editor.activeGroup;
		await hosts.editor.openEditor({ resource: URI.parse('ash-browser:/fixture') }, { pinned: true });
		const browser = hosts.editor.activeGroup;
		const pane = browser.activePane;
		assert.equal(hosts.editor.addGroup(files.id, Direction.Down), files);
		await hosts.editor.splitEditors(files.id, files.inputs, Direction.Down);
		await hosts.editor.openEditor({ resource: URI.file('/fixture/b.txt') }, { pinned: true }, 'sideGroup');
		assert.equal(hosts.editor.parts.length, hosts.tools.size + 1);
		assert.equal(hosts.editor.getEditorState().groups.length, hosts.editor.groups.length);
		assert.deepEqual(hosts.files.fileGroups.map(group => group.id), [files.id]);
		assert.equal(files.inputs.length, 2);
		assert.equal(hosts.tools.get('browser')!.groups.length, 1);
		assert.equal(browser.activePane, pane);
		hosts.editor.hideTool(files.id);
		assert.ok(hosts.files.fileGroups.every(group => !hosts.editor.isGroupVisible(group.id)));
		assert.equal(hosts.editor.isGroupVisible(browser.id), true);
	});

	test('restores legacy terminal splits as tabs with the saved selection', async () => {
		using hosts = fixture();
		const { editor, area } = hosts;
		const firstInput = new TerminalEditorInput(URI.parse('vscode-terminal:/fixture/1'));
		const secondInput = new TerminalEditorInput(URI.parse('vscode-terminal:/fixture/2'));
		await editor.openEditor(firstInput, { pinned: true });
		const groupId = editor.activeGroup.id;
		await editor.openEditor(secondInput, { pinned: true });
		const saved = editor.saveWorkingSet('legacy-terminal');
		const metadata = saved.toolParts!;
		const original = saved.groups.find(group => group.id === groupId)!;
		const extraId = Math.max(...saved.groups.map(group => group.id!)) + 1;
		const [first, second] = original.editors;
		const leaf = (id: number, visible: boolean) => ({ type: 'leaf', data: { groupId: id }, visible, size: 300, priority: 0 } as const);
		const legacy = {
			...saved,
			groups: [...saved.groups.map(group => group === original ? { ...group, editors: [first!], activeEditorIndex: 0 } : group),
			{ ...original, id: extraId, editors: [second!], activeEditorIndex: 0 }],
			activeGroupIndex: saved.groups.length,
			toolParts: {
				...metadata, parts: {
					...metadata.parts, terminal: {
						groups: [groupId, extraId],
						layout: { type: 'branch', orientation: Orientation.VERTICAL, priority: 0, size: 600, children: [leaf(groupId, true), leaf(extraId, false)] },
					}
				},
			},
		} as const;
		await editor.applyWorkingSet(legacy);
		const terminal = hosts.tools.get('terminal')!;
		assert.equal(terminal.groups.length, 1);
		assert.deepEqual(terminal.activeGroup.inputs.map(input => input.resource.toString()), [firstInput.resource.toString(), secondInput.resource.toString()]);
		assert.equal(editor.activeGroup.activeInput?.resource.toString(), secondInput.resource.toString());
		assert.equal(area.isToolVisible('terminal'), true);
	});

	test('round-trips Part and group geometry with globally unique restored identities', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const file = hosts.editor.activeGroup;
		await hosts.editor.openEditor({ resource: URI.file('/fixture/b.txt') }, { pinned: true }, { groupId: file.id });
		await hosts.editor.openEditor({ resource: URI.parse('ash-browser:/fixture') }, { pinned: true });
		const browser = hosts.editor.activeGroup;
		hosts.area.moveTool('browser', 'files', Direction.Right);
		hosts.editor.setGroupVisible(browser.id, false);
		const saved = hosts.editor.saveWorkingSet('session:a');
		assert.equal(saved.groups.flatMap(group => group.editors).length, 3);
		assert.equal(saved.toolParts!.parts.files.groups.length, 1);
		assert.ok(!('editors' in saved.toolParts!.parts.files));
		await hosts.editor.applyWorkingSet(saved);
		const ids = hosts.editor.groups.map(group => group.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(hosts.editor.groups.some(group => group.id === hosts.editor.pageGroupId));
		assert.equal(hosts.files.isGroupVisible(hosts.editor.pageGroupId), false);
		assert.equal(hosts.files.fileGroups.length, 1);
		assert.equal(hosts.tools.get('browser')!.activeInput?.resource.toString(), 'ash-browser:/fixture');
		assert.equal(hosts.tools.get('browser')!.isGroupVisible(hosts.tools.get('browser')!.activeGroup.id), false);
		assert.deepEqual(hosts.area.saveLayout(), saved.toolParts!.layout);
	});

	test('restores tool layouts saved before the Chat workspace was added', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const saved = hosts.editor.saveWorkingSet('before-side-chat');
		const { chat, search, ...parts } = saved.toolParts!.parts;
		const layout = saved.toolParts!.layout;
		assert.ok(layout.type === 'branch');
		const children = layout.children.filter(node => node.type !== 'leaf' || node.data !== 'chat' && node.data !== 'search');
		assert.equal(children.length, layout.children.length - 2);
		const legacy = {
			...saved, groups: saved.groups.filter(group => !chat.groups.includes(group.id!) && !search.groups.includes(group.id!)), toolParts: {
				version: 1, parts, layout: children.length === 1 ? children[0] : { ...layout, children },
			}
		};
		await hosts.editor.applyWorkingSet(legacy);
		assert.equal(hosts.editor.activeGroup.activeInput?.resource.toString(), 'file:///fixture/a.txt');
		assert.ok(hosts.tools.get('chat')!.groups.every(group => !hosts.editor.isGroupVisible(group.id)));
		assert.deepEqual(hosts.area.saveLayout(), layout);
	});

	test('routes Search to a separate Part even when opened from a Files group', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		const filesGroup = hosts.editor.activeGroup;
		hosts.editor.toggleMaximizeTool(filesGroup.id);
		const input = { resource: URI.parse('untitled:/fixture.code-search'), editorId: SearchEditorID };
		await hosts.editor.openEditor(input, { pinned: true }, { groupId: filesGroup.id });
		const searchPart = hosts.tools.get('search')!;
		assert.equal(hosts.editor.activeGroup, searchPart.activeGroup);
		assert.deepEqual(filesGroup.inputs.map(entry => entry.resource.path), ['/fixture/a.txt']);
		assert.equal(searchPart.activeInput, input);
		assert.equal(hosts.area.isToolVisible('search'), true);
		assert.equal(hosts.area.isToolVisible('files'), true);
	});

	test('reveals Files when opening a result in the foreground from maximized Search', async () => {
		using hosts = fixture();
		const { editor, area, files } = hosts;
		const result = { resource: URI.file('/fixture/result.txt') };
		await editor.openEditor(result, { pinned: true });
		const search = { resource: URI.parse('untitled:/fixture.code-search'), editorId: SearchEditorID };
		await editor.openEditor(search, { pinned: true });
		const searchGroup = editor.activeGroup;
		editor.toggleMaximizeTool();
		assert.equal(area.isToolVisible('search'), true);
		assert.equal(area.isToolVisible('files'), false);

		await editor.openEditor(result, { pinned: true, preserveFocus: true });
		assert.equal(area.isToolVisible('files'), false);
		assert.equal(editor.activeGroup, searchGroup);

		const pane = await editor.openEditor(result, { pinned: true });
		assert.equal(area.isToolVisible('files'), true);
		assert.equal(area.isToolVisible('search'), true);
		assert.equal(editor.activeGroup, files.activeGroup);
		assert.equal(editor.activeGroup.activePane, pane);
		assert.equal(editor.activeInput?.resource.toString(), result.resource.toString());
	});

	test('moves a saved Search tab out of Files while restoring the original active tab', async () => {
		using hosts = fixture();
		const file = URI.file('/fixture/a.txt');
		const search = { resource: URI.parse('untitled:/fixture.code-search'), editorId: SearchEditorID, initialText: 'saved search query' };
		await hosts.editor.openEditor({ resource: file }, { pinned: true });
		const fileGroup = hosts.editor.activeGroup;
		await hosts.files.openEditor(search, { pinned: true }, { groupId: fileGroup.id });
		const saved = hosts.editor.saveWorkingSet('before-search-tool');
		const { search: emptySearch, ...parts } = saved.toolParts!.parts;
		const layout = saved.toolParts!.layout;
		assert.ok(layout.type === 'branch');
		const children = layout.children.filter(node => node.type !== 'leaf' || node.data !== 'search');
		const legacy = {
			...saved, groups: saved.groups.filter(group => !emptySearch.groups.includes(group.id!)),
			toolParts: { ...saved.toolParts, parts, layout: { ...layout, children } },
		};
		await hosts.editor.applyWorkingSet(legacy);
		const searchPart = hosts.tools.get('search')!;
		assert.equal(hosts.editor.activeGroup, searchPart.activeGroup);
		assert.equal(searchPart.activeInput?.resource.toString(), search.resource.toString());
		assert.equal(searchPart.activeInput?.initialText, search.initialText);
		assert.equal(hosts.files.fileGroups.flatMap(group => group.inputs).some(input => input.resource.toString() === file.toString()), true);
		assert.equal(hosts.files.fileGroups.flatMap(group => group.inputs).some(input => input.resource.toString() === search.resource.toString()), false);
	});

	test('repairs a misplaced Search tab when the working set already contains a hidden Search group', async () => {
		using hosts = fixture();
		const file = { resource: URI.file('/fixture/a.txt') };
		const misplaced = { resource: URI.file('/fixture/old.code-search') };
		const existing = { resource: URI.parse('untitled:/current.code-search'), editorId: SearchEditorID };
		await hosts.editor.openEditor(existing, { pinned: true });
		const searchPart = hosts.tools.get('search')!;
		hosts.editor.setGroupVisible(searchPart.activeGroup.id, false);
		await hosts.editor.openEditor(file, { pinned: true });
		const filesGroup = hosts.editor.activeGroup;
		await hosts.files.openEditor(misplaced, { pinned: true }, { groupId: filesGroup.id });
		const saved = hosts.editor.saveWorkingSet('mixed-search');

		await hosts.editor.applyWorkingSet(saved);

		assert.equal(hosts.editor.activeGroup, searchPart.activeGroup);
		assert.equal(searchPart.activeInput?.resource.toString(), misplaced.resource.toString());
		assert.deepEqual(searchPart.activeGroup.inputs.map(input => input.resource.toString()), [existing.resource.toString(), misplaced.resource.toString()]);
		assert.deepEqual(hosts.files.fileGroups.flatMap(group => group.inputs.map(input => input.resource.toString())), [file.resource.toString()]);
		assert.equal(hosts.area.isToolVisible('search'), true);
	});

	test('restacks an older Files and Changes pair and preserves a recorded manual split', async () => {
		using hosts = fixture();
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		await hosts.editor.openEditor({ resource: URI.parse('ash-session-changes:/fixture') }, { pinned: true });
		hosts.area.moveTool('changes', 'files', Direction.Right);
		const saved = hosts.editor.saveWorkingSet('files-and-changes');
		const split = (node: SerializedGridDescriptor): Orientation | undefined => {
			if (node.type === 'leaf') return undefined;
			const hasTool = (child: SerializedGridDescriptor, name: string): boolean =>
				child.type === 'leaf' ? child.data === name : child.children.some(nested => hasTool(nested, name));
			const shared = node.children.find(child => hasTool(child, 'files') && hasTool(child, 'changes'));
			return shared ? split(shared) : node.orientation;
		};
		assert.equal(split(saved.toolParts!.layout), Orientation.HORIZONTAL);
		await hosts.editor.applyWorkingSet(saved);
		assert.equal(split(hosts.area.saveLayout()), Orientation.HORIZONTAL);
		const older = { ...saved, toolParts: { ...saved.toolParts!, manuallyArranged: undefined } };
		await hosts.editor.applyWorkingSet(older);
		assert.equal(split(hosts.area.saveLayout()), Orientation.VERTICAL);
		assert.equal(hosts.editor.activeGroup.activeInput?.resource.toString(), 'ash-session-changes:/fixture');
	});

	test('reopens Preview by a surviving neighbor and falls back after that neighbor closes', async () => {
		using hosts = fixture();
		const preview = { resource: URI.parse('ash-browser:/fixture') };
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		await hosts.editor.openEditor(preview, { pinned: true });
		await hosts.editor.openEditor({ resource: URI.parse('ash-session-changes:/fixture') }, { pinned: true });
		const visible = (node: SerializedGridDescriptor): unknown => {
			if (node.type === 'leaf') return node.visible ? node.data : undefined;
			const children = node.children.map(visible).filter(child => child !== undefined);
			return children.length > 1 ? [node.orientation, ...children] : children[0];
		};
		const togglePreview = () => hosts.editor.toggleToolEditors(input => input.resource.scheme === 'ash-browser');
		await togglePreview();
		const saved = hosts.editor.saveWorkingSet('closed-preview');
		assert.deepEqual(saved.toolParts?.closedSlots?.browser?.anchors, ['files']);
		await hosts.editor.applyWorkingSet(saved);
		await togglePreview();
		assert.deepEqual(visible(hosts.area.saveLayout()), [Orientation.HORIZONTAL, [Orientation.VERTICAL, 'files', 'browser'], 'changes']);
		await togglePreview();
		hosts.area.moveTool('changes', 'files', Direction.Down);
		assert.deepEqual(visible(hosts.area.saveLayout()), [Orientation.VERTICAL, 'files', 'changes']);
		await togglePreview();
		assert.deepEqual(visible(hosts.area.saveLayout()), [Orientation.VERTICAL, 'files', 'browser', 'changes']);
		await hosts.editor.applyWorkingSet(saved);
		await hosts.editor.toggleFileEditors();
		await togglePreview();
		assert.deepEqual(visible(hosts.area.saveLayout()), [Orientation.VERTICAL, 'changes', 'browser']);
	});

	test('allocates new tool columns against the conversation and restores their width', async () => {
		using hosts = fixture();
		hosts.area.layout({ width: 1800, height: 900 });
		const width = () => hosts.area.getPreferredWidth(3000, 100, 600);
		const changes = { resource: URI.parse('ash-session-changes:/fixture') };
		const toggleChanges = () => hosts.editor.toggleToolEditors(input => input.resource.scheme === changes.resource.scheme);
		await hosts.editor.openEditor({ resource: URI.file('/fixture/a.txt') }, { pinned: true });
		assert.equal(width(), 1800);
		await hosts.editor.openEditor({ resource: URI.parse('ash-browser:/fixture') }, { pinned: true });
		assert.equal(width(), 1800);
		await hosts.editor.openEditor(changes, { pinned: true });
		assert.equal(width(), 2000);

		await toggleChanges();
		assert.equal(width(), 1800);
		const saved = hosts.editor.saveWorkingSet('two-tools');
		hosts.area.rememberWidth(0.5);
		assert.equal(width(), 1500);
		await hosts.editor.applyWorkingSet(saved);
		assert.equal(width(), 1800);
		await toggleChanges();
		assert.equal(width(), 2000);
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

	test('restores a working set with a hidden Files group whose legacy size is zero', async () => {
		using source = fixture();
		const files = source.files.fileGroups[0]!;
		source.editor.setGroupVisible(files.id, false);
		const browserResource = URI.parse('ash-browser:/fixture');
		await source.editor.openEditor({ resource: browserResource }, { pinned: true });
		const saved = source.editor.saveWorkingSet('hidden-files');
		const snapshot = { ...saved, groups: saved.groups.map(group => group.id === files.id ? { ...group, size: 0 } : group) };

		using target = fixture();
		await target.editor.applyWorkingSet(snapshot);

		assert.deepEqual(target.files.fileGroups.map(group => ({ visible: target.files.isGroupVisible(group.id), tabs: group.inputs.length })), [{ visible: false, tabs: 0 }]);
		assert.equal(target.editor.activePart, target.tools.get('browser'));
		assert.equal(target.editor.activeGroup.activeInput?.resource.toString(), browserResource.toString());
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
