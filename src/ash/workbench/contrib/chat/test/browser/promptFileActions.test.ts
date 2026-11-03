import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IAppServerHookApi, type ClaudeHookImportCommand } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstructionService, type IInstructionImports, type InstructionImportItem, type InstructionImportSelection } from '../../../../../platform/instructions/common/instructionService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService, type INotification } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { registerPromptActions } from '../../browser/promptSyntax/promptFileActions.js';

class ImportFixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly ready = new DeferredPromise<void>();
	readonly closed = this._register(new Emitter<void>());
	readonly opened: IResourceEditorInput[] = [];
	readonly previews: InstructionImportSelection[] = [];
	readonly published: unknown[] = [];
	readonly warnings: unknown[] = [];
	readonly errors: unknown[] = [];
	readonly notices: unknown[] = [];
	notification: INotification | undefined;
	revision = 1;
	dirty = false;
	active = { sessionId: 'provider:session', threadId: 'provider:thread' } as { sessionId: string; threadId: string; } | undefined;
	outcome: InstructionImportItem[] = [];
	cancelAt = 0;
	picks = 0;
	needsAccess = false;
	consent = false;
	readonly grants: string[] = [];
	readonly imports: IInstructionImports = {
		directories: async () => [{ path: '/project', resource: URI.file('/project'), needsAccess: this.needsAccess }],
		grantAccess: async directory => { this.grants.push(directory); },
		preview: async selection => {
			this.previews.push(selection);
			return {
				targetDirectory: URI.file('/project'), digest: selection.sources.length ? 'exact-review' : 'discovery', diagnostics: [], items: [
					{ source: 'first.md', target: 'ASH.md', content: 'First instructions.', status: 'ready' },
					{ source: 'second.md', target: '.ash/instructions/copilot-second.md', content: 'Complete reviewed instructions.', status: 'ready' },
					{ source: 'unsupported.md', target: 'blocked.md', content: 'Never import.', status: 'unsupported' },
				].filter(item => !selection.sources.length || selection.sources.includes(item.source)) as InstructionImportItem[]
			};
		},
		apply: async (selection, digest) => { this.published.push([selection, digest]); return this.outcome; },
	};
	constructor() {
		super();
		this._register(registerPromptActions());
		const fixture = this;
		this.services.registerInstance(IDialogService, { confirm: async () => ({ confirmed: this.consent }) } as unknown as IDialogService);
		this.services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
		this.services.registerInstance(IInstructionService, { isAvailable: true, list: async () => [], captureImports: sessionId => { assert.equal(sessionId, 'provider:session'); return this.imports; } });
		this.services.registerInstance(IChatSessionNavigationService, { get revision() { return fixture.revision; }, getActiveConversation: () => this.active } as unknown as IChatSessionNavigationService);
		this.services.registerInstance(IEditorService, { openEditor: async (input: IResourceEditorInput) => { this.opened.push(input); } } as unknown as IEditorService);
		this.services.registerInstance(IWorkingCopyService, { get: () => [{ isDirty: this.dirty }] } as unknown as IWorkingCopyService);
		this.services.registerInstance(INotificationService, {
			info: (message: unknown) => this.notices.push(message), warn: (message: unknown) => this.warnings.push(message), error: (error: unknown) => this.errors.push(error),
			notify: (notification: INotification) => {
				this.notification = notification;
				void this.ready.complete();
				return { onDidClose: this.closed.event, close: () => this.closed.fire(), updateActions: () => { } };
			},
		} as unknown as INotificationService);
		this.services.registerInstance(IQuickInputService, {
			createQuickPick: () => {
				const accepted = this._register(new Emitter<void>());
				const hidden = this._register(new Emitter<void>());
				return {
					...toDisposable(() => { }), items: [] as readonly IQuickPickItem[], canSelectMany: false,
					get selectedItems(): readonly IQuickPickItem[] { return this.canSelectMany ? this.items.slice(-1) : this.items.slice(0, 1); },
					onDidAccept: accepted.event, onDidHide: hidden.event, onDidChangeValue: Event.None,
					show: () => { this.picks++; if (this.picks === this.cancelAt) hidden.fire(); else accepted.fire(); }, hide: () => hidden.fire(),
				};
			}
		} as unknown as IQuickInputService);
	}
	async run(commandId = 'workbench.action.chat.importInstructions'): Promise<void> {
		await this.services.invokeFunction(CommandsRegistry.getCommand(commandId)!);
	}
	async approve(): Promise<void> { await this.notification!.actions!.primary![0].run(); }
}

