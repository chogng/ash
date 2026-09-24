import { Emitter } from '../../../../base/common/event.js';
import type { KeybindingEvent } from '../../../../base/common/keybindings.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { operatingSystem, OperatingSystem } from '../../../../base/common/platform.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { KeyboardConfiguration } from '../../../../platform/keyboardLayout/common/keyboardConfiguration.js';
import {
	KeyboardDispatchMode,
	keyboardMappingsEqual,
	type IKeyboardLayoutDefinition,
	type IKeyboardLayoutInfo,
	type IKeyboardLayoutProvider,
	type IKeyboardLayoutService,
	type IKeyboardMapper,
	type IKeyboardMapperConfiguration,
	type IKeyboardMapping,
	type IKeyboardMappingEntry,
} from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { FallbackKeyboardMapper } from '../common/fallbackKeyboardMapper.js';
import { CachedKeyboardMapper } from '../common/keyboardMapper.js';
import {
	copyKeyboardMapping,
	createKeyboardMappingFromLabels,
	getKeyboardMappingValue,
	observeKeyboardMapping,
} from '../common/keyboardMapping.js';
import { MacLinuxKeyboardMapper } from '../common/macLinuxKeyboardMapper.js';
import { WindowsKeyboardMapper } from '../common/windowsKeyboardMapper.js';
import { findMatchingBuiltinLayout, loadBuiltinKeyboardLayouts } from './builtinKeyboardLayouts.js';

interface KeyboardLayoutMapLike extends Iterable<readonly [string, string]> {
	get(code: string): string | undefined;
}

interface NavigatorKeyboardLike {
	getLayoutMap(): Promise<KeyboardLayoutMapLike>;
	addEventListener?(type: 'layoutchange', listener: () => void): void;
	removeEventListener?(type: 'layoutchange', listener: () => void): void;
}

type NavigatorWithKeyboard = Navigator & {
	readonly keyboard?: NavigatorKeyboardLike;
};

export interface BrowserKeyboardLayoutServiceOptions {
	readonly navigator: Navigator;
	readonly configurationService?: IConfigurationService;
	readonly layoutProvider?: IKeyboardLayoutProvider;
	/** Profile-scoped user layout. It participates only in explicit selection. */
	readonly userLayoutProvider?: IKeyboardLayoutProvider;
	readonly operatingSystem?: OperatingSystem;
	readonly dispatch?: KeyboardDispatchMode;
	readonly mapAltGrToCtrlAlt?: boolean;
	/** A native or user-provided layout takes precedence over the browser API. */
	readonly layout?: IKeyboardLayoutDefinition;
	readonly additionalLayouts?: readonly IKeyboardLayoutDefinition[];
}

/** Owns browser layout discovery and publishes immutable mapper snapshots. */
export class BrowserKeyboardLayoutService extends Disposable implements IKeyboardLayoutService {
	private readonly _onDidChangeKeyboardLayout = this._register(new Emitter<void>());
	private readonly navigator: NavigatorWithKeyboard;
	private readonly operatingSystem: OperatingSystem;
	private readonly configurationService: IConfigurationService | undefined;
	private readonly layoutProvider: IKeyboardLayoutProvider | undefined;
	private readonly userLayoutProvider: IKeyboardLayoutProvider | undefined;
	private readonly dispatchOverride: KeyboardDispatchMode | undefined;
	private readonly mapAltGrOverride: boolean | undefined;
	private configuration: IKeyboardMapperConfiguration;
	private readonly configuredLayout: IKeyboardLayoutDefinition | undefined;
	private readonly additionalLayouts: readonly IKeyboardLayoutDefinition[];
	private builtinLayouts: readonly IKeyboardLayoutDefinition[] = [];
	private nativeLayout: IKeyboardLayoutDefinition | undefined;
	private userLayout: IKeyboardLayoutDefinition | undefined;
	private mapping: IKeyboardMapping | undefined;
	private layout: IKeyboardLayoutInfo;
	private mapper: IKeyboardMapper;
	private refreshing: Promise<void> | undefined;
	private refreshPending = false;

	public readonly onDidChangeKeyboardLayout = this._onDidChangeKeyboardLayout.event;

