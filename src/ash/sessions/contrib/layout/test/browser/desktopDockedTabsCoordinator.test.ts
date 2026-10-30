import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../../../../editor/test/browser/testEditorDom.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { IEditorGroupView } from '../../../../../workbench/browser/parts/editor/editor.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService, type EditorOpenTarget } from '../../../../../workbench/services/editor/common/editorService.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../../../../workbench/common/editor.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionChangesService } from '../../../changes/common/sessionChangesService.js';
import { SessionChangesEditorInput } from '../../../changes/browser/sessionChangesEditorInput.js';
import { EmptyFileEditorInput } from '../../../editor/browser/emptyFileEditorInput.js';
import { DesktopDockedTabsCoordinator } from '../../browser/desktop/desktopDockedTabsCoordinator.js';

suite('DesktopDockedTabsCoordinator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty sessions do not create Files or Changes tabs in either editor presentation', async () => {
		using fixture = new TabsFixture();
		await fixture.coordinator.reconcile(fixture.selection, true);
		await fixture.coordinator.reconcile(fixture.selection, false);
		assert.deepEqual(fixture.documents.inputs, []);
		assert.deepEqual(fixture.pages.inputs.map(input => input.resource.scheme), ['ash-trace']);
		assert.deepEqual(fixture.opened, []);
	});

	test('removes restored Files landing tabs while retaining documents and product pages', async () => {
		using fixture = new TabsFixture();
		const file = { resource: URI.file('/sample.ts'), label: 'sample.ts' };
		fixture.documents.inputs.push(new EmptyFileEditorInput(), file);
		await fixture.coordinator.removeFilesLandingTab();
		await fixture.coordinator.reconcile(fixture.selection, true);
		assert.deepEqual(fixture.documents.inputs, [file]);
		assert.deepEqual(fixture.pages.inputs.map(input => input.resource.scheme), ['ash-trace']);
		assert.deepEqual(fixture.opened, []);
	});

	test('retained Changes tabs still follow the selected session and editor presentation', async () => {
		using fixture = new TabsFixture();
		fixture.documents.inputs.push(new SessionChangesEditorInput(selection('outgoing')));
		await fixture.coordinator.reconcile(fixture.selection, true);
		assert.equal(fixture.documents.inputs[0]?.resource.path, '/current');
		assert.equal(fixture.documents.inputs[0]?.capabilities, EditorInputCapabilities.CannotClose | EditorInputCapabilities.ExcludeFromEditorLimit);
		await fixture.coordinator.reconcile(fixture.selection, false);
		assert.equal(fixture.documents.inputs[0]?.capabilities, EditorInputCapabilities.ExcludeFromEditorLimit);
		assert.ok(fixture.opened.every(open => open.target === fixture.documents.id));
	});

	test('disposal during a landing tab close stops further cleanup', async () => {
		using fixture = new TabsFixture();
		fixture.documents.inputs.push(new EmptyFileEditorInput(), new EmptyFileEditorInput());
		const gate = new DeferredPromise<void>();
		fixture.closeGate = gate.p;
		const pending = fixture.coordinator.removeFilesLandingTab();
		await fixture.closeStarted.p;
		fixture.coordinator.dispose();
		await gate.complete();
		await pending;
		assert.equal(fixture.documents.inputs.length, 1);
	});

	test('a session switch during replacement stops outgoing tab updates', async () => {
		using fixture = new TabsFixture();
		fixture.documents.inputs.push(new SessionChangesEditorInput(selection('outgoing')));
		const gate = new DeferredPromise<void>();
		fixture.replaceGate = gate.p;
		const outgoing = fixture.coordinator.reconcile(fixture.selection, true);
		await fixture.replaceStarted.p;
		fixture.selection = selection('incoming');
		await gate.complete();
		await outgoing;
		assert.deepEqual(fixture.opened, []);
		await fixture.coordinator.reconcile(fixture.selection, true);
		assert.equal(fixture.documents.inputs.filter(input => input.resource.scheme === 'ash-session-changes').length, 1);
		assert.equal(fixture.documents.inputs.find(input => input.resource.scheme === 'ash-session-changes')?.resource.path, '/incoming');
	});

	test('closing a target group during replacement does not recreate its tabs elsewhere', async () => {
		using fixture = new TabsFixture();
		fixture.documents.inputs.push(new SessionChangesEditorInput(selection('outgoing')));
		const gate = new DeferredPromise<void>();
		fixture.replaceGate = gate.p;
		const pending = fixture.coordinator.reconcile(fixture.selection, true);
		await fixture.replaceStarted.p;
		fixture.groups = [fixture.pages];
		await gate.complete();
		await pending;
		assert.deepEqual(fixture.opened, []);
		assert.deepEqual(fixture.pages.inputs.map(input => input.resource.scheme), ['ash-trace']);
	});

	test('an in-flight replacement failure after disposal is ignored', async () => {
		using fixture = new TabsFixture();
		fixture.documents.inputs.push(new SessionChangesEditorInput(selection('outgoing')));
		const gate = new DeferredPromise<void>();
		fixture.replaceGate = gate.p;
		const pending = fixture.coordinator.reconcile(fixture.selection, false);
		await fixture.replaceStarted.p;
		fixture.coordinator.dispose();
		await gate.error(new Error('Editor group released'));
		await pending;
		assert.deepEqual(fixture.opened, []);
	});

	test('live replacement failures remain observable to the layout owner', async () => {
		using fixture = new TabsFixture();
		fixture.documents.inputs.push(new SessionChangesEditorInput(selection('outgoing')));
		fixture.replaceGate = Promise.reject(new Error('Replacement failed'));
		await assert.rejects(fixture.coordinator.reconcile(fixture.selection, false), /Replacement failed/);
	});
});

