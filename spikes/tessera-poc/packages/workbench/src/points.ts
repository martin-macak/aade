import type { Schema } from '@tessera/base';
import {
  ViewRegistry,
  defineContributionPoint,
  type ContributionHandler,
  type ViewContribution,
  type WorkspaceContribution,
} from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { z } from 'zod';

const viewSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  icon: z.string().optional(),
  when: z.string().optional(),
  workspace: z.string().optional(),
  visibleByDefault: z.boolean().optional(),
  multiplicity: z.enum(['singleton', 'keyed']).optional(),
  multiPlacement: z.boolean().optional(),
  workItem: z.string().optional(),
  canMove: z.boolean().optional(),
  canClose: z.boolean().optional(),
  retain: z.enum(['grace', 'none', 'workItem']).optional(),
  order: z.number().optional(),
  renderMode: z.enum(['onlyWhenVisible', 'always']).optional(),
}) as unknown as Schema<ViewContribution>;

const workspaceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  icon: z.string().optional(),
  kind: z.enum(['tabs', 'accordion']),
  part: z.enum(['primarySideBar', 'secondarySideBar', 'panel']),
  order: z.number().optional(),
  when: z.string().optional(),
}) as unknown as Schema<WorkspaceContribution>;

export const viewsPoint: ReturnType<typeof defineContributionPoint<ViewContribution>> = defineContributionPoint<ViewContribution>('views', viewSchema, {
  description: 'Declares a view type: where it shows by default, how instances are owned and retained.',
  activationEvents: (entry) => [`onView:${entry.id}`],
  identity: (entry) => entry.id,
});

export const workspacesPoint: ReturnType<typeof defineContributionPoint<WorkspaceContribution>> = defineContributionPoint<WorkspaceContribution>('workspaces', workspaceSchema, {
  description: 'Adds a container workspace (tabs or accordion) to a side bar or the panel.',
  identity: (entry) => entry.id,
});

export function viewsHandler(scope: ScopeReader): ContributionHandler<ViewContribution> {
  return { apply: (c) => scope.get(ViewRegistry).register({ ...c.value, owner: c.pluginId }) };
}
