import { stopEvent } from '../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { CommandsRegistry } from '../../commands/common/commands.js';
import { ContextKeyExpr, type Context, type ContextKeyValue } from '../../contextkey/common/contextkey.js';
import { KeybindingResolver, KeybindingResolveKind } from '../../keybinding/common/keybindingResolver.js';
import {
	KeybindingSource,
	KeybindingsRegistry,
	KeybindingWeight,
} from '../../keybinding/common/keybindingsRegistry.js';
import {
	IQuickInputService,
	QuickInputType,
	QuickPickFocus,
	type IKeyMods,
	type IQuickInput,
	type IQuickPick,
	type IQuickPickItem,
} from '../common/quickInput.js';
import {
	endOfQuickInputBoxContext,
	inQuickInputContext,
	quickInputFocusContext,
	quickInputTypeContextKey,
} from './quickInput.js';

interface QuickInputCommand {
	readonly id: string;
	readonly key: number;
	readonly pickOnly?: boolean;
	readonly anywhere?: boolean;
	readonly endOnly?: boolean;
	readonly focus?: QuickPickFocus;
}

const control = isMacintosh ? KeyMod.WinCtrl : KeyMod.CtrlCmd;
const commands: readonly QuickInputCommand[] = [
	{ id: 'quickInput.next', key: KeyCode.DownArrow, pickOnly: true, focus: QuickPickFocus.Next },
	{ id: 'quickInput.previous', key: KeyCode.UpArrow, pickOnly: true, focus: QuickPickFocus.Previous },
	{ id: 'quickInput.pageNext', key: KeyCode.PageDown, pickOnly: true, focus: QuickPickFocus.NextPage },
	{ id: 'quickInput.pagePrevious', key: KeyCode.PageUp, pickOnly: true, focus: QuickPickFocus.PreviousPage },
	{ id: 'quickInput.first', key: control | KeyCode.Home, pickOnly: true, focus: QuickPickFocus.First },
	{ id: 'quickInput.last', key: control | KeyCode.End, pickOnly: true, focus: QuickPickFocus.Last },
	{ id: 'quickInput.accept', key: KeyCode.Enter },
	{ id: 'quickInput.acceptInBackground', key: KeyCode.RightArrow, pickOnly: true, endOnly: true },
	{ id: 'quickInput.hide', key: KeyCode.Escape, anywhere: true },
	{ id: 'quickInput.toggleCheckbox', key: control | KeyCode.Space, pickOnly: true },
];

/** Command invocation and DOM fallback share these operations; there is no second key map. */
function run(command: QuickInputCommand, input: IQuickInput | undefined, mods?: IKeyMods): void {
	if (!input || (command.pickOnly && input.type !== QuickInputType.QuickPick)) return;
	const picker = input.type === QuickInputType.QuickPick ? (input as IQuickPick<IQuickPickItem>) : undefined;
	if (mods && picker) picker.keyMods = mods;
	if (command.focus !== undefined) picker?.focus(command.focus);
	else if (command.id === 'quickInput.hide') input.hide();
	else if (command.id === 'quickInput.toggleCheckbox') picker?.toggle();
	else void input.accept(command.id === 'quickInput.acceptInBackground');
}

for (const command of commands) {
	CommandsRegistry.register(command.id, (accessor, mods) =>
		run(command, accessor.get(IQuickInputService).currentQuickInput, mods as IKeyMods | undefined),
	);
	const when = ContextKeyExpr.and(
		inQuickInputContext.isEqualTo(true),
		command.anywhere ? undefined : quickInputFocusContext.isEqualTo(true),
		command.pickOnly ? quickInputTypeContextKey.isEqualTo(QuickInputType.QuickPick) : undefined,
		command.endOnly ? endOfQuickInputBoxContext.isEqualTo(true) : undefined,
	);
	const bits = [KeyMod.CtrlCmd, KeyMod.WinCtrl, KeyMod.Alt, KeyMod.Shift];
	const modifiers =
		command.id === 'quickInput.accept'
			? Array.from({ length: 16 }, (_, index) =>
					bits.reduce((value, bit, offset) => value | (index & (1 << offset) ? bit : 0), 0),
				)
			: [0];
	for (const modifier of modifiers) {
		KeybindingsRegistry.registerKeybindingRule({
			command: command.id,
			keybinding: command.key | modifier,
			when,
			args: [
				{
					ctrlCmd: !!(modifier & (KeyMod.CtrlCmd | KeyMod.WinCtrl)),
					alt: !!(modifier & KeyMod.Alt),
					shift: !!(modifier & KeyMod.Shift),
				},
			],
			source: KeybindingSource.Builtin,
			priority: KeybindingWeight.WorkbenchContrib,
		});
	}
}

const resolver = new KeybindingResolver();

/** Bare widget hosts resolve the same registered bindings, including user blockers and overrides. */
export function dispatchQuickInputKeyDown(event: KeyboardEvent, input: IQuickInput, inherited?: Context): void {
	if (event.defaultPrevented || event.isComposing) return;
	const target = event.target as HTMLElement;
	const field = target.tagName === 'INPUT' ? (target as HTMLInputElement) : undefined;
	const values = new Map<string, ContextKeyValue>([
		[inQuickInputContext.key, true],
		[quickInputTypeContextKey.key, input.type],
		[quickInputFocusContext.key, !target.closest('button, [role="tab"]')],
		[
			endOfQuickInputBoxContext.key,
			!field || (field.selectionStart === field.selectionEnd && field.selectionEnd === field.value.length),
		],
	]);
	const context: Context = {
		getValue: <T extends ContextKeyValue>(key: string): T | undefined =>
			(values.has(key) ? values.get(key) : inherited?.getValue(key)) as T | undefined,
	};
	const result = resolver.resolve(context, [
		{
			key: event.key,
			code: event.code,
			location: event.location,
			ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
		},
	]);
	if (result.kind === KeybindingResolveKind.Blocked) {
		stopEvent(event);
		return;
	}
	if (result.kind !== KeybindingResolveKind.Command) return;
	const command = commands.find(command => command.id === result.command);
	if (!command) return;
	stopEvent(event);
	run(command, input, { ctrlCmd: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey });
}
