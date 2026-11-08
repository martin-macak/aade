/* oxlint-disable typescript/no-unsafe-declaration-merging, no-unused-vars -- phantom type parameter, see the note below */
declare const tokenType: unique symbol;

// The phantom member lives in a merged interface because TypeScript 7.0.2 rejects computed property names in class
// bodies under isolatedDeclarations (TS9038). The merged form is equivalent for callers (see docs/8-poc/deviations.md).

export interface Token<T> {
  /** Phantom: carries T, never set at runtime. */
  readonly [tokenType]?: T;
}

/** A typed key for one provider. T is a phantom type. Identity is the string id, never the object. */
export class Token<T> {
  readonly id: string;
  readonly description: string | undefined;

  constructor(id: string, description?: string) {
    this.id = id;
    this.description = description;
  }

  toString(): string {
    return `Token(${this.id})`;
  }
}

export interface MultiToken<T> {
  /** Phantom: carries T, never set at runtime. */
  readonly [tokenType]?: T;
}

/** A typed key for many providers (a code-level extension point). */
export class MultiToken<T> {
  readonly id: string;
  readonly description: string | undefined;

  constructor(id: string, description?: string) {
    this.id = id;
    this.description = description;
  }

  toString(): string {
    return `MultiToken(${this.id})`;
  }
}

export function token<T>(id: string, description?: string): Token<T> {
  return new Token<T>(id, description);
}

export function multiToken<T>(id: string, description?: string): MultiToken<T> {
  return new MultiToken<T>(id, description);
}
