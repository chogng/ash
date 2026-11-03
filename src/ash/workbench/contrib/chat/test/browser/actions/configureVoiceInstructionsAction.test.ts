import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import '../../../browser/chat.shared.contribution.js';
import { DeferredPromise, timeout } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { FileNotFoundError, FileRevisionConflictError, IFileService } from '../../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { TestUriIdentityServices } from '../../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { IVoiceCodeTranscriptionBackendService, SpeechInstructionsConflictError, type SpeechInstructionKind, type SpeechInstructionsDocument } from '../../../../../../platform/dictation/common/dictation.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../common/contributions.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { BrowserWorkingCopyService } from '../../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { CONFIGURE_DICTATION_INSTRUCTIONS_ACTION_ID, CONFIGURE_VOICE_INSTRUCTIONS_ACTION_ID } from '../../../browser/actions/configureVoiceInstructionsAction.js';

const voice = URI.parse('ash-speech-instructions:/voice.md');
const dictation = URI.parse('ash-speech-instructions:/dictation.md');

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly files = this._register(new FileService());
	readonly context = this._register(new ContextKeyService());
	readonly identities = this._register(new TestUriIdentityServices(this.files));
	readonly copies = this._register(this.identities.createInstance(BrowserWorkingCopyService));
	readonly connection = this._register(new Emitter<void>());
	readonly documents = new Map<SpeechInstructionKind, SpeechInstructionsDocument>();
	readonly opened: URI[] = [];
	connected = true;
	disabled = false;
	revision = 0;
	reads = 0;
	beforeWrite: (() => void) | undefined;
	gate: DeferredPromise<void> | undefined;
	constructor(capability = true) {
		super();
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IContextKeyService, this.context);
		this.services.registerInstance(IWorkingCopyService, this.copies);
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled } as unknown as IConfigurationService);
		this.services.registerInstance(IEditorService, { openEditor: async (input: { resource: URI; }) => { this.opened.push(input.resource); } } as unknown as IEditorService);
		const fixture = this;
		this.services.registerInstance(IVoiceCodeTranscriptionBackendService, capability ? {
			get isConnected() { return fixture.connected; },
			onDidChangeConnection: this.connection.event, onDidTranscribe: Event.None, onDidEnd: Event.None,
			readInstructions: async kind => { this.reads++; await this.gate?.p; return this.documents.get(kind) ?? { exists: false, text: '', revision: 'missing' }; },
			writeInstructions: async (kind, text, expected) => {
				this.beforeWrite?.();
				if (expected !== (this.documents.get(kind)?.revision ?? 'missing')) throw new SpeechInstructionsConflictError();
				const revision = String(++this.revision); this.documents.set(kind, { text, revision, exists: true }); return revision;
			},
			getOptions: async () => { throw new Error('No recording'); }, start: async () => { }, pushAudio: async () => { }, stop: async () => undefined, cancel: async () => { },
		} : undefined);
	}
	start() {
		const host = this._register(WorkbenchContributionsRegistry.createHost(this.services, error => { throw error; }, ['workbench.contrib.chatSpeechInstructions']));
		host.advance(WorkbenchPhase.BlockStartup); return host;
	}
	async run(id = CONFIGURE_VOICE_INSTRUCTIONS_ACTION_ID): Promise<void> { await this.services.invokeFunction(CommandsRegistry.getCommand(id)!); }
}

