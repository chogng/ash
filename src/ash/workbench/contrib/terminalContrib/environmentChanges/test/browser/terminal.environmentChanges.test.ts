import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, type IReference } from '../../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../../base/common/platform.js';
import Severity from '../../../../../../base/common/severity.js';
import { URI } from '../../../../../../base/common/uri.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelService, type IResolvedTextEditorModel } from '../../../../../../editor/common/services/resolverService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { MergedEnvironmentVariableCollection } from '../../../../../../platform/terminal/common/environmentVariableCollection.js';
import { ITerminalProcessService } from '../../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { TextModelResolverService } from '../../../../../services/textmodelResolver/common/textModelResolverService.js';
import { ITextModelResourceService } from '../../../../../services/textmodelResolver/common/textModelResourceService.js';
import { ITerminalService, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { TerminalStatusList } from '../../../../terminal/browser/terminalStatusList.js';
import { IEnvironmentVariableService } from '../../../../terminal/common/environmentVariable.js';
import { EnvironmentVariableService } from '../../../../terminal/common/environmentVariableService.js';
import { TerminalCommandId } from '../../../../terminal/common/terminal.js';
import { TerminalEnvironmentChangesContribution } from '../../browser/terminal.environmentChanges.contribution.js';

function fixture(owner: DisposableStore) {
	const services = owner.add(new InstantiationService());
	const workspace = owner.add(new TestWorkspaceService({ id: 'workspace', uri: URI.file('/workspace') }));
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IStorageService, { get: () => undefined, store: () => { } } as unknown as IStorageService);
	services.registerInstance(ITerminalProcessService, { operatingSystem: OperatingSystem.Linux } as ITerminalProcessService);
	const environment = owner.add(services.createInstance(EnvironmentVariableService));
	services.registerInstance(IEnvironmentVariableService, environment);
	const state = owner.add(new Emitter<'running'>());
	const statuses = owner.add(new TerminalStatusList());
	let snapshot: MergedEnvironmentVariableCollection | undefined;
	const instance = {
		dirId: 'workspace', shellLaunchConfig: {}, statusList: statuses, onDidChangeState: state.event,
		get extEnvironmentVariableCollection() { return snapshot; },
	} as unknown as ITerminalInstance;
	services.registerInstance(ITerminalService, { activeInstance: instance } as ITerminalService);
	const set = (value: string) => environment.set('extension.test', {
		persistent: true,
		map: new Map([['PATH', { variable: 'PATH', value, type: 3 }]]),
	});
	return {
		services, environment, instance, state, statuses, set,
		capture: () => { snapshot = new MergedEnvironmentVariableCollection(environment.collections); },
		forget: () => { snapshot = undefined; }
	};
}

test('environment status compares retained launch mutations and never guesses an unknown snapshot', () => {
	using owner = new DisposableStore();
	const context = fixture(owner);
	context.set('original:');
	context.capture();
	using contribution = context.services.createInstance(TerminalEnvironmentChangesContribution, { instance: context.instance });
	assert.deepEqual(context.statuses.statuses, []);
	context.set('future:');
	assert.equal(context.statuses.primary?.severity, Severity.Warning);
	context.capture();
	context.state.fire('running');
	assert.deepEqual(context.statuses.statuses, []);
	context.forget();
	context.state.fire('running');
	assert.equal(context.statuses.primary?.severity, Severity.Info);
	assert.match(context.statuses.primary!.tooltip, /no retained/);
	contribution.dispose();
	assert.deepEqual(context.statuses.statuses, []);
});

test('environment details use read-only reference-counted models and keep values out of resource URLs', async () => {
	using owner = new DisposableStore();
	const context = fixture(owner);
	context.set('original:');
	context.capture();
	context.set('future:');
	context.services.registerInstance(ITextModelResourceService, { acquire: async () => { throw new Error('Virtual content must not read files'); } } as unknown as ITextModelResourceService);
	const resolver = context.services.createInstance(TextModelResolverService);
	context.services.registerInstance(ITextModelService, resolver);
	context.services.registerInstance(IModelService, {
		createModel: (text: string, _language: unknown, resource: URI) => owner.add(new TextModel(text, { resource, languageId: 'markdown' })),
	} as unknown as IModelService);
	const opened: { resource: URI; reference: IReference<IResolvedTextEditorModel>; }[] = [];
	context.services.registerInstance(IEditorService, {
		openEditor: async (input: { resource: URI; readOnly?: boolean; }) => {
			assert.equal(input.readOnly, true);
			assert.equal(input.resource.fragment, '');
			assert.equal(input.resource.query, '');
			opened.push({ resource: input.resource, reference: await resolver.createModelReference(input.resource) });
		},
	} as unknown as IEditorService);
	using commands = new CommandService(context.services);
	await commands.executeCommand(TerminalCommandId.ShowEnvironmentContributions);
	const first = opened[0]!;
	const content = first.reference.object.textEditorModel.getValue();
	assert.match(content, /original:/);
	assert.match(content, /future:/);
	assert.match(content, /not a live reading/);
	assert.equal(first.reference.object.textEditorModel.isDisposed(), false);
	assert.equal(resolver.canHandleResource(first.resource), true);
	context.forget();
	await commands.executeCommand(TerminalCommandId.ShowEnvironmentContributions);
	const second = opened[1]!;
	assert.match(second.reference.object.textEditorModel.getValue(), /snapshot is unavailable/);
	assert.doesNotMatch(second.reference.object.textEditorModel.getValue(), /original:/);
	assert.equal(first.reference.object.textEditorModel.getValue(), content, 'An open details editor remains an immutable snapshot');
	for (const item of opened) {
		const model = item.reference.object.textEditorModel;
		item.reference.dispose();
		assert.equal(resolver.canHandleResource(item.resource), false);
		assert.equal(model.isDisposed(), true);
	}
});
