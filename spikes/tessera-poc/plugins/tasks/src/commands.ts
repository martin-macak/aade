import { defineCommand } from '@tessera/plugin-api';
import type { CommandDef, Schema } from '@tessera/plugin-api';
import { isRecord, schemaOf } from './schemas.ts';
import { PROJECTS, type ProjectId } from './task-store.ts';

// The commands of sample.tasks as typed handles (`defineCommand`): the id, the argument schema and the result type live in one place.
// Handlers are registered with `AddTask.id` and `AddTask.args`; callers use `commands.run(AddTask, args)` and get the result type.

export interface AddTaskArgs {
  readonly title?: string;
  readonly project?: ProjectId;
}
export interface CompleteTaskArgs {
  readonly id?: string;
}

export const addArgs: Schema<AddTaskArgs | undefined> = schemaOf((i) =>
  i === undefined || (isRecord(i) && (i['title'] === undefined || typeof i['title'] === 'string') && (i['project'] === undefined || PROJECTS.includes(i['project'] as ProjectId))) ? undefined : 'expected { title?: string, project?: ProjectId }',
);
export const idArgs: Schema<CompleteTaskArgs | undefined> = schemaOf((i) => (i === undefined || (isRecord(i) && (i['id'] === undefined || typeof i['id'] === 'string')) ? undefined : 'expected { id?: string }'));

export const AddTask: CommandDef<AddTaskArgs | undefined, { id: string }> = defineCommand<AddTaskArgs | undefined, { id: string }>('tasks.add', addArgs);
export const CompleteTask: CommandDef<CompleteTaskArgs | undefined, { id: string; changed: boolean }> = defineCommand<CompleteTaskArgs | undefined, { id: string; changed: boolean }>('tasks.complete', idArgs);
export const ClearCompleted: CommandDef<void, { removed: number }> = defineCommand<void, { removed: number }>('tasks.clearCompleted');
