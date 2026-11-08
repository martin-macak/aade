import type { Brand } from '@tessera/base';

// contracts.md section 15.1: ids and records.

export type WindowId = Brand<string, 'WindowId'>;
export type PlacementId = Brand<string, 'PlacementId'>;
export type ViewInstanceId = Brand<string, 'ViewInstanceId'>;

export const PartId = {
  TitleBar: 'titleBar',
  ActivityBar: 'activityBar',
  PrimarySideBar: 'primarySideBar',
  SecondarySideBar: 'secondarySideBar',
  EditorArea: 'editorArea',
  Panel: 'panel',
  StatusBar: 'statusBar',
} as const;
export type PartId = (typeof PartId)[keyof typeof PartId];

/** CAB workspace styles. 'dock' is the editor area. 'tabs' and 'accordion' are VS Code view containers. */
export const WorkspaceKind = {
  Dock: 'dock',
  Tabs: 'tabs',
  Accordion: 'accordion',
  Deck: 'deck',
  Zone: 'zone',
  Dialog: 'dialog',
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];

/** Rendering adapter id: 'react', 'lit', 'solid'. */
export type RendererId = string;

export const PluginState = {
  Discovered: 'discovered',
  Invalid: 'invalid',
  Unresolved: 'unresolved',
  Resolved: 'resolved',
  Activating: 'activating',
  Active: 'active',
  Deactivating: 'deactivating',
  Failed: 'failed',
  Disabled: 'disabled',
} as const;
export type PluginState = (typeof PluginState)[keyof typeof PluginState];

// Leaf types of the dock and layout contracts live here so that the contract files form no import cycle.
export interface DockPosition {
  readonly reference?: PlacementId;
  readonly direction: 'within' | 'left' | 'right' | 'above' | 'below';
}
export interface DockArrangement {
  /** 'dockview' */
  readonly engine: string;
  /** major.minor of the engine, '8.8' */
  readonly engineVersion: string;
  /** Engine JSON. The core never reads it. */
  readonly data: unknown;
}
export interface DockSlot {
  readonly group: string;
  readonly where: 'grid' | 'floating' | 'popout';
  readonly popoutId: string | undefined;
}

/** Deviations from contributed defaults. Only fields that differ are present. */
export interface LayoutOverrides {
  readonly views: Readonly<Record<string, ViewOverride>>;
  readonly workspaces: Readonly<Record<string, WorkspaceOverride>>;
}
export interface ViewOverride {
  readonly workspace?: string;
  readonly hidden?: boolean;
  readonly order?: number;
  readonly collapsed?: boolean;
}
export interface WorkspaceOverride {
  readonly part?: PartId;
  readonly order?: number;
  readonly hidden?: boolean;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkbenchState {
  /** +1 on every model change. Used to drop stale dock surface reports. */
  readonly revision: number;
  readonly windows: Readonly<Record<string, WindowRecord>>;
  readonly workspaces: Readonly<Record<string, WorkspaceRecord>>;
  readonly placements: Readonly<Record<string, PlacementRecord>>;
  readonly instances: Readonly<Record<string, ViewInstanceRecord>>;
  readonly focus: PlacementId | undefined;
  /** User deviations from contributed defaults (section 16.4). */
  readonly overrides: LayoutOverrides;
}

export interface WindowRecord {
  readonly id: WindowId;
  readonly kind: 'main' | 'auxiliary';
  readonly bounds: Box | undefined;
  readonly parts: Readonly<Partial<Record<PartId, PartRecord>>>;
}

export interface PartRecord {
  readonly id: PartId;
  readonly visible: boolean;
  readonly size: number | undefined;
  /** Workspace ids shown in this part, in order. A side bar shows one at a time (active). */
  readonly workspaces: readonly string[];
  readonly active: string | undefined;
}

export interface WorkspaceRecord {
  /** 'workbench.editorArea' or a contributed id such as 'sample.tasks.sidebar'. */
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly windowId: WindowId;
  readonly partId: PartId | undefined;
  readonly title: string;
  readonly icon: string | undefined;
  /** Plugin id or 'core'. */
  readonly owner: string;
  /** Order = tab order or accordion order. */
  readonly members: readonly PlacementId[];
  readonly active: PlacementId | undefined;
  /** Accordion only. */
  readonly collapsed: readonly PlacementId[];
  /** Dock workspaces only. Opaque to the core (section 15.9). */
  readonly arrangement: DockArrangement | undefined;
}

export const PlacementStatus = {
  Pending: 'pending',
  Placeholder: 'placeholder',
  Attached: 'attached',
  Hidden: 'hidden',
  Closing: 'closing',
  Closed: 'closed',
} as const;
export type PlacementStatus = (typeof PlacementStatus)[keyof typeof PlacementStatus];

export interface PlacementRecord {
  readonly id: PlacementId;
  readonly viewType: string;
  readonly instanceId: ViewInstanceId;
  readonly workspaceId: string;
  readonly status: PlacementStatus;
  /** Dock workspaces only: group and where, as last reported by the surface. */
  readonly dock: DockSlot | undefined;
}

export interface ViewInstanceRecord {
  readonly id: ViewInstanceId;
  readonly viewType: string;
  /** '' for singleton view types. A document URI for keyed ones. */
  readonly key: string;
  readonly workItemPath: string;
  readonly placements: readonly PlacementId[];
}

/** Light reference handed to plugins, commands and events. */
export interface PlacementRef {
  readonly id: PlacementId;
  readonly viewType: string;
  readonly instanceId: ViewInstanceId;
  readonly workspaceId: string;
  readonly windowId: WindowId;
}

export interface ViewInstanceRef {
  readonly id: ViewInstanceId;
  readonly viewType: string;
  readonly key: string;
  readonly workItemPath: string;
}
