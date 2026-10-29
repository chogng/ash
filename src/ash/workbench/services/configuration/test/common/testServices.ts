import type { IAnyWorkspaceIdentifier, IWorkspace } from '../../../../../platform/workspace/common/workspace.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FileNotFoundError, type IFileService } from '../../../../../platform/files/common/files.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ConfigurationModelParser } from '../../../../../platform/configuration/common/configurationModels.js';
import { UserDataProfileService } from '../../../userDataProfile/browser/userDataProfileService.js';
import { WorkspaceService, type WorkspaceServiceOptions } from '../../browser/configurationService.js';

const resource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' });
const log = new NullLoggerService();

/** Real file provider for settings tests, including creation, revisions and watch notifications. */
export class TestConfigurationFiles extends FileService {
	private readonly ready: Promise<void>;
	constructor(source = '{}\n') {
		super();
		const provider = this._register(new InMemoryFileSystemProvider());
		this._register(this.registerProvider(Schemas.vscodeUserData, provider));
		this.ready = this.createDirectory(resource.with({ path: '/user' })).then(async () => {
			if (!this.isDisposed) await super.writeFile({ resource, content: source }, { create: true, overwrite: false });
		});
	}

	override async stat(...args: Parameters<FileService['stat']>) {
		await this.ready;
		return super.stat(...args);
	}

	override async readFile(...args: Parameters<FileService['readFile']>) {
		await this.ready;
		return super.readFile(...args);
	}

	async emit(source: string): Promise<void> {
		await this.ready;
		await this.writeFile({ resource, content: source }, { create: true, overwrite: true });
	}
}

interface TestOptions extends WorkspaceServiceOptions {
	readonly source?: string;
	readonly files?: IFileService;
}

function prepare(options: TestOptions) {
	const files = options.files ?? new TestConfigurationFiles(options.source);
	const parser = new ConfigurationModelParser('test settings', log);
	parser.parse(options.source ?? '{}');
	if (parser.errors.length) throw new TypeError('Invalid test settings');
	return { files, options: { ...options, initialConfiguration: options.initialConfiguration ?? parser.configurationModel.toJSON() } };
}

async function read(files: IFileService) {
	try { const file = await files.readFile(resource); return { source: file.content, revision: file.revision }; }
	catch (error) { if (error instanceof FileNotFoundError) return { source: '{}\n', revision: undefined }; throw error; }
}

async function write(files: IFileService, source: string, expectedRevision?: string) {
	const previous = await read(files);
	await files.createDirectory(resource.with({ path: '/user' }));
	await files.writeFile({ resource, content: source, expectedRevision: expectedRevision ?? previous.revision }, { create: true, overwrite: previous.revision !== undefined });
}

/** Test composition only; production resolves required services through DI. */
export function testConfigurationService(Service: typeof WorkspaceService) {
	class Fixture extends Service {
		readonly fileService: IFileService;
		constructor(options: TestOptions = {}) {
			const prepared = prepare(options);
			super(prepared.options, prepared.files, log, new UserDataProfileService());
			this.fileService = prepared.files;
			if (!options.files) this._register(prepared.files as TestConfigurationFiles);
		}
		read() { return read(this.fileService); }
		async write(source: string, expectedRevision?: string) {
			await write(this.fileService, source, expectedRevision);
			await this.reloadConfiguration();
			return this.read();
		}
	}
	// Descriptors own the returned fixture. A factory constructor avoids inheriting
	// the production constructor's DI parameters into this explicit test composition.
	return function (options: TestOptions = {}) {
		return new Fixture(options);
	} as unknown as new (options?: TestOptions) => Fixture;
}

export const TestConfigurationService = testConfigurationService(WorkspaceService);
export type TestConfigurationService = InstanceType<typeof TestConfigurationService>;

/** Workspace-only tests still exercise the production context and own the settings provider. */
export class TestWorkspaceService extends TestConfigurationService {
	constructor(workspace: IAnyWorkspaceIdentifier | IWorkspace) {
		super({ workspace });
	}
}