test('Instructions import reviews the exact selected files and publishes only on the explicit notification action', async () => {
	using fixture = new ImportFixture();
	fixture.outcome = [{ source: 'second.md', target: '.ash/instructions/copilot-second.md', content: 'Complete reviewed instructions.', status: 'imported' }];
	const running = fixture.run();
	await fixture.ready.p;
	assert.equal(fixture.published.length, 0);
	assert.equal(fixture.opened[0].readOnly, true);
	assert.ok(fixture.opened[0].initialText?.includes('Complete reviewed instructions.'));
	assert.ok(!fixture.opened[0].initialText?.includes('First instructions.'));
	assert.deepEqual(fixture.previews.map(selection => selection.sources), [[], ['second.md']]);
	await fixture.approve();
	await running;
	assert.deepEqual(fixture.published, [[{ directory: '/project', source: 'copilot', sources: ['second.md'] }, 'exact-review']]);
	assert.equal(fixture.errors.length, 0);
	assert.equal(fixture.warnings.length, 0);
});

test('Dismissing a review or cancelling file selection leaves the import authority untouched', async () => {
	using fixture = new ImportFixture();
	const running = fixture.run();
	await fixture.ready.p;
	fixture.closed.fire();
	await running;
	assert.deepEqual(fixture.published, []);
});

test('Cancelling the file picker does not open a preview or publish', async () => {
	using fixture = new ImportFixture();
	fixture.cancelAt = 3;
	await fixture.run();
	assert.deepEqual(fixture.opened, []);
	assert.deepEqual(fixture.published, []);
});

for (const change of ['dirty', 'host'] as const) test(`Instructions import rechecks ${change} after the user reviews the plan`, async () => {
	using fixture = new ImportFixture();
	const running = fixture.run();
	await fixture.ready.p;
	if (change === 'dirty') fixture.dirty = true;
	else fixture.revision++;
	await fixture.approve();
	await running;
	assert.deepEqual(fixture.published, []);
	assert.equal(fixture.errors.length, change === 'dirty' ? 1 : 0);
});

test('Per-file import failures are reported even when the RPC resolves successfully', async () => {
	using fixture = new ImportFixture();
	fixture.outcome = [{ source: 'second.md', target: '.ash/instructions/copilot-second.md', content: '', status: 'conflict', message: 'Changed since review' }];
	const running = fixture.run();
	await fixture.ready.p;
	await fixture.approve();
	await running;
	assert.equal(fixture.warnings.length, 1);
	assert.match(String(fixture.warnings[0]), /Changed since review/);
});

test('Instructions import requires a durable Session without materializing a chat or Turn', async () => {
	using fixture = new ImportFixture();
	fixture.active = undefined;
	await fixture.run();
	assert.equal(fixture.picks, 0);
	assert.deepEqual(fixture.previews, []);
	assert.equal(fixture.notices.length, 1);
});


test('Import obtains explicit directory-wide consent before requesting a Session grant', async () => {
	using fixture = new ImportFixture();
	fixture.needsAccess = true;
	await fixture.run();
	assert.deepEqual(fixture.grants, []);
	assert.deepEqual(fixture.previews, []);
	fixture.consent = true;
	const running = fixture.run();
	await fixture.ready.p;
	assert.deepEqual(fixture.grants, ['/project']);
	assert.equal(fixture.published.length, 0);
	fixture.closed.fire();
	await running;
});

test('Claude Hook migration opens a read-only review before publishing disabled commands', async () => {
	using fixture = new ImportFixture();
	const resource = URI.file('/project/claude-settings.json');
	const content = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] } });
	const applied: ClaudeHookImportCommand[] = [];
	fixture.services.registerInstance(IFileDialogService, { showOpenDialog: async () => [resource] } as unknown as IFileDialogService);
	fixture.services.registerInstance(IFileService, {
		stat: async () => ({ sizeBytes: content.length }),
		readFile: async () => ({ content }),
	} as unknown as IFileService);
	fixture.services.registerInstance(IAppServerHookApi, {
		onDidChangeHooks: Event.None,
		list: async () => [],
		captureClaudeHookImport: async () => async commands => {
			applied.push(...commands);
			return { imported: commands.length, existing: 0 };
		},
	});
	const running = fixture.run('workbench.action.chat.reviewClaudeHookMigration');
	await Promise.race([fixture.ready.p, running]);
	assert.equal(fixture.opened[0]?.readOnly, true);
	assert.match(fixture.opened[0]?.initialText ?? '', /enablement = "disabled"/u);
	assert.deepEqual(applied, []);
	await fixture.approve();
	await running;
	assert.deepEqual(applied.map(({ program, args }) => ({ program, args })), [{ program: '/bin/sh', args: ['-c', 'exit 2'] }]);
});


test('User Instructions import reviews and publishes using user scope', async () => {
	using fixture = new ImportFixture();
	const running = fixture.run('workbench.action.chat.importUserInstructions');
	await Promise.race([fixture.ready.p, running]);
	assert.equal(fixture.opened[0]?.readOnly, true);
	assert.deepEqual(fixture.previews.map(selection => selection.scope), ['user', 'user']);
	await fixture.approve();
	await running;
	assert.deepEqual(fixture.published, [[{ scope: 'user', directory: '/project', source: 'claude', sources: ['second.md'] }, 'exact-review']]);
});
