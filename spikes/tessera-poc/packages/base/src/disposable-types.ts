export interface IDisposable {
  dispose(): void;
}
export interface IAsyncDisposable {
  dispose(): Promise<void>;
}

/** Anything the framework can dispose: our interfaces or the ES resource-management protocol. */
export type DisposableLike =
  | IDisposable
  | IAsyncDisposable
  | { [Symbol.dispose](): void }
  | { [Symbol.asyncDispose](): Promise<void> };
