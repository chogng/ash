import { Registry } from '../../../../../platform/registry/common/platform.js';
import { createJsonCompletionProvider } from '../../../language/common/jsonLanguageFeatures.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { LanguageCompletionTriggerKind } from '../../../../../editor/common/languages.js';
import '../../../../contrib/commands/common/commands.contribution.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../localization/common/localizationCatalogs.js';
import { KeybindingTestServices } from './keybindingTestServices.js';
import { suiteTeardown } from 'mocha';
const profileFixture = new KeybindingTestServices();
suiteTeardown(() => profileFixture.dispose());
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { parseJsonDocument } from '../../../../../base/common/json.js';
import { jsonSchemaAtPath, validateJsonSchema, type JsonSchema } from '../../../../../base/common/jsonSchema.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { registerWindow } from "../../../../../base/browser/window.js";
import { IME } from "../../../../../base/common/ime.js";
import {
	Keybinding,
	logicalKey,
	physicalKey,
	resolveKeybinding,
} from "../../../../../base/common/keybindings.js";
import { DisposableStore, toDisposable } from "../../../../../base/common/lifecycle.js";
import { Emitter } from "../../../../../base/common/event.js";
import { OperatingSystem } from "../../../../../base/common/platform.js";
import { KeyCode, NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE, ScanCode, ScanCodeUtils } from "../../../../../base/common/keyCodes.js";
import { parseKeybinding } from "../../../../../base/common/keybindingParser.js";
import {
	getKeybindingLabel,
} from "../../../../../base/common/keybindingLabels.js";
import {
	CommandRegistry,
	CommandsRegistry,
} from "../../../../../platform/commands/common/commands.js";
import { ContextKeyExpr } from "../../../../../platform/contextkey/common/contextkey.js";
import { ContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { NotificationService } from "../../../../../workbench/services/notification/common/notificationService.js";
import { NotificationsToasts } from "../../../../browser/parts/notifications/notificationsToasts.js";
import { NotificationActionRunner } from "../../../../browser/parts/notifications/notificationsCommands.js";
import { INotificationService, NotificationSeverity } from "../../../../../platform/notification/common/notification.js";
import {
	KeybindingResolveKind,
	KeybindingResolver,
} from "../../../../../platform/keybinding/common/keybindingResolver.js";
import {
	KeybindingRegistry,
	KeybindingSource,
} from "../../../../../platform/keybinding/common/keybindingsRegistry.js";
import {
	BrowserKeyboardLayoutService,
} from "../../../../../workbench/services/keybinding/browser/keyboardLayoutService.js";
import { loadBuiltinKeyboardLayouts } from "../../../../../workbench/services/keybinding/browser/builtinKeyboardLayouts.js";
import {
	KeyboardDispatchMode,
	type IKeyboardLayoutDefinition,
	type IKeyboardMapping,
} from "../../../../../platform/keyboardLayout/common/keyboardLayout.js";
import { KeyboardConfiguration } from "../../../../../platform/keyboardLayout/common/keyboardConfiguration.js";
import { validateNativeKeyboardLayout } from "../../../../../platform/keyboardLayout/common/nativeKeyboardLayout.js";
import {
	WorkbenchKeybindingService,
} from "../../../../../workbench/services/keybinding/browser/keybindingService.js";
import {
	CommandService,
} from "../../../../../workbench/services/commands/common/commandService.js";
import {
	StatusbarAlignment,
	StatusbarService,
} from "../../../../../workbench/services/statusbar/browser/statusbar.js";
import { WorkbenchConfigurationService } from "../../../../../workbench/services/configuration/browser/configurationService.js";

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

test("resolver applies context, source, priority, and latest-registration precedence", () => {
	using registrations = new DisposableStore();
	const registry = new KeybindingRegistry();
	const contexts = registrations.add(new ContextKeyService());
	const keybinding = Keybinding.single(logicalKey("p", {
		ctrlKey: true,
	}));
	registrations.add(registry.registerKeybindingRule({
		command: "test.low",
		keybinding,
		source: KeybindingSource.Builtin,
	}));
	registrations.add(registry.registerKeybindingRule({
		command: "test.disabled",
		keybinding,
		when: ContextKeyExpr.has("test.enabled"),
		source: KeybindingSource.User,
	}));
	registrations.add(registry.registerKeybindingRule({
		command: "test.latest",
		keybinding,
	}));
	const resolver = new KeybindingResolver({
		registry,
		resolveKeybinding: (keybinding) =>
			resolveKeybinding(keybinding, OperatingSystem.Windows),
	});
	const event = keyEventData();

	let result = resolver.resolve(contexts, [event]);
	assert.equal(result.kind, KeybindingResolveKind.Command);
	assert.equal(
		result.kind === KeybindingResolveKind.Command
			? result.command
			: undefined,
		"test.latest",
	);

	contexts.setContext("test.enabled", true);
	result = resolver.resolve(contexts, [event]);
	assert.equal(
		result.kind === KeybindingResolveKind.Command
			? result.command
			: undefined,
		"test.disabled",
	);
});

test("pass-through keybinding leaves the browser shortcut available to the focused view", () => {
	using registrations = new DisposableStore();
	const registry = new KeybindingRegistry();
	const contexts = registrations.add(new ContextKeyService());
	const keybinding = Keybinding.single(logicalKey("p", { ctrlKey: true }));
	registrations.add(registry.registerKeybindingRule({ command: "editor.paste", keybinding, priority: 100 }));
	registrations.add(registry.registerKeybindingPassThrough({ keybinding, when: ContextKeyExpr.has("explorerFocused"), priority: 200 }));
	const resolver = new KeybindingResolver({ registry, resolveKeybinding: value => resolveKeybinding(value, OperatingSystem.Windows) });
	assert.equal(resolver.resolve(contexts, [keyEventData()]).kind, KeybindingResolveKind.Command);
	contexts.setContext("explorerFocused", true);
	assert.equal(resolver.resolve(contexts, [keyEventData()]).kind, KeybindingResolveKind.PassThrough);
});

test("when expressions preserve boolean precedence and comparisons", () => {
	using contexts = new ContextKeyService();
	const expression = ContextKeyExpr.deserialize(
		"editorFocus && (mode == edit || !readOnly)",
	);

	assert.ok(expression);
	contexts.setContext("editorFocus", true);
	contexts.setContext("mode", "preview");
	contexts.setContext("readOnly", false);
	assert.equal(expression.evaluate(contexts), true);

	contexts.setContext("readOnly", true);
	assert.equal(expression.evaluate(contexts), false);
	contexts.setContext("mode", "edit");
	assert.equal(expression.evaluate(contexts), true);
	assert.equal(ContextKeyExpr.deserialize("editorFocus &&"), undefined);
});

test("browser service executes chords and restores IME state", async () => {
	using registrations = new DisposableStore();
	const dom = new JSDOM("<!doctype html><body></body>");
	registrations.add(toDisposable(() => dom.window.close()));
	const registry = new KeybindingRegistry();
	const commands = new CommandRegistry();
	const contexts = registrations.add(new ContextKeyService());
	let executions = 0;
	const executed = new Promise<void>((resolve) => {
		registrations.add(commands.register("test.chord", () => {
			executions += 1;
			resolve();
		}));
	});
	registrations.add(registry.registerKeybindingRule({
		command: "test.chord",
		keybinding: Keybinding.chord(
			physicalKey("KeyK", { ctrlKey: true }),
			physicalKey("KeyC", { ctrlKey: true }),
		),
	}));
	const keyboardLayout = registrations.add(
		new BrowserKeyboardLayoutService({
			navigator: fakeNavigator(),
			operatingSystem: OperatingSystem.Windows,
		}),
	);
	const statusbar = registrations.add(new StatusbarService());
	const service = registrations.add(new WorkbenchKeybindingService({
		ownerDocument: dom.window.document,
		commandService: new CommandService(new InstantiationService(), commands),
		contextKeyService: contexts,
		keyboardLayoutService: keyboardLayout,
		statusbarService: statusbar,
		registry,
	}, registrations.add(new NotificationService()), profileFixture.files, profileFixture.profiles));

	IME.enable();
	const first = keyboardEvent({ code: "KeyK", key: "k" });
	assert.equal(service.dispatchEvent(first.event), true);
	assert.equal(first.prevented, true);
	assert.equal(IME.enabled, false);
	assert.equal(service.inChordMode, true);
	assert.equal(contexts.getValue("keybinding.inChordMode"), true);
	assert.match(
		statusbar.getEntries(StatusbarAlignment.Left)[0].entry.text,
		/Waiting for another key/,
	);

	const second = keyboardEvent({ code: "KeyC", key: "c" });
	assert.equal(service.dispatchEvent(second.event), true);
	await executed;
	assert.equal(executions, 1);
	assert.equal(IME.enabled, true);
	assert.equal(service.inChordMode, false);
	assert.equal(contexts.getValue("keybinding.inChordMode"), false);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
	assert.equal(
		getKeybindingLabel(service.resolveUserBinding("ctrl+k")!),
		"Ctrl+K",
	);
});

test("browser layout observation preserves a chord ending with Shift+Enter", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using cleanup = toDisposable(() => dom.window.close());
	using registrations = new DisposableStore();
	using contexts = new ContextKeyService();
	using layouts = new BrowserKeyboardLayoutService({ navigator: fakeNavigator(usLetterLayout()), operatingSystem: OperatingSystem.Windows });
	await layouts.refreshKeyboardLayout();
	const registry = new KeybindingRegistry();
	const commands = new CommandRegistry();
	let executions = 0;
	registrations.add(commands.register("test.shiftEnter", () => { executions += 1; }));
	registrations.add(registry.registerKeybindingRule({ command: "test.shiftEnter", keybinding: Keybinding.chord(physicalKey("KeyK", { ctrlKey: true }), logicalKey("Enter", { shiftKey: true })) }));
	using services = new InstantiationService();
	using commandService = new CommandService(services, commands);
	using notifications = new NotificationService();
	using keybindings = new WorkbenchKeybindingService({ ownerDocument: dom.window.document, commandService, contextKeyService: contexts, keyboardLayoutService: layouts, registry }, notifications, profileFixture.files, profileFixture.profiles);
	let layoutChanges = 0;
	using listener = layouts.onDidChangeKeyboardLayout(() => { layoutChanges += 1; });
	assert.equal(keybindings.dispatchEvent(keyboardEvent({ code: "KeyK", key: "k" }).event), true);
	keybindings.dispatchEvent(keyboardEvent({ code: "ShiftLeft", key: "Shift", keyCode: 16, ctrlKey: false, shiftKey: true }).event);
	assert.equal(keybindings.inChordMode, true);
	assert.equal(keybindings.dispatchEvent(keyboardEvent({ code: "Enter", key: "Enter", keyCode: 13, ctrlKey: false, shiftKey: true }).event), true);
	await Promise.resolve();
	assert.deepEqual({ executions, layoutChanges, chord: keybindings.inChordMode }, { executions: 1, layoutChanges: 0, chord: false });
});

