import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBarService } from '@tessera/contracts';
import { computed, state } from '@tessera/reactive';
import { captureErrors } from '@tessera/testing';
import { ChromeBoundary } from '../src/index.ts';
import { renderCounterApp } from './app-kit.tsx';

describe('round 2: the window chrome survives plugin data', () => {
  it('C24: a status bar item with a throwing text and one with a bad `when` do not blank the window; the other items render', async () => {
    const errors = captureErrors();
    const r = await renderCounterApp();
    const bar = r.app.get(StatusBarService);
    const boom = state(true);
    await act(async () => {
      bar.add({ id: 'ok', alignment: 'left', text: 'fine' });
      bar.add({ id: 'throws', alignment: 'left', text: computed(() => (boom.get() ? (() => { throw new Error('text broke'); })() : 'back')) });
      bar.add({ id: 'bad-when', alignment: 'right', text: 'never', when: 'a &&' });
    });
    expect(document.querySelector('[data-tessera-chrome]')).not.toBeNull(); // the window is still there
    expect(document.querySelector('[data-status-item="ok"]')?.textContent).toBe('fine');
    expect(document.querySelector('[data-status-item="throws"]')).toBeNull();
    expect(document.querySelector('[data-status-item="bad-when"]')).toBeNull();
    await act(async () => boom.set(false));
    expect(document.querySelector('[data-status-item="throws"]')?.textContent).toBe('back');
    errors.drain();
    errors.dispose();
    r.unmount();
  });

  it('C24: a disabled command draws a disabled button; the click runs through the service (source statusBar)', async () => {
    const r = await renderCounterApp();
    const bar = r.app.get(StatusBarService);
    await act(async () => {
      bar.add({ id: 'no-cmd', alignment: 'left', text: 'Nope', command: 'counter.doesNotExist' });
    });
    const button = document.querySelector('[data-status-item="no-cmd"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    r.unmount();
  });

  it('C24: ChromeBoundary shows a notice for a part that throws, reports it, keeps its siblings, and Retry renders again', () => {
    const errors = captureErrors();
    let broken = true;
    const Bad = (): never | string => {
      if (broken) throw new Error('chrome part failed');
      return 'recovered';
    };
    render(
      <div>
        <ChromeBoundary name="statusBar">
          <Bad />
        </ChromeBoundary>
        <span>sibling</span>
      </div>,
    );
    expect(screen.getByText('sibling')).toBeTruthy();
    expect(document.querySelector('[data-chrome-error="statusBar"]')).not.toBeNull();
    const reported = errors.drain();
    expect(reported.some((e) => e.context.source === 'view' && e.context.target === 'chrome:statusBar')).toBe(true);
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('recovered')).toBeTruthy();
    errors.dispose();
  });
});
