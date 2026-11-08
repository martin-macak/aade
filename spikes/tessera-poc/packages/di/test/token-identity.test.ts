import { describe, expect, it } from 'vitest';
import { multiToken, Token, token } from '@tessera/di';
import { useRoots } from './helpers.ts';

interface TokenModule {
  readonly Token: typeof Token;
  token: typeof token;
  multiToken: typeof multiToken;
}

async function loadCopy(name: string): Promise<TokenModule> {
  const specifier = `../src/token.ts?copy=${name}`;
  return (await import(/* @vite-ignore */ specifier)) as TokenModule;
}

describe('C3: tokens compare by string id across module copies', () => {
  const root = useRoots();

  it('C3: two separately loaded copies of the token module are different classes but the same token', async () => {
    const copyA = await loadCopy('a');
    const copyB = await loadCopy('b');
    expect(copyA.Token).not.toBe(copyB.Token);
    expect(copyA.Token).not.toBe(Token);

    const fromA = copyA.token<string>('shared.service');
    const fromB = copyB.token<string>('shared.service');
    expect(fromA).not.toBe(fromB);
    expect(fromA.id).toBe(fromB.id);

    const app = root();
    app.provideValue(fromA, 'provided through copy A');
    expect(app.get(fromB)).toBe('provided through copy A');
    expect(app.get(token<string>('shared.service'))).toBe('provided through copy A');
  });

  it('C3: a registration made with one copy is a duplicate for the other copy', async () => {
    const copyA = await loadCopy('c');
    const copyB = await loadCopy('d');
    const app = root();
    app.provideValue(copyA.token<number>('dup.service'), 1);
    expect(() => app.provideValue(copyB.token<number>('dup.service'), 2)).toThrow(expect.objectContaining({ code: 'di.duplicate' }));
  });

  it('C3: multi-tokens from different copies collect together', async () => {
    const copyA = await loadCopy('e');
    const copyB = await loadCopy('f');
    const app = root();
    app.provideMany(copyA.multiToken<string>('shared.multi'), () => 'a');
    app.provideMany(copyB.multiToken<string>('shared.multi'), () => 'b');
    expect(app.getAll(multiToken<string>('shared.multi'))).toEqual(['a', 'b']);
  });

  it('tokens print their id', () => {
    expect(token('x.y').toString()).toBe('Token(x.y)');
    expect(multiToken('x.z').toString()).toBe('MultiToken(x.z)');
  });
});
