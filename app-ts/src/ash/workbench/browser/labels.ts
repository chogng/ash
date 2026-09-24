import { IconLabel, type IconLabelValueOptions } from '../../base/browser/ui/iconlabel/iconlabel.js';
import { getPathLabel, type IRelativePathProvider } from '../../base/common/labels.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, type IDisposable } from '../../base/common/lifecycle.js';
import { basenameOrAuthority, dirnameResource, isEqualResource } from './resourceLabelHelpers.js';
import type { URI } from '../../base/common/uri.js';
import { operatingSystem, OperatingSystem } from '../../base/common/platform.js';
import { createServiceIdentifier } from '../../platform/instantiation/common/instantiation.js';
import { FileKind } from '../../platform/files/common/files.js';
import type { ILabelService } from '../../platform/label/common/labelService.js';
import type { IFileIconThemeService } from '../../platform/theme/browser/fileIconThemeService.js';
import type { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import type { IUntitledTextEditorService } from '../services/untitled/common/untitledTextEditorService.js';
import type { IFileLabelDecoration, IFileLabelDecorationChangeEvent, IFileLabelDecorationService } from '../services/labels/common/fileLabelDecorationService.js';

export interface IResourceLabelProps {
	readonly resource?: URI | { readonly primary?: URI; readonly secondary?: URI };
	readonly name?: string | readonly string[];
	readonly description?: string;
	readonly range?: { readonly startLineNumber: number; readonly endLineNumber?: number };
}

export interface IResourceLabelOptions extends IconLabelValueOptions {
	readonly fileKind?: FileKind;
	readonly fileDecorations?: { readonly colors: boolean; readonly badges: boolean };
	readonly forceLabel?: boolean;
	readonly namePrefix?: string;
	readonly nameSuffix?: string;
}

export interface IFileLabelOptions extends IResourceLabelOptions {
	readonly hideLabel?: boolean;
	readonly hidePath?: boolean;
	readonly range?: { readonly startLineNumber: number; readonly endLineNumber?: number };
}

export interface IResourceLabel extends IDisposable {
	readonly element: HTMLElement;
	readonly onDidRender: Event<void>;

	setLabel(label: string | readonly string[], description?: string, options?: IconLabelValueOptions): void;
	setResource(label: IResourceLabelProps, options?: IResourceLabelOptions): void;
	setFile(resource: URI, options?: IFileLabelOptions): void;
	clear(): void;
}

export interface IResourceLabelsContainer {
	readonly onDidChangeVisibility: Event<boolean>;
}

export const DEFAULT_LABELS_CONTAINER: IResourceLabelsContainer = {
	onDidChangeVisibility: Event.None,
};

export interface ResourceLabelServices {
	readonly workspaceContextService: IWorkspaceContextService;
	readonly fileIconThemeService: IFileIconThemeService;
	readonly untitledTextEditorService?: IUntitledTextEditorService;
	readonly fileLabelDecorationService?: IFileLabelDecorationService;
	readonly labelService?: ILabelService;
}

export interface IResourceLabelService extends IDisposable {
	create(container: HTMLElement, options?: { readonly supportIcons?: boolean }): IResourceLabel;
}

export const IResourceLabelService = createServiceIdentifier<IResourceLabelService>('resourceLabelService');

/** Owns a group of resource labels and keeps them in sync with Workbench state. */
export class ResourceLabels extends Disposable {
	private readonly widgets = new Set<ResourceLabelWidget>();
	private readonly labels = new Set<IResourceLabel>();
	private readonly decorationChangeEmitter = this._register(new Emitter<void>());
	private readonly services: ResourceLabelServices;

	readonly onDidChangeDecorations = this.decorationChangeEmitter.event;

	constructor(
		container: IResourceLabelsContainer = DEFAULT_LABELS_CONTAINER,
		services: ResourceLabelServices,
	) {
		super();
		this.services = services;
		this._register(container.onDidChangeVisibility(visible => {
			for (const widget of this.widgets) widget.setVisibility(visible);
		}));
		this._register(services.workspaceContextService.onDidChangeWorkspace(() => this.rerenderAll()));
		this._register(services.fileIconThemeService.onDidFileIconThemeChange(() => this.rerenderAll(true)));
		if (services.labelService) this._register(services.labelService.onDidChangeFormatters(event => this.rerenderScheme(event.scheme)));
		if (services.untitledTextEditorService) {
			this._register(services.untitledTextEditorService.onDidCreate(() => this.rerenderAll()));
			this._register(services.untitledTextEditorService.onDidChangeLabel(() => this.rerenderAll()));
		}
		if (services.fileLabelDecorationService) this._register(services.fileLabelDecorationService.onDidChange(event => this.onDecorationChange(event)));
	}

	create(container: HTMLElement, options?: { readonly supportIcons?: boolean }): IResourceLabel {
		const widget = new ResourceLabelWidget(container, this.services, options);
		this.widgets.add(widget);
		const label: IResourceLabel = {
			element: widget.element,
			onDidRender: widget.onDidRender,
			setLabel: (value, description, valueOptions) => widget.setLabel(value, description, valueOptions),
			setResource: (value, resourceOptions) => widget.setResource(value, resourceOptions),
			setFile: (resource, fileOptions) => widget.setFile(resource, fileOptions),
			clear: () => widget.clear(),
			dispose: () => this.disposeWidget(widget, label),
			[Symbol.dispose]: () => this.disposeWidget(widget, label),
		};
		this.labels.add(label);
		return label;
	}

	get(index: number): IResourceLabel | undefined {
		return [...this.labels][index];
	}

	clear(): void {
		for (const widget of this.widgets) widget.dispose();
		this.widgets.clear();
		this.labels.clear();
	}

	protected override disposeCore(): void {
		this.clear();
		super.disposeCore();
	}

	private disposeWidget(widget: ResourceLabelWidget, label: IResourceLabel): void {
		if (!this.widgets.delete(widget)) return;
		this.labels.delete(label);
		widget.dispose();
	}

	private rerenderAll(forceIcon = false): void {
		for (const widget of this.widgets) widget.rerender(forceIcon);
	}

	private rerenderScheme(scheme: string): void {
		for (const widget of this.widgets) {
			if (widget.resource?.scheme === scheme) widget.rerender();
		}
	}

	private onDecorationChange(event: IFileLabelDecorationChangeEvent): void {
		if (!event.resources) {
			this.rerenderAll();
			this.decorationChangeEmitter.fire();
			return;
		}
		let changed = false;
		for (const widget of this.widgets) {
			if (widget.resource && event.resources.some(resource => isEqualResource(resource, widget.resource))) {
				widget.rerender();
				changed = true;
			}
		}
		if (changed) this.decorationChangeEmitter.fire();
	}
}

/** Window-scoped factory for consumers that do not need to manage a label group. */
export class ResourceLabelService extends Disposable implements IResourceLabelService {
	private readonly labels: ResourceLabels;

	constructor(services: ResourceLabelServices) {
		super();
		this.labels = this._register(new ResourceLabels(DEFAULT_LABELS_CONTAINER, services));
	}

	create(container: HTMLElement, options?: { readonly supportIcons?: boolean }): IResourceLabel {
		return this.labels.create(container, options);
	}
}

/** Convenience owner for a single resource label. */
export class ResourceLabel extends Disposable implements IResourceLabel {
	private readonly labels: ResourceLabels;
	private readonly label: IResourceLabel;

	readonly element: HTMLElement;
	readonly onDidRender: Event<void>;

	constructor(
		container: HTMLElement,
		services: ResourceLabelServices,
		options?: { readonly supportIcons?: boolean },
	) {
		super();
		this.labels = this._register(new ResourceLabels(DEFAULT_LABELS_CONTAINER, services));
		this.label = this.labels.create(container, options);
		this.element = this.label.element;
		this.onDidRender = this.label.onDidRender;
	}

	setLabel(label: string | readonly string[], description?: string, options?: IconLabelValueOptions): void {
		this.label.setLabel(label, description, options);
	}

	setResource(label: IResourceLabelProps, options?: IResourceLabelOptions): void {
		this.label.setResource(label, options);
	}

	setFile(resource: URI, options?: IFileLabelOptions): void {
		this.label.setFile(resource, options);
	}

	clear(): void {
		this.label.clear();
	}
}

class ResourceLabelWidget extends Disposable {
	private readonly label: IconLabel;
	private readonly renderEmitter = this._register(new Emitter<void>());
	private readonly services: ResourceLabelServices;
	private readonly supportIcons: boolean;
	private current: IResourceLabelProps | undefined;
	private currentOptions: IResourceLabelOptions | undefined;
	private currentTitle: IconLabelValueOptions['title'];
	private currentSuffix: string | undefined;
	private fromFileLabel = false;
	private visible = true;
	private pendingRerender = false;

	readonly element: HTMLElement;
	readonly onDidRender = this.renderEmitter.event;

	get resource(): URI | undefined {
		return resourceOf(this.current);
	}

	constructor(container: HTMLElement, services: ResourceLabelServices, options: { readonly supportIcons?: boolean } | undefined) {
		super();
		this.services = services;
		this.supportIcons = options?.supportIcons === true;
		this.label = this._register(new IconLabel(container, { label: '', supportIcons: this.supportIcons }));
		this.element = this.label.element;
	}

	setLabel(label: string | readonly string[], description?: string, options?: IconLabelValueOptions): void {
		this.current = undefined;
		this.currentOptions = undefined;
		this.currentTitle = undefined;
		this.currentSuffix = undefined;
		this.fromFileLabel = false;
		this.label.setLabel(label, description, {
			...options,
			hideIcon: options?.hideIcon ?? (options?.icon === undefined && options?.renderIcon === undefined),
			supportIcons: options?.supportIcons ?? this.supportIcons,
		});
		this.renderEmitter.fire();
	}

	setFile(resource: URI, options: IFileLabelOptions = {}): void {
		const workspaceFolder = options.fileKind === FileKind.Directory ? workspaceFolderFor(this.services.workspaceContextService, resource) : undefined;
		const name = options.hideLabel
			? undefined
			: workspaceFolder && isEqualResource(workspaceFolder.uri, resource)
				? workspaceFolder.name
				: basenameOrAuthority(resource);
		const description = options.hidePath || workspaceFolder && isEqualResource(workspaceFolder.uri, resource)
			? undefined
			: parentLabel(resource, this.services.workspaceContextService, this.services.labelService);
		this.setResourceInternal({
			resource,
			name,
			description: description && description !== '.' ? description : undefined,
			range: options.range,
		}, options, true);
	}

	setResource(label: IResourceLabelProps, options: IResourceLabelOptions = {}): void {
		this.setResourceInternal(label, options, false);
	}

	private setResourceInternal(label: IResourceLabelProps, options: IResourceLabelOptions, fromFileLabel: boolean): void {
		this.fromFileLabel = fromFileLabel;
		const resource = resourceOf(label);
		const name = applyNameAffixes(label.name, options.namePrefix, options.nameSuffix);
		let description = label.description;
		let title = options.title;
		if (resource && !options.forceLabel && resource.scheme === 'untitled') {
			const untitled = this.services.untitledTextEditorService?.get(resource);
			if (untitled) {
				if (typeof name === 'string') {
					const untitledName = untitled.label;
					if (name === '' || name === basenameOrAuthority(resource)) title = `${untitledName} • ${resource.path}`;
				}
				if (typeof name === 'string' && name === basenameOrAuthority(resource)) description = resource.path;
			}
		}

		const suffix = label.range
			? label.range.endLineNumber && label.range.endLineNumber !== label.range.startLineNumber
				? `:${label.range.startLineNumber}-${label.range.endLineNumber}`
				: `:${label.range.startLineNumber}`
			: options.suffix;

		this.current = Object.freeze({ ...label, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) });
		this.currentTitle = title;
		this.currentSuffix = suffix;
		this.currentOptions = Object.freeze({ ...options });
		this.rerender(true);
	}

	clear(): void {
		this.current = undefined;
		this.currentOptions = undefined;
		this.currentTitle = undefined;
		this.currentSuffix = undefined;
		this.fromFileLabel = false;
		this.label.setLabel('', undefined, { hideIcon: true, supportIcons: this.supportIcons });
		this.renderEmitter.fire();
	}

	setVisibility(visible: boolean): void {
		this.visible = visible;
		if (visible && this.pendingRerender) {
			this.pendingRerender = false;
			this.rerender(true);
		}
	}

	rerender(forceIcon = false): void {
		if (!this.visible) {
			this.pendingRerender = true;
			return;
		}
		const current = this.current;
		if (!current) return;
		const options = this.currentOptions ?? {};
		const resource = resourceOf(current);
		const fileKind = options.fileKind;
		const fileOptions = options as IFileLabelOptions;
		let displayName = current.name;
		let displayDescription = current.description;
		if (this.fromFileLabel && resource) {
			const workspaceFolder = fileKind === FileKind.Directory
				? workspaceFolderFor(this.services.workspaceContextService, resource)
				: undefined;
			const fileName = fileOptions.hideLabel
				? undefined
				: workspaceFolder && isEqualResource(workspaceFolder.uri, resource)
					? workspaceFolder.name
					: basenameOrAuthority(resource);
			displayName = applyNameAffixes(fileName, options.namePrefix, options.nameSuffix);
			displayDescription = fileOptions.hidePath || workspaceFolder && isEqualResource(workspaceFolder.uri, resource)
				? undefined
					: parentLabel(resource, this.services.workspaceContextService, this.services.labelService);
			const untitled = resource.scheme === 'untitled' && !options.forceLabel
				? this.services.untitledTextEditorService?.get(resource)
				: undefined;
			if (untitled && displayName === basenameOrAuthority(resource)) {
				displayName = untitled.label;
				displayDescription = resource.path;
			}
		}
		const decoration = resource && options.fileDecorations
			? this.services.fileLabelDecorationService?.getDecoration(resource, fileKind === FileKind.Directory)
			: undefined;
		const extraClasses = decorationClasses(options, decoration);
		let title = this.currentTitle ?? (resource ? pathLabel(resource, this.services.workspaceContextService, this.services.labelService) : undefined);
		if (decoration?.tooltip) title = title ? `${title} • ${decoration.tooltip}` : decoration.tooltip;
		const renderIcon = resource && !options.hideIcon && !options.icon && fileKind !== FileKind.Directory
			? (container: HTMLSpanElement) => this.services.fileIconThemeService.renderFileIcon(resource, container)
			: undefined;
		const iconOptions: IconLabelValueOptions = {
			...options,
			title,
			extraClasses,
			strikethrough: options.strikethrough || decoration?.strikethrough,
			icon: options.hideIcon ? undefined : options.icon,
			renderIcon,
			reserveIconSpace: options.hideIcon ? false : fileKind !== FileKind.Directory,
			suffix: this.currentSuffix,
			supportIcons: options.supportIcons ?? this.supportIcons,
		};
		this.label.setLabel(displayName ?? '', displayDescription, iconOptions);
		this.renderEmitter.fire();
		void forceIcon;
	}
}