test("browser service dispatches Ctrl+Shift+P with a shifted key value", async () => {
	using registrations = new DisposableStore();
	const dom = new JSDOM("<!doctype html><body></body>");
	registrations.add(toDisposable(() => dom.window.close()));
	const registry = new KeybindingRegistry();
	const commands = new CommandRegistry();
	const contexts = registrations.add(new ContextKeyService());
	const commandId = "workbench.action.showCommands";
	const executed = new Promise<void>((resolve) => {
		registrations.add(commands.register(commandId, () => resolve()));
	});
	registrations.add(registry.registerKeybindingRule({
		command: commandId,
		keybinding: Keybinding.single(logicalKey("p", {
			ctrlKey: true,
			shiftKey: true,
		})),
	}));
	const keyboardLayout = registrations.add(
		new BrowserKeyboardLayoutService({
			navigator: fakeNavigator(),
			operatingSystem: OperatingSystem.Windows,
		}),
	);
	const service = registrations.add(new WorkbenchKeybindingService({
		ownerDocument: dom.window.document,
		commandService: new CommandService(new InstantiationService(), commands),
		contextKeyService: contexts,
		keyboardLayoutService: keyboardLayout,
		registry,
	}, registrations.add(new NotificationService()), profileFixture.files, profileFixture.profiles));
	const shortcut = keyboardEvent({
		code: "KeyP",
		key: "P",
		shiftKey: true,
	});

	assert.equal(service.dispatchEvent(shortcut.event), true);
	await executed;
	assert.equal(shortcut.prevented, true);
});

