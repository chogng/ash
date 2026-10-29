import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { prototypePath, prototypeScrollRange, prototypeScrollTargets } from '../../../common/model/prototypeScroll.js';
import './prototype.css';
import { addDisposableListener, h, svg } from '../../../../../../base/browser/dom.js';
import { status } from '../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { localize } from '../../../../../../nls.js';
import type { DesignEditorContributionContext, IDesignPrototypeContribution } from '../../../browser/designEditorBrowser.js';
import { CreatorMode } from '../../../common/creator.js';
import { flattenDesignShapes, type DesignShape } from '../../../common/model/document.js';
import { getDesignLibraryShapes, getDesignResourceCatalog } from '../../../common/model/designResources.js';
import { defaultPrototypeSpring, defaultPrototypeTransition, flattenPrototypeActions, prototypeVariants, isPrototypeUrl, prototypeFrames, prototypeOwner, type PrototypeInteraction, type PrototypeStep } from '../../../common/model/prototype.js';
import { parsePrototypeExpression, formatPrototypeExpression, prototypeExpressionType, type PrototypeExpression } from '../../../common/model/prototypeExpression.js';
import { springProgress, prototypeTransitionDuration } from '../../../common/model/prototypePlayback.js';
import { PrototypeConnections } from './prototypeConnections.js';
import { PrototypePreview } from './prototypePreview.js';
import { actionLabels, transitionLabels, triggerLabels } from './prototypeLabels.js';