function resourceOf(props: IResourceLabelProps | undefined): URI | undefined {
	if (!props?.resource) return undefined;
	return props.resource instanceof Object && 'primary' in props.resource
		? props.resource.primary
		: props.resource as URI;
}

function workspaceFolderFor(context: IWorkspaceContextService, resource: URI): { readonly uri: URI; readonly name: string } | undefined {
	const folders = context.getWorkspace().folders;
	return folders.find(folder => isResourceInFolder(folder.uri, resource));
}

function isResourceInFolder(folder: URI, resource: URI): boolean {
	if (folder.scheme !== resource.scheme || folder.authority !== resource.authority) return false;
	const folderPath = decodeURIComponent(folder.path).replace(/\/+$/u, '') || '/';
	const resourcePath = decodeURIComponent(resource.path).replace(/\/+$/u, '') || '/';
	if (operatingSystem === OperatingSystem.Windows) return resourcePath.toLowerCase() === folderPath.toLowerCase() || resourcePath.toLowerCase().startsWith(`${folderPath.toLowerCase()}/`);
	return resourcePath === folderPath || resourcePath.startsWith(`${folderPath}/`);
}

function parentLabel(resource: URI, context: IWorkspaceContextService, labelService?: ILabelService): string | undefined {
	const parent = dirnameResource(resource);
	if (!parent) return undefined;
	return pathLabel(parent, context, labelService);
}

