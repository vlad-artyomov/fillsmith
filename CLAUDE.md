# FormForge — notes for Claude Code

Chrome MV3 extension that fills forms with coherent, valid test data for QA. Plain ES2020, no build step, no runtime
dependencies. `README.md` says what it does; `ARCHITECTURE.md` says how it is built and lists the rules learned from
real bugs. Read both before changing behaviour.

## Commands

```bash
npm test                # all four suites; must be green before you are done
npm run test:native     # generator + native controls (fast)
npm run test:widgets    # widget layer against test/primevue-form.html (fast)
npm run test:complete   # one fill on a clean page leaves nothing empty
npm run test:ext        # unpacked extension + popup in Chromium (slowest)
npm run audit           # drive the real extension and judge the page
npm run vocab           # regenerate src/vocab.js (only when changing tools/vendor-faker.mjs)
```

`npm test` runs the four suites in parallel (about a minute and a half; the extension suite is the long pole). While
iterating,
run only the suite that observes the change — `test:native` for rules and the generator, `test:widgets` for anything
that drives a control, `test:ext` for the popup, manifest or worker — and the full set once at the end. `npm run audit`
is for changes to the indicator, the overlays or the toolbar icon, not for every edit.

`test:ext` needs the new headless mode (`channel: 'chromium'`); extension service workers do not register under the old
one. `test/primevue-form.html?latency=slow` makes the fixture's remote pickers slow; the default keeps them quick.

## Where things live

- `src/background.js` owns `FILLER_FILES`, the ordered list of injected scripts. Every suite and tool parses it from
  there. Adding a file is one line here and nowhere else.
- `RULES` in `src/generator.js` decides values from labels. Specific patterns above general ones.
- `LIBS` in `src/adapters.js` recognises widget libraries. `root` and `kind` are required; the rest are hints.
- `src/fillers.js` drives controls; `src/overlays.js` finds and closes their popups; `src/content.js` orders the fill
  and repairs it.

## Rules

- **Judge by the page, not by our report.** Every filler reads its control back and returns what it holds. Never
  `return input.value || v`.
- **Scope every overlay question to its widget** (`aria-controls`, or freshness). This mistake has been made six times;
  do not make it a seventh.
- **No `Math.random()` in a fill path.** `rng` is the persona's RNG; the seed must reproduce every choice.
- **Nothing to the console** from content scripts or the worker. Use `note()` from `dom.js`; it lands in the Debug tab.
- **Never block on the model.** Every await has a budget. A missing, slow or wedged model changes how good the values
  are, never whether they arrive.
- **Wait for a condition, do not sleep for a time**, and give every search a budget.
- **Every bug fix ships with a regression check** in the suite that can observe it. Reproduce the observed symptom
  first, then fix.
- **Comments say why**, in one to four lines. The history of a fix belongs in git, not in the file.
- **Keep the persona invisible.** It is machinery for coherence, not a setting a tester should reason about.
- **Bump the version with every change that lands**, in `manifest.json` and `package.json` together: patch for a fix,
  minor for a feature. A reloaded extension must say which build it is.
