import { Emitter, type Event } from '../../../base/common/event.js';
import { getPathLabel, type IPathLabelFormatting, type IRelativePathProvider, type IUserHomeProvider } from '../../../base/common/labels.js';
import { operatingSystem, OperatingSystem } from '../../../base/common/platform.js';
import { Schemas } from '../../../base/common/network.js';
import { basename } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../workspace/common/workspace.js';
import { IPathService } from '../../path/common/pathService.js';
import { IRendererHostService, type IRendererHost } from '../../renderer/common/rendererHost.js';

export interface ILabelFormatter {
	readonly scheme: string;
	readonly priority?: number;
	format(resource: URI): string | undefined;
}

export interface IUriLabelOptions {
	readonly relative?: boolean;
	readonly noPrefix?: boolean;
	readonly separator?: string;
}

export interface ILabelFormatterChangeEvent {
	readonly scheme: string;
}

/** Window-scoped URI label service used by ResourceLabels and other Workbench consumers. */
export interface ILabelService extends IDisposable {
	readonly onDidChangeFormatters: Event<ILabelFormatterChangeEvent>;

	getUriLabel(resource: URI, options?: IUriLabelOptions): string;
	getUriBasenameLabel(resource: URI): string;
	getSeparator(resource?: URI): string;
	registerFormatter(formatter: ILabelFormatter): IDisposable;
}

export const ILabelService = createServiceIdentifier<ILabelService>('labelService');

/** Default label service for the current Workbench workspace and host OS. */
export class LabelService extends Disposable implements ILabelService {
	private readonly formatterChangeEmitter = this._register(new Emitter<ILabelFormatterChangeEvent>());
	private readonly formatters = new Map<string, ILabelFormatter[]>();

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
		const formatter = this.formatters.get(resource.scheme)?.[0];
		const formatted = formatter?.format(resource);
		if (formatted !== undefined) return formatted;

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
			...(userHome ? { tildify: { userHome } satisfies IUserHomeProvider } : {}),
		};
		const label = getPathLabel(resource, formatting);
		return options.separator ? replaceSeparators(label, options.separator) : label;
	}

	getUriBasenameLabel(resource: URI): string {
		return basename(resource) || resource.authority || resource.toString();
	}

	getSeparator(resource?: URI): string {
		return this.resourceOperatingSystem(resource) === OperatingSystem.Windows ? '\\' : '/';
	}

	private resourceOperatingSystem(resource?: URI): OperatingSystem {
		if (resource && (resource.scheme !== Schemas.file || resource.path.startsWith('/@browser/'))) {
			return OperatingSystem.Linux;
		}
		return this.host.hasAppServer ? this.host.appServer.operatingSystem ?? OperatingSystem.Linux : operatingSystem;
	}

	registerFormatter(formatter: ILabelFormatter): IDisposable {
		if (!formatter || typeof formatter !== 'object' || typeof formatter.scheme !== 'string' || formatter.scheme.length === 0 || typeof formatter.format !== 'function') {
			throw new TypeError('Label formatter must provide a scheme and format function');
		}
		const entries = this.formatters.get(formatter.scheme) ?? [];
		entries.push(formatter);
		entries.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
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

function replaceSeparators(value: string, separator: string): string {
	if (separator.length === 0) return value;
	return value.replace(/[\\/]/gu, separator);
}
