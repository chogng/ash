import type { DesignKeyframe, DesignShape } from '../../../common/model/document.js';

/** Linear interpolation matches the CSS animation emitted by the code generator. */
export function sampleDesignMotion(shape: DesignShape, time: number): DesignKeyframe {
	const motion = shape.motion;
	if (!motion) { return { offset: 0, x: shape.x, y: shape.y, rotation: shape.rotation, opacity: 1 }; }
	const offset = motion.loop ? (time % motion.duration) / motion.duration : Math.min(1, time / motion.duration);
	const endIndex = motion.keyframes.findIndex(frame => frame.offset >= offset);
	const end = motion.keyframes[endIndex];
	const start = motion.keyframes[Math.max(0, endIndex - 1)];
	const fraction = start === end ? 0 : (offset - start.offset) / (end.offset - start.offset);
	const interpolate = (field: 'x' | 'y' | 'rotation' | 'opacity'): number => start[field] + (end[field] - start[field]) * fraction;
	return { offset, x: interpolate('x'), y: interpolate('y'), rotation: interpolate('rotation'), opacity: interpolate('opacity') };
}

export function designMotionDuration(shapes: readonly DesignShape[]): number {
	return Math.max(1000, ...shapes.map(shape => Math.max(shape.motion?.duration ?? 0, shape.kind === 'group' || shape.kind === 'frame' ? designMotionDuration(shape.children) : 0)));
}
