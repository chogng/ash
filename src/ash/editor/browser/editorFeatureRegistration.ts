import { DisposableStore, markAsSingleton, type IDisposable } from '../../base/common/lifecycle.js';
import { type Command, type EditorAction, type EditorCommand, type EditorContributionHooks, type EditorContributionCtor, type EditorContributionRegistration, type EditorFeatureSet, type MultiEditorAction, EditorContributionInstantiation, EditorExtensionsRegistry } from './editorExtensions.js';
export * from './editorExtensions.js';

const contributions: EditorContributionRegistration[] = [];
const actions: EditorAction[] = [];
const commands: Command[] = [];
const registrations: (() => IDisposable)[] = [];

/** Module evaluation records declarations only; every effect is leased when the provider is admitted. */
export function onActivate(register: () => IDisposable): void { registrations.push(register); }
export function registerEditorContribution(contribution: EditorContributionHooks): void;
export function registerEditorContribution(id: string, ctor: EditorContributionCtor, instantiation: EditorContributionInstantiation): void;
export function registerEditorContribution(value: string | EditorContributionHooks, ctor?: EditorContributionCtor, instantiation?: EditorContributionInstantiation): void {
	contributions.push(typeof value === 'string' ? { id: value, ctor: ctor!, instantiation: instantiation! } : value);
}
export function registerEditorAction<T extends EditorAction>(ctor: new () => T): T { const action = new ctor(); actions.push(action); return action; }
export function registerMultiEditorAction<T extends MultiEditorAction>(action: T): T { actions.push(action); return action; }
export function registerInstantiatedEditorAction(action: EditorAction): void { actions.push(action); }
export function registerEditorCommand<T extends EditorCommand>(command: T): T { commands.push(command); return command; }
export function declareCommand<T extends Command>(command: T): T { commands.push(command); return command; }
export function getEditorFeatures(): EditorFeatureSet {
	return Object.freeze({ contributions: Object.freeze([...contributions]), actions: Object.freeze([...actions]), commands: Object.freeze([...commands]), registrations: Object.freeze([...registrations]) });
}

const productFeatures = markAsSingleton(new DisposableStore());
let active: EditorFeatureSet = { contributions: [], actions: [], commands: [], registrations: [] };

/** Product entries can admit a small feature set before loading the complete editor. */
export function activateEditorFeatures(): void {
	const next = getEditorFeatures();
	const added: EditorFeatureSet = {
		contributions: next.contributions.filter(value => !active.contributions.includes(value)),
		actions: next.actions.filter(value => !active.actions.includes(value)),
		commands: next.commands.filter(value => !active.commands.includes(value)),
		registrations: next.registrations.filter(value => !active.registrations.includes(value)),
	};
	if (!added.contributions.length && !added.actions.length && !added.commands.length && !added.registrations.length) return;
	// Existing inputs keep their contribution and command identities when Code arrives.
	productFeatures.add(EditorExtensionsRegistry.registerEditorFeatures(added));
	active = next;
}
