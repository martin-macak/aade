import { alienEngine } from '@tessera/reactive/alien';
import { reactiveEngineConformance } from '@tessera/testing';

// alien-signals ends effect loops by itself (an effect is not re-triggered by writes to its own sources
// while it runs), so there is nothing for the facade to report. Everything else is identical.
reactiveEngineConformance(alienEngine, { engineRerunsLoopingEffects: false });
