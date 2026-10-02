import { appendIcon } from '../../base/browser/ui/lxicons/lxicon.js';
import { colorCssVariable } from '../../platform/theme/common/colorUtils.js';
import { ILanguageService } from '../../editor/common/languages/language.js';
import { getIconClasses } from '../../editor/common/services/getIconClasses.js';
import { IFileTextModelService } from '../services/textmodelResolver/common/textModelResourceService.js';
import { IconLabel, type IconLabelValueOptions } from '../../base/browser/ui/iconlabel/iconlabel.js';
import { getPathLabel, type IRelativePathProvider } from '../../base/common/labels.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { basenameOrAuthority, dirnameResource, isEqualResource } from './resourceLabelHelpers.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { operatingSystem } from '../../base/common/platform.js';
import { createServiceIdentifier } from '../../platform/instantiation/common/instantiation.js';
import type { IFileIconTheme } from '../../platform/theme/common/themeService.js';
import type { ThemeIcon } from '../../base/common/themables.js';
import { FileKind } from '../../platform/files/common/files.js';
import { ILabelService } from '../../platform/label/common/labelService.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { IUntitledTextEditorService } from '../services/untitled/common/untitledTextEditorService.js';
import { IDecorationsService, type IDecoration, type IResourceDecorationChangeEvent } from '../services/decorations/common/decorations.js';

export interface IResourceLabelProps {
	readonly resource?: URI | { readonly primary?: URI; readonly secondary?: URI };
	readonly name?: string | readonly string[];
	readonly description?: string;
	readonly range?: { readonly startLineNumber: number; readonly endLineNumber?: number };
}

export interface IResourceLabelOptions extends Omit<IconLabelValueOptions, 'icon' | 'iconPath'> {
	readonly icon?: ThemeIcon | URI;
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

/** Renders a resource icon using the active Workbench file icon theme. */
export interface IResourceIconRenderer {
	readonly onDidChangeResourceIcons: Event<void>;
	getFileIconTheme(): IFileIconTheme;
	renderFileIcon(resource: URI, container: HTMLElement, classes?: readonly string[]): void;
}

export const IResourceIconRenderer = createServiceIdentifier<IResourceIconRenderer>('resourceIconRenderer');

export const DEFAULT_LABELS_CONTAINER: IResourceLabelsContainer = {
	onDidChangeVisibility: Event.None,
};

export interface ResourceLabelServices {
	readonly workspaceContextService: IWorkspaceContextService;
	readonly resourceIconRenderer: IResourceIconRenderer;
	readonly untitledTextEditorService?: IUntitledTextEditorService;
	readonly decorationsService?: IDecorationsService;
	readonly labelService?: ILabelService;
	readonly fileModels?: IFileTextModelService;
	readonly languageService?: ILanguageService;
}

export interface IResourceLabelService {
	createGroup(): ResourceLabels;
}

export const IResourceLabelService = createServiceIdentifier<IResourceLabelService>('resourceLabelService');

/** Owns a group of resource labels and keeps them in sync with Workbench state. */
export class ResourceLabels extends Disposable {
	private readonly widgets = new Set<ResourceLabelWidget>();
	private readonly labels = new Set<IResourceLabel>();
	private readonly decorationChangeEmitter = this._register(new Emitter<void>());
	private readonly services: ResourceLabelServices;
	private iconsVisible = true;

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
		this._register(services.resourceIconRenderer.onDidChangeResourceIcons(() => this.rerenderAll(true)));
		if (services.fileModels) {
			this._register(services.fileModels.onModelAdded(model => this.rerenderResource(model.uri)));
			this._register(services.fileModels.onModelRemoved(model => this.rerenderResource(model.uri)));
			this._register(services.fileModels.onModelLanguageChanged(event => this.rerenderResource(event.model.uri)));
		}
		if (services.labelService) this._register(services.labelService.onDidChangeFormatters(event => this.rerenderScheme(event.scheme)));
		if (services.untitledTextEditorService) {
			this._register(services.untitledTextEditorService.onDidCreate(() => this.rerenderAll()));
			this._register(services.untitledTextEditorService.onDidChangeLabel(() => this.rerenderAll()));
		}
		if (services.decorationsService) this._register(services.decorationsService.onDidChangeDecorations(event => this.onDecorationChange(event)));
	}

