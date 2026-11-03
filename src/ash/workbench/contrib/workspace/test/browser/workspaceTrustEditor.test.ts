import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IAgentCapabilitiesService } from '../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DEVELOPMENT_DIR_PERMISSIONS, IWorkspaceTrustApi, IWorkspaceTrustManagementService, READ_DIR_PERMISSIONS, RESTRICTED_DIR_PERMISSIONS, type WorkspaceTrustPermission } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { WorkspaceTrustEditorInput } from '../../../../services/workspaces/browser/workspaceTrustEditorInput.js';
import { IDebugService } from '../../../debug/common/debug.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { WorkspaceTrustEditor } from '../../browser/workspaceTrustEditor.js';

async function fixture() {
	const resources = new DisposableStore();
	try {
		const dom = new JSDOM('<!doctype html><body><button>Outside</button></body>', { url: 'https://ash.test' });
		resources.add(toDisposable(() => dom.window.close()));
		const { document } = dom.window;
		const services = resources.add(new InstantiationService());
		const uri = URI.file('/project');
		const canonical = URI.file('/canonical/project');
		const workspace = resources.add(new TestWorkspaceService({ id: 'test', folders: [{ id: 'project', index: 0, name: 'Project', uri }] }));
		const changed = resources.add(new Emitter<void>());
		const integrationUpdates: string[] = [];
		const confirmation = new DeferredPromise<{ confirmed: boolean; }>();
		const applying = new DeferredPromise<void>();
		const writes: { path: string; permissions: readonly WorkspaceTrustPermission[]; revision: number; }[] = [];
		const state = {
			permissions: READ_DIR_PERMISSIONS,
			revision: 7,
			readError: false,
			saveError: false,
			canManage: true,
			generation: 1,
			waitForApply: Promise.resolve(),
		};
		const persist = async (path: string, permissions: readonly WorkspaceTrustPermission[], revision: number) => {
			writes.push({ path, permissions, revision });
			if (state.saveError) throw new Error('Revision conflict');
			await applying.complete();
			await state.waitForApply;
			state.permissions = permissions;
			state.revision++;
			return { revision: state.revision, generation: state.generation, disposition: 'updated' as const };
		};
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IConfigurationService, workspace);
		services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
		services.registerInstance(IContextViewService, {} as IContextViewService);
		services.registerInstance(IThemeService, resources.add(new TestThemeService(lightColorTheme)));
		services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'trust-test' })));
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		services.registerInstance(ILocalizationService, { translate: (_bundle: string, _key: string, fallback: string) => fallback } as ILocalizationService);
		services.registerInstance(ITerminalService, { instances: [] } as unknown as ITerminalService);
		services.registerInstance(IDebugService, { sessions: [] } as unknown as IDebugService);
		services.registerInstance(IDialogService, { confirm: () => confirmation.p } as unknown as IDialogService);
		services.registerInstance(IAgentCapabilitiesService, { read: async () => ({ directoryGrantsReadable: state.canManage }) } as IAgentCapabilitiesService);
		services.registerInstance(IAppServerApi, {
			isAvailable: true, get connectionGeneration() { return state.generation; }, getConnectionState: async () => 'ready',
			onConnectionState: () => toDisposable(() => { }),
			getSlashCommands: async () => [],
			recovery: { status: 'idle', error: undefined, onDidChange: Event.None, reconnect: async options => { assert.deepEqual(options, { reason: 'permissions' }); integrationUpdates.push('reconnect'); } },
		});
		services.registerInstance(IWorkspaceTrustManagementService, {
			getUriTrustInfo: async folder => {
				assert.equal(folder.toString(), uri.toString());
				if (state.readError) throw new Error('Permission read failed');
				return { uri: canonical, trusted: state.permissions === DEVELOPMENT_DIR_PERMISSIONS, permissions: state.permissions };
			},
			setUrisTrust: async (folders, trusted, revision) => {
				assert.deepEqual(folders, [uri]);
				await persist(canonical.fsPath, trusted ? DEVELOPMENT_DIR_PERMISSIONS : RESTRICTED_DIR_PERMISSIONS, revision!);
			},
			resolveWorkspaceTrust: async () => { integrationUpdates.push('refresh trust'); },
		} as IWorkspaceTrustManagementService);
		services.registerInstance(IWorkspaceTrustApi, {
			onDidChangeTrust: changed.event,
			listDirectories: async () => ({ revision: state.revision, entries: [{ dir: 'dir', path: canonical.fsPath, permissions: state.permissions }] }),
			readDirectory: async (path: string) => {
				assert.equal(path, canonical.fsPath);
				return { dir: 'dir', permissions: state.permissions };
			},
			setDirectoryPermissions: persist,
		} as unknown as IWorkspaceTrustApi);
		const input = resources.add(new WorkspaceTrustEditorInput());
		const editor = resources.add(services.createInstance(WorkspaceTrustEditor));
		editor.create(document.body);
		const open = () => editor.setInput(input, new AbortController().signal);
		await open();
		const root = document.querySelector<HTMLElement>('section[aria-label="Workspace Trust"]')!;
		const button = (label: string): HTMLElement => {
			const element = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')].find(button => button.textContent?.trim() === label);
			assert.ok(element, label);
			return element;
		};
		return { applying, button, canonical, changed, confirmation, document, integrationUpdates, open, root, state, writes, [Symbol.dispose]: () => resources.dispose() };
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

