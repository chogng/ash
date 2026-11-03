import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { SkillReference } from '../../../../../platform/agentHost/common/appServerApi.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatWidgetService, type IChatWidget } from '../../browser/chat.js';
import { registerRunPromptActions } from '../../browser/promptSyntax/runPromptAction.js';
import { IPromptsService, type IAgentSkill } from '../../common/promptSyntax/service/promptsService.js';
import type { SkillSelectorDefinition } from '../../../../services/chat/common/chatService.js';

const reference: SkillReference = { id: { source: 'plugin:review-tools@1', name: 'review' }, version: { type: 'pinnedDigest', digest: `sha256:${'a'.repeat(64)}` } };
const selection: SkillSelectorDefinition = { name: 'review', source: reference.id.source, description: 'Review project changes.', skill: reference };

class RunFixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly changed = this._register(new Emitter<void>());
	readonly hidden = this._register(new Emitter<void>());
	readonly rebound = this._register(new Emitter<void>());
	readonly configChanged = this._register(new Emitter<never>());
	readonly skillsChanged = this._register(new Emitter<void>());
	readonly accepted = this._register(new Emitter<void>());
	readonly pickerHidden = this._register(new Emitter<void>());
	readonly pickerReady = new DeferredPromise<void>();
	readonly notices: string[] = [];
	readonly attached: SkillReference[] = [];
	readonly resource = URI.parse('private://skill/review/SKILL.md?source=package-v1');
	readonly model = { composerGeneration: 1, onDidChange: this.changed.event, inputState: { phase: 'ready', skillSelectorsLoading: false, canSelectAgent: true, skillSelectors: [selection] } };
	readonly catalog: IAgentSkill[] = [{ id: reference.id, name: 'review', uri: this.resource, contentDigest: reference.version.digest, description: selection.description, enabled: true, compatible: true }];
	readonly widget = {
		model: this.model, visible: true, onDidHide: this.hidden.event, onDidChangeViewModel: this.rebound.event,
		input: { captureDraft: async () => this.capture(), attachSkill: (skill: SkillReference) => this.attached.push(skill) },
		acceptInput: async () => { this.submissions++; }, focusInput: () => { this.focused++; },
	} as unknown as IChatWidget;
	disabled = false;
	newChats = 0;
	navigationResult = true;
	expectedProviderId: string | undefined;
	submissions = 0;
	focused = 0;
	autoAccept = true;
	cancelPicker = false;
	activeResource = this.resource;
	capture: () => Promise<unknown> = async () => undefined;

	constructor() {
		super();
		this._register(registerRunPromptActions());
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled, onDidChangeConfiguration: this.configChanged.event } as unknown as IConfigurationService);
		this.services.registerInstance(IChatSessionNavigationService, { createNewConversation: async (options: unknown) => { assert.deepEqual(options, { focus: true, ...(this.expectedProviderId ? { providerId: this.expectedProviderId } : {}) }); this.newChats++; return this.navigationResult; } } as unknown as IChatSessionNavigationService);
		this.services.registerInstance(IChatWidgetService, { lastFocusedWidget: this.widget, getAllWidgets: () => [this.widget], onDidChangeWidgets: Event.None } as unknown as IChatWidgetService);
		this.services.registerInstance(IPromptsService, { onDidChangeSkills: this.skillsChanged.event, resolveSkill: async (resource: URI) => this.catalog.find(skill => skill.uri.toString() === resource.toString()) } as unknown as IPromptsService);
		const fixture = this;
		this.services.registerInstance(IEditorService, { get activeEditor() { return { resource: fixture.activeResource }; } } as unknown as IEditorService);
		this.services.registerInstance(INotificationService, { info: (message: string) => this.notices.push(message) } as unknown as INotificationService);
		this.services.registerInstance(IQuickInputService, {
			createQuickPick: () => {
				let items: readonly IQuickPickItem[] = [];
				return {
					...toDisposable(() => { }),
					get items() { return items; }, set items(value) { items = value; },
					get selectedItems() { return items.slice(0, 1); },
					onDidAccept: this.accepted.event, onDidHide: this.pickerHidden.event, onDidChangeValue: Event.None,
					hide: () => this.pickerHidden.fire(),
					show: () => {
						void this.pickerReady.complete();
						if (this.cancelPicker) this.pickerHidden.fire();
						else if (this.autoAccept) this.accepted.fire();
					},
				};
			}
		} as unknown as IQuickInputService);
	}

	async run(current = false): Promise<void> { await this.services.invokeFunction(CommandsRegistry.getCommand(`workbench.action.chat.run.prompt${current ? '.current' : ''}`)!); }
}

