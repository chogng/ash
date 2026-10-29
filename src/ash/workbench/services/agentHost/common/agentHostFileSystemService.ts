import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { AgentHostFileSystemProvider, type IRemoteFilesystemConnection } from '../../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import { IFileService, type IFileSystemProvider } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IAgentHostFileSystemService = createDecorator<IAgentHostFileSystemService>('agentHostFileSystemService');

export interface IAgentHostFileSystemService {
	/** Registers a host scope's connection without transferring its ownership. */
	registerAuthority(authority: string, connection: IRemoteFilesystemConnection): IDisposable;
}

/**
 * Owns the workspace host's file registrations. Providers remain borrowed: the
 * runtime that created them owns their backend connections and disposal.
 */
export class AgentHostFileSystemService extends Disposable implements IAgentHostFileSystemService {
	private readonly authorities = this._register(new DisposableStore());

	constructor(
		private readonly provider: AgentHostFileSystemProvider,
		localProvider: IFileSystemProvider | undefined,
		@IFileService fileService: IFileService,
	) {
		super();
		try {
			this._register(fileService.registerProvider(Schemas.file, localProvider ?? provider));
			this._register(fileService.registerProvider(Schemas.ashRemote, provider));
		} catch (error) {
			// A failed second registration must not leave a partially mounted host.
			this.dispose();
			throw error;
		}
	}

	registerAuthority(authority: string, connection: IRemoteFilesystemConnection): IDisposable {
		this.assertNotDisposed();
		const registration = this.authorities.add(this.provider.registerAuthority(authority, connection));
		return toDisposable(() => {
			this.authorities.delete(registration);
			registration.dispose();
		});
	}
}