	constructor(options: BrowserKeyboardLayoutServiceOptions) {
		super();
		this.navigator = options.navigator as NavigatorWithKeyboard;
		this.operatingSystem = options.operatingSystem ?? operatingSystem;
		this.configurationService = options.configurationService;
		this.layoutProvider = options.layoutProvider;
		this.userLayoutProvider = options.userLayoutProvider;
		this.dispatchOverride = options.dispatch;
		this.mapAltGrOverride = options.mapAltGrToCtrlAlt;
		this.configuration = Object.freeze({
			dispatch: options.dispatch ?? options.configurationService?.getValue<KeyboardDispatchMode>(KeyboardConfiguration.dispatch) ?? KeyboardDispatchMode.Code,
			mapAltGrToCtrlAlt: options.mapAltGrToCtrlAlt ?? options.configurationService?.getValue<boolean>(KeyboardConfiguration.mapAltGrToCtrlAlt) ?? false,
		});
		this.configuredLayout = options.layout;
		this.additionalLayouts = options.additionalLayouts ?? [];
		this.mapping = options.layout?.mapping;
		this.layout = options.layout?.layout ?? this.fallbackLayout();
		this.mapper = this.createMapper();
		this._register(toDisposable(() => {
			this.mapping = undefined;
		}));
		this.listenForLayoutChanges();
		this.listenForProvidedLayoutChanges();
		this.listenForConfigurationChanges();
		void this.refreshKeyboardLayout();
	}

	public getRawKeyboardMapping(): IKeyboardMapping | undefined {
		return this.mapping;
	}

	public getCurrentKeyboardLayout(): IKeyboardLayoutInfo {
		return this.layout;
	}

	public getAllKeyboardLayouts(): readonly IKeyboardLayoutInfo[] {
		const layouts = [
			this.layout,
			...(this.configuredLayout ? [this.configuredLayout.layout] : []),
			...(this.nativeLayout ? [this.nativeLayout.layout] : []),
			...(this.userLayout ? [this.userLayout.layout] : []),
			...this.builtinLayouts.map((definition) => definition.layout),
			...this.additionalLayouts.map((definition) => definition.layout),
		];
		const unique = new Map<string, IKeyboardLayoutInfo>();
		for (const layout of layouts) {
			if (!unique.has(layout.id)) {
				unique.set(layout.id, layout);
			}
		}
		return [...unique.values()];
	}

	public getKeyboardMapper(): IKeyboardMapper {
		return this.mapper;
	}

	public getKeyboardMapperConfiguration(): IKeyboardMapperConfiguration {
		return this.configuration;
	}

	public validateCurrentKeyboardMapping(event: KeybindingEvent): void {
		if (this.hasExplicitLayoutSelection() || this.layout.source === 'native' || this.layout.source === 'user' || !this.navigator.keyboard || !this.mapping || !event.code || event.isComposing) {
			return;
		}
		const entry = this.mapping[event.code];
		const expected = getKeyboardMappingValue(
			entry,
			{ ...event, altGraphKey: event.altGraphKey },
			this.configuration.mapAltGrToCtrlAlt,
		);
		const isDeadKey = event.key === 'Dead';
		if (isDeadKey || (!expected && (event.shiftKey || event.altGraphKey))) {
			this.acceptObservedMapping(event);
			return;
		}
		if (!expected || expected.toLocaleLowerCase('en-US') !== event.key.toLocaleLowerCase('en-US')) {
			if (event.shiftKey || event.altGraphKey) {
				this.acceptObservedMapping(event);
			} else {
				void this.refreshKeyboardLayout();
			}
		}
	}

	public refreshKeyboardLayout(): Promise<void> {
		if (this.isDisposed) {
			return Promise.resolve();
		}
		if (this.refreshing) {
			this.refreshPending = true;
			return this.refreshing;
		}
		const refreshing = this.refreshUntilStable().finally(() => {
			if (this.refreshing === refreshing) {
				this.refreshing = undefined;
			}
		});
		this.refreshing = refreshing;
		return refreshing;
	}

	private async refreshUntilStable(): Promise<void> {
		do {
			this.refreshPending = false;
			await this.refreshLayout();
		} while (this.refreshPending && !this.isDisposed);
	}

