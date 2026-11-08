import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InterceptorRegistry, type PlacementId } from '@tessera/contracts';
import { captureErrors, type TestApp } from '@tessera/testing';
import { listApp, listManifest } from './kit.ts';

// Claim C21 (invariant 17): after every settled change, the set of dock panel ids equals the members of the dock
// workspace. Random gestures and commands run against the real workbench with fakeDockSurface.

const EDITOR = 'workbench.editorArea';
const DIRECTIONS = ['left', 'right', 'above', 'below'] as const;

type Op =
  | { t: 'open'; k: number; focus: boolean }
  | { t: 'close'; i: number; force: boolean }
  | { t: 'activate'; i: number }
  | { t: 'userNewGroup'; i: number; d: number }
  | { t: 'userToGroup'; i: number; g: number }
  | { t: 'userActivate'; i: number }
  | { t: 'userClose'; i: number }
  | { t: 'geometry' }
  | { t: 'stale'; back: number }
  | { t: 'toggleVeto' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('open' as const), k: fc.integer({ min: 0, max: 5 }), focus: fc.boolean() }),
  fc.record({ t: fc.constant('close' as const), i: fc.nat(10), force: fc.boolean() }),
  fc.record({ t: fc.constant('activate' as const), i: fc.nat(10) }),
  fc.record({ t: fc.constant('userNewGroup' as const), i: fc.nat(10), d: fc.nat(3) }),
  fc.record({ t: fc.constant('userToGroup' as const), i: fc.nat(10), g: fc.nat(5) }),
  fc.record({ t: fc.constant('userActivate' as const), i: fc.nat(10) }),
  fc.record({ t: fc.constant('userClose' as const), i: fc.nat(10) }),
  fc.constant({ t: 'geometry' as const }),
  fc.record({ t: fc.constant('stale' as const), back: fc.integer({ min: 1, max: 4 }) }),
  fc.constant({ t: 'toggleVeto' as const }),
);

function check(app: TestApp, label: string): void {
  const ws = app.workbench.state.peek().workspaces[EDITOR]!;
  const fake = app.dock!.surfaces.get(EDITOR)!;
  const panels = [...fake.panelIds()];
  expect(new Set(panels).size, `${label}: panel ids are unique`).toBe(panels.length);
  expect(panels.sort(), `${label}: panel ids equal workspace members`).toEqual([...ws.members].sort());
  if (ws.active !== undefined) expect(ws.members, `${label}: the active placement is a member`).toContain(ws.active);
  // visibility reported by the surface matches what the workbench believes
  const visible = new Set(fake.visiblePanels());
  for (const id of ws.members) {
    expect(app.workbench.placement(id)?.visible.peek(), `${label}: visibility of ${id}`).toBe(visible.has(id));
  }
  // records and runtime objects agree
  const state = app.workbench.state.peek();
  for (const id of ws.members) expect(state.placements[id]?.workspaceId).toBe(EDITOR);
  expect(Object.keys(state.placements).filter((id) => state.placements[id]?.workspaceId === EDITOR).sort()).toEqual([...ws.members].sort());
}

describe('C21: dock sync property (fast-check against fakeDockSurface)', () => {
  it('C21: panel ids equal workspace members after every settled change, for random gestures and commands', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 24 }), async (ops) => {
        const manifest = listManifest({ contributes: { views: [{ id: 'fixture.list', title: 'Doc', multiplicity: 'keyed' }] } });
        const app = await listApp({ manifest });
        const errors = captureErrors();
        const fake = app.dock!.surfaces.get(EDITOR)!;
        let veto = false;
        app.application.get(InterceptorRegistry).register({
          id: 'maybe-veto',
          kinds: ['command'],
          match: 'workbench.*',
          mode: 'guard',
          phase: 'guard',
          async intercept(ctx, next) {
            if (veto && (ctx.target === 'workbench.movePlacement' || ctx.target === 'workbench.closePlacement')) return ctx.target === 'workbench.closePlacement' ? false : undefined;
            return next();
          },
        });
        const members = (): PlacementId[] => [...(app.workbench.state.peek().workspaces[EDITOR]?.members ?? [])];
        const pick = (i: number): PlacementId | undefined => {
          const list = members();
          return list.length === 0 ? undefined : list[i % list.length];
        };
        let step = 0;
        try {
          for (const op of ops) {
            step++;
            const id = 'i' in op ? pick(op.i) : undefined;
            switch (op.t) {
              case 'open':
                await app.workbench.showView('fixture.list', { key: `doc-${op.k}`, workspace: EDITOR, focus: op.focus });
                break;
              case 'close':
                if (id) await app.workbench.close(id, { force: op.force });
                break;
              case 'activate':
                if (id) await app.workbench.activate(id);
                break;
              case 'userNewGroup':
                if (id) fake.userMoveToNewGroup(id, DIRECTIONS[op.d % 4]);
                break;
              case 'userToGroup': {
                const groups = fake.groups();
                const target = groups[op.g % Math.max(groups.length, 1)];
                if (id && target) fake.userMoveToGroup(id, target.id);
                break;
              }
              case 'userActivate':
                if (id) fake.userActivate(id);
                break;
              case 'userClose':
                if (id) fake.userClose(id);
                break;
              case 'geometry':
                fake.userGeometry();
                break;
              case 'stale':
                fake.reportAtRevision(Math.max(0, app.workbench.state.peek().revision - op.back), ['structure']);
                break;
              case 'toggleVeto':
                veto = !veto;
                break;
            }
            await app.settle();
            check(app, `step ${step} (${JSON.stringify(op)})`);
          }
          // whatever the user did, an un-vetoed sync leaves the surface equal to the model
          veto = false;
          await app.settle();
          check(app, 'end');
          const unexpected = errors.drain().filter((e) => (e.error as { code?: string }).code !== 'workbench.moveRejected');
          expect(unexpected.map((e) => String(e.error))).toEqual([]);
        } finally {
          errors.dispose();
          await app.dispose();
        }
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
