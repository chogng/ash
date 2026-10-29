import { localize, localize2 } from '../../../../../nls.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ILocalTranscriptionModelService, isModelPreparing } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { readDictationPreparation } from '../speechToText/dictationInput.js';
import { activeDictationEditor, cancelDictation, isDictating, onDidChangeDictationEditor, startDictation, stopDictation } from '../speechToText/dictationSession.js';
import { IChatWidgetService, type IChatWidget } from '../chat.js';
import { SELECT_MICROPHONE_COMMAND } from '../speechToText/micButtonMenuActions.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IDictationOnboardingService, SHOW_DICTATION_ONBOARDING_COMMAND, RESET_DICTATION_ONBOARDING_COMMAND } from '../speechToText/dictationOnboarding.js';
import { IChatSpeechToTextService, ChatSpeechToTextInProgress } from '../speechToText/chatSpeechToTextService.js';

// Command admission while local model discovery is pending; capture state belongs to the speech service.
const preparations = new WeakMap<IChatSpeechToTextService, { readonly widget: IChatWidget; readonly cancel: () => void; }>();

registerAction2(class ShowDictationIntroductionAction extends Action2 {
	constructor() {
		super({
			id: SHOW_DICTATION_ONBOARDING_COMMAND,
			title: localize2({ bundle: 'ash', key: 'dictation.showIntroduction' }, 'Dictation: Show introduction'),
			f1: true,
		});
	}
	public override run(accessor: ServicesAccessor): void { accessor.get(IDictationOnboardingService).show(); }
});
registerAction2(class ResetDictationIntroductionAction extends Action2 {
	constructor() {
		super({ id: RESET_DICTATION_ONBOARDING_COMMAND, title: localize2('dictation.resetIntroduction', 'Dictation: Reset introduction'), f1: true });
	}
	public override run(accessor: ServicesAccessor): void { accessor.get(IDictationOnboardingService).reset(); }
});
registerAction2(class CancelDictationAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.cancelSpeechToText',
			precondition: ChatSpeechToTextInProgress.isEqualTo(true),
			title: localize2({ bundle: 'ash', key: 'dictation.cancelCommand' }, 'Dictation: Cancel recording'),
			f1: true,
		});
	}
	public override run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IChatSpeechToTextService);
		preparations.get(service)?.cancel();
		cancelDictation();
		return service.cancel();
	}
});

async function toggle(accessor: ServicesAccessor, context?: unknown): Promise<void> {
	const widgets = accessor.get(IChatWidgetService);
	const widget = targetWidget(widgets, context);
	if (!widget) return;
	const preparation = preparations.get(accessor.get(IChatSpeechToTextService));
	if (preparation?.widget === widget) { preparation.cancel(); return; }
	if (activeDictationEditor() === widget.inputEditor) { await stopDictation(); return; }
	if (isDictating()) return;
	await record(accessor, widget);
}

function targetWidget(widgets: IChatWidgetService, context: unknown): IChatWidget | undefined {
	const explicit = context && typeof context === 'object' && 'widget' in context ? context.widget : undefined;
	const widget = explicit === undefined ? widgets.lastFocusedWidget : widgets.getAllWidgets().find(widget => widget === explicit);
	return widget?.visible && !widget.isTranscriptProgressActive && widget.inputEditor ? widget : undefined;
}

