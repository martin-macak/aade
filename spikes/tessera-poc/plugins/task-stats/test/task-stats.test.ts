import { describe, expect, it } from 'vitest';
import { STATUS_ITEM_ID, TaskStoreToken, openTasksText } from '../src/main.ts';
import { manifest } from '../src/manifest.ts';

describe('C19: sample.taskStats', () => {
  it('C19: the status text is singular for one task and plural otherwise', () => {
    expect([0, 1, 2].map(openTasksText)).toEqual(['0 open tasks', '1 open task', '2 open tasks']);
    expect(STATUS_ITEM_ID).toBe('taskStats.open');
  });

  it('C19: it requires the token of sample.tasks by id and activates at startup finished', () => {
    expect(TaskStoreToken.id).toBe('sample.tasks/TaskStore');
    expect(manifest.requires).toEqual(['sample.tasks/TaskStore']);
    expect(manifest.activationEvents).toEqual(['onStartupFinished']);
  });
});
