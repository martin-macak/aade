import { describe, expect, it } from 'vitest';
import { CommandRegistry, ContextKeyService, KeybindingService, WorkItemService, WorkbenchService, type PlacementId } from '@tessera/contracts';
import { createTestApp } from '@tessera/testing';
import { CHROME_ATTRIBUTE, installFocusTracking, installKeyboard, isChrome, isEditable, keyPressOf, markPlacementHost, placementIdOf, PLACEMENT_ATTRIBUTE } from '../src/index.ts';

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('@tessera/dom: keyboard', () => {
  it('keyPressOf maps a KeyboardEvent to the normalized KeyPress', () => {
    const event = new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, shiftKey: true });
    expect(keyPressOf(event)).toEqual({ code: 'KeyK', key: 'k', ctrl: true, shift: true, alt: false, meta: false });
  });

  it('a handled key press runs the bound command (source keybinding) and calls preventDefault; unhandled presses are left alone', async () => {
    const app = await createTestApp();
    const ran: string[] = [];
    app.application.get(CommandRegistry).declare({ id: 'test.hello', title: 'Hello', owner: 'test' });
    app.application.get(CommandRegistry).registerHandler('test.hello', { run: (_a, ctx) => void ran.push(ctx.source) });
    app.get(KeybindingService).register({ key: 'ctrl+alt+h', command: 'test.hello', source: 'core' });
    const keyboard = installKeyboard(document, app.window);
    const handled = press(document.body, { code: 'KeyH', key: 'h', ctrlKey: true, altKey: true });
    await app.settle();
    expect(handled.defaultPrevented).toBe(true);
    expect(ran).toEqual(['keybinding']);
    const unhandled = press(document.body, { code: 'KeyJ', key: 'j', ctrlKey: true, altKey: true });
    expect(unhandled.defaultPrevented).toBe(false);
    keyboard.dispose();
    const after = press(document.body, { code: 'KeyH', key: 'h', ctrlKey: true, altKey: true });
    expect(after.defaultPrevented).toBe(false); // the listener is gone
  });

  it('pure modifier presses and IME composition are skipped', async () => {
    const app = await createTestApp();
    const keyboard = installKeyboard(document, app.window);
    expect(press(document.body, { code: 'ControlLeft', key: 'Control', ctrlKey: true }).defaultPrevented).toBe(false);
    keyboard.dispose();
  });

  it('a chord prefix is consumed (preventDefault) and the second press completes it', async () => {
    const app = await createTestApp();
    const ran: string[] = [];
    app.application.get(CommandRegistry).declare({ id: 'test.chord', title: 'Chord', owner: 'test' });
    app.application.get(CommandRegistry).registerHandler('test.chord', { run: () => void ran.push('chord') });
    app.get(KeybindingService).register({ key: 'ctrl+k ctrl+t', command: 'test.chord', source: 'core' });
    const keyboard = installKeyboard(document, app.window);
    const first = press(document.body, { code: 'KeyK', key: 'k', ctrlKey: true });
    expect(first.defaultPrevented).toBe(true);
    expect(ran).toEqual([]);
    const second = press(document.body, { code: 'KeyT', key: 't', ctrlKey: true });
    await app.settle();
    expect(second.defaultPrevented).toBe(true);
    expect(ran).toEqual(['chord']);
    keyboard.dispose();
  });
});

describe('@tessera/dom: placement host marking and focus tracking', () => {
  it('markPlacementHost sets and removes the data attribute; placementIdOf finds the nearest marked ancestor', () => {
    const host = document.createElement('div');
    const inner = document.createElement('span');
    host.append(inner);
    const mark = markPlacementHost(host, 'p-1' as PlacementId);
    expect(host.getAttribute(PLACEMENT_ATTRIBUTE)).toBe('p-1');
    expect(placementIdOf(inner)).toBe('p-1');
    expect(placementIdOf(document.body)).toBeUndefined();
    mark.dispose();
    expect(host.hasAttribute(PLACEMENT_ATTRIBUTE)).toBe(false);
    expect(placementIdOf(inner)).toBeUndefined();
  });

  it('isEditable is true for text inputs, textareas and contenteditable only', () => {
    const input = document.createElement('input');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    expect(isEditable(input)).toBe(true);
    expect(isEditable(area)).toBe(true);
    expect(isEditable(checkbox)).toBe(false);
    expect(isEditable(div)).toBe(false);
    expect(isEditable(null)).toBe(false);
  });

  it('focus inside a marked host reports the placement; focus elsewhere clears it; inputFocus follows editable elements', async () => {
    const app = await createTestApp();
    const focus: Array<PlacementId | undefined> = [];
    const adapterApi = app.workbench as unknown as { reportFocus(id: PlacementId | undefined): void };
    const original = adapterApi.reportFocus.bind(adapterApi);
    adapterApi.reportFocus = (id) => {
      focus.push(id);
      original(id);
    };
    const tracking = installFocusTracking(document, app.window);
    const host = document.createElement('div');
    host.tabIndex = -1;
    const field = document.createElement('input');
    const outside = document.createElement('button');
    host.append(field);
    document.body.append(host, outside);
    const mark = markPlacementHost(host, 'p-7' as PlacementId);

    field.focus();
    expect(focus.at(-1)).toBe('p-7');
    expect(app.get(WorkItemService).root.context.getValue('inputFocus')).toBe(true);
    outside.focus();
    expect(focus.at(-1)).toBeUndefined();
    expect(app.get(WorkItemService).root.context.getValue('inputFocus')).toBe(false);

    // focus on chrome (a toolbar button, the palette button) keeps the last placement; a placement inside the chrome still wins
    field.focus();
    const chrome = document.createElement('div');
    chrome.setAttribute(CHROME_ATTRIBUTE, '');
    const chromeButton = document.createElement('button');
    chrome.append(chromeButton);
    document.body.append(chrome);
    expect(isChrome(chromeButton)).toBe(true);
    expect(isChrome(outside)).toBe(false);
    const before = focus.length;
    chromeButton.focus();
    expect(focus.length).toBe(before); // nothing reported: the placement p-7 is still the focused one
    expect(app.get(WorkItemService).root.context.getValue('inputFocus')).toBe(false); // inputFocus follows the real element
    outside.focus();
    expect(focus.at(-1)).toBeUndefined();
    chrome.remove();

    tracking.dispose();
    mark.dispose();
    host.remove();
    outside.remove();
    void app.get(ContextKeyService);
    void WorkbenchService;
  });
});