test('registered auxiliary window dispatches workbench shortcuts until it closes', async () => {
	using resources = new DisposableStore();
	const main = new JSDOM('<!doctype html><body></body>');
	const auxiliary = new JSDOM('<!doctype html><body><button>Editor</button></body>');
	resources.add(toDisposable(() => main.window.close()));
	resources.add(toDisposable(() => auxiliary.window.close()));
	const registry = new KeybindingRegistry();
	const commands = new CommandRegistry();
	let executions = 0;
	resources.add(commands.register('test.auxiliaryShortcut', () => { executions++; }));
	resources.add(registry.registerKeybindingRule({
		command: 'test.auxiliaryShortcut',
		keybinding: Keybinding.single(logicalKey('p', { ctrlKey: true })),
	}));
	const contexts = resources.add(new ContextKeyService());
	const keyboardLayout = resources.add(new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Windows,
	}));
	const services = resources.add(new InstantiationService());
	resources.add(new WorkbenchKeybindingService({
		ownerDocument: main.window.document,
		commandService: resources.add(new CommandService(services, commands)),
		contextKeyService: contexts,
		keyboardLayoutService: keyboardLayout,
		registry,
	}, resources.add(new NotificationService()), profileFixture.files, profileFixture.profiles));
	const registration = resources.add(registerWindow(auxiliary.window as unknown as Window));
	const button = auxiliary.window.document.querySelector('button')!;
	const pressShortcut = (): void => {
		const event = new auxiliary.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'p', code: 'KeyP', ctrlKey: true });
		Object.defineProperty(event, 'keyCode', { value: 80 });
		button.dispatchEvent(event);
	};

	pressShortcut();
	await Promise.resolve();
	assert.equal(executions, 1);
	registration.dispose();
	pressShortcut();
	await Promise.resolve();
	assert.equal(executions, 1);
});

test('failed keyboard command appears as a warning notification', async () => {
	using resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const registry = new KeybindingRegistry();
	const commands = new CommandRegistry();
	resources.add(commands.register('test.failedShortcut', () => { throw new Error('Shortcut failed'); }));
	resources.add(registry.registerKeybindingRule({
		command: 'test.failedShortcut',
		keybinding: Keybinding.single(logicalKey('p', { ctrlKey: true })),
	}));
	const contexts = resources.add(new ContextKeyService());
	const keyboardLayout = resources.add(new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Windows,
	}));
	const notifications = resources.add(new NotificationService());
	const files = resources.add(new KeybindingTestServices());
	const services = files.services;
	services.registerInstance(INotificationService, notifications);
	const notificationActionRunner = resources.add(services.createInstance(NotificationActionRunner));
	resources.add(new NotificationsToasts(dom.window.document.body, notifications, notificationActionRunner));
	const keybindings = resources.add(services.createInstance(WorkbenchKeybindingService, {
		ownerDocument: dom.window.document,
		commandService: resources.add(new CommandService(services, commands)),
		contextKeyService: contexts,
		keyboardLayoutService: keyboardLayout,
		registry,
	}));

	assert.equal(keybindings.dispatchEvent(keyboardEvent().event), true);
	await Promise.resolve();
	assert.deepEqual(notifications.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [
		{ severity: NotificationSeverity.Warning, message: 'Shortcut failed' },
	]);
	assert.equal(dom.window.document.querySelector('.ash-notification')?.getAttribute('role'), 'status');
});

