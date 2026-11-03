import type { UserInputValidation } from '../../../../../platform/agentHost/common/agent.js';

export function isChatQuestionAnswerValid(value: string, validation: UserInputValidation): boolean {
	const { min, max } = validation;
	switch (validation.type) {
		case 'string': {
			// MCP measures Unicode scalar values, while HTML length constraints count UTF-16 units.
			const length = Array.from(value).length;
			return (min === null || length >= Number(min)) && (max === null || length <= Number(max));
		}
		case 'integer': {
			if (!/^[+-]?[0-9]+$/.test(value)) return false;
			const integer = BigInt(value);
			return integer >= BigInt(min ?? '-9223372036854775808')
				&& integer <= BigInt(max ?? '9223372036854775807');
		}
		case 'number': {
			if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)) return false;
			const number = Number(value);
			return Number.isFinite(number) && (min === null || number >= Number(min)) && (max === null || number <= Number(max));
		}
	}
}
