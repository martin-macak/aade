// jsdom has no ResizeObserver, which Radix Checkbox (useSize) needs. React 19 needs the act flag in tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
// jsdom has no DragEvent. @lumino/dragdrop declares `class Event extends DragEvent` at module load, so importing any
// @lumino/widgets entry point fails in jsdom without this line.
(globalThis as { DragEvent?: unknown }).DragEvent ??= class DragEvent extends MouseEvent {};