function pathLabel(resource: URI, context: IWorkspaceContextService, labelService?: ILabelService): string {
	if (labelService) return labelService.getUriLabel(resource, { relative: true });
	const relative: IRelativePathProvider = {
		getWorkspace: () => context.getWorkspace(),
		getWorkspaceFolder: candidate => workspaceFolderFor(context, candidate) ?? null,
	};
	try {
		return getPathLabel(resource, { os: operatingSystem, relative });
	} catch {
		return resource.toString();
	}
}

function applyNameAffixes(
	name: string | readonly string[] | undefined,
	prefix: string | undefined,
	suffix: string | undefined,
): string | readonly string[] | undefined {
	if (name === undefined) return undefined;
	if (typeof name === 'string') return `${prefix ?? ''}${name}${suffix ?? ''}`;
	if (name.length === 0) return name;
	return [
		...name.slice(0, -1),
		`${prefix ?? ''}${name[name.length - 1] ?? ''}${suffix ?? ''}`,
	];
}

function decorationClasses(options: IResourceLabelOptions, decoration: IFileLabelDecoration | undefined): readonly string[] {
	if (!decoration || !options.fileDecorations) return options.extraClasses ?? [];
	return [
		...(options.extraClasses ?? []),
		...(options.fileDecorations.colors && decoration.colorClassName ? [decoration.colorClassName] : []),
		...(options.fileDecorations.badges && decoration.badgeClassName ? [decoration.badgeClassName] : []),
		...(options.fileDecorations.badges && decoration.iconClassName ? [decoration.iconClassName] : []),
		...(decoration.strikethrough ? ['strikethrough'] : []),
	];
}