test("keyboard shortcut troubleshooting traces native, mapped, and resolved events", async () => {
	using registrations = new DisposableStore();
	const dom = new JSDOM("<!doctype html><body></body>");
	registrations.add(toDisposable(() => dom.window.close()));
	const registry = new KeybindingRegistry();
	const commands = new CommandRegistry();
	const contexts = registrations.add(new ContextKeyService());
	const executed = new Promise<void>((resolve) => {
		registrations.add(commands.register("test.trace", () => resolve()));
	});
	registrations.add(registry.registerKeybindingRule({
		command: "test.trace",
		keybinding: Keybinding.single(logicalKey("p", { ctrlKey: true })),
	}));
	const keyboardLayout = registrations.add(new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Windows,
	}));
	const service = registrations.add(new WorkbenchKeybindingService({
		ownerDocument: dom.window.document,
		commandService: new CommandService(new InstantiationService(), commands),
		contextKeyService: contexts,
		keyboardLayoutService: keyboardLayout,
		registry,
	}, registrations.add(new NotificationService()), profileFixture.files, profileFixture.profiles));
	const messages: string[] = [];
	registrations.add(service.onDidLog(message => messages.push(message)));

	assert.equal(service.toggle(), true);
	assert.equal(service.dispatchEvent(keyboardEvent().event), true);
	await executed;
	assert.match(messages[0], /troubleshooting enabled/);
	assert.ok(messages.some(message => message.startsWith("Keydown:")));
	assert.ok(messages.some(message => message.startsWith("Mapper:")));
	assert.ok(messages.some(message => message.includes("Resolver: command test.trace")));

	assert.equal(service.toggle(), false);
	const messageCount = messages.length;
	service.dispatchEvent(keyboardEvent({ key: "x", code: "KeyX", keyCode: 88 }).event);
	assert.equal(messages.length, messageCount);
});

test("browser keyboard layouts provide physical key labels", async () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(new Map([["KeyY", "z"]])),
		operatingSystem: OperatingSystem.Windows,
	});
	await service.refreshKeyboardLayout();

	const resolved = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(physicalKey("KeyY", { ctrlKey: true })),
	)[0];
	assert.ok(resolved);
	assert.equal(getKeybindingLabel(resolved), "Ctrl+Z");
	assert.equal(service.getCurrentKeyboardLayout().source, "browser");
});

test("single modifier bindings dispatch on keyup only when the modifier was unused", async () => {
	using registrations = new DisposableStore();
	const dom = new JSDOM("<!doctype html><body></body>");
	registrations.add(toDisposable(() => dom.window.close()));
	const registry = new KeybindingRegistry();
	const commands = new CommandRegistry();
	const contexts = registrations.add(new ContextKeyService());
	let executions = 0;
	registrations.add(commands.register("test.ctrl", () => {
		executions += 1;
	}));
	const parsed = parseKeybinding("ctrl");
	assert.ok(parsed);
	registrations.add(registry.registerKeybindingRule({
		command: "test.ctrl",
		keybinding: parsed,
	}));
	const keyboardLayout = registrations.add(new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Windows,
	}));
	const service = registrations.add(new WorkbenchKeybindingService({
		ownerDocument: dom.window.document,
		commandService: new CommandService(new InstantiationService(), commands),
		contextKeyService: contexts,
		keyboardLayoutService: keyboardLayout,
		registry,
	}, registrations.add(new NotificationService()), profileFixture.files, profileFixture.profiles));

	const firstDown = keyboardEvent({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true });
	const firstUp = keyboardEvent({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: false });
	assert.equal(service.dispatchEvent(firstDown.event), false);
	assert.equal(service.dispatchKeyupEvent(firstUp.event), true);
	await Promise.resolve();
	assert.equal(executions, 1);
	assert.equal(firstUp.prevented, true);

	const usedDown = keyboardEvent({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true });
	const letter = keyboardEvent({ key: "p", code: "KeyP", keyCode: 80, ctrlKey: true });
	const usedUp = keyboardEvent({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: false });
	service.dispatchEvent(usedDown.event);
	service.dispatchEvent(letter.event);
	assert.equal(service.dispatchKeyupEvent(usedUp.event), false);
	assert.equal(executions, 1);
});

test("browser mapping selects a complete built-in layout corpus entry", async () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(usLetterLayout()),
		operatingSystem: OperatingSystem.Windows,
	});
	await service.refreshKeyboardLayout();

	assert.equal(service.getCurrentKeyboardLayout().id, "00000409");
	assert.equal(service.getCurrentKeyboardLayout().source, "builtin");
	assert.equal(service.getRawKeyboardMapping()?.KeyE.withShift, "E");
	assert.equal(service.getRawKeyboardMapping()?.KeyE.vkey, "VK_E");
	assert.ok(service.getAllKeyboardLayouts().length > 20);
});

test("code dispatch resolves logical bindings through the active physical layout", () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Linux,
		dispatch: KeyboardDispatchMode.Code,
		layout: keyboardLayout({
			KeyY: mappingEntry("z", "Z"),
			KeyZ: mappingEntry("z", "Z"),
		}),
	});

	const candidates = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("z", { ctrlKey: true })),
	);
	assert.deepEqual(
		candidates.map((candidate) => candidate.chords[0].key),
		["KeyY", "KeyZ"],
	);
	assert.ok(candidates.every((candidate) =>
		candidate.chords[0].kind === "physical"
	));
});

test("keyCode dispatch retains logical identity", () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Linux,
		dispatch: KeyboardDispatchMode.KeyCode,
		layout: keyboardLayout({ KeyY: mappingEntry("z", "Z") }),
	});

	const resolved = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("z", { ctrlKey: true })),
	)[0];
	assert.ok(resolved);
	assert.equal(resolved.chords[0].kind, "logical");
	assert.equal(resolved.chords[0].key, "z");
});

