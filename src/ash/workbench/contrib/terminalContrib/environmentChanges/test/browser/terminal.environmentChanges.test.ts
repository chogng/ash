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
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { MarshalledId } from '../../../../../../base/common/marshallingIds.js';
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
	const commands = owner.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const workspace = owner.add(new TestWorkspaceService({ id: 'workspace', uri: URI.file('/workspace') }));
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IStorageService, { get: () => undefined, store: () => { } } as unknown as IStorageService);
	services.registerInstance(ITerminalProcessService, { operatingSystem: OperatingSystem.Linux } as ITerminalProcessService);
	const environment = owner.add(services.createInstance(EnvironmentVariableService));
	services.registerInstance(IEnvironmentVariableService, environment);
	const state = owner.add(new Emitter<'running' | 'reconnecting'>());
	const statuses = owner.add(new TerminalStatusList());
	let snapshot: MergedEnvironmentVariableCollection | undefined;
	const instance = {
		instanceId: 1, state: 'running',
		resource: URI.from({ scheme: 'vscode-terminal', path: '/fixture/1' }),
		dirId: 'workspace', shellLaunchConfig: {}, statusList: statuses, onDidChangeState: state.event,
		get extEnvironmentVariableCollection() { return snapshot; },
	} as unknown as ITerminalInstance;
	const terminals = { activeInstance: instance, instances: [instance] };
	services.registerInstance(ITerminalService, terminals as unknown as ITerminalService);
	const set = (value: string) => environment.set('extension.test', {
		persistent: true,
		map: new Map([['PATH', { variable: 'PATH', value, type: 3 }]]),
	});
	return {
		services, commands, environment, instance, state, statuses, terminals, set,
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

test('environment relaunch actions retain their instance and retire when relaunch is unavailable', async () => {
	using owner = new DisposableStore();
	const context = fixture(owner);
	context.set('original:');
	context.capture();
	using contribution = context.services.createInstance(TerminalEnvironmentChangesContribution, { instance: context.instance });
	context.set('future:');
	const status = context.statuses.primary!;
	assert.equal(status.hoverActions?.[0]?.commandId, TerminalCommandId.Relaunch);
	assert.match(status.detailedTooltip!, /Show Environment Contributions/);
	context.terminals.activeInstance = { ...context.instance, instanceId: 2 };
	let acknowledge!: (request: unknown) => void;
	const request = new Promise<unknown>(resolve => { acknowledge = resolve; });
	using command = CommandsRegistry.register(TerminalCommandId.Relaunch, (_accessor, target) => { acknowledge(target); });
	status.hoverActions![0]!.run();
	assert.deepEqual(await request, { $mid: MarshalledId.TerminalContext, instanceId: 1 });
	Object.assign(context.instance, { state: 'reconnecting' });
	context.state.fire('reconnecting');
	assert.equal(context.statuses.primary?.hoverActions, undefined);
	Object.assign(context.instance, { state: 'running', isReadOnly: true });
	context.state.fire('running');
	assert.equal(context.statuses.primary?.hoverActions, undefined);
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
	const other = { ...context.instance, resource: URI.from({ scheme: 'vscode-terminal', path: '/fixture/2' }), extEnvironmentVariableCollection: undefined };
	context.terminals.activeInstance = other;
	context.terminals.instances.push(other);
	await commands.executeCommand(TerminalCommandId.ShowEnvironmentContributions, context.instance.resource);
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
	await assert.rejects(commands.executeCommand(TerminalCommandId.ShowEnvironmentContributions, 'invalid'), /Invalid terminal instance context/);
	await assert.rejects(commands.executeCommand(TerminalCommandId.ShowEnvironmentContributions, URI.from({ scheme: 'vscode-terminal', path: '/closed' })), /This terminal has been closed/);
	for (const item of opened) {
		const model = item.reference.object.textEditorModel;
		item.reference.dispose();
		assert.equal(resolver.canHandleResource(item.resource), false);
		assert.equal(model.isDisposed(), true);
	}
});