function selection(id: string): SessionsViewSelection {
	return { kind: 'session', active: { session: { sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', chats: [] }, threadId: id + '-thread' } };
}

class TabsFixture extends Disposable {
	private readonly services = this._register(new InstantiationService());
	public selection = selection('current');
	public readonly closeStarted = new DeferredPromise<void>();
	public readonly replaceStarted = new DeferredPromise<void>();
	public closeGate: Promise<void> | undefined;
	public replaceGate: Promise<void> | undefined;
	public readonly opened: { input: IResourceEditorInput; target: number | undefined; }[] = [];
	public readonly documents = this.group(1);
	public readonly pages = this.group(3);
	public groups = [this.documents, this.pages];
	public readonly coordinator: DesktopDockedTabsCoordinator;
	constructor() {
		super();
		this.pages.inputs.push({ resource: URI.parse('ash-trace:/retained'), label: 'Trace' });
		this.services.registerInstance(IEditorPart, { get groups() { return fixture.groups; }, activeGroup: this.pages } as unknown as IEditorPart);
		const fixture = this;
		this.services.registerInstance(IEditorService, {
			openEditor: async (input: IResourceEditorInput, _options: unknown, target?: EditorOpenTarget) => {
				const groupId = typeof target === 'object' ? target.groupId : undefined;
				this.opened.push({ input, target: groupId });
				const group = this.groups.find(group => group.id === groupId);
				if (group && !group.inputs.includes(input)) { group.inputs.push(input); }
			},
		} as unknown as IEditorService);
		this.services.registerInstance(ISessionChangesService, {} as ISessionChangesService);
		this.services.registerInstance(ISessionsService, { get activeSelection() { return fixture.selection; } } as ISessionsService);
		this.coordinator = this._register(this.services.createInstance(DesktopDockedTabsCoordinator, this.pages.id));
	}
	private group(id: number) {
		const inputs: IResourceEditorInput[] = [];
		return {
			id, inputs,
			closeEditor: async (input: IResourceEditorInput) => {
				if (!this.closeStarted.isSettled) { await this.closeStarted.complete(); }
				await this.closeGate;
				inputs.splice(inputs.indexOf(input), 1);
				return true;
			},
			replaceEditor: async (input: IResourceEditorInput, replacement: IResourceEditorInput) => {
				if (!this.replaceStarted.isSettled) { await this.replaceStarted.complete(); }
				await this.replaceGate;
				inputs.splice(inputs.indexOf(input), 1, replacement);
			},
		} as Pick<IEditorGroupView, 'id' | 'replaceEditor' | 'closeEditor'> & { inputs: IResourceEditorInput[]; };
	}
}