test("keyCode dispatch preserves numpad identity while NumLock is off", () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Windows,
		dispatch: KeyboardDispatchMode.KeyCode,
		layout: keyboardLayout({}),
	});

	const binding = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("numpad1")),
	)[0];
	const event = service.getKeyboardMapper().resolveKeyboardEvent({
		...keyEventData(),
		key: "End",
		code: "Numpad1",
		keyCode: KeyCode.Numpad1,
		location: 3,
		ctrlKey: false,
	});

	assert.ok(binding);
	assert.equal(binding.chords[0].key, "numpad1");
	assert.equal(event.chords[0].key, "numpad1");
});

test("Windows vkeys and non-Latin fallback resolve logical shortcuts to physical keys", () => {
	using windows = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Windows,
		layout: keyboardLayout({
			KeyA: { ...mappingEntry("й", "Й"), vkey: "VK_Q" },
		}),
	});
	using linux = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Linux,
		layout: keyboardLayout({
			KeyQ: mappingEntry("й", "Й"),
		}),
	});

	assert.equal(windows.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("q", { ctrlKey: true })),
	)[0]?.chords[0].key, "KeyA");
	assert.equal(linux.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("q", { ctrlKey: true })),
	)[0]?.chords[0].key, "KeyQ");
});

test("AltGr can opt into Ctrl+Alt dispatch without changing physical key identity", () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Linux,
		mapAltGrToCtrlAlt: true,
		layout: keyboardLayout({
			KeyE: mappingEntry("e", "E", "€"),
		}),
	});

	const binding = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("e", { ctrlKey: true, altKey: true })),
	)[0];
	const event = service.getKeyboardMapper().resolveKeyboardEvent({
		...keyEventData(),
		key: "€",
		code: "KeyE",
		ctrlKey: false,
		altKey: true,
		altGraphKey: true,
	});

	assert.ok(binding);
	assert.equal(binding.chords[0].key, "KeyE");
	assert.equal(event.chords[0].key, "KeyE");
	assert.equal(event.chords[0].ctrlKey, true);
	assert.equal(event.chords[0].altKey, true);
});

test("mapper labels AltGr states and macOS combining dead keys", () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Macintosh,
		mapAltGrToCtrlAlt: true,
		layout: keyboardLayout({
			KeyE: mappingEntry("e", "E", "€", "Ê"),
			Backquote: {
				...mappingEntry("\u0300", "~"),
				valueIsDeadKey: true,
			},
		}),
	});

	const altGr = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(physicalKey("KeyE", { ctrlKey: true, altKey: true })),
	)[0];
	const dead = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(physicalKey("Backquote")),
	)[0];
	assert.ok(altGr && dead);
	assert.equal(altGr.chords[0].label, "€");
	assert.equal(dead.chords[0].label, "`");
	assert.equal(dead.chords[0].isDeadKey, true);
});

test("macOS mapper translates US logical punctuation into required physical modifier states", () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Macintosh,
		layout: keyboardLayout({
			KeyY: mappingEntry("z", "Z"),
			KeyZ: mappingEntry("y", "Y"),
			Digit6: mappingEntry("6", "&", "]"),
			Digit7: mappingEntry("7", "/"),
			Minus: mappingEntry("'", "?"),
		}),
	});

	const z = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("z", { metaKey: true })),
	)[0];
	const slash = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("/", { metaKey: true })),
	)[0];
	const question = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("/", { shiftKey: true, metaKey: true })),
	)[0];
	const bracket = service.getKeyboardMapper().resolveKeybinding(
		Keybinding.single(logicalKey("]", { metaKey: true })),
	)[0];

	assert.equal(z?.chords[0].key, "KeyY");
	assert.equal(slash?.chords[0].key, "Digit7");
	assert.equal(slash?.chords[0].shiftKey, true);
	assert.equal(slash?.chords[0].metaKey, true);
	assert.equal(question?.chords[0].key, "Minus");
	assert.equal(question?.chords[0].shiftKey, true);
	assert.equal(question?.chords[0].metaKey, true);
	assert.equal(bracket?.chords[0].key, "Digit6");
	assert.equal(bracket?.chords[0].ctrlKey, true);
	assert.equal(bracket?.chords[0].altKey, true);
	assert.equal(bracket?.chords[0].metaKey, true);
	assert.equal(getKeybindingLabel(slash!), "⇧⌘7");
});

test("mapper diagnostics enumerate modifier states, dead keys, vkeys, and dispatch", () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		operatingSystem: OperatingSystem.Windows,
		layout: keyboardLayout({
			Backquote: {
				...mappingEntry("`", "~", "´", "¨"),
				withAltGrIsDeadKey: true,
				vkey: "VK_OEM_3",
			},
		}),
	});
	const diagnostics = service.getKeyboardMapper().dumpDebugInfo();

	assert.match(diagnostics, /WindowsKeyboardMapper/);
	assert.match(diagnostics, /Base \| Shift \| AltGr \| Shift\+AltGr/);
	assert.match(diagnostics, /altgr/);
	assert.match(diagnostics, /VK_OEM_3/);
	assert.match(diagnostics, /ctrl\+shift\+alt\+\[Backquote\]/);
});

test("browser mapping learns AltGr and dead-key states from native events", async () => {
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(new Map([
			["KeyE", "e"],
			["Backquote", "`"],
		])),
		operatingSystem: OperatingSystem.Linux,
	});
	await service.refreshKeyboardLayout();

	service.validateCurrentKeyboardMapping({
		...keyEventData(),
		key: "€",
		code: "KeyE",
		ctrlKey: false,
		altKey: true,
		altGraphKey: true,
	});
	service.validateCurrentKeyboardMapping({
		...keyEventData(),
		key: "Dead",
		code: "Backquote",
		ctrlKey: false,
	});

	assert.equal(service.getRawKeyboardMapping()?.KeyE.withAltGr, "€");
	assert.equal(service.getRawKeyboardMapping()?.Backquote.valueIsDeadKey, true);
});

