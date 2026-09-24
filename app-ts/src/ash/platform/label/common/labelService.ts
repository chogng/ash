import { Emitter, type Event } from '../../../base/common/event.js';
import { getPathLabel, type IPathLabelFormatting, type IRelativePathProvider, type IUserHomeProvider } from '../../../base/common/labels.js';
import { operatingSystem, type OperatingSystem } from '../../../base/common/platform.js';
import type { URI } from '../../../base/common/uri.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IWorkspaceContextService } from '../../workspace/common/workspace.js';

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
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly os: OperatingSystem = operatingSystem,
		private readonly userHome?: URI,
	) {
		super();
	}

	getUriLabel(resource: URI, options: IUriLabelOptions = {}): string {
		const formatter = this.formatters.get(resource.scheme)?.[0];
		const formatted = formatter?.format(resource);
		if (formatted !== undefined) return formatted;

		const relative: IRelativePathProvider | undefined = options.relative
			? {
				noPrefix: options.noPrefix,
				getWorkspace: () => this.workspaceContextService.getWorkspace(),
				getWorkspaceFolder: candidate => this.workspaceContextService.getWorkspace().folders.find(folder => isResourceInFolder(folder.uri, candidate)) ?? null,
			}
			: undefined;
		const formatting: IPathLabelFormatting = {
			os: this.os,
			...(relative ? { relative } : {}),
			...(this.userHome ? { tildify: { userHome: this.userHome } satisfies IUserHomeProvider } : {}),
		};
		const label = getPathLabel(resource, formatting);
		return options.separator ? replaceSeparators(label, options.separator) : label;
	}

	getUriBasenameLabel(resource: URI): string {
		const path = decodeURIComponent(resource.path).replace(/\/+$/u, '');
		return path.slice(path.lastIndexOf('/') + 1) || resource.authority || resource.toString();
	}

	getSeparator(_resource?: URI): string {
		return this.os === 'windows' ? '\\' : '/';
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

function isResourceInFolder(folder: URI, resource: URI): boolean {
	if (folder.scheme !== resource.scheme || folder.authority !== resource.authority) return false;
	const folderPath = decodeURIComponent(folder.path).replace(/\/+$/u, '') || '/';
	const resourcePath = decodeURIComponent(resource.path).replace(/\/+$/u, '') || '/';
	if (operatingSystem === 'windows') {
		const comparableFolder = folderPath.toLowerCase();
		const comparableResource = resourcePath.toLowerCase();
		return comparableResource === comparableFolder || comparableResource.startsWith(`${comparableFolder}/`);
	}
	return resourcePath === folderPath || resourcePath.startsWith(`${folderPath}/`);
}

function replaceSeparators(value: string, separator: string): string {
	if (separator.length === 0) return value;
	return value.replace(/[\\/]/gu, separator);
}
