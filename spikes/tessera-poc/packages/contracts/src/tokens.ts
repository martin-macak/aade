import type { ErrorReporter as ErrorReporterType, Logger as LoggerType } from '@tessera/base';
import { token, type Token } from '@tessera/di';
import type { InterceptorRegistry as InterceptorRegistryType } from '@tessera/interceptors';
import { CommandService } from './commands.ts';
import { StatusBarService } from './status-bar.ts';
import { ConfigurationService } from './configuration.ts';
import { ContextKeyService } from './context-keys.ts';
import { UndoService } from './undo.ts';
import { DialogService, NotificationService, QuickInputService, SelectionService, WorkbenchService } from './workbench.ts';
import { WorkItemService } from './workitems.ts';

// Tokens for kernel types (contracts.md section 20). The interfaces live in @tessera/base and @tessera/interceptors.

export type Logger = LoggerType;
export const Logger: Token<LoggerType> = token<LoggerType>('tessera.logger');

export type ErrorReporter = ErrorReporterType;
export const ErrorReporter: Token<ErrorReporterType> = token<ErrorReporterType>('tessera.errorReporter');

export type InterceptorRegistry = InterceptorRegistryType;
export const InterceptorRegistry: Token<InterceptorRegistryType> = token<InterceptorRegistryType>('tessera.interceptors');

/** The tokens in-process plugins may get without declaring them in manifest requires (contracts.md section 20). */
export const PublicTokens: readonly Token<unknown>[] = [
  CommandService,
  ContextKeyService,
  WorkbenchService,
  WorkItemService,
  SelectionService,
  UndoService,
  NotificationService,
  DialogService,
  QuickInputService,
  ConfigurationService,
  // POC addition (deviations.md): plugins need it to show dynamic status text; the `statusBar` point carries static text only.
  StatusBarService,
] as readonly Token<unknown>[];
