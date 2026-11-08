import { TesseraError } from '@tessera/base';

export type InterceptorErrorCode =
  | 'interceptor.nextTwice'
  | 'interceptor.missingAwait'
  | 'interceptor.depth'
  | 'interceptor.kindMismatch'
  | 'interceptor.failed'
  | 'interceptor.observerTimeout'
  | 'interceptor.guardTimeout';

export class InterceptorError extends TesseraError {
  readonly interceptorId: string;

  constructor(code: InterceptorErrorCode, message: string, interceptorId: string, options?: { cause?: unknown }) {
    super(code, message, { ...options, details: { interceptorId } });
    this.name = 'InterceptorError';
    this.interceptorId = interceptorId;
  }
}
