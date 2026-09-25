import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IResourceIconRenderer } from '../../../../browser/labels.js';
import type { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { IEditorGroup } from '../../../../browser/parts/editor/editorGroup.js';
import type { EditorInstanceState, EditorPartChangeEvent } from '../../../../services/editor/common/editorState.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { NumberBadge, type IActivityService } from '../../../../services/activity/common/activity.js';
import type { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { DirtyFilesIndicator } from '../../common/dirtyFilesIndicator.js';

test('Open Editors follows editor groups, dirty state, activation, and close', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(browser);
	using changes = new Emitter<EditorPartChangeEvent>();
	using contextKeys = new ContextKeyService();
	using configuration = new InMemoryConfigurationService();
	const first = editor('group-a', 'first', 'first.ts', false);
	const second = editor('group-b', 'second', 'second.ts', false);
	let groups = [group('group-a', [first])];
	let activated: string | undefined;
	let closed: string | undefined;
	const editorPart = {
		get groups() { return groups; },
		get activeGroup() { return groups[0]!; },
		onDidChangeEditors: changes.event,
		activateEditorIdentifier: (entry: EditorInstanceState) => { activated = entry.instanceId; },
		closeEditorIdentifier: async (entry: EditorInstanceState) => {
			closed = entry.instanceId;
			groups = groups.map(candidate => group(candidate.id, candidate.editors.filter(editor => editor.instanceId !== entry.instanceId)));
			changes.fire({ kind: 'groupChanged', groupId: entry.groupId, event: { kind: 'editorClosed', editor: entry, reason: 'close' } });
			return true;
		},
	} as unknown as IEditorPart;
	const accessibility: IAccessibleViewService = {
		show: () => false,
		getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.',
		dispose() {},
		[Symbol.dispose]() {},
	};
	const icons: IResourceIconRenderer = { onDidChangeResourceIcons: Event.None, renderFileIcon() {} };

	try {
		const { OpenEditorsView } = await import('../../browser/views/openEditorsView.js');
		using view = new OpenEditorsView(browser.window.document.body, { id: OpenEditorsView.ID, title: 'Open Editors' }, editorPart, contextKeys, accessibility, configuration, icons);
		browser.window.document.body.append(view.element);
		assert.match(view.getAccessibleContent(), /first\.ts/);
		const dirtyFirst = { ...first, isDirty: true };
		groups = [group('group-a', [dirtyFirst]), group('group-b', [second])];
		changes.fire({ kind: 'groupAdded', group: { id: 'group-b', editors: [second], activeEditorInstanceId: second.instanceId } });
		assert.deepEqual([...view.element.querySelectorAll('.ash-open-editors-row')].map(row => row.textContent?.trim()), [
			'Group 1', 'first.tsUnsaved changes', 'Group 2', 'second.ts',
		]);
		assert.match(view.getAccessibleContent(), /first\.ts, Unsaved changes/);
		const firstRow = [...view.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => row.textContent?.includes('first.ts'));
		assert.ok(firstRow);
		firstRow.click();
		assert.equal(activated, 'first');
		firstRow.querySelector<HTMLButtonElement>('.ash-open-editors-close')?.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(closed, 'first');
		assert.equal(view.element.querySelectorAll('.ash-open-editors-row').length, 3);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test('Dirty file activity follows working copy registration and dirty state', () => {
	using dirtyChanges = new Emitter<void>();
	using workingCopies = new BrowserWorkingCopyService();
	let isDirty = true;
	let activeBadge: NumberBadge | undefined;
	const activity: IActivityService = {
		showViewContainerActivity(_containerId, badge) {
			activeBadge = badge;
			return toDisposable(() => {
				if (activeBadge === badge) activeBadge = undefined;
			});
		},
	};
	using indicator = new DirtyFilesIndicator(activity, workingCopies);
	const first: IWorkingCopy = {
		resource: URI.file('/project/main.ts'),
		backupKind: 'text',
		get isDirty() { return isDirty; },
		hasExternalChange: false,
		onDidChangeDirty: dirtyChanges.event,
		onDidChangeExternalChange: Event.None,
		onDidChangeContent: Event.None,
		backup: () => '',
		restoreBackup() {},
		save: async () => {},
		saveAs: async () => {},
		revert: async () => {},
		dispose() {},
		[Symbol.dispose]() {},
	};
	using registration = workingCopies.register(first);
	assert.equal(activeBadge?.number, 1);
	assert.equal(activeBadge?.description, '1 unsaved file');
	isDirty = false;
	dirtyChanges.fire();
	assert.equal(activeBadge, undefined);
});

function editor(groupId: string, instanceId: string, label: string, isDirty: boolean): EditorInstanceState {
	return {
		groupId,
		instanceId,
		paneId: 'text',
		input: { resource: URI.parse(`file:///C:/project/${label}`), label },
		index: 0,
		isActive: true,
		isPreview: false,
		isSticky: false,
		isDirty,
		canRevert: isDirty,
		hasExternalChange: false,
	};
}

function group(id: string, editors: readonly EditorInstanceState[]): IEditorGroup {
	return { id, editors } as IEditorGroup;
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		KeyboardEvent: browser.window.KeyboardEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
	return Object.keys(globals);
}