test("native layout provider takes priority and refreshes after an OS layout change", async () => {
	using changes = new Emitter<void>();
	let current = nativeKeyboardLayout("native.first", {
		KeyY: mappingEntry("z", "Z"),
	});
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(usLetterLayout()),
		operatingSystem: OperatingSystem.Windows,
		layoutProvider: {
			onDidChangeKeyboardLayout: changes.event,
			async readKeyboardLayout() {
				return current;
			},
		},
	});
	await service.refreshKeyboardLayout();

	assert.equal(service.getCurrentKeyboardLayout().id, "native.first");
	assert.equal(service.getCurrentKeyboardLayout().source, "native");
	assert.equal(service.getRawKeyboardMapping()?.KeyY.value, "z");

	current = nativeKeyboardLayout("native.second", {
		KeyY: mappingEntry("y", "Y"),
	});
	changes.fire();
	await service.refreshKeyboardLayout();

	assert.equal(service.getCurrentKeyboardLayout().id, "native.second");
	assert.equal(service.getRawKeyboardMapping()?.KeyY.value, "y");
});

test("user layout provider is explicit-only and hot-reloads the selected profile layout", async () => {
	using changes = new Emitter<void>();
	let current: IKeyboardLayoutDefinition | undefined = {
		layout: {
			id: "user.custom",
			label: "User custom",
			source: "user",
			operatingSystem: OperatingSystem.Linux,
		},
		mapping: { KeyQ: mappingEntry("x", "X") },
	};
	using configuration = new WorkbenchConfigurationService();
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		configurationService: configuration,
		operatingSystem: OperatingSystem.Linux,
		userLayoutProvider: {
			onDidChangeKeyboardLayout: changes.event,
			async readKeyboardLayout() { return current; },
		},
	});
	await service.refreshKeyboardLayout();
	assert.equal(service.getCurrentKeyboardLayout().source, "fallback");
	assert.ok(service.getAllKeyboardLayouts().some((layout) => layout.id === "user.custom"));

	await configuration.updateValue(KeyboardConfiguration.layout, "user.custom");
	await service.refreshKeyboardLayout();
	assert.equal(service.getCurrentKeyboardLayout().source, "user");
	assert.equal(service.getRawKeyboardMapping()?.KeyQ.value, "x");

	current = { ...current, mapping: { KeyQ: mappingEntry("q", "Q") } };
	changes.fire();
	await service.refreshKeyboardLayout();
	assert.equal(service.getRawKeyboardMapping()?.KeyQ.value, "q");

	current = undefined;
	changes.fire();
	await service.refreshKeyboardLayout();
	assert.equal(service.getCurrentKeyboardLayout().source, "fallback");
});

test("built-in layout corpus has valid scan codes, Windows vkeys, and four-state mappings", async () => {
	const platforms = [OperatingSystem.Windows, OperatingSystem.Macintosh, OperatingSystem.Linux] as const;
	const counts: number[] = [];
	for (const platform of platforms) {
		const layouts = await loadBuiltinKeyboardLayouts(platform);
		counts.push(layouts.length);
		assert.ok(layouts.length > 0);
		for (const definition of layouts) {
			assert.equal(definition.layout.operatingSystem, platform);
			assert.ok(Object.keys(definition.mapping).length > 40);
			for (const [code, entry] of Object.entries(definition.mapping)) {
				assert.notEqual(ScanCodeUtils.toEnum(code), ScanCode.None, `${definition.layout.id}: ${code}`);
				assert.equal(typeof entry.value, "string");
				assert.equal(typeof entry.withShift, "string");
				assert.equal(typeof entry.withAltGr, "string");
				assert.equal(typeof entry.withShiftAltGr, "string");
				if (entry.vkey) {
					assert.notEqual(NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE[entry.vkey], undefined, `${definition.layout.id}: ${entry.vkey}`);
				}
			}
		}
	}
	assert.ok(counts[0] > 20);
	assert.ok(counts[1] > 10);
	assert.ok(counts[2] >= 4);
});

test("native keyboard layout IPC validation rejects untrusted shapes", () => {
	assert.throws(() => validateNativeKeyboardLayout({
		layout: {
			id: "native.test",
			label: "Native test",
			source: "native",
			operatingSystem: "windows",
		},
		mapping: {
			KeyA: {
				...mappingEntry("a", "A"),
				unexpected: true,
			},
		},
	}), /unknown fields/);
});

test("keyboard configuration switches dispatch and explicit layouts at runtime", async () => {
	using configuration = new WorkbenchConfigurationService();
	const selected = {
		layout: {
			id: "test.selected",
			label: "Selected layout",
			source: "user" as const,
			operatingSystem: OperatingSystem.Linux,
		},
		mapping: { KeyQ: mappingEntry("x", "X") },
	};
	using service = new BrowserKeyboardLayoutService({
		navigator: fakeNavigator(),
		configurationService: configuration,
		operatingSystem: OperatingSystem.Linux,
		additionalLayouts: [selected],
	});
	await service.refreshKeyboardLayout();

	await configuration.updateValue(KeyboardConfiguration.dispatch, KeyboardDispatchMode.KeyCode);
	assert.equal(service.getKeyboardMapperConfiguration().dispatch, KeyboardDispatchMode.KeyCode);

	await configuration.updateValue(KeyboardConfiguration.layout, selected.layout.id);
	assert.equal(service.getCurrentKeyboardLayout().id, selected.layout.id);
	assert.equal(service.getRawKeyboardMapping()?.KeyQ.value, "x");
});

