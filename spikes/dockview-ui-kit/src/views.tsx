// Two panel views with the same shape, one per component library: a Popover and a Checkbox.
import { Popover as BasePopover } from '@base-ui/react/popover';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Checkbox as RadixCheckbox, Popover as RadixPopover } from 'radix-ui';
import { useEffect, useState } from 'react';
import './styles.css';
import type { PanelProps } from './dock-react.tsx';

/** Lifecycle counters of the views. A test resets them. `instances` gives every mounted view its own number. */
export const probe = { mounts: 0, unmounts: 0, instances: 0 };

function useProbe(): number {
  const [instance] = useState(() => ++probe.instances);
  useEffect(() => {
    probe.mounts++;
    return () => {
      probe.unmounts++;
    };
  }, []);
  return instance;
}

export function RadixView(_props: PanelProps) {
  const instance = useProbe();
  return (
    <div className="view" data-testid="view" data-lib="radix" data-instance={instance}>
      <p>Radix UI (radix-ui 1.8.1)</p>
      <RadixPopover.Root>
        <RadixPopover.Trigger className="btn" data-testid="trigger">
          Open popover
        </RadixPopover.Trigger>
        <RadixPopover.Portal>
          <RadixPopover.Content className="popup" data-testid="popup" side="bottom" align="start" sideOffset={6}>
            <p>Radix popover content</p>
            <RadixPopover.Close className="btn" data-testid="popup-close">
              Close
            </RadixPopover.Close>
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
      <label className="row">
        <RadixCheckbox.Root className="checkbox" data-testid="checkbox">
          <RadixCheckbox.Indicator>✓</RadixCheckbox.Indicator>
        </RadixCheckbox.Root>
        Accept the terms
      </label>
    </div>
  );
}

export function BaseView(_props: PanelProps) {
  const instance = useProbe();
  return (
    <div className="view" data-testid="view" data-lib="base" data-instance={instance}>
      <p>Base UI (@base-ui/react 1.9.0)</p>
      <BasePopover.Root>
        <BasePopover.Trigger className="btn" data-testid="trigger">
          Open popover
        </BasePopover.Trigger>
        <BasePopover.Portal>
          <BasePopover.Positioner className="positioner" side="bottom" align="start" sideOffset={6}>
            <BasePopover.Popup className="popup" data-testid="popup">
              <p>Base UI popover content</p>
              <BasePopover.Close className="btn" data-testid="popup-close">
                Close
              </BasePopover.Close>
            </BasePopover.Popup>
          </BasePopover.Positioner>
        </BasePopover.Portal>
      </BasePopover.Root>
      <label className="row">
        <BaseCheckbox.Root className="checkbox" data-testid="checkbox">
          <BaseCheckbox.Indicator>✓</BaseCheckbox.Indicator>
        </BaseCheckbox.Root>
        Accept the terms
      </label>
    </div>
  );
}

/** A plain React panel, only there to give the dock a second group to move into. */
export function FillerView(_props: PanelProps) {
  return <div className="view" data-testid="filler">Filler panel</div>;
}
