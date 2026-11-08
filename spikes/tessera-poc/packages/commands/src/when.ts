import { WhenSyntaxError, type ContextReader, type ContextValue, type WhenExpr } from '@tessera/contracts';

// The when-clause language: a frozen subset of VS Code (contracts.md 12.2), parsed by hand. No eval, no new Function.
//
//   expression = or            or  = and { "||" and }        and = unary { "&&" unary }
//   unary      = "!" unary | primary                         primary = "(" expression ")" | test
//   test       = key [ op value ] | key "=~" /regex/flags | key [ "not" ] "in" key

type Evaluator = (context: ContextReader) => boolean;

function truthy(value: ContextValue): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'boolean') return value;
  return value.length > 0;
}

interface Literal {
  readonly kind: 'boolean' | 'number' | 'string';
  readonly text: string;
  readonly boolean: boolean;
}

function equalsLiteral(value: ContextValue, literal: Literal): boolean {
  if (literal.kind === 'boolean') {
    // key == true means the value is boolean true. key == false also holds for a key that is not set, like !key.
    return literal.boolean ? value === true : value === false || value === undefined || value === null;
  }
  if (value === undefined || value === null) return false;
  return String(value) === literal.text;
}

function compareNumbers(value: ContextValue, literal: Literal, op: '<' | '<=' | '>' | '>='): boolean {
  if (typeof value !== 'number' || literal.kind !== 'number') return false;
  const right = Number(literal.text);
  switch (op) {
    case '<':
      return value < right;
    case '<=':
      return value <= right;
    case '>':
      return value > right;
    case '>=':
      return value >= right;
  }
}

function inArray(value: ContextValue, list: ContextValue): boolean {
  if (!Array.isArray(list) || value === undefined || value === null) return false;
  const items = list as readonly unknown[];
  return items.some((item) => item === value || item === String(value));
}

const KEY_START = /[A-Za-z]/;
const KEY_PART = /[A-Za-z0-9_.\-:/]/;

class Parser {
  readonly #source: string;
  #pos = 0;
  readonly keys = new Set<string>();

  constructor(source: string) {
    this.#source = source;
  }

  parse(): Evaluator {
    this.#skip();
    if (this.#pos >= this.#source.length) throw this.#error('Empty when-clause');
    const expression = this.#or();
    this.#skip();
    if (this.#pos < this.#source.length) throw this.#error(`Unexpected "${this.#source.slice(this.#pos, this.#pos + 8).trim()}"`);
    return expression;
  }

  #error(message: string, at = this.#pos): WhenSyntaxError {
    return new WhenSyntaxError(message, this.#source, at + 1);
  }

  #skip(): void {
    while (this.#pos < this.#source.length && /\s/.test(this.#source[this.#pos] as string)) this.#pos++;
  }

  #peek(token: string): boolean {
    this.#skip();
    return this.#source.startsWith(token, this.#pos);
  }

  #or(): Evaluator {
    let left = this.#and();
    while (this.#peek('||')) {
      this.#pos += 2;
      const a = left;
      const b = this.#and();
      left = (c) => a(c) || b(c);
    }
    return left;
  }

