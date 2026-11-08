import type { RpcFrame } from '@tessera/contracts';
import { z } from 'zod';

const id = z.number().int().safe();
const text = z.string();

/** Most nested causes a peer may send, and the longest stack, message and details it may send. */
export const MAX_ERR_CAUSE_DEPTH = 5;
const MAX_STACK_CHARS = 16_384;

/** The strict shape of a serialized error: known fields with the right types, causes up to MAX_ERR_CAUSE_DEPTH deep. Unknown keys are ignored by the reader. */
function isSerializedError(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (typeof e['name'] !== 'string' || typeof e['message'] !== 'string') return false;
  if (e['code'] !== undefined && typeof e['code'] !== 'string') return false;
  if (e['stack'] !== undefined && (typeof e['stack'] !== 'string' || e['stack'].length > MAX_STACK_CHARS)) return false;
  if (e['details'] !== undefined && (typeof e['details'] !== 'object' || e['details'] === null || Array.isArray(e['details']))) return false;
  if (e['cause'] !== undefined) return depth > 0 && isSerializedError(e['cause'], depth - 1);
  return true;
}

const serializedError = z.custom<{ name: string; message: string }>((value) => isSerializedError(value, MAX_ERR_CAUSE_DEPTH), { message: 'malformed error' });

/** The envelope of every frame (contracts.md 17.2). The payload of args, value and events is checked by the interface schemas, not here. */
export const frameSchema: z.ZodType<RpcFrame> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.literal(1), name: text, interfaces: z.array(z.object({ id: text, version: z.number().int() })), features: z.array(text).max(64).optional() }),
  z.object({ t: z.literal('req'), id, iface: text, method: text, args: z.array(z.unknown()), trace: text.optional() }),
  z.object({ t: z.literal('ack'), id }),
  z.object({ t: z.literal('ok'), id, value: z.unknown() }),
  z.object({ t: z.literal('err'), id, error: serializedError }),
  z.object({ t: z.literal('cancel'), id }),
  z.object({ t: z.literal('sub'), id, iface: text, event: text }),
  z.object({ t: z.literal('evt'), id, payload: z.unknown() }),
  z.object({ t: z.literal('unsub'), id }),
  z.object({ t: z.literal('bye'), reason: text }),
]) as unknown as z.ZodType<RpcFrame>;

/** The frame kinds of protocol 1. A kind outside this set is not an error of the sender's form: it may be a later feature (stream chunks, credits). */
export const KNOWN_FRAME_KINDS: ReadonlySet<string> = new Set(['hello', 'req', 'ack', 'ok', 'err', 'cancel', 'sub', 'evt', 'unsub', 'bye']);

/** The envelope `{ t }` of a frame: the kind, when it is a string. Validated first; the full schema of a known kind follows. */
export function frameKindOf(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const t = (frame as { t?: unknown }).t;
  return typeof t === 'string' ? t : undefined;
}

/** The id of an err frame that failed validation, if it has a usable one (so the waiting caller can be rejected at once). */
export function errIdOf(frame: unknown): number | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const candidate = frame as { t?: unknown; id?: unknown };
  return candidate.t === 'err' && typeof candidate.id === 'number' && Number.isSafeInteger(candidate.id) ? candidate.id : undefined;
}

/** The request id of a frame that failed validation, if it has a usable one (so the sender gets an err frame). */
export function requestIdOf(frame: unknown): number | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const candidate = (frame as { t?: unknown; id?: unknown });
  return candidate.t === 'req' && typeof candidate.id === 'number' && Number.isSafeInteger(candidate.id) ? candidate.id : undefined;
}
