import { extUri } from '../../../../base/common/resources.js';
import { environment } from '../../../../base/common/platform.js';
import { FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { parseUserKeybindings } from '../common/keybindingIO.js';
import { parseContextKeyExpression } from '../../../../platform/contextkey/common/contextKeyExpressionParser.js';
import { ResolvedKeybindingItem } from '../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import type { IUserFriendlyKeybinding } from '../../../../platform/keybinding/common/keybinding.js';
import { localize } from '../../../../nls.js';
import { type JsonSchema } from '../../../../base/common/jsonSchema.js';
import { JsonSchemasRegistry } from '../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { type KeybindingsSchemaContribution } from '../../../../platform/keybinding/common/keybinding.js';
import { addDisposableListener } from "../../../../base/browser/dom.js";
import { getWindows, onDidRegisterWindow, onWillUnregisterWindow } from "../../../../base/browser/window.js";
import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import {
	isModifierKey,
	StandardKeyboardEvent,
} from "../../../../base/browser/keyboardEvent.js";
import { Emitter } from "../../../../base/common/event.js";
import { getErrorMessage } from "../../../../base/common/errors.js";
import { IME } from "../../../../base/common/ime.js";
import {
	getKeybindingLabel,
} from "../../../../base/common/keybindingLabels.js";
import { parseKeybinding } from "../../../../base/common/keybindingParser.js";
import {
	type Keybinding,
	KeybindingChordKind,
	type KeybindingEvent,
	ResolvedKeybinding,
} from "../../../../base/common/keybindings.js";
import {
	combinedDisposable,
	Disposable,
	DisposableMap,
	DisposableStore,
	MutableDisposable,
	type IDisposable,

	toDisposable,
} from "../../../../base/common/lifecycle.js";
import type {
	CommandId,
	ICommandService,
} from "../../../../platform/commands/common/commands.js";
import { type Context, type IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { type IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import {
	IKeybindingService,
	KeybindingContextKeys,
} from "../../../../platform/keybinding/common/keybinding.js";
import {
	KeybindingResolveKind,
	KeybindingResolver,
	type KeybindingResolveResult,
} from "../../../../platform/keybinding/common/keybindingResolver.js";
import {
	KeybindingRuleKind,
	KeybindingSource,
	type KeybindingRegistry,
	KeybindingsRegistry,
} from "../../../../platform/keybinding/common/keybindingsRegistry.js";
import type {
	IKeyboardLayoutService,
} from "../../../../platform/keyboardLayout/common/keyboardLayout.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import type {
	IStatusbarEntryAccessor,
	IStatusbarService,
} from "../../statusbar/browser/statusbar.js";
import { StatusbarAlignment } from "../../statusbar/browser/statusbar.js";
import type { IKeyboardShortcutTroubleshootingService } from "../common/keyboardShortcutTroubleshooting.js";

export { KeybindingContextKeys } from "../../../../platform/keybinding/common/keybinding.js";

export interface WorkbenchKeybindingServiceOptions {
	readonly ownerDocument: Document;
	readonly commandService: ICommandService;
	readonly contextKeyService: IContextKeyService;
	readonly keyboardLayoutService: IKeyboardLayoutService;
	readonly statusbarService?: IStatusbarService;
	readonly registry?: KeybindingRegistry;
	readonly chordTimeoutMs?: number;
}

/**
 * Window-scoped product service that combines keybinding contributions,
 * keyboard layout mapping, ContextKey scopes, command execution, and browser
 * event lifecycle.
 */
export class WorkbenchKeybindingService
	extends Disposable
	implements IKeybindingService, IKeyboardShortcutTroubleshootingService {
	private userBindings: readonly IUserFriendlyKeybinding[] = [];
	private readonly userRegistration = this._register(new MutableDisposable<IDisposable>());
	private readonly registry: KeybindingRegistry;
	private loadQueue: Promise<void> = Promise.resolve();
	private readonly schemaContributions = new Map<KeybindingsSchemaContribution, IDisposable | undefined>();
	private readonly schemaRegistration = this._register(new MutableDisposable<IDisposable>());
	private readonly ownerWindow: Window;
	private readonly commandService: ICommandService;
	private readonly contextKeyService: IContextKeyService;
	private readonly keyboardLayoutService: IKeyboardLayoutService;
	private readonly statusbarService: IStatusbarService | undefined;
	private readonly resolver: KeybindingResolver;
	private readonly chordTimeoutMs: number;
	private readonly _onDidUpdateKeybindings = this._register(new Emitter<void>());
	private readonly _onDidLog = this._register(new Emitter<string>());
	private readonly chordTimeout = this._register(new MutableDisposable<IDisposable>());
	private readonly chordStatus = this._register(
		new MutableDisposable<IStatusbarEntryAccessor>(),
	);
	private readonly windowListeners = this._register(new DisposableMap<Window, DisposableStore>());
	private readonly inChordModeKey: IContextKey<boolean>;
	private readonly isComposingKey: IContextKey<boolean>;
	private currentEvents: KeybindingEvent[] = [];
	private singleModifierCandidate: SingleModifierKey | undefined;
	private disabledIme = false;
	private troubleshootingEnabled = false;

	readonly onDidUpdateKeybindings = this._onDidUpdateKeybindings.event;
	readonly onDidLog = this._onDidLog.event;

	constructor(
		options: WorkbenchKeybindingServiceOptions,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly files: IFileService,
		@IUserDataProfileService private readonly profiles: IUserDataProfileService,
	) {
		super();
		const ownerWindow = options.ownerDocument.defaultView;
		if (!ownerWindow) throw new Error("WorkbenchKeybindingService requires an owner window");
		this.ownerWindow = ownerWindow;
		this.commandService = options.commandService;
		this.contextKeyService = options.contextKeyService;
		this.keyboardLayoutService = options.keyboardLayoutService;
		this.statusbarService = options.statusbarService;
		this.registry = options.registry ?? KeybindingsRegistry;
		this.resolver = new KeybindingResolver({
			registry: this.registry,
			resolveKeybinding: (keybinding) => this.keyboardLayoutService
				.getKeyboardMapper()
				.resolveKeybinding(keybinding),
		});
		this.chordTimeoutMs = options.chordTimeoutMs ?? 5_000;
		this.inChordModeKey = KeybindingContextKeys.inChordMode.bindTo(
			this.contextKeyService,
		);
		this.isComposingKey = KeybindingContextKeys.isComposing.bindTo(
			this.contextKeyService,
		);

		this._register(toDisposable(() => {
			this.leaveChordMode();
			this.isComposingKey.reset();
		}));
		this._register(this.resolver.onDidChangeKeybindings(() => {
			this._onDidUpdateKeybindings.fire();
		}));
		this._register(this.keyboardLayoutService.onDidChangeKeyboardLayout(() => {
			this.leaveChordMode();
			this._onDidUpdateKeybindings.fire();
		}));
		this.updateKeybindingsSchema();
		this._register(JsonSchemasRegistry.registerAssociation(profiles.currentProfile.keybindingsResource, 'ash://schemas/keybindings'));
		this._register(files.onDidChangeFiles(event => {
			if (!event.resources || event.resources.some(resource => extUri.isEqual(resource, profiles.currentProfile.keybindingsResource))) {
				void this.initialize().catch(error => notificationService.warning(localize({ bundle: 'ash', key: 'keybindings.invalid' }, 'Could not load keybindings.json: {0}', getErrorMessage(error))));
			}
		}));
		this._register(toDisposable(() => {
			for (const listener of this.schemaContributions.values()) listener?.dispose();
			this.schemaContributions.clear();
		}));
		this.attachWindow(this.ownerWindow);
		for (const { window } of getWindows()) this.attachWindow(window);
		this._register(onDidRegisterWindow(({ window }) => this.attachWindow(window)));
		this._register(onWillUnregisterWindow(({ window }) => this.windowListeners.deleteAndDispose(window)));
	}

	/** Called by the window owner after service registration; file events use the same load queue. */
	public initialize(): Promise<void> {
		const result = this.loadQueue.then(async () => {
			if (this.isDisposed) {
				return;
			}
			let source: string;
			try { source = (await this.files.readFile(this.profiles.currentProfile.keybindingsResource)).content; }
			catch (error) {
				if (!(error instanceof FileNotFoundError)) {
					throw error;
				}
				source = '[]';
			}
			const bindings = parseUserKeybindings(source);
			if (this.isDisposed || JSON.stringify(bindings) === JSON.stringify(this.userBindings)) {
				return;
			}
			const registrations: IDisposable[] = [];
			for (const binding of bindings) {
				const key = this.userKey(binding);
				if (key === null) {
					continue;
				}
				const keybinding = parseKeybinding(key)!;
				const when = binding.when ? parseContextKeyExpression(binding.when) : undefined;
				registrations.push(binding.command === null
					? this.registry.registerKeybindingBlocker({ keybinding, when, source: KeybindingSource.User })
					: this.registry.registerKeybindingRule({ command: binding.command, keybinding, when, args: binding.args === undefined ? undefined : [binding.args], source: KeybindingSource.User }));
			}
			this.userBindings = bindings;
			this.userRegistration.value = combinedDisposable(...registrations);
			this._onDidUpdateKeybindings.fire();
		});
		this.loadQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	public getKeybindings(): readonly ResolvedKeybindingItem[] {
		const defaults = this.registry.getKeybindings().filter(rule => rule.source !== KeybindingSource.User).map(rule =>
			new ResolvedKeybindingItem(this.resolveKeybinding(rule.keybinding), rule.kind === KeybindingRuleKind.Command ? rule.command : null,
				rule.kind === KeybindingRuleKind.Command ? rule.args?.[0] : undefined, rule.when, true, null, true));
		const users = this.userBindings.map((entry, index) => {
			const key = this.userKey(entry);
			return new ResolvedKeybindingItem(key === null ? undefined : this.resolveUserBinding(key), entry.command, entry.args,
				entry.when ? parseContextKeyExpression(entry.when) : undefined, false, null, false,
				{ index, entry });
		});
		return [...defaults, ...users];
	}

	private userKey(binding: IUserFriendlyKeybinding): string | null {
		switch (environment.os) {
			case 'mac': return binding.mac === undefined ? binding.key : binding.mac;
			case 'windows': return binding.win === undefined ? binding.key : binding.win;
			case 'linux': return binding.linux === undefined ? binding.key : binding.linux;
			case 'unknown': return binding.key;
		}
	}

	public registerSchemaContribution(contribution: KeybindingsSchemaContribution): IDisposable {
		this.assertNotDisposed();
		if (this.schemaContributions.has(contribution)) throw new Error('Keybinding schema contribution is already registered');
		const listener = contribution.onDidChange?.(() => this.updateKeybindingsSchema());
		this.schemaContributions.set(contribution, listener);
		this.updateKeybindingsSchema();
		return toDisposable(() => {
			if (!this.schemaContributions.delete(contribution)) return;
			listener?.dispose();
			this.updateKeybindingsSchema();
		});
	}

	private updateKeybindingsSchema(): void {
		const keybindingsSchema: JsonSchema = {
			type: 'object',
			properties: {
				key: { type: 'string' },
				command: { type: ['string', 'null'] },
				when: { type: 'string' },
				args: {},
			},
			allOf: [...this.schemaContributions.keys()].flatMap(contribution => contribution.getSchemaAdditions()),
		};
		this.schemaRegistration.clear();
		this.schemaRegistration.value = JsonSchemasRegistry.registerSchema('ash://schemas/keybindings', {
			type: 'array',
			items: keybindingsSchema,
		});
	}

	private attachWindow(targetWindow: Window): void {
		if (this.windowListeners.has(targetWindow)) return;
		const listeners = new DisposableStore();
		this.windowListeners.set(targetWindow, listeners);
		const document = targetWindow.document;
		listeners.add(addDisposableListener(document, "keydown", (event: KeyboardEvent) => this.dispatchEvent(event), true));
		listeners.add(addDisposableListener(document, "keyup", (event: KeyboardEvent) => this.dispatchKeyupEvent(event), true));
		listeners.add(addDisposableListener(document, "compositionstart", () => {
			this.isComposingKey.set(true);
			this.singleModifierCandidate = undefined;
			this.leaveChordMode();
		}, true));
		listeners.add(addDisposableListener(document, "compositionend", () => this.isComposingKey.set(false), true));
		listeners.add(addDisposableListener(targetWindow, "blur", () => {
			this.singleModifierCandidate = undefined;
			this.leaveChordMode();
		}));
	}

	get inChordMode(): boolean {
		return this.currentEvents.length > 0;
	}

	get enabled(): boolean {
		return this.troubleshootingEnabled;
	}

	toggle(): boolean {
		this.troubleshootingEnabled = !this.troubleshootingEnabled;
		this._onDidLog.fire(
			`Keyboard shortcuts troubleshooting ${this.troubleshootingEnabled ? "enabled" : "disabled"}.`,
		);
		return this.troubleshootingEnabled;
	}

	resolveKeybinding(keybinding: Keybinding): ResolvedKeybinding {
		const resolved = this.keyboardLayoutService
			.getKeyboardMapper()
			.resolveKeybinding(keybinding);
		if (!resolved[0]) {
			throw new Error("Keyboard mapper could not resolve the keybinding");
		}
		return resolved[0];
	}

	resolveUserBinding(
		userBinding: string,
	): ResolvedKeybinding | undefined {
		const keybinding = parseKeybinding(userBinding);
		return keybinding ? this.resolveKeybinding(keybinding) : undefined;
	}

	lookupKeybindings(
		command: CommandId,
		context: Context = this.contextKeyService,
	): readonly ResolvedKeybinding[] {
		return this.resolver.lookupKeybindings(command, context);
	}

	lookupKeybinding(
		command: CommandId,
		context: Context = this.contextKeyService,
	): ResolvedKeybinding | undefined {
		return this.resolver.lookupKeybinding(command, context);
	}

	/**
	 * Dispatches one native event and returns whether a keybinding consumed it.
	 */
	dispatchEvent(browserEvent: KeyboardEvent): boolean {
		if (this.contextKeyService.getContext(keyboardEventTarget(browserEvent)).getValue(KeybindingContextKeys.isRecording.key)) {
			this.singleModifierCandidate = undefined;
			this.leaveChordMode();
			return false;
		}
		const event = new StandardKeyboardEvent(browserEvent);
		const nextEvent: KeybindingEvent = {
			key: event.key,
			code: event.code,
			keyCode: event.keyCode,
			scanCode: event.scanCode,
			location: event.location,
			ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
			altGraphKey: event.altGraphKey,
			isComposing: event.isComposing,
		};
		this.logTroubleshooting(`Keydown: ${formatKeyboardEvent(nextEvent)}`);
		this.keyboardLayoutService.validateCurrentKeyboardMapping(nextEvent);
		if (isModifierKey(browserEvent)) {
			this.singleModifierCandidate = singleModifierCandidate(event);
			this.logTroubleshooting(
				this.singleModifierCandidate
					? `Modifier candidate: ${this.singleModifierCandidate}`
					: "Modifier key is not eligible for a single-modifier binding.",
			);
			return false;
		}
		if (this.singleModifierCandidate) {
			this.logTroubleshooting(
				`Modifier candidate cancelled: ${this.singleModifierCandidate} was used with another key.`,
			);
		}
		this.singleModifierCandidate = undefined;
		if (
			event.isComposing ||
			(event.altGraphKey && !this.keyboardLayoutService.getKeyboardMapperConfiguration().mapAltGrToCtrlAlt) ||
			event.key === "Process"
		) {
			return false;
		}

		const dispatchEvent = toDispatchEvent(
			this.keyboardLayoutService.getKeyboardMapper().resolveKeyboardEvent(nextEvent),
			nextEvent,
		);
		this.logTroubleshooting(`Mapper: ${formatKeyboardEvent(dispatchEvent)}`);
		return this.dispatchResolvedEvent(browserEvent, event, dispatchEvent);
	}

	/** Dispatches a modifier-only binding after the key is released unused. */
	dispatchKeyupEvent(browserEvent: KeyboardEvent): boolean {
		if (this.contextKeyService.getContext(keyboardEventTarget(browserEvent)).getValue(KeybindingContextKeys.isRecording.key)) {
			this.singleModifierCandidate = undefined;
			return false;
		}
		if (!isModifierKey(browserEvent)) {
			return false;
		}
		const released = modifierKey(browserEvent.key);
		const candidate = this.singleModifierCandidate;
		this.singleModifierCandidate = undefined;
		if (!released || released !== candidate || hasAnyModifier(browserEvent)) {
			this.logTroubleshooting("Keyup: no unused single-modifier candidate.");
			return false;
		}
		const event = new StandardKeyboardEvent(browserEvent);
		const keybindingEvent: KeybindingEvent = {
			key: released,
			code: event.code,
			keyCode: event.keyCode,
			scanCode: event.scanCode,
			location: event.location,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			metaKey: false,
			altGraphKey: false,
			isComposing: false,
		};
		const resolved = this.keyboardLayoutService.getKeyboardMapper().resolveKeyboardEvent(keybindingEvent);
		const dispatchEvent = toDispatchEvent(resolved, keybindingEvent);
		this.logTroubleshooting(`Keyup mapper: ${formatKeyboardEvent(dispatchEvent)}`);
		return this.dispatchResolvedEvent(browserEvent, event, dispatchEvent);
	}

	private dispatchResolvedEvent(
		browserEvent: KeyboardEvent,
		event: StandardKeyboardEvent,
		dispatchEvent: KeybindingEvent,
	): boolean {
		const events = [...this.currentEvents, dispatchEvent];
		const target = keyboardEventTarget(browserEvent);
		const context = this.contextKeyService.getContext(target);
		const result = this.resolver.resolve(context, events);
		this.logTroubleshooting(`Resolver: ${formatResolveResult(result)}`);

		switch (result.kind) {
			case KeybindingResolveKind.NoMatch:
				if (!this.inChordMode) return false;
				this.leaveChordMode();
				event.stop();
				return true;

			case KeybindingResolveKind.MoreChordsNeeded:
				this.currentEvents = events;
				this.enterChordMode(result.keybinding);
				event.stop();
				return true;

			case KeybindingResolveKind.Command:
				this.leaveChordMode();
				event.stop();
				void this.commandService
					.executeCommand(result.command, ...result.args)
					.catch((error: unknown) => this.notificationService.warning(getErrorMessage(error)));
				return true;

			case KeybindingResolveKind.Blocked:
				this.leaveChordMode();
				event.stop();
				return true;

			case KeybindingResolveKind.PassThrough:
				this.leaveChordMode();
				return false;
		}
	}

	private enterChordMode(keybinding: ResolvedKeybinding): void {
		this.inChordModeKey.set(true);
		if (IME.enabled) {
			IME.disable();
			this.disabledIme = true;
		}
		this.chordTimeout.value = disposableWindowTimeout(
			this.ownerWindow,
			() => this.leaveChordMode(),
			this.chordTimeoutMs,
		);

		if (this.statusbarService) {
			const prefix = new ResolvedKeybinding(
				keybinding.chords.slice(0, this.currentEvents.length),
				keybinding.operatingSystem,
			);
			const label = getKeybindingLabel(prefix);
			this.chordStatus.clear();
			this.chordStatus.value = this.statusbarService.addEntry(
				{
					text: `${label} was pressed. Waiting for another key…`,
					ariaLabel: `${label} was pressed. Waiting for another key`,
				},
				{
					id: "ash.keybinding.chord",
					alignment: StatusbarAlignment.Left,
					priority: 10_000,
				},
			);
		}
	}

	private leaveChordMode(): void {
		this.chordTimeout.clear();
		this.chordStatus.clear();
		this.currentEvents = [];
		this.inChordModeKey.reset();
		if (this.disabledIme) {
			this.disabledIme = false;
			IME.enable();
		}
	}

	private logTroubleshooting(message: string): void {
		if (this.troubleshootingEnabled) {
			this._onDidLog.fire(message);
		}
	}
}

type SingleModifierKey = "ctrl" | "shift" | "alt" | "meta";

function modifierKey(key: string): SingleModifierKey | undefined {
	switch (key) {
		case "Control": return "ctrl";
		case "Shift": return "shift";
		case "Alt": return "alt";
		case "Meta": return "meta";
		default: return undefined;
	}
}

function singleModifierCandidate(event: StandardKeyboardEvent): SingleModifierKey | undefined {
	if (event.repeat || event.altGraphKey) {
		return undefined;
	}
	const key = modifierKey(event.key);
	if (!key) {
		return undefined;
	}
	const active = [event.ctrlKey, event.shiftKey, event.altKey, event.metaKey].filter(Boolean).length;
	return active === 1 ? key : undefined;
}

function hasAnyModifier(event: KeyboardEvent): boolean {
	return event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.getModifierState?.("AltGraph") === true;
}

function toDispatchEvent(
	resolved: ResolvedKeybinding,
	original: KeybindingEvent,
): KeybindingEvent {
	const chord = resolved.chords[0];
	if (!chord) {
		return original;
	}
	return {
		...original,
		key: chord.kind === KeybindingChordKind.Logical ? chord.key : original.key,
		code: chord.kind === KeybindingChordKind.Physical ? chord.key : original.code,
		keyCode: chord.keyCode ?? original.keyCode,
		scanCode: chord.scanCode ?? original.scanCode,
		ctrlKey: chord.ctrlKey,
		shiftKey: chord.shiftKey,
		altKey: chord.altKey,
		metaKey: chord.metaKey,
	};
}

function keyboardEventTarget(event: KeyboardEvent): Node | null {
	const first = event.composedPath?.()[0];
	return isNodeLike(first)
		? first
		: isNodeLike(event.target) ? event.target : null;
}

function isNodeLike(value: unknown): value is Node {
	return typeof value === "object" &&
		value !== null &&
		"nodeType" in value;
}

function formatKeyboardEvent(event: KeybindingEvent): string {
	return JSON.stringify({
		key: event.key,
		code: event.code,
		keyCode: event.keyCode,
		scanCode: event.scanCode,
		location: event.location,
		ctrl: event.ctrlKey,
		shift: event.shiftKey,
		alt: event.altKey,
		meta: event.metaKey,
		altGraph: event.altGraphKey,
		composing: event.isComposing,
	});
}

function formatResolveResult(result: KeybindingResolveResult): string {
	switch (result.kind) {
		case KeybindingResolveKind.NoMatch:
			return "no matching keybinding";
		case KeybindingResolveKind.MoreChordsNeeded:
			return `waiting for chord (${getKeybindingLabel(result.keybinding)})`;
		case KeybindingResolveKind.Command:
			return `command ${result.command} (${getKeybindingLabel(result.keybinding)})`;
		case KeybindingResolveKind.Blocked:
			return `blocked (${getKeybindingLabel(result.keybinding)})`;
		case KeybindingResolveKind.PassThrough:
			return `pass through (${getKeybindingLabel(result.keybinding)})`;
	}
}
