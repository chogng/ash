import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { IKeyboardLayoutDefinition, IKeyboardMappingEntry } from '../common/keyboardLayout.js';
import { NATIVE_KEYBOARD_LAYOUT_READ_CHANNEL } from '../common/nativeKeyboardLayout.js';

type NativeKeymapModule = typeof import('native-keymap');

/** Lazily loads the optional native-keymap addon and owns its current immutable snapshot. */
export class NativeKeyboardLayoutMainService extends Disposable {
	private readonly _onDidChangeKeyboardLayout = this._register(new Emitter<IKeyboardLayoutDefinition | undefined>());
	private initialization: Promise<void> | undefined;
	private layout: IKeyboardLayoutDefinition | undefined;

	public readonly onDidChangeKeyboardLayout = this._onDidChangeKeyboardLayout.event;

	public async readKeyboardLayout(): Promise<IKeyboardLayoutDefinition | undefined> {
		this.initialization ??= this.initialize();
		await this.initialization;
		return this.layout;
	}

	private async initialize(): Promise<void> {
		try {
			const nativeKeymap = await import('native-keymap');
			this.layout = readNativeKeyboardLayout(nativeKeymap);
			nativeKeymap.onDidChangeKeyboardLayout(() => {
				if (this.isDisposed) {
					return;
				}
				this.layout = readNativeKeyboardLayout(nativeKeymap);
				this._onDidChangeKeyboardLayout.fire(this.layout);
			});
		} catch (error) {
			this.layout = undefined;
			console.warn('Native keyboard layout detection is unavailable', error);
		}
	}
}

export function nativeKeyboardLayoutIpcRoutes(
	service: NativeKeyboardLayoutMainService,
): readonly IpcRoute<unknown, unknown>[] {
	return [{
		channel: NATIVE_KEYBOARD_LAYOUT_READ_CHANNEL,
		validate(value: unknown): undefined {
			if (value !== undefined) {
				throw new TypeError('keyboard layout read does not accept parameters');
			}
			return undefined;
		},
		invoke: () => service.readKeyboardLayout(),
	}];
}

function readNativeKeyboardLayout(nativeKeymap: NativeKeymapModule): IKeyboardLayoutDefinition {
	const nativeLayout = nativeKeymap.getCurrentKeyboardLayout();
	const operatingSystem = currentOperatingSystem();
	const mapping: Record<string, IKeyboardMappingEntry> = {};
	for (const [code, rawEntry] of Object.entries(nativeKeymap.getKeyMap())) {
		const entry = rawEntry as Partial<IKeyboardMappingEntry>;
		mapping[code] = Object.freeze({
			value: entry.value ?? '',
			withShift: entry.withShift ?? '',
			withAltGr: entry.withAltGr ?? '',
			withShiftAltGr: entry.withShiftAltGr ?? '',
			valueIsDeadKey: Boolean(entry.valueIsDeadKey),
			withShiftIsDeadKey: Boolean(entry.withShiftIsDeadKey),
			withAltGrIsDeadKey: Boolean(entry.withAltGrIsDeadKey),
			withShiftAltGrIsDeadKey: Boolean(entry.withShiftAltGrIsDeadKey),
			vkey: entry.vkey,
		});
	}
	const identity = nativeLayoutIdentity(nativeLayout, operatingSystem);
	return Object.freeze({
		layout: Object.freeze({
			...identity,
			source: 'native',
			operatingSystem,
			isUSStandard: isUSStandardLayout(identity.id, operatingSystem) || undefined,
		}),
		mapping: Object.freeze(mapping),
	});
}

function nativeLayoutIdentity(
	layout: ReturnType<NativeKeymapModule['getCurrentKeyboardLayout']>,
	operatingSystem: OperatingSystem,
): { readonly id: string; readonly label: string } {
	if (operatingSystem === OperatingSystem.Windows && 'name' in layout) {
		return { id: layout.name, label: layout.text };
	}
	if (operatingSystem === OperatingSystem.Macintosh && 'lang' in layout) {
		return { id: layout.id, label: layout.localizedName || layout.id };
	}
	if ('layout' in layout) {
		return {
			id: layout.layout,
			label: layout.variant ? `${layout.layout} (${layout.variant})` : layout.layout,
		};
	}
	return { id: 'unknown', label: 'Unknown keyboard layout' };
}

function currentOperatingSystem(): OperatingSystem {
	switch (process.platform) {
		case 'win32': return OperatingSystem.Windows;
		case 'darwin': return OperatingSystem.Macintosh;
		default: return OperatingSystem.Linux;
	}
}

function isUSStandardLayout(id: string, operatingSystem: OperatingSystem): boolean {
	return operatingSystem === OperatingSystem.Windows
		? id === '00000409' || id === '00000804' || id === '00000411' || id === '00000412' || id === '00000404'
		: operatingSystem === OperatingSystem.Macintosh
			? id === 'com.apple.keylayout.US' || id === 'com.apple.keylayout.ABC'
			: id === 'us';
}
