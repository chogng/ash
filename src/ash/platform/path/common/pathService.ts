import type { URI } from '../../../base/common/uri.js';
import type { OperatingSystem } from '../../../base/common/platform.js';
import type { IPath } from '../../../base/common/path.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const IPathService = createServiceIdentifier<IPathService>('pathService');

/** Selects path semantics for the filesystem that owns a resource. */
export interface IPathService {
	readonly path: Promise<IPath>;
	/** Actual ambient home, absent when the connection has no OS user directory. */
	readonly resolvedUserHome: URI | undefined;
	userHome(options: { preferLocal: true; }): URI;
	userHome(options?: { preferLocal: boolean; }): Promise<URI>;
	getPath(resource: URI): Promise<IPath | undefined>;
	/** Converts an absolute App Server path without applying the renderer's separator rules. */
	fileURI(path: string): Promise<URI>;
	/** Unknown schemes and browser-owned handles do not identify a host operating system. */
	getOperatingSystem(resource: URI): Promise<OperatingSystem | undefined>;
	hasValidBasename(resource: URI, basename?: string): Promise<boolean>;
}
