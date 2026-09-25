# Contributing

Thanks for looking. Fillsmith is small on purpose: plain ES2020, no build step, no runtime dependency, and four
test suites that judge the page rather than the code's own opinion of itself. Keeping it that way is most of the job.

## Before you start

Read [README.md](README.md) for what it does and [ARCHITECTURE.md](ARCHITECTURE.md) for how it is built. The second
half of ARCHITECTURE.md is a list of rules learned from real bugs; each has a regression check, and a change that
breaks one of them usually means the rule was not understood rather than that it was wrong.

```bash
npm install                     # Playwright, faker and TypeScript, dev only
npx playwright install chromium
npm test                        # all four suites, about three minutes
npm run typecheck               # the JSDoc and types/, over the logic files
```

While iterating, run the one suite that can see your change: `npm run test:native` for the generator and rules,
`npm run test:widgets` for anything that drives a control, `npm run test:ext` for the popup, manifest or worker.
`npm run fixture` serves `test/` so you can try the fixtures by hand.

## What a change looks like

- **A bug fix ships with a check** in the suite that can observe it, and the check fails before the fix. Reproduce
  the symptom first. The fixtures (`test/primevue-form.html` and the smaller pages in `test/`) exist to be extended:
  add the control shape that failed, then the check.
- **Judge by the page.** A filler returns what the control holds afterwards, never what it typed. A check reads the
  page's own model, never Fillsmith's report.
- **Nothing to the console** from the content scripts or the worker; `note()` in `src/dom.js` lands in the Debug tab.
- **No `Math.random()` in a fill path.** Every choice comes from the persona's RNG so a seed reproduces a fill.
- **Waits are conditions with a budget**, never a fixed sleep.
- **Comments say why**, in a few lines. What changed and when belongs in the commit.

## Adding a rule or a library

- A rule is one line in `RULES` in `src/generator.js`, specific patterns above general ones; a check for the label
  goes into the routing table in `test/run.mjs`. The README's *Extending it* section has the shape.
- A widget library is one entry in `LIBS` in `src/adapters.js`. `root` must be something only that library renders.
  Bring a fixture: the closed control's DOM and its open popup, captured from the real thing.

## Landing it

One landed change per commit; the subject is the changelog, so write it for the person reading the release. A change
to what the package carries gets a version bump through `npm run release -- patch|minor` in the same commit;
tooling, docs and tests do not. Pull requests are welcome; CI runs the suites and a check that `src/vocab.js` is
still what `npm run vocab` generates.
