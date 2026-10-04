import { Color } from '../../../../base/common/color.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type IColorPresentation } from '../../../common/languages.js';

export class ColorPickerModel extends Disposable {
	readonly originalColor: Color;
	private _color: Color;

	get color(): Color {
		return this._color;
	}

	set color(color: Color) {
		if (this._color.equals(color)) return;
		this._color = color;
		this._onDidChangeColor.fire(color);
	}

	get presentation(): IColorPresentation {
		return this.colorPresentations[this.presentationIndex]!;
	}

	private _colorPresentations: IColorPresentation[];

	get colorPresentations(): IColorPresentation[] {
		return this._colorPresentations;
	}

	set colorPresentations(colorPresentations: IColorPresentation[]) {
		this._colorPresentations = colorPresentations;
		if (colorPresentations.length > 0 && this.presentationIndex > colorPresentations.length - 1) this.presentationIndex = 0;
		this._onDidChangePresentation.fire(this.presentation);
	}

	private readonly _onColorFlushed = this._register(new Emitter<Color>());
	readonly onColorFlushed: Event<Color> = this._onColorFlushed.event;

	private readonly _onDidChangeColor = this._register(new Emitter<Color>());
	readonly onDidChangeColor: Event<Color> = this._onDidChangeColor.event;

	private readonly _onDidChangePresentation = this._register(new Emitter<IColorPresentation>());
	readonly onDidChangePresentation: Event<IColorPresentation> = this._onDidChangePresentation.event;

	constructor(color: Color, availableColorPresentations: IColorPresentation[], private presentationIndex: number) {
		super();
		this.originalColor = color;
		this._color = color;
		this._colorPresentations = availableColorPresentations;
	}

	selectNextColorPresentation(): void {
		if (this.colorPresentations.length === 0) { return; }
		this.selectColorPresentation((this.presentationIndex + 1) % this.colorPresentations.length);
	}

	public selectColorPresentation(index: number): void {
		this.presentationIndex = index;
		this._onDidChangePresentation.fire(this.presentation);
		this.flushColor();
	}

	guessColorPresentation(color: Color, originalText: string): void {
		void color;
		let presentationIndex = -1;
		for (let i = 0; i < this.colorPresentations.length; i++) {
			if (originalText.toLowerCase() === this.colorPresentations[i]!.label.toLowerCase()) {
				presentationIndex = i;
				break;
			}
		}

		if (presentationIndex === -1) {
			const originalTextPrefix = originalText.trim().startsWith('#') ? '#' : originalText.split('(')[0]!.trim().toLowerCase();
			for (let i = 0; i < this.colorPresentations.length; i++) {
				if (this.colorPresentations[i]!.label.toLowerCase().startsWith(originalTextPrefix)) {
					presentationIndex = i;
					break;
				}
			}
		}

		if (presentationIndex !== -1 && presentationIndex !== this.presentationIndex) {
			this.presentationIndex = presentationIndex;
			this._onDidChangePresentation.fire(this.presentation);
		}
	}

	flushColor(): void {
		this._onColorFlushed.fire(this._color);
	}
}
