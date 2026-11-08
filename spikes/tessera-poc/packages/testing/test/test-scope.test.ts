import { describe, expect, it } from 'vitest';
import { token, inject } from '@tessera/di';
import { ErrorReporter, HostEnvironment, InterceptorRegistry, Logger } from '@tessera/contracts';
import { getScheduler } from '@tessera/base';
import { captureErrors, createMemoryStorageBackend, createTestScope } from '@tessera/testing';

describe('createTestScope', () => {
  it('provides the infrastructure services and the window child scope', () => {
    const t = createTestScope();
    expect(t.application.kind).toBe('application');
    expect(t.window.kind).toBe('window');
    expect(t.window.parent).toBe(t.application);
    expect(t.window.get(HostEnvironment).kind).toBe('test');
    expect(t.window.get(InterceptorRegistry)).toBe(t.interceptors);
    expect(t.window.get(Logger).name).toBe('null');
    expect(typeof t.window.get(ErrorReporter).report).toBe('function');
  });

  it('flat: one scope of kind test plays application and window', () => {
    const t = createTestScope({ flat: true });
    expect(t.application).toBe(t.window);
    expect(t.window.kind).toBe('test');
  });

  it('makes ManualScheduler the process-wide scheduler and restores it on dispose', async () => {
    const before = getScheduler();
    const t = createTestScope();
    expect(getScheduler()).toBe(t.scheduler);
    await t.dispose();
    expect(getScheduler()).toBe(before);
  });

  it('installs modules with the install context', () => {
    const Marker = token<string>('test.marker');
    const t = createTestScope({
      modules: [
        {
          id: '@tessera/fake',
          install: ({ application, window, host }) => {
            application.provideValue(Marker, `installed for ${host.kind} on ${window.kind}`);
          },
        },
      ],
    });
    expect(t.window.get(Marker)).toBe('installed for test on window');
  });

  it('wires the DI service-interception hook to the interceptor registry (kind service)', async () => {
    const Svc = token<{ greet(name: string): Promise<string> }>('test.svc');
    const t = createTestScope();
    const seen: string[] = [];
    t.interceptors.register({
      id: 'watch',
      kinds: ['service'],
      async intercept(ctx, next) {
        seen.push(`${ctx.target}(${JSON.stringify(ctx.data.args)})`);
        return next();
      },
    });
    t.application.provide(Svc, () => ({ greet: async (name: string) => `hello ${name}` }), { intercept: { methods: ['greet'] } });
    await expect(t.window.get(Svc).greet('Ada')).resolves.toBe('hello Ada');
    expect(seen).toEqual(['test.svc.greet(["Ada"])']);
  });

  it('is disposed by the setup file: a test that forgets to dispose does not leak', () => {
    const t = createTestScope();
    t.window.provide(token<object>('test.disposable'), () => ({ dispose() {} }));
    expect(t.window.state).toBe('active');
  });

  it('resolves inject() inside factories registered on the window scope', () => {
    const A = token<string>('test.a');
    const B = token<string>('test.b');
    const t = createTestScope();
    t.application.provideValue(A, 'a');
    t.window.provide(B, () => `${inject(A)}b`);
    expect(t.window.get(B)).toBe('ab');
  });
});

describe('captureErrors and the memory storage backend', () => {
  it('captureErrors collects reported errors and lets the test drain them', async () => {
    const { reportError } = await import('@tessera/base');
    const capture = captureErrors();
    reportError(new Error('x'), { source: 'command', target: 'tasks.add' });
    expect(capture.errors).toHaveLength(1);
    expect(capture.drain()).toHaveLength(1);
    expect(capture.errors).toHaveLength(0);
    capture.dispose();
  });

  it('the memory storage backend stores batches and records the writes', async () => {
    const backend = createMemoryStorageBackend({ application: { a: 1 } });
    await backend.write('application', { set: { b: 2 }, delete: ['a'] });
    await expect(backend.load('application')).resolves.toEqual({ b: 2 });
    await expect(backend.load('project')).resolves.toEqual({});
    expect(backend.writes).toHaveLength(1);
  });
});
