# Tessera demo app

This Vite app shows the demo items of the proof of concept in a browser. It boots `@tessera/host-web` with the React renderer and dockview.

Run these commands from `spikes/tessera-poc`, through `mise exec --`:

```bash
npm run demo        # dev server at http://localhost:5173
npm run build:demo  # production build in apps/demo/dist
```

`npm test` runs the demo script in Chromium through Vitest Browser Mode. The tests are `apps/demo/test/two-placements.browser.test.tsx` and `apps/demo/test/demo-smoke.browser.test.ts`.

To try the demo by hand, press **Reset storage**, which clears `localStorage` and reloads the page. Then use the numbered buttons at the top of the page.
