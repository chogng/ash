import '../../browser/advisor.contribution.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickDidAcceptEvent } from '../../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IChatService, type AdvisorConfig } from '../../../../services/chat/common/chatService.js';
import { AdvisorSettingsModel } from '../../browser/advisorSettingsModel.js';
import { ModelPurpose, type ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';

test('Advisor settings and Quick Pick preserve budgets and remove incompatible effort on the same model change', async () => {
	using resources = new DisposableStore();
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(AdvisorSettingsModel), /chatService/);
	const initial: AdvisorConfig = { model: { provider: 'test', model: 'old' }, enabled: false, maxCalls: 7, maxOutputTokens: 8192, reasoningEffort: 'high' };
	const next: ModelCatalogEntry = { model: { provider: 'test', model: 'next' }, displayName: 'Next Advisor', longContext: null, recommendedFor: [ModelPurpose.Advisor], supportedReasoningEfforts: [{ effort: 'medium', description: 'Medium' }] };
	const expected = { model: next.model, enabled: true, maxCalls: 7, maxOutputTokens: 8192, reasoningEffort: undefined };
	const writes: (AdvisorConfig | null)[] = [];
	const wrote = new DeferredPromise<void>();
	services.registerInstance(IChatService, {
		readAdvisorDefault: async () => initial,
		saveAdvisorDefault: async value => { writes.push(value); await wrote.p; },
	} as IChatService);
	services.registerInstance(ILanguageModelsService, {
		onDidChangeModels: Event.None, listModelCatalog: async () => [next], listAdvisorModels: async () => [next], isModelVisible: () => true,
	} as unknown as ILanguageModelsService);
	const accepted = resources.add(new Emitter<IQuickPickDidAcceptEvent>());
	const hidden = resources.add(new Emitter<void>());
	let disposed = false;
	const dispose = (): void => { disposed = true; };
	const quickPick = {
		items: [] as readonly IQuickPickItem[], selectedItems: [] as readonly IQuickPickItem[],
		onDidAccept: accepted.event, onDidHide: hidden.event,
		show() { }, hide() { hidden.fire(); }, dispose, [Symbol.dispose]: dispose,
	} as unknown as IQuickPick<IQuickPickItem>;
	services.registerInstance(IQuickInputService, { createQuickPick: () => quickPick } as unknown as IQuickInputService);
	const command = CommandsRegistry.getCommand('workbench.action.chat.configureAdvisor');
	assert.ok(command);
	await services.invokeFunction(command);
	const choice = quickPick.items.find(item => item.label === 'Next Advisor');
	assert.ok(choice && !('type' in choice));
	quickPick.selectedItems = [choice];
	accepted.fire({ inBackground: false });
	accepted.fire({ inBackground: false });
	assert.deepEqual([...writes], [expected], 'A second acceptance during persistence must not duplicate the write');
	await wrote.complete();
	await Promise.resolve();
	assert.equal(disposed, true);
	accepted.fire({ inBackground: false });
	assert.equal(writes.length, 1);

	const settings = resources.add(services.createInstance(AdvisorSettingsModel));
	const loaded = new DeferredPromise<void>();
	resources.add(settings.onDidChange(() => {
		if (settings.fields.some(field => field.kind === 'select' && field.enabled)) { void loaded.complete(); }
	}));
	settings.setVisible(true);
	await loaded.p;
	const field = settings.fields.find(field => field.kind === 'select');
	assert.ok(field?.kind === 'select');
	field.setValue(field.options.find(option => option.label === 'Next Advisor · Default')!.value);
	assert.deepEqual([...writes], [expected, expected]);
});
