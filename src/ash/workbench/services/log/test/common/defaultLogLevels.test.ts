import { CommandService } from '../../../commands/common/commandService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { parseJsonc } from '../../../../../base/common/jsonc.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { LogLevel, ILogService, ILoggerService } from '../../../../../platform/log/common/log.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { ElectronWorkbenchEnvironmentService } from '../../../environment/electron-browser/environmentService.js';
import { IJSONEditingService, JSONEditingError } from '../../../configuration/common/jsonEditing.js';
import '../../../configuration/common/jsonEditingService.js';
import { IWorkingCopyService } from '../../../workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../../workingCopy/browser/browserWorkingCopyService.js';
import { IFileTextModelService } from '../../../textmodelResolver/common/textModelResourceService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IOutputService } from '../../../output/common/output.js';
import { DefaultLogLevelsService, IDefaultLogLevelsService, parseDefaultLogLevels, readDefaultLogLevels } from '../../common/defaultLogLevels.js';
import '../../../../contrib/output/browser/output.contribution.js';

async function fixture(resources: DisposableStore, text?: string, environment = new ElectronWorkbenchEnvironmentService()) {
	const files = resources.add(new FileService());
	const provider = resources.add(new InMemoryFileSystemProvider());
	resources.add(files.registerProvider(environment.argvResource.scheme, provider));
	await files.createDirectory(environment.argvResource.with({ path: '/user' }));
	if (text !== undefined) await files.writeFile({ resource: environment.argvResource, content: text }, { create: true, overwrite: true });
	const failures = resources.add(new Emitter<void>());
	const logger = resources.add(new LogService({ sinks: [{ log: entry => { if (entry.level === LogLevel.Error) failures.fire(); } }] }));
	const parent = workbenchInstantiationService(resources, undefined, {
		fileResources: {
			onDidChange: files.onDidChangeFiles,
			resolve: async request => {
				if (request.bootstrapText !== undefined) return { resource: request.resource, text: request.bootstrapText, revision: undefined };
				const file = await files.readFile(request.resource);
				return { resource: request.resource, text: file.content, revision: file.revision };
			},
			save: async request => ({ revision: (await files.writeFile({ resource: request.resource, content: request.text, expectedRevision: request.expectedRevision }, { create: true, overwrite: request.expectedRevision !== undefined })).revision }),
		}
	});
	const services = resources.add(parent.createChild());
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerInstance(IFileService, files);
	services.registerCollection(new ServiceCollection(...getSingletonServiceDescriptors().filter(([id]) => id === IJSONEditingService)));
	services.registerInstance(IWorkbenchEnvironmentService, environment);
	services.registerInstance(ILogService, logger);
	services.registerInstance(ILoggerService, logger);
	services.registerInstance(IWorkingCopyService, resources.add(services.createInstance(BrowserWorkingCopyService)));
	const initial = await readDefaultLogLevels(files, environment, logger);
	logger.setLevel(initial.default);
	const defaults = resources.add(services.createInstance(DefaultLogLevelsService, initial));
	services.registerInstance(IDefaultLogLevelsService, defaults);
	const output = services.get(IOutputService);
	const channel = resources.add(output.createChannel({ id: 'rendererLog', label: 'Window', kind: 'log', logger: { label: 'Workbench', control: logger } }));
	const read = async () => (await files.readFile(environment.argvResource)).content;
	return { files, provider, logger, services, defaults, output, channel, environment, failures, read };
}

test('startup levels parse canonical spellings, extension identities and invalid boundaries', () => {
	assert.deepEqual(parseDefaultLogLevels(['debug', 'error', 'Publisher.Extension=warn', 'publisher.extension=trace']), { default: LogLevel.Error, extensions: [['publisher.extension', LogLevel.Trace]] });
	for (const invalid of [null, 4, {}, ['info', 1], ['invalid'], ['bad=debug'], ['publisher.extension=invalid']]) assert.throws(() => parseDefaultLogLevels(invalid));
});