for (const current of [false, true]) test(`Run ${current ? 'current' : 'selected'} Skill passes the exact source and digest to the existing new Chat input`, async () => {
	using fixture = new RunFixture();
	await fixture.run(current);
	assert.equal(fixture.newChats, 1);
	assert.deepEqual(fixture.attached, [reference]);
	assert.equal(fixture.submissions, 1);
	assert.equal(fixture.focused, 1);
});

test('A current Skill never falls back from an undiscovered local file or another host with the same name', async () => {
	using fixture = new RunFixture();
	fixture.activeResource = URI.file('/project/.ash/skills/review/SKILL.md');
	await fixture.run(true);
	assert.equal(fixture.newChats, 0);
	assert.equal(fixture.notices.length, 1);
	fixture.activeResource = fixture.resource;
	fixture.model.inputState.skillSelectors = [{ ...selection, skill: { ...reference, id: { ...reference.id, source: 'other-host' } } }];
	await fixture.run(true);
	assert.equal(fixture.newChats, 1);
	assert.equal(fixture.submissions, 0);
	assert.equal(fixture.notices.length, 2);
});

test('Disabled AI, an empty Skill list and picker cancellation never submit', async () => {
	using fixture = new RunFixture();
	fixture.disabled = true;
	await fixture.run();
	assert.equal(fixture.newChats, 0);
	fixture.disabled = false;
	fixture.model.inputState.skillSelectors = [];
	await fixture.run();
	assert.equal(fixture.notices.length, 1);
	fixture.model.inputState.skillSelectors = [selection];
	fixture.cancelPicker = true;
	await fixture.run();
	assert.deepEqual(fixture.attached, []);
	assert.equal(fixture.submissions, 0);
});

test('Replacing the composer while its Skill picker is open cancels the exact operation', async () => {
	using fixture = new RunFixture();
	fixture.autoAccept = false;
	const pending = fixture.run();
	await fixture.pickerReady.p;
	fixture.model.composerGeneration++;
	fixture.changed.fire();
	await assert.rejects(pending, isCancellationError);
	assert.deepEqual(fixture.attached, []);
	assert.equal(fixture.submissions, 0);
});

test('An existing new Chat draft is preserved instead of being submitted with a Skill', async () => {
	using fixture = new RunFixture();
	fixture.capture = async () => ({ draft: { text: 'Keep this draft.', contexts: [] } });
	await assert.rejects(fixture.run(), /unsent draft/);
	assert.deepEqual(fixture.attached, []);
	assert.equal(fixture.submissions, 0);
});

test('Revoking a Skill while attachments settle cannot submit a captured stale digest', async () => {
	using fixture = new RunFixture();
	const captured = new DeferredPromise<void>();
	const pendingCapture = new DeferredPromise<unknown>();
	fixture.capture = () => { void captured.complete(); return pendingCapture.p; };
	const pending = fixture.run();
	await captured.p;
	fixture.model.inputState.skillSelectors = [];
	await pendingCapture.complete(undefined);
	await assert.rejects(pending, isCancellationError);
	assert.equal(fixture.submissions, 0);
});


test('Running a Skill waits for its owning catalog independently of model readiness', async () => {
	using fixture = new RunFixture();
	fixture.model.inputState.skillSelectorsLoading = true;
	const pending = fixture.run();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(fixture.submissions, 0);
	assert.equal(fixture.pickerReady.isSettled, false);
	fixture.model.inputState.skillSelectorsLoading = false;
	fixture.changed.fire();
	await pending;
	assert.equal(fixture.submissions, 1);
});


test('Canceling the new Chat host picker never falls back to a previously focused draft', async () => {
	using fixture = new RunFixture();
	fixture.navigationResult = false;
	await fixture.run();
	assert.deepEqual(fixture.attached, []);
	assert.equal(fixture.submissions, 0);
	assert.equal(fixture.pickerReady.isSettled, false);
});


test('Running the current Skill asks the navigation owner for its exact original host', async () => {
	using fixture = new RunFixture();
	fixture.catalog[0] = { ...fixture.catalog[0], providerId: 'original-host' };
	fixture.expectedProviderId = 'original-host';
	await fixture.run(true);
	assert.deepEqual(fixture.attached, [reference]);
	assert.equal(fixture.submissions, 1);
});
