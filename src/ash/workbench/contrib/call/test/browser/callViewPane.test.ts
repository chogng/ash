import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import type { CallDocument, CallState, ICallService } from '../../../../../platform/call/common/callService.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import type { IEditorPane, IResourceEditorInput } from '../../../../common/editor.js';
import { DocumentTypes } from '../../../../services/documentEditor/common/documentTypes.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { CallViewPane } from '../../browser/callViewPane.js';

const shared: CallDocument = {
	serverUrl: 'https://documents.example',
	roomId: 'document-1',
	schemaId: 'stanza-document-v1',
	contentType: 'application/test-document',
	title: 'Shared notes',
};

function fixture() {
	const browser = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
	const descriptors = new Map<string, PropertyDescriptor | undefined>();
	for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
		descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, value: browser.window[name as 'window'] });
	}
	const changed = new Emitter<void>();
	let state: CallState = {
		connection: 'connected',
		muted: true,
		deafened: false,
		microphoneAllowed: true,
		canManage: true,
		screenSharing: false,
		screenAllowed: true,
		participants: [],
		documents: [shared],
		error: null,
	};
	const linked: CallDocument[] = [];
	const joined: CallDocument[] = [];
	const opened: IResourceEditorInput[] = [];
	const original = { resource: URI.file('/local-draft.ashdoc'), label: 'Local draft' };
	const originalCopy = { resource: original.resource, isDirty: true };
	let active: IResourceEditorInput = original;
	let panes: readonly IEditorPane[] = [
		{
			workingCopy: originalCopy,
			getCollaborationDocument: () => shared,
			joinCollaborationDocument: async () => {
				throw new Error('Must not join into a local dirty file');
			},
		} as unknown as IEditorPane,
	];
	const calls: ICallService = {
		onDidChange: changed.event,
		onDidChangeScreens: Event.None,
		screens: [],
		screenError: undefined,
		get state() {
			return state;
		},
		start: async () => {},
		mute: async () => {},
		deafen: async () => {},
		selectDevice: async () => {},
		screenSources: async () => [],
		shareScreen: async () => {},
		stopScreenShare: async () => {},
		invite: async () => ({ url: '', credential: '' }),
		leave: async () => {},
		end: async () => {},
		shareDocument: async document => {
			linked.push(document);
		},
		unshareDocument: async () => {
			state = { ...state, documents: [] };
			changed.fire();
		},
	};
	const editors: IEditorService = {
		...emptyEditorServiceState,
		get activeEditor() {
			return active;
		},
		get visibleEditorPanes() {
			return panes;
		},
		openEditor: async input => {
			opened.push(input);
			active = input;
			panes = [
				{
					workingCopy: { resource: input.resource },
					getCollaborationDocument: () => undefined,
					joinCollaborationDocument: async (document: CallDocument) => {
						joined.push(document);
					},
				} as unknown as IEditorPane,
			];
		},
		focusActiveEditor: () => {},
	};
	const registration = DocumentTypes.registerTypes();
	registration.replace([{ id: 'test', contentType: shared.contentType, extensions: ['.ashdoc'] }]);
	const configuration = new TestConfigurationService();
	const view = new CallViewPane(
		browser.window.document.body,
		{ id: 'calls', title: 'Calls' },
		calls,
		configuration,
		editors,
	);
	return {
		browser,
		view,
		linked,
		joined,
		opened,
		originalCopy,
		setOwner(owner: boolean) {
			state = { ...state, canManage: owner };
			changed.fire();
		},
		dispose() {
			view.dispose();
			configuration.dispose();
			registration.dispose();
			changed.dispose();
			browser.window.close();
			for (const [name, descriptor] of descriptors) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			}
		},
	};
}

function button(view: CallViewPane, name: string): HTMLButtonElement {
	const element = [...view.element.querySelectorAll('button')].find(button => button.textContent === name);
	assert.ok(element, `Missing button ${name}`);
	return element;
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test('Calls links references and opens a new document without touching a dirty local working copy', async () => {
	const test = fixture();
	try {
		button(test.view, 'Link current document').click();
		await settled();
		assert.deepEqual(test.linked, [{ ...shared, title: 'Local draft' }]);
		button(test.view, 'Open document').click();
		await settled();
		assert.equal(test.opened[0]?.resource.scheme, 'untitled');
		assert.equal(test.opened[0]?.contentType, shared.contentType);
		assert.equal(test.opened[0]?.initialText, undefined);
		assert.deepEqual(test.joined, [shared]);
		assert.equal(test.originalCopy.isDirty, true);
		assert.equal(test.originalCopy.resource.toString(), URI.file('/local-draft.ashdoc').toString());
		button(test.view, 'Unlink document').click();
		await settled();
		assert.equal(test.view.element.querySelectorAll('.call-document').length, 0);
		assert.equal(button(test.view, 'Link current document').disabled, false);
	} finally {
		test.dispose();
	}
});

test('Calls exposes translated shared-document actions and keeps management controls owner-only', () => {
	const translations = JSON.parse(
		readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'),
	) as Record<string, Record<string, string>>;
	setNlsMessages('zh-CN', translations);
	const test = fixture();
	try {
		assert.equal(button(test.view, '打开文档').getAttribute('aria-label'), '打开 Shared notes');
		assert.equal(
			test.view.element
				.querySelector('ul[aria-label="此通话中共享的文档"]')
				?.textContent?.includes('Shared notes'),
			true,
		);
		test.setOwner(false);
		assert.equal(button(test.view, '关联当前文档').hidden, true);
		assert.equal(button(test.view, '取消文档关联').hidden, true);
		assert.equal(button(test.view, '打开文档').disabled, false);
	} finally {
		test.dispose();
		resetNlsResolver();
	}
});