test('user keybindings load conditions, arguments, OS overrides and blockers through the file service', async () => {
	using registrations = new DisposableStore();
	using fixture = new KeybindingTestServices();
	const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
	registrations.add(toDisposable(() => dom.window.close()));
	const registry = new KeybindingRegistry();
	const contexts = registrations.add(new ContextKeyService());
	registrations.add(registry.registerKeybindingRule({ command: 'test.builtin', keybinding: Keybinding.single(logicalKey('p', { ctrlKey: true })), source: KeybindingSource.Builtin }));
	const layouts = registrations.add(new BrowserKeyboardLayoutService({ navigator: dom.window.navigator, operatingSystem: OperatingSystem.Windows }));
	const notifications = registrations.add(new NotificationService());
	const service = registrations.add(new WorkbenchKeybindingService({ ownerDocument: dom.window.document, commandService: registrations.add(new CommandService(registrations.add(new InstantiationService()))), contextKeyService: contexts, keyboardLayoutService: layouts, registry }, notifications, fixture.files, fixture.profiles));
	const resolver = new KeybindingResolver({ registry, resolveKeybinding: binding => resolveKeybinding(binding, OperatingSystem.Windows) });
	await fixture.write([{ key: 'ctrl+q', mac: 'ctrl+p', linux: 'ctrl+p', win: 'ctrl+p', command: 'test.user', when: String.raw`test.enabled && mode in modes && count >= 2 && path =~ /\.md$/ && true`, args: { source: 'user' } }]);
	await service.initialize();
	assert.equal(resolver.resolve(contexts, [keyEventData()]).kind, KeybindingResolveKind.Command);
	contexts.setContext('test.enabled', true);
	contexts.setContext('mode', 'edit');
	contexts.setContext('modes', ['edit']);
	contexts.setContext('count', '2');
	contexts.setContext('path', 'readme.md');
	const result = resolver.resolve(contexts, [keyEventData()]);
	assert.equal(result.kind === KeybindingResolveKind.Command ? result.command : undefined, 'test.user');
	assert.deepEqual(result.kind === KeybindingResolveKind.Command ? result.args : undefined, [{ source: 'user' }]);
	contexts.setContext('modes', ['preview']);
	const disabled = resolver.resolve(contexts, [keyEventData()]);
	assert.equal(disabled.kind === KeybindingResolveKind.Command ? disabled.command : undefined, 'test.builtin');
	await fixture.write([{ key: 'ctrl+p', command: null }]);
	await service.initialize();
	assert.equal(resolver.resolve(contexts, [keyEventData()]).kind, KeybindingResolveKind.Blocked);
	await fixture.writeSource('[{"key":"ctrl+p","command":"test.invalid","when":"&&"}]');
	await assert.rejects(service.initialize());
	assert.equal(resolver.resolve(contexts, [keyEventData()]).kind, KeybindingResolveKind.Blocked);
});

function keyEventData() {
	return {
		key: "p",
		code: "KeyP",
		ctrlKey: true,
		shiftKey: false,
		altKey: false,
		metaKey: false,
	} as const;
}

function keyboardEvent(
	overrides: Partial<KeyboardEvent> = {},
): { event: KeyboardEvent; readonly prevented: boolean; } {
	let prevented = false;
	const event = {
		key: "p",
		code: "KeyP",
		ctrlKey: true,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		repeat: false,
		isComposing: false,
		target: null,
		composedPath: () => [],
		getModifierState: () => false,
		preventDefault: () => {
			prevented = true;
		},
		stopPropagation: () => { },
		stopImmediatePropagation: () => { },
		...overrides,
	} as KeyboardEvent;
	return {
		event,
		get prevented() {
			return prevented;
		},
	};
}

function fakeNavigator(
	layout?: ReadonlyMap<string, string>,
): Navigator {
	const keyboard = layout
		? {
			async getLayoutMap() {
				return layout;
			},
		}
		: undefined;
	return {
		language: "en-US",
		keyboard,
	} as unknown as Navigator;
}

function keyboardLayout(mapping: IKeyboardMapping) {
	return {
		layout: {
			id: "test.layout",
			label: "Test layout",
			source: "user" as const,
		},
		mapping,
	};
}

function nativeKeyboardLayout(id: string, mapping: IKeyboardMapping): IKeyboardLayoutDefinition {
	return {
		layout: {
			id,
			label: id,
			source: "native",
			operatingSystem: OperatingSystem.Windows,
		},
		mapping,
	};
}

function mappingEntry(
	value: string,
	withShift = "",
	withAltGr = "",
	withShiftAltGr = "",
) {
	return { value, withShift, withAltGr, withShiftAltGr };
}

function usLetterLayout(): ReadonlyMap<string, string> {
	const layout = new Map<string, string>();
	for (let index = 0; index < 26; index += 1) {
		const letter = String.fromCharCode(65 + index);
		layout.set(`Key${letter}`, letter.toLocaleLowerCase("en-US"));
	}
	return layout;
}


