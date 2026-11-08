import { describe, expect, it } from 'vitest';
import { declare, kit } from './kit.ts';

describe('C11: the most specific handler wins - when, then priority, then newest', () => {
  it('C11: a handler whose when matches beats a handler without when, whatever the priority and age', async () => {
    const k = kit();
    declare(k, 'edit.copy');
    k.registry.registerHandler('edit.copy', { when: 'editorFocus', priority: 0, run: () => 'editor' });
    k.registry.registerHandler('edit.copy', { priority: 100, run: () => 'generic' });
    k.win.set('editorFocus', true);
    await expect(k.commands.execute('edit.copy', undefined, { context: k.win })).resolves.toBe('editor');
  });

  it('C11: a handler whose when is false does not apply', async () => {
    const k = kit();
    declare(k, 'edit.copy');
    k.registry.registerHandler('edit.copy', { when: 'editorFocus', run: () => 'editor' });
    k.registry.registerHandler('edit.copy', { run: () => 'generic' });
    await expect(k.commands.execute('edit.copy', undefined, { context: k.win })).resolves.toBe('generic');
  });

  it('C11: only when-handlers and none matches: command.unavailable', async () => {
    const k = kit();
    declare(k, 'edit.copy');
    k.registry.registerHandler('edit.copy', { when: 'editorFocus', run: () => 'editor' });
    await expect(k.commands.execute('edit.copy', undefined, { context: k.win })).rejects.toMatchObject({ code: 'command.unavailable' });
  });

  it('C11: among handlers with when, the higher priority wins', async () => {
    const k = kit();
    declare(k, 'x');
    k.registry.registerHandler('x', { when: 'a', priority: 1, run: () => 'low' });
    k.registry.registerHandler('x', { when: 'a', priority: 5, run: () => 'high' });
    k.registry.registerHandler('x', { when: 'a', priority: 3, run: () => 'middle' });
    k.win.set('a', true);
    await expect(k.commands.execute('x', undefined, { context: k.win })).resolves.toBe('high');
  });

  it('C11: with equal when and priority the newest registration wins, and the older one returns when it is removed', async () => {
    const k = kit();
    declare(k, 'x');
    k.registry.registerHandler('x', { run: () => 'older' });
    const newer = k.registry.registerHandler('x', { run: () => 'newer' });
    await expect(k.commands.execute('x')).resolves.toBe('newer');
    newer.dispose();
    await expect(k.commands.execute('x')).resolves.toBe('older');
  });

  it('C11: handler choice follows the context-key scope of the call', async () => {
    const k = kit();
    declare(k, 'tasks.open');
    k.registry.registerHandler('tasks.open', { when: 'view == tasks.list', run: () => 'list handler' });
    k.registry.registerHandler('tasks.open', { when: 'view == audit.log', run: () => 'audit handler' });
    const listPlacement = k.win.createChild('placement:list');
    listPlacement.set('view', 'tasks.list');
    const auditPlacement = k.win.createChild('placement:audit');
    auditPlacement.set('view', 'audit.log');
    await expect(k.commands.execute('tasks.open', undefined, { context: listPlacement })).resolves.toBe('list handler');
    await expect(k.commands.execute('tasks.open', undefined, { context: auditPlacement })).resolves.toBe('audit handler');
  });

  it('C11: the selected handler provides args validation, isEnabled and the owner', async () => {
    const k = kit();
    declare(k, 'x');
    k.registry.registerHandler('x', { when: 'a', isEnabled: () => false, run: () => 'disabled specific' });
    k.registry.registerHandler('x', { run: () => 'generic' });
    k.win.set('a', true);
    await expect(k.commands.execute('x', undefined, { context: k.win })).rejects.toMatchObject({ code: 'command.disabled' });
    k.win.set('a', false);
    await expect(k.commands.execute('x', undefined, { context: k.win })).resolves.toBe('generic');
  });
});
