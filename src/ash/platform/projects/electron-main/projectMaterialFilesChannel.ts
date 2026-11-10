import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { isValidBasename } from '../../../base/common/extpath.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { DiskFileSystemProviderChannel } from '../../files/electron-main/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../../files/node/diskFileSystemProvider.js';
import { projectMaterialFilesKey, projectMaterialFilesLocation, projectMaterialFilesRoot, projectMaterialFilesScheme } from '../common/projectMaterialFiles.js';

/** A local capability scoped to Ash's project material paths and create-only writes. */
export class ProjectMaterialFilesChannel extends Disposable implements IServerChannel<string> {
	private readonly lifetime = this._register(new MutableDisposable<DisposableStore>());
	private current: { readonly root: URI; readonly channel: DiskFileSystemProviderChannel; } | undefined;

	constructor(
		private readonly profile: URI,
		private readonly acceptsContext: (context: string) => boolean,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { super(); }

	async call<T>(context: string, command: string, value: unknown, token = CancellationToken.None): Promise<T> {
		this.checkContext(context);
		if (!['stat', 'readFile', 'writeFile'].includes(command) || !isRecord(value)) throw new TypeError('Invalid project file operation');
		if (command === 'writeFile' && (!isRecord(value.options) || value.options.create !== true || value.options.overwrite !== false
			|| Object.keys(value.options).length !== 2)) throw new TypeError('Project file copies may only be created');
		const resource = this.parseResource(value.resource);
		if (resource.authority !== projectMaterialFilesKey(this.root().fsPath)) await this.configuration.reloadConfiguration();
		const { channel, target } = this.resolve(resource);
		return channel.call(context, command, { ...value, resource: target.toString() }, token);
	}

	listen<T>(context: string, event: string, value?: unknown): Event<T> {
		this.checkContext(context);
		if (event === 'fileChange' || event === 'watch') return Event.None;
		if (event !== 'readFileStream' || !isRecord(value)) throw new TypeError('Invalid project file event');
		const { channel, target } = this.resolve(this.parseResource(value.resource));
		return channel.listen(context, event, { ...value, resource: target.toString() });
	}

	private checkContext(context: string): void {
		this.assertNotDisposed();
		if (!this.acceptsContext(context)) throw new Error('Project files are unavailable in this window');
	}

	private root(): URI {
		return projectMaterialFilesRoot(this.profile, this.configuration.getValue<string>(projectMaterialFilesLocation));
	}

	private parseResource(value: unknown): URI {
		if (typeof value !== 'string' || value.length > 1024) throw new TypeError('Invalid project file resource');
		const resource = URI.parse(value);
		const [, project, file, name, extra] = resource.path.split('/');
		if (resource.scheme !== projectMaterialFilesScheme || resource.query || resource.fragment || extra !== undefined
			|| !/^[a-f0-9]{40}$/u.test(project) || !/^[a-f0-9]{40}$/u.test(file)
			|| !isValidBasename(name, true) || Buffer.byteLength(name) > 200) throw new TypeError('Invalid project file path');
		return resource;
	}

	private resolve(resource: URI): { readonly channel: DiskFileSystemProviderChannel; readonly target: URI; } {
		const root = this.root();
		if (resource.authority !== projectMaterialFilesKey(root.fsPath)) throw new CancellationError();
		if (this.current?.root.toString() !== root.toString()) {
			const resources = new DisposableStore();
			const provider = resources.add(new DiskFileSystemProvider([root]));
			this.current = { root, channel: resources.add(new DiskFileSystemProviderChannel(provider, root, root)) };
			this.lifetime.value = resources;
		}
		return { channel: this.current.channel, target: URI.joinPath(root, resource.path) };
	}
}