test('keybinding schema registration updates conditional command arguments and releases its subscription', () => {
	const dom = new JSDOM('<body></body>');
	using close = toDisposable(() => dom.window.close());
	using contexts = new ContextKeyService();
	using layouts = new BrowserKeyboardLayoutService({ navigator: fakeNavigator(), operatingSystem: OperatingSystem.Windows });
	using services = new InstantiationService();
	const registry = new CommandRegistry();
	using commands = new CommandService(services, registry);
	using notifications = new NotificationService();
	using keybindings = new WorkbenchKeybindingService({
		ownerDocument: dom.window.document,
		commandService: commands,
		commandRegistry: registry,
		contextKeyService: contexts,
		keyboardLayoutService: layouts,
	}, notifications, profileFixture.files, profileFixture.profiles);
	using changed = new Emitter<void>();
	let kind = 'text';
	let schemaReads = 0;
	using registration = keybindings.registerSchemaContribution({
		onDidChange: changed.event,
		getSchemaAdditions: (): JsonSchema[] => {
			schemaReads++;
			return [{
				if: { required: ['command'], properties: { command: { const: 'test.paste' } } },
				then: { properties: { args: { type: 'object', properties: { kind: { const: kind } } } } },
			}];
		},
	});
	const invalid = (): number => validateJsonSchema(
		parseJsonDocument('[{"key":"ctrl+p","command":"test.paste","args":{"kind":"html"}}]'),
		jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings'],
	).length;
	assert.equal(invalid(), 1);
	assert.equal(validateJsonSchema(parseJsonDocument('[{"key":"ctrl+p","command":"other","args":{"kind":42}}]'), jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings']).length, 0);
	kind = 'html';
	changed.fire();
	assert.equal(invalid(), 0);
	registration.dispose();
	const readsAfterDispose = schemaReads;
	changed.fire();
	assert.equal(schemaReads, readsAfterDispose);
	assert.deepEqual(jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings']!.definitions!.commandsSchemas.allOf, []);
	keybindings.dispose();
	assert.equal(jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings'], undefined);
});


test('registered command metadata drives nested batch validation, completion and live replacement', async () => {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	using resetLocale = toDisposable(() => resetNlsResolver());
	const dom = new JSDOM('<body></body>');
	using close = toDisposable(() => dom.window.close());
	using contexts = new ContextKeyService();
	using layouts = new BrowserKeyboardLayoutService({ navigator: fakeNavigator(), operatingSystem: OperatingSystem.Windows });
	using services = new InstantiationService();
	const registry = new CommandRegistry();
	using commands = new CommandService(services, registry);
	using notifications = new NotificationService();
	using batch = registry.registerMany([CommandsRegistry.getCommands().get('runCommands')!]);
	using keybindings = new WorkbenchKeybindingService({
		ownerDocument: dom.window.document, commandService: commands, commandRegistry: registry,
		contextKeyService: contexts, keyboardLayoutService: layouts,
	}, notifications, profileFixture.files, profileFixture.profiles);
	const validate = (value: unknown): readonly string[] => validateJsonSchema(
		parseJsonDocument(JSON.stringify([value])), jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings'],
	).map(issue => issue.message);
	const target = registry.registerMany([{
		id: 'test.argument', handler: () => undefined,
		metadata: { description: 'Choose a kind', args: [{ name: 'options', isOptional: false, schema: {
			type: 'object', required: ['kind'], properties: { kind: { enum: ['text', 'html'] } },
		} }] },
	}]);
	try {
		const value = { key: 'ctrl+p', command: 'runCommands', args: { commands: [{ command: 'test.argument', args: { kind: 'text' } }] } };
		assert.deepEqual(validate(value), []);
		assert.deepEqual(validate({ key: 'ctrl+p', command: 'runCommands' }), ["Required property 'args' is missing"]);
		assert.equal(validate({ ...value, args: { commands: [{ command: 'test.argument' }] } }).length, 1);
		assert.equal(validate({ ...value, args: { commands: [{ command: 'test.argument', args: { kind: 42 } }] } }).length, 1);
		assert.deepEqual(validate({ ...value, args: { commands: [{ command: 'runCommands', args: { commands: ['unknown.command'] } }] } }), []);
		const schema = jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings']!;
		const node = parseJsonDocument(JSON.stringify([value]));
		const kind = jsonSchemaAtPath(schema, [0, 'args', 'commands', 0, 'args', 'kind'], node.root);
		assert.deepEqual(kind?.enum, ['text', 'html']);
		const names = jsonSchemaAtPath(schema, [0, 'args', 'commands', 0, 'command'], node.root);
		assert.deepEqual(names?.anyOf?.[0].enum, ['runCommands', 'test.argument']);
		assert.deepEqual(names?.anyOf?.[0].enumDescriptions, ['Run several commands', 'Choose a kind']);
		const source = JSON.stringify([value]).replace('"kind":"text"', '"kind":""');
		using model = new TextModel(source);
		const completion = await createJsonCompletionProvider().provideCompletions({
			requestId: 1, languageId: 'jsonc', resource: profileFixture.profiles.currentProfile.keybindingsResource,
			position: new Position(1, source.indexOf('"kind":""') + '"kind":"'.length + 1),
			context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
		}, new AbortController().signal);
		assert.deepEqual(completion?.items.map(item => item.label), ['"text"', '"html"']);
		assert.match(validate({ key: 'ctrl+p', command: ['first', 'second'] })[0]!, /运行多个命令.*runCommands/u);
		target.replace([{ id: 'test.argument', handler: () => undefined, metadata: { description: 'A count', args: [{ name: 'count', schema: { type: 'number' } }] } }]);
		assert.equal(validate(value).length, 1);
		assert.deepEqual(validate({ key: 'ctrl+p', command: 'test.argument', args: 3 }), []);
		target.dispose();
		assert.deepEqual(validate(value), []);
		assert.deepEqual(jsonRegistry.getSchemaContributions().schemas['ash://schemas/keybindings']!.definitions!.commandNames.enum, ['runCommands']);
	} finally {
		target.dispose();
	}
});