	private async refreshLayout(): Promise<void> {
		await this.loadBuiltinLayouts();
		await this.readProvidedLayout();
		if (this.selectConfiguredLayout()) {
			return;
		}
		if (!this.navigator.keyboard) {
			this.installFallback();
			return;
		}
		await this.readKeyboardLayout();
	}

	private async readProvidedLayout(): Promise<void> {
		const [nativeLayout, userLayout] = await Promise.all([
			this.readLayoutProvider(this.layoutProvider),
			this.readLayoutProvider(this.userLayoutProvider),
		]);
		if (!this.isDisposed) {
			this.nativeLayout = nativeLayout;
			this.userLayout = userLayout;
		}
	}

	private async readLayoutProvider(
		provider: IKeyboardLayoutProvider | undefined,
	): Promise<IKeyboardLayoutDefinition | undefined> {
		if (!provider) {
			return undefined;
		}
		try {
			return await provider.readKeyboardLayout();
		} catch {
			return undefined;
		}
	}

	private async loadBuiltinLayouts(): Promise<void> {
		const layouts = await loadBuiltinKeyboardLayouts(this.operatingSystem);
		if (this.isDisposed || layouts === this.builtinLayouts) {
			return;
		}
		this.builtinLayouts = layouts;
		this._onDidChangeKeyboardLayout.fire();
	}

	private listenForLayoutChanges(): void {
		const keyboard = this.navigator.keyboard;
		if (!keyboard?.addEventListener) {
			return;
		}
		const handleLayoutChange = () => {
			void this.refreshKeyboardLayout();
		};
		keyboard.addEventListener('layoutchange', handleLayoutChange);
		this._register(toDisposable(() => keyboard.removeEventListener?.('layoutchange', handleLayoutChange)));
	}

	private listenForProvidedLayoutChanges(): void {
		for (const provider of [this.layoutProvider, this.userLayoutProvider]) {
			if (!provider) {
				continue;
			}
			this._register(provider.onDidChangeKeyboardLayout(() => {
				void this.refreshKeyboardLayout();
			}));
		}
	}

	private listenForConfigurationChanges(): void {
		if (!this.configurationService) {
			return;
		}
		this._register(this.configurationService.onDidChangeConfiguration((event) => {
			const mapperChanged = event.affectsConfiguration(KeyboardConfiguration.dispatch) ||
				event.affectsConfiguration(KeyboardConfiguration.mapAltGrToCtrlAlt);
			if (mapperChanged) {
				this.configuration = Object.freeze({
					dispatch: this.dispatchOverride ?? this.configurationService!.getValue<KeyboardDispatchMode>(KeyboardConfiguration.dispatch),
					mapAltGrToCtrlAlt: this.mapAltGrOverride ??
						this.configurationService!.getValue<boolean>(KeyboardConfiguration.mapAltGrToCtrlAlt),
				});
				this.mapper = this.createMapper();
				this._onDidChangeKeyboardLayout.fire();
			}
			if (event.affectsConfiguration(KeyboardConfiguration.layout)) {
				if (!this.selectConfiguredLayout()) {
					this.installFallback();
					void this.refreshKeyboardLayout();
				}
			}
		}));
	}

	private async readKeyboardLayout(): Promise<void> {
		try {
			const keyboard = this.navigator.keyboard;
			if (!keyboard) {
				return;
			}
			const layoutMap = await keyboard.getLayoutMap();
			if (this.isDisposed) {
				return;
			}
			const labels = new Map<string, string>();
			for (const [code, label] of layoutMap) {
				if (code && label) {
					labels.set(code, label);
				}
			}
			const browserMapping = createKeyboardMappingFromLabels(labels);
			const matchedLayout = findMatchingBuiltinLayout(browserMapping, this.builtinLayouts);
			if (matchedLayout) {
				this.installLayout(matchedLayout.layout, matchedLayout.mapping);
				return;
			}
			const nextMapping = preserveObservedStates(browserMapping, this.mapping);
			const language = this.navigator.language || 'unknown';
			const nextLayout: IKeyboardLayoutInfo = {
				id: `browser.${language}`,
				label: language,
				source: 'browser',
				operatingSystem: this.operatingSystem,
			};
			this.installLayout(nextLayout, nextMapping);
		} catch {
			// Focus and iframe permission rules can temporarily deny getLayoutMap().
		}
	}

