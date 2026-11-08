// Capability 2: a plugin-contributed command that shows up in a menu and in the command palette, and is enabled by context state.
//
// Native: `CommandRegistry.addCommand` (label, execute, isEnabled), `notifyCommandChanged`, `addKeyBinding`, `Menu`, `MenuBar`,
// `CommandPalette`. The palette re-reads `isEnabled` on `commandChanged`; a Menu re-reads it each time it is opened (it does not
// listen to `commandChanged`, see test c2).
// Ours: Lumino has no "context key". `isEnabled` is a plain callback, so the state it reads and the notification that tells the
// palette to re-evaluate it are up to us. `ContextKeys` below is that state (a map plus a Signal). The declarative bundler that turns
// one declaration into command + menu item + palette item + key binding, removable as one, is in contributions.ts (shared
// infrastructure, also used for the manifest commands of capability 4).
import { Signal } from '@lumino/signaling';

export class ContextKeys {
  readonly changed = new Signal<this, string>(this);
  private readonly values = new Map<string, unknown>();
  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  set(key: string, value: unknown): void {
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    this.changed.emit(key);
  }
}