	create(container: HTMLElement, options?: { readonly supportIcons?: boolean }): IResourceLabel {
		const widget = new ResourceLabelWidget(container, this.services, options);
		widget.setIconVisibility(this.iconsVisible);
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

	setIconVisibility(visible: boolean): void {
		this.iconsVisible = visible;
		for (const widget of this.widgets) widget.setIconVisibility(visible);
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

	private rerenderResource(resource: URI): void {
		for (const widget of this.widgets) {
			if (isEqualResource(widget.resource, resource)) widget.rerender();
		}
	}

	private rerenderScheme(scheme: string): void {
		for (const widget of this.widgets) {
			if (widget.resource?.scheme === scheme) widget.rerender();
		}
	}

	private onDecorationChange(event: IResourceDecorationChangeEvent): void {
		let changed = false;
		for (const widget of this.widgets) {
			if (widget.resource && event.affectsResource(widget.resource)) {
				widget.rerender();
				changed = true;
			}
		}
		if (changed) this.decorationChangeEmitter.fire();
	}
}

/** Assembles label groups; each consumer owns its group's listeners and labels. */
export class ResourceLabelService implements IResourceLabelService {
	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IResourceIconRenderer private readonly resourceIconRenderer: IResourceIconRenderer,
		@IUntitledTextEditorService private readonly untitledTextEditorService: IUntitledTextEditorService,
		@IDecorationsService private readonly decorationsService: IDecorationsService,
		@ILabelService private readonly labelService: ILabelService,
		@IFileTextModelService private readonly fileModels: IFileTextModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {}

	createGroup(): ResourceLabels {
		return new ResourceLabels(DEFAULT_LABELS_CONTAINER, {
			workspaceContextService: this.workspaceContextService,
			resourceIconRenderer: this.resourceIconRenderer,
			untitledTextEditorService: this.untitledTextEditorService,
			decorationsService: this.decorationsService,
			labelService: this.labelService,
			fileModels: this.fileModels,
			languageService: this.languageService,
		});
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
	private readonly decoration = this._register(new MutableDisposable<IDecoration>());
	private readonly renderEmitter = this._register(new Emitter<void>());
	private readonly services: ResourceLabelServices;
	private readonly supportIcons: boolean;
	private current: IResourceLabelProps | undefined;
	private currentOptions: IResourceLabelOptions | undefined;
	private currentTitle: IconLabelValueOptions['title'];
	private currentSuffix: string | undefined;
	private fromFileLabel = false;
	private visible = true;
	private iconsVisible = true;
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
		const { iconPath, ...valueOptions } = options ?? {};
		this.setResourceInternal({ name: label, description }, {
			...valueOptions,
			icon: iconPath ?? options?.icon,
			hideIcon: options?.hideIcon ?? (options?.icon === undefined && iconPath === undefined && options?.renderIcon === undefined),
		}, false);
	}

	setFile(resource: URI, options: IFileLabelOptions = {}): void {
		this.setResourceInternal({ resource, range: options.range }, options, true);
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
		this.decoration.clear();
		this.current = undefined;
		this.currentOptions = undefined;
		this.currentTitle = undefined;
		this.currentSuffix = undefined;
		this.fromFileLabel = false;
		this.label.setLabel('', undefined, { hideIcon: true, supportIcons: this.supportIcons });
		this.renderEmitter.fire();
	}

	setIconVisibility(visible: boolean): void {
		if (this.iconsVisible === visible) return;
		this.iconsVisible = visible;
		this.rerender();
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
				? this.services.workspaceContextService.getWorkspaceFolder(resource)
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
			? this.services.decorationsService?.getDecoration(resource, fileKind === FileKind.Directory)
			: undefined;
		this.decoration.value = decoration;
		const extraClasses = decorationClasses(options, decoration);
		let title = this.currentTitle ?? (resource ? pathLabel(resource, this.services.workspaceContextService, this.services.labelService) : undefined);
		if (decoration?.tooltip) title = title ? `${title} • ${decoration.tooltip}` : decoration.tooltip;
		const hideIcon = !this.iconsVisible || options.hideIcon === true;
		const hasFileIcons = this.services.resourceIconRenderer.getFileIconTheme().hasFileIcons;
		const iconClasses = resource && this.services.fileModels && this.services.languageService
			? getIconClasses(this.services.fileModels, this.services.languageService, resource, FileKind.File)
			: undefined;
		const customIcon = options.icon instanceof URI ? undefined : options.icon;
		const customIconColor = customIcon?.color;
		const renderIcon = customIcon && customIconColor
			? (container: HTMLSpanElement) => { appendIcon(customIcon, container).style.color = `var(${colorCssVariable(customIconColor.id)})`; }
			: options.renderIcon ?? (resource && !hideIcon && !options.icon && hasFileIcons && fileKind !== FileKind.Directory
			? (container: HTMLSpanElement) => this.services.resourceIconRenderer.renderFileIcon(resource, container, iconClasses)
			: undefined);
		const iconOptions: IconLabelValueOptions = {
			...options,
			ariaLabel: decoration?.tooltip ? localize('workbench.explorerDecoratedFile', '{0}, {1}', options.ariaLabel ?? (typeof displayName === 'string' ? displayName : displayName?.join('/')), decoration.tooltip) : options.ariaLabel,
			hideIcon,
			title,
			extraClasses,
			strikethrough: options.strikethrough || decoration?.strikethrough,
			icon: !hideIcon && !customIconColor ? customIcon : undefined,
			iconPath: !hideIcon && options.icon instanceof URI ? options.icon : undefined,
			renderIcon,
			reserveIconSpace: !hideIcon && (options.reserveIconSpace ?? (options.icon !== undefined || resource !== undefined && hasFileIcons && fileKind !== FileKind.Directory)),
			suffix: this.currentSuffix,
			suffixIcon: options.fileDecorations?.badges && decoration?.icon ? decoration.icon : options.suffixIcon,
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

function parentLabel(resource: URI, context: IWorkspaceContextService, labelService?: ILabelService): string | undefined {
	const parent = dirnameResource(resource);
	if (!parent) return undefined;
	return pathLabel(parent, context, labelService);
}

function pathLabel(resource: URI, context: IWorkspaceContextService, labelService?: ILabelService): string {
	if (labelService) return labelService.getUriLabel(resource, { relative: true });
	const relative: IRelativePathProvider = {
		getWorkspace: () => context.getWorkspace(),
		getWorkspaceFolder: candidate => context.getWorkspaceFolder(candidate),
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

function decorationClasses(options: IResourceLabelOptions, decoration: IDecoration | undefined): readonly string[] {
	if (!decoration || !options.fileDecorations) return options.extraClasses ?? [];
	return [
		...(options.extraClasses ?? []),
		...(options.fileDecorations.colors && decoration.labelClassName ? [decoration.labelClassName] : []),
		...(options.fileDecorations.badges && decoration.badgeClassName ? [decoration.badgeClassName] : []),
		...(options.fileDecorations.badges && decoration.iconClassName ? [decoration.iconClassName] : []),
		...(decoration.strikethrough ? ['strikethrough'] : []),
	];
}
