import { isCancellationError } from '../../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IFileSearchService } from '../../../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import { createBinaryDiffEditorInput, createDiffEditorInput } from '../../../../../common/editor/diffEditorInput.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { NotificationService } from '../../../../../services/notification/common/notificationService.js';
import { IWorkingCopyService } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { emptyEditorServiceState } from '../../../../../test/common/testEditorService.js';
import { ChatAttachmentModel } from '../../../browser/attachments/chatAttachmentModel.js';
import { ImplicitContextAttachmentWidget } from '../../../browser/attachments/implicitContextAttachment.js';

setARIAContainer(document.body);

function setup(resources: DisposableStore, read: (resource: URI) => Promise<string>, unsaved?: string) {
	const host = document.createElement('div');
	document.body.append(host);
	resources.add(toDisposable(() => host.remove()));
	const changed = resources.add(new Emitter<void>());
	let activeEditor: IResourceEditorInput | undefined = { resource: URI.file('/workspace/current.ts') };
	const services = resources.add(new InstantiationService());
	services.registerInstance(IEditorService, {
		...emptyEditorServiceState, onDidActiveEditorChange: changed.event,
		get activeEditor() { return activeEditor; },
		openEditor: async () => { }, focusActiveEditor() { },
	});
	services.registerInstance(IFileService, { readFile: async (resource: URI) => ({ content: await read(resource) }) } as unknown as IFileService);
	services.registerInstance(IWorkingCopyService, { get: () => unsaved === undefined ? [] : [{ backupKind: 'text', backup: () => unsaved }] } as unknown as IWorkingCopyService);
	services.registerInstance(IWorkspaceContextService, {} as IWorkspaceContextService);
	services.registerInstance(IFileSearchService, {} as IFileSearchService);
	const notifications = resources.add(new NotificationService());
	services.registerInstance(INotificationService, notifications);
	const attachments = resources.add(new ChatAttachmentModel());
	const input = document.createElement('textarea');
	host.append(input);
	const widget = resources.add(services.createInstance(ImplicitContextAttachmentWidget, host, attachments, () => input.focus()));
	return {
		widget, attachments, input, notifications,
		activate(resource?: URI) { activeEditor = resource ? { resource } : undefined; changed.fire(); },
		activateInput(editor: IResourceEditorInput) { activeEditor = editor; changed.fire(); },
	};
}

test('Suggested context follows active files without adding draft context and hides attached files', () => {
	using resources = new DisposableStore();
	const { widget, attachments, activate, input } = setup(resources, async () => { assert.fail('Suggestions must not read files'); });
	assert.equal(widget.domNode.textContent, 'current.ts');
	assert.equal(attachments.size, 0);
	const resource = URI.file('/workspace/next.ts');
	activate(resource);
	assert.equal(widget.domNode.textContent, 'next.ts');
	widget.domNode.querySelector('button')!.focus();
	attachments.addContext({ id: 'manual', kind: 'file', name: 'next.ts', resource, resolve: async () => ({ name: 'next.ts', content: 'existing' }) });
	assert.equal(widget.domNode.hidden, true);
	assert.equal(document.activeElement, input);
	attachments.clear();
	assert.equal(widget.domNode.hidden, false);
	activate(URI.parse('private:settings'));
	assert.equal(widget.domNode.hidden, true);
	activate();
	assert.equal(widget.accessibleContent, undefined);
});

test('Adding suggested context captures unsaved text and restores input focus', async () => {
	using resources = new DisposableStore();
	const { widget, attachments, input } = setup(resources, async () => { assert.fail('Unsaved text must take precedence'); }, 'const unsaved = true;');
	const added = new Promise<void>(resolve => resources.add(attachments.onDidChange(resolve)));
	widget.domNode.querySelector('button')!.focus();
	widget.domNode.querySelector('button')!.click();
	await added;
	assert.equal(widget.domNode.hidden, true);
	assert.equal(document.activeElement, input);
	assert.equal(attachments.size, 1);
	assert.deepEqual(await attachments.attachments[0]!.resolve(), { name: 'current.ts', content: 'const unsaved = true;' });
});

test('A pending suggested file keeps its clicked identity and ignores completion after disposal', async () => {
	using resources = new DisposableStore();
	let complete!: (text: string) => void;
	const pending = new Promise<string>(resolve => { complete = resolve; });
	const reads: string[] = [];
	const { widget, attachments, activate } = setup(resources, async resource => { reads.push(resource.path); return pending; });
	const added = new Promise<void>(resolve => resources.add(attachments.onDidChange(resolve)));
	widget.domNode.querySelector('button')!.click();
	activate(URI.file('/workspace/other.ts'));
	widget.domNode.querySelector('button')!.click();
	complete('clicked file text');
	await added;
	assert.deepEqual(reads, ['/workspace/current.ts']);
	assert.equal(attachments.attachments[0]!.resource?.path, '/workspace/current.ts');
	assert.equal(widget.domNode.textContent, 'other.ts');
	widget.domNode.querySelector('button')!.click();
	widget.dispose();
	await pending;
	await Promise.resolve();
	assert.equal(attachments.size, 1);
});