  #and(): Evaluator {
    let left = this.#unary();
    while (this.#peek('&&')) {
      this.#pos += 2;
      const a = left;
      const b = this.#unary();
      left = (c) => a(c) && b(c);
    }
    return left;
  }

  #unary(): Evaluator {
    this.#skip();
    if (this.#source[this.#pos] === '!' && this.#source[this.#pos + 1] !== '=') {
      this.#pos++;
      const operand = this.#unary();
      return (c) => !operand(c);
    }
    return this.#primary();
  }

  #primary(): Evaluator {
    this.#skip();
    if (this.#source[this.#pos] === '(') {
      this.#pos++;
      const inner = this.#or();
      this.#skip();
      if (this.#source[this.#pos] !== ')') throw this.#error('Expected ")"');
      this.#pos++;
      return inner;
    }
    return this.#test();
  }

  #readKey(what: string): string {
    this.#skip();
    const start = this.#pos;
    if (!KEY_START.test(this.#source[this.#pos] ?? '')) throw this.#error(`Expected ${what}`);
    this.#pos++;
    while (this.#pos < this.#source.length && KEY_PART.test(this.#source[this.#pos] as string)) this.#pos++;
    return this.#source.slice(start, this.#pos);
  }

  #test(): Evaluator {
    const keyStart = (this.#skip(), this.#pos);
    const key = this.#readKey('a context key');
    this.#skip();
    const rest = this.#source.slice(this.#pos);

    // key [not] in key
    const inMatch = /^(not\s+)?in(?![A-Za-z0-9_.\-:/])/.exec(rest);
    if (inMatch) {
      const negate = inMatch[1] !== undefined;
      this.#pos += inMatch[0].length;
      const listKey = this.#readKey('a context key after "in"');
      this.keys.add(key);
      this.keys.add(listKey);
      return (c) => {
        const found = inArray(c.getValue(key), c.getValue(listKey));
        return negate ? !found : found;
      };
    }

    // key =~ /regex/flags
    if (rest.startsWith('=~')) {
      this.#pos += 2;
      this.#skip();
      const regex = this.#readRegex();
      this.keys.add(key);
      return (c) => {
        const value = c.getValue(key);
        return typeof value === 'string' && regex.test(value);
      };
    }

    // key op value
    const opMatch = /^(==|!=|<=|>=|<|>)/.exec(rest);
    if (opMatch) {
      const op = opMatch[1] as '==' | '!=' | '<=' | '>=' | '<' | '>';
      const opStart = this.#pos;
      this.#pos += op.length;
      if (op !== '==' && op !== '!=' && !(/\s/.test(this.#source[opStart - 1] ?? 'x') && /\s/.test(this.#source[this.#pos] ?? 'x'))) {
        throw this.#error(`Spaces are required around "${op}"`, opStart);
      }
      const literal = this.#readValue();
      this.keys.add(key);
      switch (op) {
        case '==':
          return (c) => equalsLiteral(c.getValue(key), literal);
        case '!=':
          return (c) => !equalsLiteral(c.getValue(key), literal);
        default:
          return (c) => compareNumbers(c.getValue(key), literal, op);
      }
    }

    // bare key, or the constants true and false
    if (key === 'true' || key === 'false') {
      const constant = key === 'true';
      return () => constant;
    }
    if (this.#pos === keyStart) throw this.#error('Expected a context key');
    this.keys.add(key);
    return (c) => truthy(c.getValue(key));
  }

  #readValue(): Literal {
    this.#skip();
    const start = this.#pos;
    if (this.#source[this.#pos] === "'") {
      const end = this.#source.indexOf("'", this.#pos + 1);
      if (end < 0) throw this.#error('Unterminated quoted value', start);
      this.#pos = end + 1;
      return { kind: 'string', text: this.#source.slice(start + 1, end), boolean: false };
    }
    while (this.#pos < this.#source.length && !/[\s()&|]/.test(this.#source[this.#pos] as string)) this.#pos++;
    const text = this.#source.slice(start, this.#pos);
    if (text.length === 0) throw this.#error('Expected a value');
    if (text === 'true' || text === 'false') return { kind: 'boolean', text, boolean: text === 'true' };
    if (/^-?\d+(\.\d+)?$/.test(text)) return { kind: 'number', text, boolean: false };
    return { kind: 'string', text, boolean: false };
  }

  #readRegex(): RegExp {
    const start = this.#pos;
    if (this.#source[this.#pos] !== '/') throw this.#error('Expected a regular expression like /pattern/');
    this.#pos++;
    let escaped = false;
    let inClass = false;
    let end = -1;
    for (; this.#pos < this.#source.length; this.#pos++) {
      const ch = this.#source[this.#pos] as string;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        end = this.#pos;
        break;
      }
    }
    if (end < 0) throw this.#error('Unterminated regular expression', start);
    const pattern = this.#source.slice(start + 1, end);
    this.#pos = end + 1;
    const flagsStart = this.#pos;
    while (this.#pos < this.#source.length && /[imsu]/.test(this.#source[this.#pos] as string)) this.#pos++;
    const flags = this.#source.slice(flagsStart, this.#pos);
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      throw this.#error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`, start);
    }
  }
}

/** Parses a when-clause. Throws WhenSyntaxError with the column of the problem. */
export function parseWhen(source: string): WhenExpr {
  const parser = new Parser(source);
  const evaluator = parser.parse();
  return Object.freeze({
    source,
    keys: parser.keys as ReadonlySet<string>,
    evaluate: (context: ContextReader) => evaluator(context),
  });
}
