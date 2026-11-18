import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import type { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IWorkspaceFolder } from './workspace.js';

/** A directory at which a workspace folder can be opened. */
export interface IFolderLocation {
	readonly uri: URI;
	readonly label: string;
	readonly description?: string;
	readonly icon?: ThemeIcon;
}

export interface IResolvedFolderLocation extends IFolderLocation {
	readonly providerId: string;
	readonly builtIn: boolean;
	readonly group?: string;
}

export interface IFolderLocationGroup {
	readonly label: string | undefined;
	readonly locations: readonly IFolderLocation[];
}

/** Lists and verifies alternate directories for a primary folder. */
export interface IWorkspaceFolderLocationProvider {
	readonly id: string;
	readonly label?: string;
	readonly onDidChangeLocations?: Event<void>;
	provideLocations(primary: URI, token: CancellationToken): Promise<IFolderLocation[]>;
	resolveLocation(primary: URI, location: URI, token: CancellationToken): Promise<IFolderLocation | undefined>;
}

export type FolderLocationChangeReason = 'user' | 'programmatic';

export interface IFolderLocationChangeEvent {
	readonly folder: IWorkspaceFolder;
	readonly reason: FolderLocationChangeReason;
}

export const IWorkspaceFolderLocationService = createServiceIdentifier<IWorkspaceFolderLocationService>('workspaceFolderLocationService');

/** Discovers locations and reads the active location from the committed workspace. */
export interface IWorkspaceFolderLocationService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCanSetLocation: Event<void>;
	readonly onDidChangeLocation: Event<IFolderLocationChangeEvent>;
	readonly onDidChangeProviders: Event<void>;
	readonly onDidChangeLocations: Event<void>;
	getLocation(folder: IWorkspaceFolder): IResolvedFolderLocation | undefined;
	isAtAlternateLocation(folder: IWorkspaceFolder): boolean;
	canSetLocation(folder: IWorkspaceFolder): boolean;
	registerProvider(provider: IWorkspaceFolderLocationProvider, options?: { readonly builtIn?: boolean; }): IDisposable;
	getLocations(primary: URI, token: CancellationToken): Promise<IFolderLocation[]>;
	getLocationGroups(primary: URI, token: CancellationToken): Promise<IFolderLocationGroup[]>;
	/** Lists the primary directory first, regardless of the active directory. */
	getFolderLocations(folder: IWorkspaceFolder, token: CancellationToken): Promise<IFolderLocation[]>;
	resolveLocation(primary: URI, location: URI, token: CancellationToken): Promise<IResolvedFolderLocation | undefined>;
}