	private acceptObservedMapping(event: KeybindingEvent): void {
		if (!this.mapping) {
			return;
		}
		const nextMapping = observeKeyboardMapping(this.mapping, event);
		this.installLayout(this.layout, nextMapping);
	}

	private installLayout(layout: IKeyboardLayoutInfo, mapping: IKeyboardMapping): void {
		if (this.layout.id === layout.id && keyboardMappingsEqual(this.mapping, mapping)) {
			return;
		}
		this.layout = layout;
		this.mapping = mapping;
		this.mapper = this.createMapper();
		this._onDidChangeKeyboardLayout.fire();
	}

	private installFallback(): void {
		const fallback = this.fallbackLayout();
		if (this.layout.id === fallback.id && !this.mapping) {
			return;
		}
		this.layout = fallback;
		this.mapping = undefined;
		this.mapper = this.createMapper();
		this._onDidChangeKeyboardLayout.fire();
	}

	private selectConfiguredLayout(): boolean {
		const requested = this.configurationService?.getValue<string>(KeyboardConfiguration.layout) ?? 'autodetect';
		if (requested === 'autodetect') {
			if (this.configuredLayout) {
				this.installLayout(this.configuredLayout.layout, this.configuredLayout.mapping);
				return true;
			}
			if (this.nativeLayout) {
				this.installLayout(this.nativeLayout.layout, this.nativeLayout.mapping);
				return true;
			}
			return false;
		}
		const definitions = [
			...(this.configuredLayout ? [this.configuredLayout] : []),
			...(this.userLayout ? [this.userLayout] : []),
			...(this.nativeLayout ? [this.nativeLayout] : []),
			...this.builtinLayouts,
			...this.additionalLayouts,
		];
		const selected = definitions.find((definition) => definition.layout.id === requested);
		if (!selected) {
			return false;
		}
		this.installLayout(selected.layout, selected.mapping);
		return true;
	}

	private hasExplicitLayoutSelection(): boolean {
		const requested = this.configurationService?.getValue<string>(KeyboardConfiguration.layout) ?? 'autodetect';
		return requested !== 'autodetect' || Boolean(this.configuredLayout);
	}

	private createMapper(): IKeyboardMapper {
		if (!this.mapping || Object.keys(this.mapping).length === 0) {
			return new CachedKeyboardMapper(new FallbackKeyboardMapper(this.configuration, this.operatingSystem));
		}
		const mapper = this.operatingSystem === OperatingSystem.Windows
			? new WindowsKeyboardMapper(this.mapping, this.configuration)
			: new MacLinuxKeyboardMapper(this.mapping, this.configuration, this.operatingSystem);
		return new CachedKeyboardMapper(mapper);
	}

	private fallbackLayout(): IKeyboardLayoutInfo {
		return {
			id: 'fallback.us',
			label: 'US keyboard fallback',
			source: 'fallback',
			operatingSystem: this.operatingSystem,
			isUSStandard: true,
		};
	}
}

function preserveObservedStates(
	nextMapping: IKeyboardMapping,
	previousMapping: IKeyboardMapping | undefined,
): IKeyboardMapping {
	if (!previousMapping) {
		return nextMapping;
	}
	const merged = copyKeyboardMapping(nextMapping);
	for (const [code, next] of Object.entries(merged)) {
		const previous = previousMapping[code];
		if (!previous || previous.value !== next.value) {
			continue;
		}
		merged[code] = preserveEntryStates(next, previous);
	}
	return Object.freeze(merged);
}

function preserveEntryStates(next: IKeyboardMappingEntry, previous: IKeyboardMappingEntry): IKeyboardMappingEntry {
	return {
		...next,
		withShift: previous.withShift || next.withShift,
		withAltGr: previous.withAltGr || next.withAltGr,
		withShiftAltGr: previous.withShiftAltGr || next.withShiftAltGr,
		withShiftIsDeadKey: previous.withShiftIsDeadKey,
		withAltGrIsDeadKey: previous.withAltGrIsDeadKey,
		withShiftAltGrIsDeadKey: previous.withShiftAltGrIsDeadKey,
	};
}
