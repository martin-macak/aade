import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineCommand, isKind, token, type InvocationContext, type Observable, type PluginContext, type ViewProvider } from '../src/index.ts';

// Type-level tests of the typed plugin API (round 3, plugin-api-type-level-tests-thin). The body of `checks` is compiled by tsc (npm run
// typecheck), never run: `// @ts-expect-error` lines fail the compile when the call is accepted, `expectTypeOf` lines when a type drifts.
declare const ctx: PluginContext;
declare const interceptorContext: InvocationContext;

const Add = defineCommand<{ readonly title: string }, { readonly id: string }>('x.add');
const Service = token<{ readonly n: number }>('x.service');

function checks(): void {
  // run: the argument and the result types come from the handle
  expectTypeOf(ctx.api.commands.run(Add, { title: 'a' })).resolves.toEqualTypeOf<{ readonly id: string }>();
  // @ts-expect-error the argument has no `name`
  void ctx.api.commands.run(Add, { name: 'a' });

  // registerHandler(def, handler): the handler's types follow the handle, and the schema comes from it
  ctx.api.commands.registerHandler(Add, {
    run(args) {
      expectTypeOf(args).toEqualTypeOf<{ readonly title: string }>();
      return { id: args.title };
    },
  });
  // @ts-expect-error the handler returns a number, the handle promises { id: string }
  ctx.api.commands.registerHandler(Add, { run: () => 5 });
  // the string form stays open: no schema, any types
  ctx.api.commands.registerHandler('x.free', { run: () => 5 });

  // services.get returns the token's type; getOptional adds undefined
  expectTypeOf(ctx.services.get(Service)).toEqualTypeOf<{ readonly n: number }>();
  expectTypeOf(ctx.services.getOptional(Service)).toEqualTypeOf<{ readonly n: number } | undefined>();
  // observeAll follows the multi token's type
  expectTypeOf(ctx.services.observeAll).returns.toMatchTypeOf<Observable<readonly unknown[]>>();

  // registerProvider infers the presenter's state and intents from the provider type
  const provider: ViewProvider<{ readonly count: number }, { readonly shown: number }, { readonly bump: () => void }, Record<string, never>, Record<string, never>> = {
    viewType: 'x.view',
    createViewModel: () => ({ count: 1 }),
    createPresenter: (p) => ({ viewState: { get: () => ({ shown: p.viewModel.count }), peek: () => ({ shown: 0 }), subscribe: () => ({ dispose() {} }) } as never, intents: { bump() {} }, dispose() {} }),
  };
  ctx.views.registerProvider(provider);

  // window dialogs and progress
  expectTypeOf(ctx.api.window.confirm({ message: 'ok?' })).resolves.toEqualTypeOf<boolean>();
  expectTypeOf(ctx.api.window.input({ prompt: 'name' })).resolves.toEqualTypeOf<string | undefined>();
  expectTypeOf(ctx.api.window.withProgress({ title: 't' }, async () => 7)).resolves.toEqualTypeOf<number>();
  // @ts-expect-error the plugin cannot pass its own signal: the facade adds the plugin's
  void ctx.api.window.confirm({ message: 'x', signal: new AbortController().signal });

  // isKind narrows the interceptor data to the kind
  if (isKind(interceptorContext, 'command')) expectTypeOf(interceptorContext.data.commandId).toEqualTypeOf<string>();
  if (isKind(interceptorContext, 'event')) expectTypeOf(interceptorContext.data.topicId).toEqualTypeOf<string>();
}
void checks;

describe('@tessera/plugin-api: the typed surface (compile-time)', () => {
  it('compiles: the type assertions above are checked by tsc, this test only keeps the file in the run', () => {
    expect(typeof checks).toBe('function');
  });
});
