declare module "webgl-plot" {
  export class ColorRGBA {
    r: number;
    g: number;
    b: number;
    a: number;
    constructor(r: number, g: number, b: number, a: number);
  }

  export class WebglLine {
    color: ColorRGBA;
    numPoints: number;
    offsetY: number;
    offsetX: number;
    scaleY: number;
    scaleX: number;
    constructor(color: ColorRGBA, numPoints: number);
    lineSpaceX(start: number, step: number): void;
    setY(index: number, y: number): void;
    getY(index: number): number;
  }

  export class WebglPlot {
    gScaleY: number;
    gScaleX: number;
    gOffsetY: number;
    gOffsetX: number;
    constructor(canvas: HTMLCanvasElement);
    addLine(line: WebglLine): void;
    removeLine(line: WebglLine): void;
    update(): void;
    clear(): void;
  }
}
