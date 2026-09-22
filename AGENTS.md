# FormForge — notes for Codex

Chrome MV3 extension that fills forms with coherent, valid test data for QA. Plain ES2020, no build step, no runtime
dependencies. `README.md` says what it does; `ARCHITECTURE.md` says how it is built and lists the rules learned from
real bugs. Read both before changing behaviour.

## Commands

```bash
npm test                # all four suites; must be green before you are done
npm run test:native     # generator + native controls (fast)
npm run test:widgets    # widget layer: test/primevue-form.html and test/libraries-form.html
npm run test:complete   # one fill on a clean page leaves nothing empty
npm run test:ext        # unpacked extension + popup in Chromium (slowest)
npm run audit           # drive the real extension and judge the page
npm run typecheck       # the JSDoc and types/, over the logic files; emits nothing
npm run screenshots     # the store pictures and the README's, at the size the store wants
npm run vocab           # regenerate src/vocab.js (only when changing tools/vendor-faker.mjs)
npm run release -- patch # move the version on in manifest.json, package.json and the lockfile together
```

`npm test` runs the four suites in parallel (about three minutes; the widget suite is the long pole). While
iterating,
run only the suite that observes the change — `test:native` for rules and the generator, `test:widgets` for anything
that drives a control, `test:ext` for the popup, manifest or worker — and the full set once at the end. `npm run audit`
is for changes to the indicator, the overlays or the toolbar icon, not for every edit.

`test:ext` needs the new headless mode (`channel: 'chromium'`); extension service workers do not register under the old
one. `test/primevue-form.html?latency=slow` makes the fixture's remote pickers slow; the default keeps them quick.

## Where things live

- `src/background.js` owns `FILLER_FILES`, the ordered list of injected scripts. Every suite and tool parses it from
  there. Adding a file is one line here and nowhere else. It also owns the record of what each fill did: `askPage()`
  adds the frames up and writes it once, so nothing in the page writes to storage.
- `RULES` in `src/generator.js` decides values from labels. Specific patterns above general ones.
- `LIBS` in `src/adapters.js` recognises widget libraries. `root` and `kind` are required; the rest are hints. Only the
  outermost match survives, so `root` must be something only that library renders — an application's own wrapper class
  matching it replaces the real control rather than merely missing it.
- `src/fillers.js` drives controls; `src/overlays.js` finds and closes their popups; `src/collect.js` reads the page
  and names what it finds; `src/model.js` holds the conversation with the model and the state that outlives a fill;
  `src/content.js` orders the fill and repairs it. A name that moves between these files has to move in the export
  list too — `collect.js` is out of the typecheck, so only the suites see it go missing.

## Rules

- **Judge by the page, not by our report.** Every filler reads its control back and returns what it holds. Never
  `return input.value || v`.
- **Scope every overlay question to its widget** (`aria-controls`, or freshness). This mistake has been made six times;
  do not make it a seventh.
- **No `Math.random()` in a fill path.** `rng` is the persona's RNG; the seed must reproduce every choice.
- **Nothing to the console** from content scripts or the worker. Use `note()` from `dom.js`; it lands in the Debug tab.
- **Keep the prompt short.** On the on-device model its length is most of the latency, so every line added to a
  prompt is paid on every batch of every fill. A batch of twelve fits in 750 characters and a check in `test:ext`
  holds it there; before adding a line, look for one that is saying the same thing twice. The reply's shape is the
  grammar's job, not the prompt's: the schema is built per batch and names every id, so the skeleton can stay short.
- **Never block on the model.** Every await has a budget, and the fill does not wait for it: the request goes out as
  soon as the form is read and writing starts immediately. A missing, slow or wedged model changes how good the values
  are, never whether they arrive — or when.
- **Wait for a condition, do not sleep for a time**, and give every search a budget.
- **Every bug fix ships with a regression check** in the suite that can observe it. Reproduce the observed symptom
  first, then fix.
- **Comments say why**, in one to four lines. The history of a fix belongs in git, not in the file.
- **Keep the persona invisible.** It is machinery for coherence, not a setting a tester should reason about.
- **One version per commit, decided just before it.** Do not bump while iterating: the number is what a reloaded
  extension says it is, so a version nobody ever built is noise. When the work is ready to land, take the version
  at `HEAD` — not whatever the tree drifted to — judge the whole change set, and **propose patch or minor and wait
  for a yes** before committing and pushing. `npm run release -- patch|minor` writes `manifest.json` and
  `package.json` together. A commit that changes nothing the package carries — tooling, suites, docs, fixtures —
  leaves the version where it is and drops the version from its subject: there is no new build to name. A `v1.0.1`
  tag — matching the manifest — is what publishes it; nothing else does.
- **Never commit or push unasked, and they are two separate asks.** Finish the work, run the suites, leave it in
  the working tree, and say what is in it. Recording it in history, and when, is the user's call — and permission
  for one commit is permission for that commit, not for the ones after it. "Commit" is not "push": a commit stays
  local until asked for in so many words, because a push is the first step anybody else can see. A tag is a third
  ask again — pushing one publishes a release. The version bump above is part of the change, not a reason to
  commit it.
