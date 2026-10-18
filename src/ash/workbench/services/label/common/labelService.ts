import {
	ILabelService, type ResourceLabelFormatter, type IFormatterChangeEvent, type IUriLabelOptions,
} from '../../../../platform/label/common/label.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { getRemoteWorkspacePath, isWindowsRemotePath } from '../../../../platform/remote/common/remote.js';
import { Emitter } from '../../../../base/common/event.js';
import {
	getPathLabel, normalizeDriveLetter, type IPathLabelFormatting, type IRelativePathProvider, type IUserHomeProvider,
} from '../../../../base/common/labels.js';
import { operatingSystem, OperatingSystem } from '../../../../base/common/platform.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { IRendererHostService, type IRendererHost } from '../../../../platform/renderer/common/rendererHost.js';

/** Formats resources using their execution owner's path conventions. */
export class LabelService extends Disposable implements ILabelService {
	private readonly formatterChangeEmitter = this._register(new Emitter<IFormatterChangeEvent>());
	private readonly formatters = new Map<string, ResourceLabelFormatter[]>();

	readonly onDidChangeFormatters = this.formatterChangeEmitter.event;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly paths: IPathService,
		@IRendererHostService private readonly host: IRendererHost,
	) {
		super();
		const subscription = host.appServer.onConnectionState(() => this.formatterChangeEmitter.fire({ scheme: Schemas.file }));
		this._register(toDisposable(() => subscription.dispose()));
	}

	getUriLabel(resource: URI, options: IUriLabelOptions = {}): string {
		const formatter = this.formatters.get(resource.scheme)?.find(candidate => !candidate.authority || candidate.authority === resource.authority);

		const relative: IRelativePathProvider | undefined = options.relative
			? {
				noPrefix: options.noPrefix,
				getWorkspace: () => this.workspaceContextService.getWorkspace(),
				getWorkspaceFolder: candidate => this.workspaceContextService.getWorkspaceFolder(candidate),
			}
			: undefined;
		const home = this.paths.resolvedUserHome;
		const userHome = home?.scheme === resource.scheme && home.authority === resource.authority && !resource.path.startsWith('/@browser/') ? home : undefined;
		const formatting: IPathLabelFormatting = {
			os: this.resourceOperatingSystem(resource),
			...(relative ? { relative } : {}),
			...(!options.noPrefix && userHome && (!formatter || formatter.formatting.tildify) ? { tildify: { userHome } satisfies IUserHomeProvider } : {}),
		};
		let label = getPathLabel(resource, formatting);
		if (formatter?.formatting.normalizeDriveLetter) {
			label = normalizeDriveLetter(label.replace(/^[\\/](?=[a-z]:)/i, ''), true);
		}
		const pathSeparator = formatting.os === OperatingSystem.Windows ? '\\' : '/';
		const separator = options.separator ?? formatter?.formatting.separator ?? pathSeparator;
		const formatted = label.split(pathSeparator).join(separator);
		if (relative && this.workspaceContextService.getWorkspaceFolder(resource)) return formatted;
		if (!formatter) return formatted;
		const path = label.split(pathSeparator).join('/');
		const replacements = { path, scheme: resource.scheme, authority: resource.authority };
		return formatter.formatting.label
			.replace(/\$\{(path|scheme|authority)\}/g, (_match, key: keyof typeof replacements) => replacements[key])
			.replaceAll('/', separator);
	}

	getUriBasenameLabel(resource: URI): string {
		const formatter = this.formatters.get(resource.scheme)?.find(candidate => !candidate.authority || candidate.authority === resource.authority);
		if (formatter) {
			const label = this.getUriLabel(resource);
			return label.split(formatter.formatting.separator || this.getSeparator(resource.scheme, resource.authority)).filter(Boolean).at(-1) ?? label;
		}
		return basename(resource) || resource.authority || resource.toString();
	}

	getSeparator(scheme: string, authority?: string): '/' | '\\' {
		const formatter = this.formatters.get(scheme)?.find(candidate => !candidate.authority || candidate.authority === authority);
		if (formatter?.formatting.separator) return formatter.formatting.separator;
		if (scheme === Schemas.ashRemote) {
			const folder = this.workspaceContextService.getWorkspace().folders.find(folder => folder.uri.scheme === scheme && folder.uri.authority === authority);
			return folder && isWindowsRemotePath(getRemoteWorkspacePath(folder.uri)) ? '\\' : '/';
		}
		return scheme === Schemas.file && this.resourceOperatingSystem() === OperatingSystem.Windows ? '\\' : '/';
	}

	private resourceOperatingSystem(resource?: URI): OperatingSystem {
		if (resource?.scheme === Schemas.ashRemote) {
			return isWindowsRemotePath(getRemoteWorkspacePath(resource)) ? OperatingSystem.Windows : OperatingSystem.Linux;
		}
		if (resource && (resource.scheme !== Schemas.file || resource.path.startsWith('/@browser/'))) {
			return OperatingSystem.Linux;
		}
		return this.host.hasAppServer ? this.host.appServer.operatingSystem ?? OperatingSystem.Linux : operatingSystem;
	}

	registerFormatter(formatter: ResourceLabelFormatter): IDisposable {
		if (!formatter || typeof formatter !== 'object'
			|| typeof formatter.scheme !== 'string' || formatter.scheme.length === 0
			|| typeof formatter.formatting?.label !== 'string'
			|| !['/', '\\', ''].includes(formatter.formatting.separator)) {
			throw new TypeError('Label formatter must provide a scheme, label and separator');
		}
		const entries = this.formatters.get(formatter.scheme) ?? [];
		entries.push(formatter);
		entries.sort((left, right) => Number(right.priority ?? false) - Number(left.priority ?? false));
		this.formatters.set(formatter.scheme, entries);
		this.formatterChangeEmitter.fire({ scheme: formatter.scheme });
		let disposed = false;
		return {
			dispose: () => {
				if (disposed) return;
				disposed = true;
				const current = this.formatters.get(formatter.scheme);
				if (!current) return;
				const index = current.indexOf(formatter);
				if (index < 0) return;
				current.splice(index, 1);
				if (current.length === 0) this.formatters.delete(formatter.scheme);
				this.formatterChangeEmitter.fire({ scheme: formatter.scheme });
			},
			[Symbol.dispose](): void {
				this.dispose();
			},
		};
	}
}

registerSingleton(ILabelService, LabelService, InstantiationType.Delayed);