/** Authoring UI stores only choices and focus. Settings are written through PrototypeCommands. */
export class DesignPrototypeWidget extends Disposable implements IDesignPrototypeContribution {
	public readonly domNode: HTMLDetailsElement;
	public readonly previewDomNode: HTMLElement;
	private readonly fields: HTMLElement;
	private parent: HTMLElement | undefined;
	private readonly controls = this._register(new DisposableStore());
	private readonly connections: PrototypeConnections;
	private readonly preview: PrototypePreview;
	private revision = '';
	private interactionId = '';
	private showConnections = false;
	private scale = 1;
	private active = true;
	constructor(private readonly context: DesignEditorContributionContext, @IOpenerService opener: IOpenerService) {
		super();
		this.fields = h(context.ownerDocument, 'div', { className: 'ash-prototype-fields' });
		this.domNode = h(context.ownerDocument, 'details', { className: 'ash-design-property-section ash-prototype-properties' }, h(context.ownerDocument, 'summary', {}, localize('sessions.design.prototype.title', 'Prototype'), h(context.ownerDocument, 'span', { className: 'ash-design-property-disclosure', attributes: { 'aria-hidden': 'true' } })), this.fields);
		this.domNode.open = context.documentController.mode === CreatorMode.Prototype;
		this.showConnections = this.domNode.open;
		this.connections = this._register(new PrototypeConnections(context, interactionId => { if (interactionId) { this.interactionId = interactionId; } this.domNode.open = true; this.update(this.scale, this.active, true); this.fields.querySelector<HTMLElement>('select')?.focus(); }));
		this.preview = this._register(new PrototypePreview(context, url => { void opener.open(URI.parse(url), { openExternal: true, allowCommands: false }).catch(error => status(String(error))); }));
		this.previewDomNode = this.preview.domNode;
		this._register(addDisposableListener(this.domNode, 'toggle', () => { if (this.domNode.open) { this.showConnections = true; this.update(this.scale, this.active, true); } }));
	}
	public update(scale: number, active: boolean, force = false): void {
		this.scale = scale; this.active = active;
		if (!active && this.preview.isOpen) { this.preview.close(); }
		this.connections.update(scale, active && this.showConnections && !this.context.documentController.isBusy);
		const revision = `${this.context.documentController.model.version}:${[...this.context.selection.ids].join(',')}:${this.context.documentController.isBusy}`;
		if (!force && this.revision === revision) { return; }
		this.revision = revision;
		const focused = this.context.ownerDocument.activeElement as HTMLElement | null;
		const focusKey = this.domNode.contains(focused) ? focused?.dataset.prototypeControl : undefined;
		this.controls.clear(); this.parent = undefined; this.fields.replaceChildren();
		const doc = this.context.documentController.model.value;
		const frames = prototypeFrames(doc.shapes);
		const selected = this.context.selection.ids;
		const shape = selected.size === 1 ? flattenDesignShapes(doc.shapes).find(shape => selected.has(shape.id)) : undefined;
		this.button('preview', localize('sessions.design.prototype.preview', 'Prototype preview'), () => this.showPreview(), !!frames.length);
		this.check('connections', localize('sessions.design.prototype.connections', 'Show connections'), this.showConnections, value => { this.showConnections = value; this.connections.update(this.scale, this.active && value); });
		if (shape && frames.some(frame => frame.id === shape.id)) {
			this.check('startingPoint', localize('sessions.design.prototype.startingPoint', 'Flow starting point'), !!shape.flowStart, value => this.context.commands.prototype.setFlow(shape.id, value ? localize('sessions.design.prototype.defaultFlow', 'Flow 1') : undefined));
			if (shape.flowStart) { this.input('flowName', localize('sessions.design.prototype.flowName', 'Flow name'), shape.flowStart, value => this.context.commands.prototype.setFlow(shape.id, value)); }
		}
		if (!shape) { this.fields.append(h(this.context.ownerDocument, 'p', {}, localize('sessions.design.prototype.selectHotspot', 'Select a layer to add an interaction. Drag its connection handle to a destination screen, or use the fields below.'))); return; }
		this.renderScroll(shape);
		const variants = prototypeVariants([...doc.shapes, ...getDesignLibraryShapes(doc.resources)], shape.id);
		this.button('add', localize('sessions.design.prototype.add', 'Add interaction'), () => {
			const owner = prototypeOwner(doc.shapes, shape.id);
			const destination = (owner ? frames.find(frame => frame.id !== owner.id) : undefined) ?? variants[0];
			if (destination) { this.context.commands.prototype.connect(new Set([shape.id]), destination.id); }
			else { this.context.commands.prototype.setInteractions(shape.id, [...shape.interactions ?? [], { id: generateUuid(), trigger: 'click', actions: [{ action: 'back', transition: defaultPrototypeTransition }] }]); }
			this.interactionId = flattenDesignShapes(this.context.documentController.model.value.shapes).find(item => item.id === shape.id)?.interactions?.at(-1)?.id ?? ''; this.update(this.scale, this.active, true);
		}, (shape.interactions?.length ?? 0) < 100);
		const interactions = shape.interactions ?? [];
		const interaction = interactions.find(item => item.id === this.interactionId) ?? interactions[0];
		if (interaction) {
			this.interactionId = interaction.id;
			const edit = (changes: Partial<PrototypeInteraction>): void => this.context.commands.prototype.setInteractions(shape.id, interactions.map(item => item.id === interaction.id ? { ...item, ...changes } : item));
			this.select('interaction', localize('sessions.design.prototype.interaction', 'Interaction'), interaction.id, interactions.map((item, index) => [item.id, `${index + 1}. ${triggerLabels()[item.trigger]} · ${item.actions.map(action => actionLabels()[action.action]).join(' → ')}`]), value => { this.interactionId = value; this.update(this.scale, this.active, true); });
			this.select('trigger', localize('sessions.design.prototype.trigger', 'Trigger'), interaction.trigger, Object.entries(triggerLabels()), value => edit({ trigger: value as PrototypeInteraction['trigger'], ...(value === 'delay' ? { delay: interaction.delay ?? 800 } : {}), ...(value === 'key' ? { key: interaction.key ?? 'Enter' } : {}) }));
			if (interaction.trigger === 'delay') { this.number('delay', localize('sessions.design.prototype.delayMs', 'Delay (ms)'), interaction.delay ?? 800, 1, 60000, value => edit({ delay: value })); }
			if (interaction.trigger === 'key') { this.input('key', localize('sessions.design.prototype.keyName', 'Key'), interaction.key ?? 'Enter', value => { if (value && value.length <= 64) { edit({ key: value }); } }); }
			this.renderActions(interaction.actions, actions => edit({ actions }), shape.id, 'actions', 0);
			this.button('remove', localize('sessions.design.prototype.remove', 'Remove interaction'), () => this.context.commands.prototype.setInteractions(shape.id, interactions.filter(item => item.id !== interaction.id)));
		}
		if (focusKey) { this.fields.querySelector<HTMLElement>(`[data-prototype-control="${focusKey}"]`)?.focus(); }
	}
	private createAction(type: PrototypeStep['action'], shapeId: string): PrototypeStep {
		const doc = this.context.documentController.model.value;
		const catalog = getDesignResourceCatalog(doc.resources);
		const variable = catalog.variables[0];
		return {
			action: type, transition: defaultPrototypeTransition,
			...(['navigate', 'overlay', 'swap'].includes(type) ? { destination: prototypeFrames(doc.shapes)[0]?.id } : {}),
			...(type === 'scrollTo' ? { destination: prototypeScrollTargets(doc.shapes, shapeId)[0]?.id } : {}),
			...(type === 'changeTo' ? { destination: prototypeVariants([...doc.shapes, ...getDesignLibraryShapes(doc.resources)], shapeId)[0]?.id } : {}),
			...(type === 'url' ? { url: '' } : {}),
			...(type === 'setVariable' ? { variableId: variable.id, value: { kind: 'literal', value: variable.type === 'number' ? 0 : variable.type === 'boolean' ? false : variable.type === 'color' ? '#000000' : '' } as const } : {}),
			...(type === 'setMode' ? { collectionId: catalog.collections[0].id, modeId: catalog.collections[0].defaultMode } : {}),
			...(type === 'conditional' ? { branches: [{ condition: { kind: 'literal', value: true } as const, actions: [] }, { actions: [] }] } : {}),
		};
	}
	private renderActions(actions: readonly PrototypeStep[], change: (actions: readonly PrototypeStep[]) => void, shapeId: string, prefix: string, depth: number): void {
		const parent = this.parent;
		const doc = this.context.documentController.model.value;
		const frames = prototypeFrames(doc.shapes), variants = prototypeVariants([...doc.shapes, ...getDesignLibraryShapes(doc.resources)], shapeId);
		const { variables, collections } = getDesignResourceCatalog(doc.resources);
		for (const [index, action] of actions.entries()) {
			const path = `${prefix}.${index}`;
			const group = h(this.context.ownerDocument, 'fieldset', { className: 'ash-prototype-action', attributes: { 'data-prototype-action': path } }, h(this.context.ownerDocument, 'legend', {}, localize('sessions.design.prototype.actionNumber', '{0}. {1}', index + 1, actionLabels()[action.action])));
			(parent ?? this.fields).append(group); this.parent = group;
			const replace = (next: PrototypeStep): void => change(actions.map((item, i) => i === index ? next : item));
			const editStep = (changes: Partial<PrototypeStep>): void => replace({ ...action, ...changes });
			this.select(`${path}.action`, localize('sessions.design.prototype.action', 'Action'), action.action, Object.entries(actionLabels()).filter(([key]) => key === 'scrollTo' ? prototypeScrollTargets(doc.shapes, shapeId).length > 0 || action.action === key : key === 'changeTo' ? variants.length > 0 || action.action === 'changeTo' : key === 'setVariable' ? variables.length > 0 || action.action === key : key === 'setMode' ? collections.length > 0 || action.action === key : key === 'conditional' ? depth < 16 : frames.length || !['navigate', 'overlay', 'swap'].includes(key)), value => { const next = this.createAction(value as PrototypeStep['action'], shapeId); replace({ ...next, ...(!['conditional', 'setVariable', 'setMode', 'url', 'scrollTo'].includes(value) && action.action !== 'scrollTo' ? { transition: action.transition } : {}), ...(['navigate', 'overlay', 'swap'].includes(value) && frames.some(frame => frame.id === action.destination) ? { destination: action.destination } : {}) }); });

			const scrollTargets = prototypeScrollTargets(doc.shapes, shapeId), wiredTarget = prototypeScrollTargets(doc.shapes, shapeId, false).find(target => target.id === action.destination || target.sourceId === action.destination);
			const destinations = action.action === 'scrollTo' ? [...scrollTargets, ...(wiredTarget && !scrollTargets.some(target => target.id === action.destination) ? [{ ...wiredTarget, id: action.destination! }] : [])] : action.action === 'changeTo' ? variants : frames;
			if (['navigate', 'overlay', 'swap', 'changeTo', 'scrollTo'].includes(action.action)) { this.select(`${path}.destination`, localize('sessions.design.prototype.destination', 'Destination'), action.destination ?? '', [...destinations.map((frame, index) => [frame.id, frame.name || localize('sessions.design.prototype.screenNumber', 'Screen {0}', index + 1)] as const), ...(!destinations.some(frame => frame.id === action.destination) ? [[action.destination ?? '', localize('sessions.design.prototype.missingDestination', 'Missing destination')] as const] : [])], value => editStep({ destination: value })); }
			if (['navigate', 'overlay', 'swap'].includes(action.action)) { this.check(`${path}.resetScroll`, localize('sessions.design.prototype.resetScroll', 'Reset scroll position'), !!action.resetScroll, resetScroll => editStep({ resetScroll })); }
			if (action.action === 'url') { this.input(`${path}.url`, localize('sessions.design.prototype.link', 'Link URL'), action.url ?? '', value => { if (!value || isPrototypeUrl(value)) { editStep({ url: value }); } else { status(localize('sessions.design.prototype.invalidUrl', 'Enter an http, https or mailto link.')); this.update(this.scale, this.active, true); } }); }
			if (action.action === 'overlay' || action.action === 'swap') {
				const overlay = action.overlay ?? { position: 'center', closeOutside: true, background: true };
				this.select(`${path}.overlayPosition`, localize('sessions.design.prototype.overlayPosition', 'Overlay position'), overlay.position, [['center', localize('sessions.design.prototype.center', 'Center')], ['topLeft', localize('sessions.design.prototype.topLeft', 'Top left')], ['topRight', localize('sessions.design.prototype.topRight', 'Top right')], ['bottomLeft', localize('sessions.design.prototype.bottomLeft', 'Bottom left')], ['bottomRight', localize('sessions.design.prototype.bottomRight', 'Bottom right')]], value => editStep({ overlay: { ...overlay, position: value as typeof overlay.position } }));
				this.check(`${path}.closeOutside`, localize('sessions.design.prototype.closeOutside', 'Close when clicking outside'), overlay.closeOutside, value => editStep({ overlay: { ...overlay, closeOutside: value } }));
				this.check(`${path}.background`, localize('sessions.design.prototype.background', 'Add background behind overlay'), overlay.background, value => editStep({ overlay: { ...overlay, background: value } }));
			}
			if (!['conditional', 'setVariable', 'setMode', 'url'].includes(action.action)) {
				const transition = action.transition;
				this.select(`${path}.transition`, localize('sessions.design.prototype.transition', 'Transition'), transition.type, Object.entries(transitionLabels()).filter(([key]) => action.action === 'scrollTo' ? key === 'instant' || key === 'scroll' : key !== 'scroll'), value => editStep({ transition: { ...transition, type: value as typeof transition.type } }));
				if (transition.type !== 'instant') {
					if (transition.easing !== 'spring') { this.number(`${path}.duration`, localize('sessions.design.prototype.duration', 'Duration (ms)'), transition.duration, 1, 10000, value => editStep({ transition: { ...transition, duration: value } })); }
					this.select(`${path}.easing`, localize('sessions.design.prototype.easing', 'Easing'), transition.easing, [['linear', localize('sessions.design.prototype.linear', 'Linear')], ['easeIn', localize('sessions.design.prototype.easeIn', 'Ease in')], ['easeOut', localize('sessions.design.prototype.easeOut', 'Ease out')], ['easeInOut', localize('sessions.design.prototype.easeInOut', 'Ease in and out')], ['spring', localize('sessions.design.prototype.spring', 'Custom spring')]], value => editStep({ transition: { ...transition, easing: value as typeof transition.easing, ...(value === 'spring' ? { spring: transition.spring ?? defaultPrototypeSpring } : { duration: Math.min(10000, transition.duration) }) } }));
					if (transition.easing === 'spring') { this.renderSpring(action, editStep); }
					if (!['smart', 'dissolve', 'scroll'].includes(transition.type)) { this.select(`${path}.direction`, localize('sessions.design.prototype.direction', 'Direction'), transition.direction, [['left', localize('sessions.design.prototype.left', 'Left')], ['right', localize('sessions.design.prototype.right', 'Right')], ['top', localize('sessions.design.prototype.top', 'Top')], ['bottom', localize('sessions.design.prototype.bottom', 'Bottom')]], value => editStep({ transition: { ...transition, direction: value as typeof transition.direction } })); }
				}

			}
			if (action.action === 'setVariable') {
				const variable = variables.find(item => item.id === action.variableId);
				this.select(`${path}.variable`, localize('sessions.design.prototype.variable', 'Variable'), action.variableId ?? '', [...variables.map(item => [item.id, item.name] as const), ...(!variable ? [[action.variableId ?? '', localize('sessions.design.prototype.missingVariable', 'Missing variable')] as const] : [])], id => { const selected = variables.find(item => item.id === id)!; editStep({ variableId: id, value: { kind: 'literal', value: selected.type === 'number' ? 0 : selected.type === 'boolean' ? false : selected.type === 'color' ? '#000000' : '' } }); });
				this.expression(`${path}.value`, localize('sessions.design.prototype.valueExpression', 'Value or expression'), action.value!, variable?.type, value => editStep({ value }));
			}
			if (action.action === 'setMode') {
				const collection = collections.find(item => item.id === action.collectionId);
				this.select(`${path}.collection`, localize('sessions.design.prototype.collection', 'Variable collection'), action.collectionId ?? '', [...collections.map(item => [item.id, item.name] as const), ...(!collection ? [[action.collectionId ?? '', localize('sessions.design.prototype.missingCollection', 'Missing collection')] as const] : [])], id => editStep({ collectionId: id, modeId: collections.find(item => item.id === id)!.defaultMode }));
				this.select(`${path}.mode`, localize('sessions.design.prototype.mode', 'Variable mode'), action.modeId ?? '', [...collection?.modes.map(mode => [mode.id, mode.name] as const) ?? [], ...(!collection?.modes.some(mode => mode.id === action.modeId) ? [[action.modeId ?? '', localize('sessions.design.prototype.missingMode', 'Missing mode')] as const] : [])], modeId => editStep({ modeId }));
			}
			if (action.action === 'conditional') {
				const branches = action.branches!;
				for (const [branchIndex, branch] of branches.entries()) {
					const branchPath = `${path}.branch.${branchIndex}`;
					const branchGroup = h(this.context.ownerDocument, 'fieldset', { className: 'ash-prototype-branch' }, h(this.context.ownerDocument, 'legend', {}, branch.condition ? branchIndex === 0 ? localize('sessions.design.prototype.if', 'If') : localize('sessions.design.prototype.elseIf', 'Else if') : localize('sessions.design.prototype.else', 'Else')));
					group.append(branchGroup); this.parent = branchGroup;
					const editBranch = (changes: Partial<typeof branch>): void => editStep({ branches: branches.map((item, i) => i === branchIndex ? { ...item, ...changes } : item) });
					if (branch.condition) { this.expression(`${branchPath}.condition`, localize('sessions.design.prototype.condition', 'Condition'), branch.condition, 'boolean', condition => editBranch({ condition })); }
					this.renderActions(branch.actions, actions => editBranch({ actions }), shapeId, branchPath, depth + 1);
					if (branchIndex > 0) { this.button(`${branchPath}.remove`, localize('sessions.design.prototype.removeBranch', 'Remove branch'), () => editStep({ branches: branches.filter((_, i) => i !== branchIndex) })); }
				}
				this.parent = group;
				this.button(`${path}.elseIf`, localize('sessions.design.prototype.addElseIf', 'Add else if'), () => { const next = [...branches]; next.splice(next.at(-1)?.condition ? next.length : next.length - 1, 0, { condition: { kind: 'literal', value: true }, actions: [] }); editStep({ branches: next }); }, branches.length < 100);
				if (branches.at(-1)?.condition) { this.button(`${path}.else`, localize('sessions.design.prototype.addElse', 'Add else'), () => editStep({ branches: [...branches, { actions: [] }] }), branches.length < 100); }
			}
			const buttons = h(this.context.ownerDocument, 'div', { className: 'ash-prototype-action-buttons' }); group.append(buttons); this.parent = buttons;
			const move = (offset: number): void => { const next = [...actions]; next.splice(index, 1); next.splice(index + offset, 0, action); change(next); };
			this.button(`${path}.up`, localize('sessions.design.prototype.moveUp', 'Move action up'), () => move(-1), index > 0);
			this.button(`${path}.down`, localize('sessions.design.prototype.moveDown', 'Move action down'), () => move(1), index < actions.length - 1);
			this.button(`${path}.remove`, localize('sessions.design.prototype.removeAction', 'Remove action'), () => change(actions.filter((_, i) => i !== index)), depth > 0 || actions.length > 1);
			this.parent = parent;
		}
		this.parent = parent;
		const total = flattenDesignShapes(doc.shapes).find(shape => shape.id === shapeId)?.interactions?.find(item => item.id === this.interactionId)?.actions ?? [];
		this.button(`${prefix}.add`, localize('sessions.design.prototype.addAction', 'Add action'), () => change([...actions, this.createAction('back', shapeId)]), flattenPrototypeActions(total).length < 1000);
	}
	private renderScroll(shape: DesignShape): void {
		const path = prototypePath(this.context.documentController.model.value.shapes, shape.id), parent = path.at(-2);
		const edit = (settings: Pick<Partial<DesignShape>, 'overflowDirection' | 'scrollPosition' | 'layoutPositioning'>): void => this.context.commands.prototype.setScroll(shape.id, settings);
		if (shape.kind === 'frame') {
			this.select('overflow', localize('sessions.design.prototype.overflow', 'Overflow scrolling'), shape.overflowDirection ?? 'none', [['none', localize('sessions.design.prototype.noScrolling', 'No scrolling')], ['horizontal', localize('sessions.design.prototype.horizontalScroll', 'Horizontal')], ['vertical', localize('sessions.design.prototype.verticalScroll', 'Vertical')], ['both', localize('sessions.design.prototype.bothScroll', 'Horizontal and vertical')]], value => edit({ overflowDirection: value as DesignShape['overflowDirection'] }));
			const range = prototypeScrollRange(shape);
			if (shape.overflowDirection && shape.overflowDirection !== 'none' && !range.x && !range.y) { this.fields.append(h(this.context.ownerDocument, 'p', {}, localize('sessions.design.prototype.noOverflow', 'Content must extend beyond the frame to scroll.'))); }
		}
		if (parent?.kind === 'frame' && parent.autoLayout) { this.check('absolute', localize('sessions.design.prototype.ignoreLayout', 'Ignore auto layout'), shape.layoutPositioning === 'absolute', value => edit({ layoutPositioning: value ? 'absolute' : 'auto' })); }
		const owner = path.slice(0, -1).reverse().find(item => item.kind === 'frame' && item.overflowDirection && item.overflowDirection !== 'none');
		if (owner || shape.scrollPosition && shape.scrollPosition !== 'scroll') {
			const options: [string, string][] = [['scroll', localize('sessions.design.prototype.scrollWithParent', 'Scroll with parent')]];
			if (!(parent?.kind === 'frame' && parent.autoLayout) || shape.layoutPositioning === 'absolute') { options.push(['fixed', localize('sessions.design.prototype.fixed', 'Fixed')]); }
			if (owner?.overflowDirection !== 'horizontal') { options.push(['sticky', localize('sessions.design.prototype.sticky', 'Sticky')]); }
			this.select('scrollPosition', localize('sessions.design.prototype.scrollPosition', 'Scroll position'), shape.scrollPosition ?? 'scroll', options, value => edit({ scrollPosition: value as DesignShape['scrollPosition'] }));
			if (parent?.kind === 'frame' && parent.autoLayout && shape.layoutPositioning !== 'absolute') { this.fields.append(h(this.context.ownerDocument, 'p', {}, localize('sessions.design.prototype.fixedRequiresAbsolute', 'Enable Ignore auto layout to use fixed positioning.'))); }
		}
	}
	private expression(key: string, label: string, value: PrototypeExpression, expected: string | undefined, change: (value: PrototypeExpression) => void): void {
		const variables = getDesignResourceCatalog(this.context.documentController.model.value.resources).variables;
		const input = h(this.context.ownerDocument, 'input', { properties: { type: 'text', value: formatPrototypeExpression(value, variables), maxLength: 8192 } });
		const error = h(this.context.ownerDocument, 'span', { className: 'ash-prototype-error', attributes: { id: `prototype-expression-${generateUuid()}`, role: 'alert' } });
		input.setAttribute('aria-describedby', error.id);
		const commit = (): void => {
			try {
				const expression = parsePrototypeExpression(input.value, variables), type = prototypeExpressionType(expression, variables);
				if (expected && type && expected !== type && !(expected === 'color' && expression.kind === 'literal' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(String(expression.value)))) { throw new TypeError(localize('sessions.design.prototype.expressionType', 'This expression must produce a {0} value.', ({ number: localize('sessions.design.prototype.numberType', 'number'), string: localize('sessions.design.prototype.stringType', 'string'), boolean: localize('sessions.design.prototype.booleanType', 'boolean'), color: localize('sessions.design.prototype.colorType', 'color') } as Record<string, string>)[expected])); }
				input.removeAttribute('aria-invalid'); error.textContent = ''; change(expression);
			} catch (cause) { input.setAttribute('aria-invalid', 'true'); error.textContent = cause instanceof Error ? cause.message : String(cause); }
		};
		this.control(key, label, input, commit); (this.parent ?? this.fields).append(error);
		this.controls.add(addDisposableListener(input, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }));
		if (variables.length) { this.select(`${key}.insert`, localize('sessions.design.prototype.insertVariable', 'Insert variable'), '', [['', localize('sessions.design.prototype.chooseVariable', 'Choose a variable…')], ...variables.map(variable => [variable.id, variable.name] as const)], id => { if (id) { const reference = formatPrototypeExpression({ kind: 'variable', id }, variables); input.setRangeText(reference, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end'); input.focus(); } }); }
	}
	private renderSpring(action: PrototypeStep, edit: (changes: Partial<PrototypeStep>) => void): void {
		const transition = action.transition, spring = transition.spring ?? defaultPrototypeSpring;
		const fields = [
			['mass', localize('sessions.design.prototype.mass', 'Mass'), 0.1, 100], ['stiffness', localize('sessions.design.prototype.stiffness', 'Stiffness'), 1, 10000],
			['damping', localize('sessions.design.prototype.damping', 'Damping'), 0.1, 1000], ['initialVelocity', localize('sessions.design.prototype.initialVelocity', 'Initial velocity'), -100, 100],
		] as const;
		for (const [key, label, min, max] of fields) { this.number(`${this.parent?.dataset.prototypeAction}.${key}`, label, spring[key], min, max, value => { const next = { ...transition, spring: { ...spring, [key]: value } }; edit({ transition: { ...next, duration: prototypeTransitionDuration(next) } }); }); }
		const duration = prototypeTransitionDuration(transition);
		const values = Array.from({ length: 101 }, (_, index) => springProgress(index / 100 * duration / 1000, spring));
		const min = Math.min(0, ...values), max = Math.max(1, ...values), y = (value: number): number => 60 - (value - min) / (max - min) * 52;
		const graph = svg(this.context.ownerDocument, 'svg', { className: 'ash-prototype-spring', attributes: { viewBox: '0 0 100 68', role: 'img', 'aria-label': localize('sessions.design.prototype.springDescription', 'Spring curve: mass {0}, stiffness {1}, damping {2}, initial velocity {3}. Settling duration {4} ms.', spring.mass, spring.stiffness, spring.damping, spring.initialVelocity, duration) } });
		graph.append(svg(this.context.ownerDocument, 'path', { className: 'ash-prototype-spring-target', attributes: { d: `M 0 ${y(1)} H 100` } }), svg(this.context.ownerDocument, 'path', { attributes: { d: values.map((value, index) => `${index ? 'L' : 'M'} ${index} ${y(value)}`).join(' ') } }));
		(this.parent ?? this.fields).append(graph, h(this.context.ownerDocument, 'span', {}, localize('sessions.design.prototype.settlingDuration', 'Settling duration: {0} ms', duration)));
	}
	public showPreview(): void { this.connections.cancel(); this.preview.show(); }
	public setVisible(visible: boolean): void { if (!visible) { this.connections.cancel(); if (this.preview.isOpen) { this.preview.close(false); } } }
	public focusPreview(): boolean { if (this.preview.isOpen) { this.preview.focus(); return true; } return false; }
	public getAccessibleContent(): string {
		if (this.preview.isOpen) { return this.preview.getAccessibleContent(); }
		const doc = this.context.documentController.model.value;
		const variables = getDesignResourceCatalog(doc.resources).variables;
		return flattenDesignShapes(doc.shapes).flatMap(shape => [shape.flowStart ? localize('sessions.design.prototype.flowDescription', 'Flow: {0}', shape.flowStart) : '', ...(shape.interactions ?? []).map(item => localize('sessions.design.prototype.connectionDescription', '{0}: {1}, {2}, {3}', shape.name || localize('sessions.design.prototype.hotspot', 'Hotspot'), triggerLabels()[item.trigger], flattenPrototypeActions(item.actions).map(action => actionLabels()[action.action]).join(' → '), flattenPrototypeActions(item.actions).map(action => action.value ? formatPrototypeExpression(action.value, variables) : action.branches ? action.branches.map(branch => branch.condition ? formatPrototypeExpression(branch.condition, variables) : localize('sessions.design.prototype.else', 'Else')).join(', ') : prototypeFrames(doc.shapes).find(frame => frame.id === action.destination)?.name || transitionLabels()[action.transition.type]).join(', ')))]).filter(Boolean).join('\n');
	}
	private button(key: string, label: string, run: () => void, enabled = true): void {
		const button = this.controls.add(new Button(this.parent ?? this.fields, {
			...defaultButtonStyles,
			label,
			onClick: () => { if (!this.context.documentController.isBusy) { run(); } },
		})); button.enabled = enabled && !this.context.documentController.isBusy; button.domNode.dataset.prototypeControl = key;
	}
	private control<T extends HTMLInputElement | HTMLSelectElement>(key: string, label: string, input: T, run: () => void): T {
		input.dataset.prototypeControl = key; input.setAttribute('aria-label', label); input.disabled = this.context.documentController.isBusy;
		(this.parent ?? this.fields).append(h(this.context.ownerDocument, 'label', { className: input instanceof this.context.ownerDocument.defaultView!.HTMLInputElement && input.type === 'checkbox' ? 'ash-prototype-checkbox' : 'ash-prototype-field' }, label, input));
		this.controls.add(addDisposableListener(input, 'change', () => { if (!this.context.documentController.isBusy) { run(); } })); return input;
	}
	private select(key: string, label: string, value: string, options: readonly (readonly [string, string])[], change: (value: string) => void): void {
		const input = h(this.context.ownerDocument, 'select'); input.replaceChildren(...options.map(([id, text]) => h(this.context.ownerDocument, 'option', { properties: { value: id } }, text))); input.value = value; this.control(key, label, input, () => change(input.value));
	}
	private input(key: string, label: string, value: string, change: (value: string) => void): void { const input = h(this.context.ownerDocument, 'input', { properties: { type: 'text', value, maxLength: 2048 } }); this.control(key, label, input, () => change(input.value.trim())); }
	private number(key: string, label: string, value: number, min: number, max: number, change: (value: number) => void): void { const input = h(this.context.ownerDocument, 'input', { properties: { type: 'number', step: 'any', value: `${value}`, min: `${min}`, max: `${max}` } }); this.control(key, label, input, () => { if (input.checkValidity() && Number.isFinite(input.valueAsNumber)) { change(input.valueAsNumber); } else { this.update(this.scale, this.active, true); } }); }
	private check(key: string, label: string, value: boolean, change: (value: boolean) => void): void { const input = h(this.context.ownerDocument, 'input', { properties: { type: 'checkbox', checked: value } }); this.control(key, label, input, () => change(input.checked)); }
}