test('Output Set As Default persists JSONC and restores global and extension levels on restart', async () => {
	using resources = new DisposableStore();
	const f = await fixture(resources, '{\n  // keep startup options\n  "other": true,\n  "log-level": ["info", "publisher.one=debug"],\n}\n');
	f.logger.setLevel(LogLevel.Trace);
	await f.services.get(ICommandService).executeCommand('workbench.action.output.activeOutputLogLevelDefault');
	assert.equal(f.defaults.getDefaultLogLevel(), LogLevel.Trace);
	assert.match(await f.read(), /\/\/ keep startup options/);
	assert.equal((parseJsonc(await f.read()) as { other: boolean; }).other, true);
	assert.deepEqual(await readDefaultLogLevels(f.files, f.environment, f.logger), { default: LogLevel.Trace, extensions: [['publisher.one', LogLevel.Debug]] });
	using extension = new LogService();
	using channel = f.output.createChannel({ id: 'extension-log', label: 'Extension', extensionId: 'Publisher.One', logger: { label: 'Extension', control: extension } });
	assert.equal(extension.getLevel(), LogLevel.Debug);
	extension.setLevel(LogLevel.Error);
	f.output.selectChannel(channel.id);
	await f.services.get(ICommandService).executeCommand('workbench.action.output.activeOutputLogLevelDefault');
	assert.equal(f.defaults.getDefaultLogLevel('PUBLISHER.ONE'), LogLevel.Error);
	assert.equal(f.defaults.getDefaultLogLevel(), LogLevel.Trace);
	const restart = await readDefaultLogLevels(f.files, f.environment, f.logger);
	assert.deepEqual(restart, { default: LogLevel.Trace, extensions: [['publisher.one', LogLevel.Error]] });
});

test('default changes update inherited loggers, preserve explicit levels and initialize later producers', async () => {
	using resources = new DisposableStore();
	const f = await fixture(resources);
	using inherited = f.logger.createLogger('inherited');
	using manual = f.logger.createLogger('manual');
	manual.setLevel(LogLevel.Off);
	using explicit = f.logger.createLogger('explicit', { logLevel: LogLevel.Info });
	using explicitChannel = f.output.createChannel({ id: 'explicit', label: 'Explicit', logger: { label: 'Explicit', control: explicit } });
	await f.defaults.setDefaultLogLevel(LogLevel.Warning);
	assert.deepEqual([f.logger.getLevel(), inherited.getLevel(), manual.getLevel(), explicit.getLevel()], [LogLevel.Warning, LogLevel.Warning, LogLevel.Off, LogLevel.Info]);
	using later = f.logger.createLogger('later');
	assert.equal(later.getLevel(), LogLevel.Warning);
	await f.defaults.setDefaultLogLevel(LogLevel.Debug, 'publisher.one');
	using extension = f.logger.createLogger('extension', { extensionId: 'Publisher.One' });
	assert.equal(extension.getLevel(), LogLevel.Debug);
});

test('external changes reload defaults, invalid input preserves the last snapshot, and deletion restores startup fallback', async () => {
	using resources = new DisposableStore();
	const f = await fixture(resources);
	const changed = nextEvent(f.defaults.onDidChangeDefaultLogLevels);
	await f.files.writeFile({ resource: f.environment.argvResource, content: '{"log-level":"debug"}' }, { create: true, overwrite: true });
	await changed;
	assert.equal(f.logger.getLevel(), LogLevel.Debug);
	const failed = nextEvent(f.failures.event);
	await f.files.writeFile({ resource: f.environment.argvResource, content: '{"log-level": [' }, { create: true, overwrite: true });
	await failed;
	assert.equal(f.defaults.getDefaultLogLevel(), LogLevel.Debug);
	await assert.rejects(f.defaults.setDefaultLogLevel(LogLevel.Error));
	assert.equal(await f.read(), '{"log-level": [');
	const deleted = nextEvent(f.defaults.onDidChangeDefaultLogLevels);
	await f.files.delete(f.environment.argvResource, 'error', 'fileOrEmptyDirectory');
	await deleted;
	assert.equal(f.defaults.getDefaultLogLevel(), LogLevel.Info);
});