suite('Speech instructions through the registered editor actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('each command creates only its own Profile file and opens the ordinary editor', async () => {
		using f = new Fixture(); f.start();
		await f.run(); await f.run(CONFIGURE_DICTATION_INSTRUCTIONS_ACTION_ID);
		assert.deepEqual(f.opened.map(uri => uri.toString()), [voice.toString(), dictation.toString()]);
		const first = await f.files.readFile(voice);
		const text = '\uFEFF# Instructions\r\n中文和术语 Ash。\r\n';
		await f.files.writeFile({ resource: voice, content: text, expectedRevision: first.revision }, { create: false, overwrite: true });
		assert.equal(f.documents.get('voice')!.text, text);
		assert.equal((await f.files.readFile(dictation)).content, '');
		await f.run(); assert.equal(f.documents.get('voice')!.text, text);
	});
	test('ordinary editor saves reject stale revisions and racing external writes', async () => {
		using f = new Fixture(); f.start(); await f.run();
		const first = await f.files.readFile(voice);
		f.documents.set('voice', { text: 'External', revision: 'external', exists: true });
		await assert.rejects(f.files.writeFile({ resource: voice, content: 'Stale', expectedRevision: first.revision }, { create: false, overwrite: true }), FileRevisionConflictError);
		f.beforeWrite = () => f.documents.set('voice', { text: 'Racing edit', revision: 'racing', exists: true });
		await assert.rejects(f.files.writeFile({ resource: voice, content: 'Late', expectedRevision: 'external' }, { create: false, overwrite: true }), FileRevisionConflictError);
		assert.equal(f.documents.get('voice')!.text, 'Racing edit');
	});
	test('simultaneous first opens retain the created document', async () => {
		using f = new Fixture(); f.start(); await Promise.all([f.run(), f.run()]);
		assert.equal(f.documents.size, 1); assert.equal(f.opened.length, 2);
	});
	test('only the two fixed files are exposed; reads do not create files', async () => {
		using f = new Fixture(); f.start();
		await assert.rejects(f.files.readFile(voice), FileNotFoundError); assert.equal(f.documents.size, 0);
		for (const path of ['ash-speech-instructions:/config.toml', 'ash-speech-instructions://other/voice.md', 'ash-speech-instructions:/voice.md?profile=other']) await assert.rejects(f.files.readFile(URI.parse(path)), FileNotFoundError);
	});
	test('disabled AI and unavailable backend cannot create or open instructions', async () => {
		using f = new Fixture(); f.start(); f.disabled = true; await f.run();
		assert.equal(f.reads, 0); f.disabled = false; f.connected = false; f.connection.fire(); await f.run();
		assert.equal(f.context.contextMatchesRules(ContextKeyExpr.equals('chat.speechInstructionsAvailable', true)), false);
		assert.deepEqual(f.opened, []);
		using browser = new Fixture(false); browser.start(); await browser.run(); assert.deepEqual(browser.opened, []);
	});
	test('the window owns provider registration and in-flight watch work', async () => {
		using f = new Fixture(); const host = f.start(); await f.run();
		let events = 0;
		using listener = f.files.onDidChangeFiles(() => events++);
		f.gate = new DeferredPromise<void>();
		using watch = f.files.watch(voice); const reads = f.reads;
		host.dispose(); await f.gate.complete(); await timeout(0);
		assert.equal(f.reads, reads); assert.equal(events, 0);
		assert.throws(() => f.files.readFile(voice));
	});
	test('invalid and oversized saves retain the original text and report Chinese diagnostics', async () => {
		using f = new Fixture(); f.start(); await f.run();
		setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			await assert.rejects(f.files.writeFileBytes(voice, new Uint8Array([255]), { create: false, overwrite: true }), /必须是 UTF-8 Markdown/u);
			await assert.rejects(f.files.writeFileBytes(voice, new Uint8Array(65537), { create: false, overwrite: true }), /最大为 64 KiB/u);
		} finally { resetNlsResolver(); }
		assert.equal(f.documents.get('voice')!.text, '');
	});
	test('the production contribution rejects a missing host capability registration', () => {
		using services = new InstantiationService();
		using files = new FileService(); using context = new ContextKeyService();
		using identities = new TestUriIdentityServices(files);
		using copies = identities.createInstance(BrowserWorkingCopyService); services.registerInstance(IWorkingCopyService, copies);
		services.registerInstance(IFileService, files); services.registerInstance(IContextKeyService, context);
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.chatSpeechInstructions']);
		assert.throws(() => host.advance(WorkbenchPhase.BlockStartup), /voiceCodeTranscriptionBackendService/u);
	});
	test('external changes are observed only while an actual working copy is registered', async () => {
		using f = new Fixture(); f.start(); await f.run();
		let changes = 0;
		using listener = f.files.onDidChangeFiles(() => changes++);
		using copy = new class extends Disposable implements IWorkingCopy {
			readonly resource = voice; readonly onDidChangeDirty = Event.None; readonly onDidChangeExternalChange = Event.None; readonly onDidChangeContent = Event.None;
			readonly isDirty = false; readonly hasExternalChange = false; readonly backupKind = 'text';
			backup() { return ''; } restoreBackup() { } async save() { } async saveAs() { } async revert() { }
		}();
		using registration = f.copies.register(copy);
		await timeout(0);
		f.documents.set('voice', { text: 'External', exists: true, revision: 'external' });
		await timeout(2100); assert.equal(changes, 1);
		registration.dispose();
		const reads = f.reads;
		await timeout(2100); assert.equal(f.reads, reads);
	});
});