test('An unreadable suggested file reports failure and leaves the draft and suggestion available', async () => {
	using resources = new DisposableStore();
	const { widget, attachments, notifications } = setup(resources, async () => { throw new Error('File unavailable'); });
	const failed = new Promise<string>(resolve => resources.add(notifications.onDidAdd(item => resolve(item.message))));
	widget.domNode.querySelector('button')!.click();
	assert.match(await failed, /File unavailable/);
	assert.equal(attachments.size, 0);
	assert.equal(widget.domNode.hidden, false);
	assert.equal(widget.domNode.querySelector('button')!.disabled, false);
});

test('SCM diff suggestions attach the modified snapshot instead of the synthetic tab or working file', async () => {
	using resources = new DisposableStore();
	const { widget, attachments, activateInput } = setup(resources, async () => { assert.fail('A staged snapshot must not read the working file'); });
	const original = { resource: URI.parse('git-change:/staged/current.ts?side=original'), initialText: 'HEAD contents', readOnly: true };
	const modified = { resource: URI.parse('git-change:/staged/current.ts?side=modified'), initialText: 'Index contents', readOnly: true };
	activateInput(createDiffEditorInput(original, modified));
	assert.equal(widget.domNode.hidden, false);
	assert.equal(widget.domNode.textContent, 'current.ts');
	const added = new Promise<void>(resolve => resources.add(attachments.onDidChange(resolve)));
	widget.domNode.querySelector('button')!.click();
	await added;
	assert.equal(widget.domNode.hidden, true);
	assert.equal(attachments.attachments[0]!.resource?.toString(), modified.resource.toString());
	assert.deepEqual(await attachments.attachments[0]!.resolve(), { name: 'current.ts', content: 'Index contents' });
	activateInput({ resource: modified.resource, initialBytes: new Uint8Array([0, 1]), contentType: 'application/octet-stream' });
	assert.equal(widget.domNode.hidden, true);
	activateInput(createBinaryDiffEditorInput({ resource: URI.file('/workspace/before.bin') }, { resource: URI.file('/workspace/after.bin') }));
	assert.equal(widget.domNode.hidden, true);
});

test('A file diff suggestion uses its modified working copy rather than the comparison URI', async () => {
	using resources = new DisposableStore();
	const { widget, attachments, activateInput } = setup(resources, async () => { assert.fail('Read the modified working copy'); }, 'Unsaved modified text');
	activateInput(createDiffEditorInput({ resource: URI.file('/workspace/before.ts') }, { resource: URI.file('/workspace/after.ts') }));
	assert.equal(widget.domNode.textContent, 'after.ts');
	const added = new Promise<void>(resolve => resources.add(attachments.onDidChange(resolve)));
	widget.domNode.querySelector('button')!.click();
	await added;
	assert.equal(attachments.attachments[0]!.resource?.path, '/workspace/after.ts');
	assert.deepEqual(await attachments.attachments[0]!.resolve(), { name: 'after.ts', content: 'Unsaved modified text' });
});


test('Suggested context joins the pending submission and cannot reenter a cleared draft', async () => {
	using resources = new DisposableStore();
	const result = new DeferredPromise<string>();
	const started = new DeferredPromise<void>();
	const { widget, attachments, notifications } = setup(resources, async () => { await started.complete(); return result.p; });
	widget.domNode.querySelector('button')!.click();
	assert.equal(attachments.hasPendingContext, true);
	const captured = attachments.resolvePendingContext();
	await started.p;
	const rejected = assert.rejects(captured, isCancellationError);
	attachments.clear();
	await rejected;
	await result.complete('late file contents');
	await Promise.resolve();
	assert.equal(attachments.size, 0);
	assert.deepEqual(notifications.getNotifications(), []);
});

test('Disposing a suggested-context widget cancels its borrowed draft preparation', async () => {
	using resources = new DisposableStore();
	const result = new DeferredPromise<string>();
	const started = new DeferredPromise<void>();
	const { widget, attachments, notifications } = setup(resources, async () => { await started.complete(); return result.p; });
	widget.domNode.querySelector('button')!.click();
	const captured = attachments.resolvePendingContext();
	await started.p;
	const rejected = assert.rejects(captured, isCancellationError);
	widget.dispose();
	await rejected;
	await result.complete('late file contents');
	await Promise.resolve();
	assert.equal(attachments.size, 0);
	assert.equal(attachments.hasPendingContext, false);
	assert.deepEqual(notifications.getNotifications(), []);
});