test('startup CLI values take precedence over the saved file and malformed files remain editable', async () => {
	using resources = new DisposableStore();
	const environment = new ElectronWorkbenchEnvironmentService({ logLevel: 'trace', extensionLogLevel: [['publisher.one', 'error']] });
	const f = await fixture(resources, '{"log-level":["warn","publisher.one=debug","publisher.two=off"]}', environment);
	assert.deepEqual(f.defaults.defaultLogLevels, { default: LogLevel.Trace, extensions: [['publisher.one', LogLevel.Error], ['publisher.two', LogLevel.Off]] });
	await f.files.writeFile({ resource: environment.argvResource, content: 'broken' }, { create: true, overwrite: true });
	assert.equal((await readDefaultLogLevels(f.files, environment, f.logger)).default, LogLevel.Trace);
	assert.equal(await f.read(), 'broken');
});

test('JSON editing shares the open model, retains unsaved edits and refuses dirty or invalid documents', async () => {
	using resources = new DisposableStore();
	const f = await fixture(resources, '{"other": 1}\n');
	using reference = await f.services.get(IFileTextModelService).acquire({ resource: f.environment.argvResource }, new AbortController().signal);
	const editing = f.services.get(IJSONEditingService);
	await editing.write(f.environment.argvResource, [{ path: ['value'], value: 2 }], false);
	assert.equal(reference.isDirty, true);
	assert.equal(await f.read(), '{"other": 1}\n');
	await assert.rejects(editing.write(f.environment.argvResource, [{ path: ['value'], value: 3 }], true), /unsaved/);
	await reference.revert(new AbortController().signal);
	await editing.write(f.environment.argvResource, [{ path: ['value'], value: 3 }], true);
	assert.equal(reference.isDirty, false);
	assert.equal((parseJsonc(await f.read()) as { value: number; }).value, 3);
	await f.files.writeFile({ resource: f.environment.argvResource, content: '{ invalid' }, { create: true, overwrite: true });
	await f.services.get(IFileTextModelService).refresh(f.environment.argvResource);
	await assert.rejects(editing.write(f.environment.argvResource, [{ path: ['value'], value: 4 }], true), JSONEditingError);
	assert.equal(await f.read(), '{ invalid');
});

test('disposal ignores an in-flight external reload and retires the file listener', async () => {
	using resources = new DisposableStore();
	const f = await fixture(resources);
	const pending = promiseWithResolvers<Awaited<ReturnType<FileService['readFile']>>>();
	const started = promiseWithResolvers<void>();
	f.files.readFile = async () => { started.resolve(); return pending.promise; };
	await f.files.writeFile({ resource: f.environment.argvResource, content: '{"log-level":"error"}' }, { create: true, overwrite: true });
	await started.promise;
	f.defaults.dispose();
	pending.resolve({ resource: f.environment.argvResource, content: '{"log-level":"error"}', revision: 'late' });
	await pending.promise;
	await Promise.resolve();
	assert.equal(f.defaults.getDefaultLogLevel(), LogLevel.Info);
});

function nextEvent<T>(event: Event<T>): Promise<T> { return new Promise(resolve => Event.once(event)(resolve)); }

test('a failed file save does not publish or apply an uncommitted default level', async () => {
	using resources = new DisposableStore();
	const f = await fixture(resources, '{"log-level":"info","other":true}');
	let events = 0;
	resources.add(f.defaults.onDidChangeDefaultLogLevels(() => events++));
	f.provider.writeFile = async () => { throw new Error('write rejected'); };
	await assert.rejects(f.defaults.setDefaultLogLevel(LogLevel.Error), /write rejected/);
	assert.equal(f.defaults.getDefaultLogLevel(), LogLevel.Info);
	assert.equal(f.logger.getLevel(), LogLevel.Info);
	assert.equal(events, 0);
	assert.equal(await f.read(), '{"log-level":"info","other":true}');
});

test('a new window rereads saved defaults instead of reusing the Main recorder startup snapshot', async () => {
	using resources = new DisposableStore();
	const environment = new ElectronWorkbenchEnvironmentService({ initialLogLevel: LogLevel.Info, extensionLogLevel: [] });
	const f = await fixture(resources, '{"log-level":"warn"}', environment);
	assert.equal(f.logger.getLevel(), LogLevel.Warning);
	await f.defaults.setDefaultLogLevel(LogLevel.Trace);
	assert.equal((await readDefaultLogLevels(f.files, environment, f.logger)).default, LogLevel.Trace);
});
