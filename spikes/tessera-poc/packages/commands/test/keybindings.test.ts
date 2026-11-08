import { describe, expect, it } from 'vitest';
import type { KeyPress } from '@tessera/contracts';
import { declare, kit, type Kit } from './kit.ts';

function press(code: string, modifiers: Partial<Pick<KeyPress, 'ctrl' | 'shift' | 'alt' | 'meta'>> = {}): KeyPress {
  return { code, key: code.replace(/^Key|^Digit/, '').toLowerCase(), ctrl: false, shift: false, alt: false, meta: false, ...modifiers };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function track(k: Kit, id: string, log: string[]): void {
  declare(k, id);
  k.registry.registerHandler(id, { run: (args: unknown, ctx) => void log.push(`${id}${args === undefined ? '' : ` ${JSON.stringify(args)}`} via ${ctx.source}`) });
}

describe('C12: keybindings', () => {
  it('C12: dispatch resolves a binding and executes the command with source keybinding and the rule args', async () => {
    const k = kit();
    const log: string[] = [];
    track(k, 'tasks.add', log);
    k.keybindings.register({ key: 'ctrl+shift+a', command: 'tasks.add', args: { title: 'quick' }, source: 'plugin' });
    expect(k.keybindings.dispatch(press('KeyA', { ctrl: true, shift: true }), k.win)).toEqual({ kind: 'handled', commandId: 'tasks.add' });
    await settle();
    expect(log).toEqual(['tasks.add {"title":"quick"} via keybinding']);
    expect(k.keybindings.dispatch(press('KeyA', { ctrl: true }), k.win)).toEqual({ kind: 'unhandled' });
  });

  it('C12: key names are KeyboardEvent.code without Key and Digit, lower case; modifiers must match exactly', async () => {
    const k = kit();
    const log: string[] = [];
    for (const id of ['one', 'enter', 'up', 'f1']) track(k, id, log);
    k.keybindings.register({ key: 'ctrl+1', command: 'one', source: 'core' });
    k.keybindings.register({ key: 'enter', command: 'enter', source: 'core' });
    k.keybindings.register({ key: 'alt+arrowup', command: 'up', source: 'core' });
    k.keybindings.register({ key: 'F1', command: 'f1', source: 'core' });
    expect(k.keybindings.dispatch(press('Digit1', { ctrl: true }), k.win).kind).toBe('handled');
    expect(k.keybindings.dispatch(press('Enter'), k.win).kind).toBe('handled');
    expect(k.keybindings.dispatch(press('ArrowUp', { alt: true }), k.win).kind).toBe('handled');
    expect(k.keybindings.dispatch(press('F1'), k.win).kind).toBe('handled');
    expect(k.keybindings.dispatch(press('Enter', { shift: true }), k.win).kind).toBe('unhandled');
    await settle();
    expect(log).toHaveLength(4);
  });

  it('C12: mod is meta on mac and ctrl elsewhere; platform specific keys override the default key', async () => {
    for (const [platform, modifiers] of [['mac', { meta: true }], ['linux', { ctrl: true }], ['win', { ctrl: true }]] as const) {
      const k = kit({ platform });
      const log: string[] = [];
      track(k, 'save', log);
      k.keybindings.register({ key: 'mod+s', command: 'save', source: 'core' });
      expect(k.keybindings.dispatch(press('KeyS', modifiers), k.win).kind).toBe('handled');
    }
    const k = kit({ platform: 'mac' });
    track(k, 'x', []);
    k.keybindings.register({ key: 'ctrl+x', mac: 'cmd+shift+x', command: 'x', source: 'core' });
    expect(k.keybindings.dispatch(press('KeyX', { ctrl: true }), k.win).kind).toBe('unhandled');
    expect(k.keybindings.dispatch(press('KeyX', { meta: true, shift: true }), k.win).kind).toBe('handled');
  });

  describe('C12: precedence: user over plugin over core', () => {
    it('C12: source decides before everything else', async () => {
      const k = kit();
      const log: string[] = [];
      for (const id of ['core.cmd', 'plugin.cmd', 'user.cmd']) track(k, id, log);
      k.keybindings.register({ key: 'ctrl+k', command: 'user.cmd', source: 'user' });
      k.keybindings.register({ key: 'ctrl+k', command: 'core.cmd', source: 'core', when: 'a' });
      k.keybindings.register({ key: 'ctrl+k', command: 'plugin.cmd', source: 'plugin', when: 'a' });
      k.win.set('a', true);
      expect(k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win)).toEqual({ kind: 'handled', commandId: 'user.cmd' });
      await settle();
      expect(log).toEqual(['user.cmd via keybinding']);
    });

    it('C12: plugin beats core', () => {
      const k = kit();
      track(k, 'core.cmd', []);
      track(k, 'plugin.cmd', []);
      k.keybindings.register({ key: 'ctrl+k', command: 'plugin.cmd', source: 'plugin' });
      k.keybindings.register({ key: 'ctrl+k', command: 'core.cmd', source: 'core', when: 'always' });
      k.win.set('always', true);
      expect(k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win)).toMatchObject({ commandId: 'plugin.cmd' });
    });

    it('C12: inside one source a rule with when beats one without; then the newest wins', () => {
      const k = kit();
      for (const id of ['plain.old', 'plain.new', 'guarded']) track(k, id, []);
      k.keybindings.register({ key: 'ctrl+k', command: 'plain.old', source: 'plugin' });
      k.keybindings.register({ key: 'ctrl+k', command: 'plain.new', source: 'plugin' });
      expect(k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win)).toMatchObject({ commandId: 'plain.new' });
      k.keybindings.register({ key: 'ctrl+k', command: 'guarded', source: 'plugin', when: 'editorFocus' });
      expect(k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win)).toMatchObject({ commandId: 'plain.new' }); // when is false
      k.win.set('editorFocus', true);
      expect(k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win)).toMatchObject({ commandId: 'guarded' });
    });

    it('C12: a user rule \'-command\' removes the matching lower-source binding, and removing the rule restores it', () => {
      const k = kit();
      track(k, 'tasks.add', []);
      k.keybindings.register({ key: 'ctrl+n', command: 'tasks.add', source: 'plugin' });
      const removal = k.keybindings.register({ key: 'ctrl+n', command: '-tasks.add', source: 'user' });
      expect(k.keybindings.dispatch(press('KeyN', { ctrl: true }), k.win).kind).toBe('unhandled');
      expect(k.keybindings.lookup('tasks.add')).toEqual([]);
      removal.dispose();
      expect(k.keybindings.dispatch(press('KeyN', { ctrl: true }), k.win).kind).toBe('handled');
    });
  });

  it('C12: `when` filters the candidates against the given context-key scope', () => {
    const k = kit();
    track(k, 'tasks.complete', []);
    k.keybindings.register({ key: 'ctrl+enter', command: 'tasks.complete', source: 'plugin', when: 'view == tasks.list' });
    const list = k.win.createChild('placement:list');
    list.set('view', 'tasks.list');
    const audit = k.win.createChild('placement:audit');
    audit.set('view', 'audit.log');
    expect(k.keybindings.dispatch(press('Enter', { ctrl: true }), audit).kind).toBe('unhandled');
    expect(k.keybindings.dispatch(press('Enter', { ctrl: true }), list).kind).toBe('handled');
  });

  it('C12: keystrokes while a text input has focus need a modifier other than shift, or a when that mentions inputFocus', () => {
    const k = kit();
    for (const id of ['plain', 'shifted', 'ctrl', 'aware']) track(k, id, []);
    k.keybindings.register({ key: 'a', command: 'plain', source: 'core' });
    k.keybindings.register({ key: 'shift+b', command: 'shifted', source: 'core' });
    k.keybindings.register({ key: 'ctrl+c', command: 'ctrl', source: 'core' });
    k.keybindings.register({ key: 'escape', command: 'aware', source: 'core', when: 'inputFocus' });
    k.win.set('inputFocus', true);
    expect(k.keybindings.dispatch(press('KeyA'), k.win).kind).toBe('unhandled');
    expect(k.keybindings.dispatch(press('KeyB', { shift: true }), k.win).kind).toBe('unhandled');
    expect(k.keybindings.dispatch(press('KeyC', { ctrl: true }), k.win).kind).toBe('handled');
    expect(k.keybindings.dispatch(press('Escape'), k.win).kind).toBe('handled');
    k.win.set('inputFocus', false);
    expect(k.keybindings.dispatch(press('KeyA'), k.win).kind).toBe('handled');
  });

  describe('C12: chords wait 1000 ms for the next part', () => {
    it('C12: the first part reports a chord and the status shows the prefix; the second part runs the command', async () => {
      const k = kit();
      const log: string[] = [];
      track(k, 'k.t', log);
      k.keybindings.register({ key: 'ctrl+k ctrl+t', command: 'k.t', source: 'plugin' });
      expect(k.keybindings.chord.peek()).toBeUndefined();
      expect(k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win)).toEqual({ kind: 'chord', prefix: 'Ctrl+K' });
      expect(k.keybindings.chord.peek()).toBe('Ctrl+K');
      k.t.scheduler.advance(999);
      expect(k.keybindings.chord.peek()).toBe('Ctrl+K');
      expect(k.keybindings.dispatch(press('KeyT', { ctrl: true }), k.win)).toEqual({ kind: 'handled', commandId: 'k.t' });
      expect(k.keybindings.chord.peek()).toBeUndefined();
      await settle();
      expect(log).toEqual(['k.t via keybinding']);
      expect(k.t.scheduler.pendingTimers).toBe(0);
    });

    it('C12: after 1000 ms the chord is dropped: the next press starts over', () => {
      const k = kit();
      track(k, 'k.t', []);
      track(k, 'solo', []);
      k.keybindings.register({ key: 'ctrl+k ctrl+t', command: 'k.t', source: 'plugin' });
      k.keybindings.register({ key: 'ctrl+t', command: 'solo', source: 'plugin' });
      k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win);
      k.t.scheduler.advance(1000);
      expect(k.keybindings.chord.peek()).toBeUndefined();
      expect(k.keybindings.dispatch(press('KeyT', { ctrl: true }), k.win)).toEqual({ kind: 'handled', commandId: 'solo' });
    });

    it('C12: a wrong second part cancels the chord and is unhandled', () => {
      const k = kit();
      track(k, 'k.t', []);
      k.keybindings.register({ key: 'ctrl+k ctrl+t', command: 'k.t', source: 'plugin' });
      k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win);
      expect(k.keybindings.dispatch(press('KeyX', { ctrl: true }), k.win)).toEqual({ kind: 'unhandled' });
      expect(k.keybindings.chord.peek()).toBeUndefined();
      expect(k.t.scheduler.pendingTimers).toBe(0);
    });

    it('C12: a rule that is both an exact match and a chord prefix waits for the timeout, then runs', async () => {
      const k = kit();
      const log: string[] = [];
      track(k, 'short', log);
      track(k, 'long', log);
      k.keybindings.register({ key: 'ctrl+k', command: 'short', source: 'plugin' });
      k.keybindings.register({ key: 'ctrl+k ctrl+t', command: 'long', source: 'plugin' });
      expect(k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win).kind).toBe('chord');
      await settle();
      expect(log).toEqual([]);
      k.t.scheduler.advance(1000);
      await settle();
      expect(log).toEqual(['short via keybinding']);
      expect(k.keybindings.chord.peek()).toBeUndefined();
    });

    it('C12: ... and when the second part arrives in time the longer chord wins', async () => {
      const k = kit();
      const log: string[] = [];
      track(k, 'short', log);
      track(k, 'long', log);
      k.keybindings.register({ key: 'ctrl+k', command: 'short', source: 'plugin' });
      k.keybindings.register({ key: 'ctrl+k ctrl+t', command: 'long', source: 'plugin' });
      k.keybindings.dispatch(press('KeyK', { ctrl: true }), k.win);
      k.t.scheduler.advance(500);
      expect(k.keybindings.dispatch(press('KeyT', { ctrl: true }), k.win).kind).toBe('handled');
      k.t.scheduler.advance(5000);
      await settle();
      expect(log).toEqual(['long via keybinding']);
    });

    it('C12: chords of three parts', () => {
      const k = kit();
      track(k, 'three', []);
      k.keybindings.register({ key: 'a b c', command: 'three', source: 'core' });
      expect(k.keybindings.dispatch(press('KeyA'), k.win)).toEqual({ kind: 'chord', prefix: 'A' });
      expect(k.keybindings.dispatch(press('KeyB'), k.win)).toEqual({ kind: 'chord', prefix: 'A B' });
      expect(k.keybindings.dispatch(press('KeyC'), k.win)).toEqual({ kind: 'handled', commandId: 'three' });
    });
  });

  describe('lookup, conflicts and registration', () => {
    it('lookup lists the bindings of a command best first with platform labels, filtered by when', () => {
      const k = kit();
      track(k, 'tasks.add', []);
      k.keybindings.register({ key: 'ctrl+k ctrl+t', command: 'tasks.add', source: 'core' });
      k.keybindings.register({ key: 'mod+alt+n', command: 'tasks.add', source: 'user' });
      k.keybindings.register({ key: 'f9', command: 'tasks.add', source: 'plugin', when: 'special' });
      expect(k.keybindings.lookup('tasks.add', k.win).map((r) => r.label)).toEqual(['Ctrl+Alt+N', 'Ctrl+K Ctrl+T']);
      k.win.set('special', true);
      expect(k.keybindings.lookup('tasks.add', k.win).map((r) => r.label)).toEqual(['Ctrl+Alt+N', 'F9', 'Ctrl+K Ctrl+T']);
      expect(k.keybindings.lookup('tasks.add').map((r) => r.label)).toHaveLength(3);
    });

    it('labels use Cmd on mac', () => {
      const k = kit({ platform: 'mac' });
      k.keybindings.register({ key: 'mod+shift+p', command: 'palette', source: 'core' });
      expect(k.keybindings.lookup('palette')[0]?.label).toBe('Shift+Cmd+P');
    });

    it('conflicts reports different commands on one key with the same source and when', () => {
      const k = kit();
      k.keybindings.register({ key: 'ctrl+k', command: 'a', source: 'plugin' });
      expect(k.keybindings.conflicts.peek()).toEqual([]);
      const second = k.keybindings.register({ key: 'ctrl+k', command: 'b', source: 'plugin' });
      k.keybindings.register({ key: 'ctrl+k', command: 'c', source: 'user' });
      k.keybindings.register({ key: 'ctrl+k', command: 'd', source: 'plugin', when: 'x' });
      const conflicts = k.keybindings.conflicts.peek();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.key).toBe('Ctrl+K');
      expect(conflicts[0]?.rules.map((r) => r.command).toSorted()).toEqual(['a', 'b']);
      second.dispose();
      expect(k.keybindings.conflicts.peek()).toEqual([]);
    });

    it('onDidChange fires when rules are added or removed; disposing a registration removes the rule', () => {
      const k = kit();
      let changes = 0;
      k.keybindings.onDidChange(() => changes++);
      track(k, 'x', []);
      const handle = k.keybindings.register({ key: 'ctrl+x', command: 'x', source: 'core' });
      expect(changes).toBe(1);
      handle.dispose();
      expect(changes).toBe(2);
      expect(k.keybindings.dispatch(press('KeyX', { ctrl: true }), k.win).kind).toBe('unhandled');
    });

    it('a keybinding for a disabled command is dispatched as handled, and the command refuses itself (enablement for every source)', async () => {
      const k = kit();
      const log: string[] = [];
      declare(k, 'tasks.complete', { enablement: 'tasks.hasSelection' });
      k.registry.registerHandler('tasks.complete', { run: () => void log.push('ran') });
      const outcomes: string[] = [];
      k.commands.onDidExecute((e) => outcomes.push(`${e.outcome}:${e.errorCode}`));
      k.keybindings.register({ key: 'ctrl+enter', command: 'tasks.complete', source: 'plugin' });
      k.keybindings.dispatch(press('Enter', { ctrl: true }), k.win);
      await settle();
      expect(log).toEqual([]);
      expect(outcomes).toEqual(['rejected:command.disabled']);
    });
  });
});

describe('round 2: lookup is indexed by command', () => {
  it('C12: 2,000 lookups over 1,000 keybindings build the index once (no O(commands x keybindings) scan), and the index follows changes', () => {
    const k = kit();
    const service = k.keybindings as unknown as { indexBuilds: number };
    const handles = Array.from({ length: 1000 }, (_, i) => k.keybindings.register({ key: `ctrl+alt+${String.fromCharCode(97 + (i % 26))}`, command: `cmd.${i}`, source: 'plugin' }));
    const before = service.indexBuilds;
    for (let round = 0; round < 2; round++) for (let i = 0; i < 1000; i++) expect(k.keybindings.lookup(`cmd.${i}`)).toHaveLength(1);
    expect(service.indexBuilds - before).toBeLessThanOrEqual(1);
    handles[5]?.dispose();
    expect(k.keybindings.lookup('cmd.5')).toHaveLength(0);
    expect(k.keybindings.lookup('cmd.6')).toHaveLength(1);
    expect(service.indexBuilds - before).toBeLessThanOrEqual(2);
  });
});
