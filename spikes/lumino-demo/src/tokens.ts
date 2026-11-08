// Typed keys for the services of the window. They are Lumino `Token`s, so the same key also works in `IPlugin.requires` /
// `provides` (the native, flat, application-wide registry) and in our scoped container (capability 7).
import { type CommandRegistry } from '@lumino/commands';
import { Token } from '@lumino/coreutils';
import { type CommandPalette } from '@lumino/widgets';
import { type ViewHost } from './cap1-shared-view.tsx';
import { type ContextKeys } from './cap2-context-keys.ts';
import { type Contributions } from './contributions.ts';
import { type Interceptors } from './cap3-interceptors.ts';
import { type PluginHost } from './cap4-plugins.ts';
import { type LayoutStore } from './cap5-persistence.ts';
import { type EventNode } from './cap6-event-bus.ts';
import { type Workspaces } from './cap8-workspaces.ts';
import { type WorkItem, type WorkItems } from './cap9-workitems.ts';

export const ICommands = new Token<CommandRegistry>('commands');
export const IPalette = new Token<CommandPalette>('palette');
export const IContextKeys = new Token<ContextKeys>('contextKeys');
export const IContributions = new Token<Contributions>('contributions');
export const IInterceptors = new Token<Interceptors>('interceptors');
export const IRootEvents = new Token<EventNode>('rootEvents');
export const IViews = new Token<ViewHost>('views');
export const IWorkspaces = new Token<Workspaces>('workspaces');
export const IPlugins = new Token<PluginHost>('plugins');
export const ILayout = new Token<LayoutStore>('layout');
/** Bound in the scope of a WorkItem, so a view below it can find "its" WorkItem. */
export const ICurrentWorkItem = new Token<WorkItem>('currentWorkItem');
export const IWorkItems = new Token<WorkItems>('workItems');
