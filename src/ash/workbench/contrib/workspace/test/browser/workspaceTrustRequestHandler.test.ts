import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { DialogResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { DialogsModel, IDialogsModel, type IDialogViewItem } from '../../../../common/dialogs.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { WorkspaceTrustRequestService } from '../../../../services/workspaces/common/workspaceTrust.js';
import { WorkspaceTrustEditorInput } from '../../../../services/workspaces/browser/workspaceTrustEditorInput.js';
import { IDebugService } from '../../../debug/common/debug.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import '../../browser/workspace.contribution.js';

function nextDialog(dialogs: DialogsModel): Promise<IDialogViewItem> {
	return new Promise(resolve => Event.once(dialogs.onWillShowDialog)(resolve));
}

function fixture(uris: readonly URI[], options: { readonly running?: boolean; readonly saved?: boolean; } = {}) {
	const resources = new DisposableStore();
	const folders = uris.map((uri, index) => ({ id: String(index), name: String(index), uri, index }));
	const workspace = resources.add(new TestWorkspaceService({ id: 'test', folders }));
	const services = resources.add(new InstantiationService());
	const dialogs = resources.add(new DialogsModel());
	const saved = new DeferredPromise<boolean>();
	const persisted = new DeferredPromise<void>();
	const editor = new DeferredPromise<string>();
	let trusted = false;
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IDialogsModel, dialogs);
	services.registerInstance(IWorkspaceTrustManagementService, {
		onDidChangeTrust: Event.None,
		workspaceTrustInitialized: Promise.resolve(),
		workspaceResolved: Promise.resolve(),
		resolveWorkspaceTrust: async () => { },
		canSetWorkspaceTrust: () => true,
		isWorkspaceTrusted: () => trusted,
		getWorkspaceTrustInfo: async () => options.saved === false ? undefined : { isTrusted: trusted, isReadOnly: false },
		setWorkspaceTrust: async value => {
			await saved.complete(value);
			await persisted.p;
			trusted = value;
		},
	} as IWorkspaceTrustManagementService);
	services.registerInstance(INotificationService, { error: (error: unknown) => assert.fail(String(error)) } as unknown as INotificationService);
	services.registerInstance(ITerminalService, { instances: options.running ? [{ state: 'running' }] : [] } as unknown as ITerminalService);
	services.registerInstance(IDebugService, { sessions: [] } as unknown as IDebugService);
	services.registerInstance(IEditorService, {
		openEditor: async (input: WorkspaceTrustEditorInput) => {
			resources.add(input);
			await editor.complete(input.contentType);
		},
	} as unknown as IEditorService);
	const requests = resources.add(services.createInstance(WorkspaceTrustRequestService));
	services.registerInstance(IWorkspaceTrustRequestService, requests);
	const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.workspaceTrustRequestHandler']));
	host.advance(WorkbenchPhase.BlockRestore);
	return { requests, dialogs, saved, persisted, editor, host, [Symbol.dispose]: () => resources.dispose() };
}

test('Workspace Trust describes the requested local and remote roots and active process impact', async () => {
	const local = URI.file('/local/project');
	const remote = createSshRemoteWorkspaceUri('dev-box', '/remote/project');
	for (const [uri, path] of [[local, local.fsPath], [remote, '/remote/project']] as const) {
		using f = fixture([uri], { running: uri === remote });
		const shown = nextDialog(f.dialogs);
		const result = f.requests.requestWorkspaceTrust({ message: 'Run a project task?' });
		const dialog = await shown;
		assert.equal(dialog.request.kind, 'choice');
		assert.match(dialog.request.detail ?? '', /Run a project task\?/);
		assert.ok(dialog.request.detail?.includes(`Folders to trust:\n${path}`));
		assert.match(dialog.request.detail ?? '', /commands, project configuration, instructions, skills/);
		assert.equal(dialog.request.detail?.includes('may terminate running terminal commands'), uri === remote);
		assert.equal(f.saved.isSettled, false);
		dialog.cancel();
		assert.equal(await result, undefined);
		assert.equal(f.saved.isSettled, false);
	}
});

test('Workspace Trust completes a confirmation only after the grant is applied', async () => {
	using f = fixture([URI.file('/project')]);
	const shown = nextDialog(f.dialogs);
	let completed = false;
	const result = f.requests.requestWorkspaceTrust().then(value => { completed = true; return value; });
	const dialog = await shown;
	dialog.close({ button: DialogResult.Primary, buttonIndex: 0 });
	assert.equal(await f.saved.p, true);
	assert.equal(completed, false);
	await f.persisted.complete();
	assert.equal(await result, true);
});

test('Manage opens the permissions editor without granting access', async () => {
	using f = fixture([URI.file('/project')]);
	const shown = nextDialog(f.dialogs);
	const result = f.requests.requestWorkspaceTrust();
	(await shown).close({ button: DialogResult.Primary, buttonIndex: 1 });
	assert.equal(await result, undefined);
	assert.equal(await f.editor.p, WorkspaceTrustEditorInput.ID);
	assert.equal(f.saved.isSettled, false);
});

test('Startup shows a prompt for a missing decision and respects a saved restricted decision', async () => {
	using restricted = fixture([URI.file('/project')]);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(restricted.dialogs.dialogs, []);
	using unanswered = fixture([URI.file('/project')], { saved: false });
	const dialog = await nextDialog(unanswered.dialogs);
	unanswered.host.dispose();
	assert.deepEqual(unanswered.dialogs.dialogs, []);
	dialog.close({ button: DialogResult.Primary, buttonIndex: 0 });
	assert.equal(unanswered.saved.isSettled, false);
});

test('Continue without trust leaves an existing restricted decision in place', async () => {
	using f = fixture([URI.file('/project')]);
	const shown = nextDialog(f.dialogs);
	const result = f.requests.requestWorkspaceTrust({
		buttons: [{ label: 'Continue in Restricted Mode', type: 'ContinueWithoutTrust' }],
	});
	(await shown).close({ button: DialogResult.Primary, buttonIndex: 0 });
	assert.equal(await result, false);
	assert.equal(f.saved.isSettled, false);
});
