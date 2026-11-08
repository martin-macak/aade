import { TesseraError } from '@tessera/base';

export type ResolutionErrorCode =
  | 'di.noProvider'
  | 'di.cycle'
  | 'di.captive'
  | 'di.duplicate'
  | 'di.disposed'
  | 'di.noContext'
  | 'di.filtered'
  | 'di.asyncFactory'
  | 'di.interceptSync'
  | 'di.tokenKindClash';

/** All DI failures. `path` is the resolution path ("token@scope" entries) when one exists. */
export class ResolutionError extends TesseraError {
  readonly path: readonly string[];

  constructor(code: ResolutionErrorCode, message: string, path: readonly string[] = [], options?: { cause?: unknown }) {
    const text = path.length > 0 ? `${message}\n  resolution path: ${path.join(' -> ')}` : message;
    super(code, text, { ...options, details: { path: [...path] } });
    this.name = 'ResolutionError';
    this.path = path;
  }
}