test('Refreshing an unavailable permission read does not grant permissions or move focus', async () => {
	using f = await fixture();
	f.state.readError = true;
	await f.open();
	assert.match(f.root.textContent ?? '', /Could not read workspace permissions: Error: Permission read failed/);
	const refresh = f.button('Refresh');
	refresh.focus();
	refresh.click();
	await setImmediate();
	assert.match(f.root.textContent ?? '', /Could not read workspace permissions/);
	assert.equal(f.document.activeElement, refresh);
	f.state.readError = false;
	refresh.click();
	await setImmediate();
	assert.equal(f.root.querySelector('h2')?.textContent, 'Read-only workspace');
	assert.deepEqual(f.writes, []);
});

test('Trust waits for persistence and restores focus after the action is retired', async () => {
	using f = await fixture();
	const gate = new DeferredPromise<void>();
	f.state.waitForApply = gate.p;
	const trust = f.button('Trust workspace');
	trust.focus();
	trust.click();
	assert.deepEqual(f.writes, []);
	await f.confirmation.complete({ confirmed: true });
	await f.applying.p;
	assert.equal(f.root.querySelector('h2')?.textContent, 'Read-only workspace');
	assert.equal(f.document.activeElement, trust);
	await gate.complete();
	await setImmediate();
	assert.deepEqual(f.writes, [{ path: f.canonical.fsPath, permissions: DEVELOPMENT_DIR_PERMISSIONS, revision: 7 }]);
	assert.equal(f.root.querySelector('h2')?.textContent, 'Trusted workspace');
	assert.equal(f.document.activeElement, f.root);
});

test('A failed save keeps the effective permissions and requires refresh', async () => {
	using f = await fixture();
	f.state.saveError = true;
	const trust = f.button('Trust workspace');
	trust.click();
	await f.confirmation.complete({ confirmed: true });
	await setImmediate();
	assert.match(f.root.textContent ?? '', /Could not apply permissions.*Revision conflict/);
	assert.equal(f.root.querySelector('h2')?.textContent, 'Read-only workspace');
	trust.click();
	await setImmediate();
	assert.equal(f.writes.length, 1);
	f.button('Refresh').click();
	await setImmediate();
	assert.doesNotMatch(f.root.textContent ?? '', /Revision conflict/);
});

test('An external grant change invalidates an unsaved custom edit', async () => {
	using f = await fixture();
	const execute = f.root.querySelector<HTMLElement>('[role="switch"][aria-label="Execute commands"]');
	assert.ok(execute);
	execute.click();
	assert.equal(execute.getAttribute('aria-checked'), 'true');
	f.state.permissions = RESTRICTED_DIR_PERMISSIONS;
	f.state.revision++;
	f.changed.fire();
	assert.match(f.root.textContent ?? '', /Directory grants changed/);
	f.button('Save permissions').click();
	assert.deepEqual(f.writes, []);
	f.button('Refresh').click();
	await setImmediate();
	assert.equal(f.root.querySelector('h2')?.textContent, 'Restricted Mode');
	assert.equal(execute.getAttribute('aria-checked'), 'false');
});

test('A confirmation from a retired connection cannot write the old revision', async () => {
	using f = await fixture();
	f.button('Trust workspace').click();
	f.state.generation++;
	await f.confirmation.complete({ confirmed: true });
	await setImmediate();
	assert.deepEqual(f.writes, []);
});

test('Advanced save writes the selected capabilities to the canonical folder and refreshes integrations', async () => {
	using f = await fixture();
	const execute = f.root.querySelector<HTMLElement>('[role="switch"][aria-label="Execute commands"]');
	assert.ok(execute);
	execute.click();
	f.button('Save permissions').click();
	assert.deepEqual(f.writes, []);
	await f.confirmation.complete({ confirmed: true });
	await setImmediate();
	assert.deepEqual(f.writes, [{ path: f.canonical.fsPath, permissions: [...READ_DIR_PERMISSIONS, 'executeCommands'], revision: 7 }]);
	assert.deepEqual(f.integrationUpdates, ['reconnect', 'refresh trust']);
	assert.equal(f.root.querySelector('h2')?.textContent, 'Custom permissions');
});

test('A grant refresh updates the overview without taking focus from outside the editor', async () => {
	using f = await fixture();
	const outside = f.document.querySelector('button')!;
	outside.focus();
	f.state.permissions = RESTRICTED_DIR_PERMISSIONS;
	f.changed.fire();
	await setImmediate();
	assert.equal(f.root.querySelector('h2')?.textContent, 'Restricted Mode');
	assert.equal(f.document.activeElement, outside);
});

test('A host without grant management authority can view effective permissions', async () => {
	using f = await fixture();
	f.state.canManage = false;
	await f.open();
	assert.equal(f.root.querySelector('h2')?.textContent, 'Read-only workspace');
	assert.match(f.root.textContent ?? '', /only be changed by an authorized desktop host/);
	f.button('Trust workspace').click();
	assert.deepEqual(f.writes, []);
});
