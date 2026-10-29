import { localize } from '../../../../../../nls.js';
import type { PrototypeAction, PrototypeTransition, PrototypeTrigger } from '../../../common/model/prototype.js';
export function triggerLabels(): Record<PrototypeTrigger, string> {
	return {
		click: localize('sessions.design.prototype.click', 'On click / tap'),
		hover: localize('sessions.design.prototype.hover', 'While hovering'),
		press: localize('sessions.design.prototype.press', 'While pressing'),
		drag: localize('sessions.design.prototype.drag', 'On drag'),
		enter: localize('sessions.design.prototype.enter', 'Mouse enter'),
		leave: localize('sessions.design.prototype.leave', 'Mouse leave'),
		down: localize('sessions.design.prototype.down', 'Mouse down'),
		up: localize('sessions.design.prototype.up', 'Mouse up'),
		key: localize('sessions.design.prototype.key', 'Key press'),
		delay: localize('sessions.design.prototype.delay', 'After delay'),
	};
}
export function actionLabels(): Record<PrototypeAction, string> {
	return {
		scrollTo: localize('sessions.design.prototype.scrollTo', 'Scroll to'),
		setVariable: localize('sessions.design.prototype.setVariable', 'Set variable'),
		setMode: localize('sessions.design.prototype.setMode', 'Set variable mode'),
		conditional: localize('sessions.design.prototype.conditional', 'Conditional'),
		changeTo: localize('sessions.design.prototype.changeTo', 'Change to'),
		navigate: localize('sessions.design.prototype.navigate', 'Navigate to'),
		back: localize('sessions.design.prototype.back', 'Back'),
		overlay: localize('sessions.design.prototype.overlay', 'Open overlay'),
		swap: localize('sessions.design.prototype.swap', 'Swap overlay'),
		close: localize('sessions.design.prototype.close', 'Close overlay'),
		url: localize('sessions.design.prototype.url', 'Open link'),
	};
}
export function transitionLabels(): Record<PrototypeTransition['type'], string> {
	return {
		scroll: localize('sessions.design.prototype.animateScroll', 'Animate'),
		instant: localize('sessions.design.prototype.instant', 'Instant'),
		dissolve: localize('sessions.design.prototype.dissolve', 'Dissolve'),
		smart: localize('sessions.design.prototype.smart', 'Smart animate'),
		moveIn: localize('sessions.design.prototype.moveIn', 'Move in'),
		moveOut: localize('sessions.design.prototype.moveOut', 'Move out'),
		push: localize('sessions.design.prototype.push', 'Push'),
		slideIn: localize('sessions.design.prototype.slideIn', 'Slide in'),
		slideOut: localize('sessions.design.prototype.slideOut', 'Slide out'),
	};
}