async function record(accessor: ServicesAccessor, widget: IChatWidget, released?: Promise<void>): Promise<void> {
	const editor = widget.inputEditor;
	const service = accessor.get(IChatSpeechToTextService);
	if (!editor || !service.isConfigured || service.isBusy || preparations.has(service)) return;
	const widgets = accessor.get(IChatWidgetService);
	const configuration = accessor.get(IConfigurationService);
	const local = accessor.get(ILocalTranscriptionModelService);
	const speech = accessor.get(ISpeechService);
	const preferences = accessor.get(IPreferencesService);
	const onboarding = accessor.get(IDictationOnboardingService);
	const log = accessor.get(ILogService);
	const lifetime = new DisposableStore();
	const controller = new AbortController();
	const preparation = {
		widget, cancel: (): void => {
			controller.abort();
			lifetime.dispose();
			if (preparations.get(service) === preparation) preparations.delete(service);
		}
	};
	const cancel = preparation.cancel;
	preparations.set(service, preparation);
	lifetime.add(Event.once(widget.onDidHide)(cancel));
	lifetime.add(Event.once(widget.onDidChangeViewModel)(cancel));
	lifetime.add(Event.once(editor.onDidDispose)(cancel));
	lifetime.add(Event.once(editor.onWillChangeModel)(cancel));
	let owned = false;
	lifetime.add(onDidChangeDictationEditor(() => {
		if (activeDictationEditor() === editor) owned = true;
		else if (owned) cancel();
	}));
	const heldFrom = Date.now();
	// Observe release before any preparation or provider acquisition can suspend this command.
	const release = released?.then(() => {
		if (Date.now() - heldFrom < 500 || !owned) cancel();
	});
	try {
		const model = await readDictationPreparation(configuration, local, speech);
		if (controller.signal.aborted || !widget.visible || widget.isTranscriptProgressActive || !widgets.getAllWidgets().includes(widget) || service.isBusy || isDictating()) return;
		if (model && (!model.available || isModelPreparing(model.status))) { await preferences.openSettings({ section: 'dictation' }); return; }
		onboarding.showIfNeeded();
		if (preparations.get(service) === preparation) preparations.delete(service);
		await startDictation(service, editor, editor.getContainerDomNode().ownerDocument.defaultView as Window & typeof globalThis, log, 'chat', controller.signal);
		if (release) {
			await release;
			if (!controller.signal.aborted && activeDictationEditor() === editor) await stopDictation();
		}
	} catch (error) {
		if (!isCancellationError(error)) throw error;
	} finally {
		if (preparations.get(service) === preparation) preparations.delete(service);
		// A toggle returns after acquisition; its listeners retire with this exact recording.
		if (release || !owned || controller.signal.aborted) lifetime.dispose();
	}
}

registerAction2(class ToggleDictationAction extends Action2 {
	constructor() { super({ id: 'workbench.action.chat.toggleSpeechToText', title: localize2('chat.input.dictate', 'Dictate message'), f1: true }); }
	public override run(accessor: ServicesAccessor, context?: unknown): Promise<void> { return toggle(accessor, context); }
});
registerAction2(class HoldDictationAction extends Action2 {
	constructor() { super({ id: 'workbench.action.chat.holdToSpeechToText', title: localize2('dictation.hold', 'Dictation: Hold to record'), f1: true }); }
	public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		if (isDictating()) return;
		const widget = targetWidget(accessor.get(IChatWidgetService), context);
		if (!widget) return;
		const released = accessor.get(IKeybindingService).enableKeybindingHoldMode(this.desc.id);
		if (released) await record(accessor, widget, released);
	}
});
registerAction2(class SelectDictationMicrophoneAction extends Action2 {
	constructor() { super({ id: SELECT_MICROPHONE_COMMAND, title: localize2('dictation.selectMicrophone', 'Select microphone'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = activeDictationEditor() ?? accessor.get(IChatWidgetService).lastFocusedWidget?.inputEditor;
		const target = (editor?.getContainerDomNode().ownerDocument.defaultView ?? window) as Window & typeof globalThis;
		const configuration = accessor.get(IConfigurationService);
		const service = accessor.get(IChatSpeechToTextService);
		const onboarding = accessor.get(IDictationOnboardingService);
		const quickInput = accessor.get(IQuickInputService);
		const devices = await target.navigator.mediaDevices?.enumerateDevices() ?? [];
		const lifetime = new DisposableStore();
		const picker = lifetime.add(quickInput.createQuickPick<IQuickPickItem & { deviceId: string; }>());
		picker.placeholder = picker.ariaLabel = localize('dictation.selectMicrophone', 'Select microphone');
		const items = [{ label: localize('dictation.defaultMicrophone', 'System default'), deviceId: '' }, ...devices.filter(device => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications').map(device => ({ label: device.label || localize('dictation.microphone', 'Microphone'), deviceId: device.deviceId }))];
		picker.items = items;
		picker.activeItems = items.filter(item => item.deviceId === configuration.getValue('dictation.inputDevice'));
		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			lifetime.add(picker.onDidHide(() => { if (!accepted) resolve(); }));
			lifetime.add(picker.onDidAccept(() => {
				const selected = picker.selectedItems[0] ?? picker.activeItems[0];
				if (!selected || accepted) return;
				accepted = true;
				picker.hide();
				void (async () => {
					await configuration.updateValue('dictation.inputDevice', selected.deviceId);
					if (service.isBusy) await service.switchMicrophone(target, selected.deviceId);
					onboarding.refreshMicrophones(service.analyserNode);
				})().then(resolve, reject);
			}));
			picker.show();
		}).finally(() => lifetime.dispose());
	}
});
