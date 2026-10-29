import { posix, win32 } from '../../../../../base/common/path.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { withRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';

/** Resolves terminal output using that process's cwd, home and execution authority. */
export class TerminalLinkResolver {
	constructor(@IFileService private readonly files: IFileService) { }

	async resolveLink(
		processManager: {
			readonly initialCwd: string;
			readonly os: OperatingSystem;
			readonly remoteAuthority?: string;
			readonly userHome?: string;
		},
		link: string,
		uri?: URI,
	): Promise<{ uri: URI; link: string; isDirectory: boolean; } | null> {
		const windows = processManager.os === OperatingSystem.Windows;
		const rules = windows ? win32 : posix;
		try {
			let path = link;
			if (uri) {
				if (uri.scheme !== Schemas.file || uri.query || uri.fragment || /%2f/i.test(uri.toEncodedComponents().path)) return null;
				if (!windows && uri.authority) return null;
				path = uri.authority ? `//${uri.authority}${uri.path}` : windows ? uri.path.replace(/^\/(?=[a-z]:\/)/i, '') : uri.path;
			}
			if (windows) {
				if (/^\\\\[?.]\\UNC\\/i.test(path)) path = '\\\\' + path.slice(8);
				else if (/^\\\\[?.]\\[a-z]:[\\/]/i.test(path)) path = path.slice(4);
				else if (/^\\\\[?.]\\/.test(path)) return null;
				// A terminal link cannot borrow the renderer's per-drive working directory.
				if (/^[a-z]:(?![\\/])/i.test(path)) return null;
			}
			if (path.startsWith('~/') || windows && path.startsWith('~\\')) {
				if (!processManager.userHome || !rules.isAbsolute(processManager.userHome)) return null;
				path = rules.join(processManager.userHome, path.slice(2));
			}
			const resolved = rules.resolve(processManager.initialCwd, path);
			let resource: URI;
			if (processManager.remoteAuthority) {
				resource = withRemoteWorkspacePath(URI.from({ scheme: Schemas.ashRemote, authority: processManager.remoteAuthority, path: '/' }), resolved);
			} else {
				const slashes = windows ? resolved.replaceAll('\\', '/') : resolved;
				const share = windows ? /^\/\/([^/]+)(\/.*)$/.exec(slashes) : null;
				resource = URI.from({ scheme: Schemas.file, authority: share?.[1] ?? '', path: share?.[2] ?? slashes });
			}
			const stat = await this.files.stat(resource);
			return stat.kind === FileKind.File || stat.kind === FileKind.Directory
				? { uri: resource, link, isDirectory: stat.kind === FileKind.Directory }
				: null;
		} catch { return null; }
	}
}
