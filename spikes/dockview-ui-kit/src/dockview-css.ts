// dockview-core 8.8.3 ships no stylesheet file (the `dockview` package ships dist/styles/dockview.css, `dockview-core` does not).
// The only copy of the CSS is a string that the UMD bundle injects into <head> when it loads. Loading that whole bundle a second
// time would run the library twice, so this module reads the bundle as text, takes the CSS string out and injects only the CSS.
import umdSource from 'dockview-core/dist/dockview-core.js?raw';

export function injectDockviewCss(): void {
  if (document.getElementById('dockview-core-css')) return;
  const match = /s\.textContent = ("(?:[^"\\]|\\.)*");/.exec(umdSource);
  if (!match?.[1]) throw new Error('dockview-core CSS string not found in dist/dockview-core.js');
  const style = document.createElement('style');
  style.id = 'dockview-core-css';
  style.textContent = JSON.parse(match[1]) as string;
  document.head.append(style);
}
