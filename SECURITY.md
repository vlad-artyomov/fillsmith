# Security

FormForge runs inside pages you point it at and, if you configure one, talks to a hosted model provider with your
key. Both are worth getting right, so please report anything that looks wrong.

## Reporting

Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**), so the
report is not public before a fix is. If that is not available to you, open an issue that says only that you have a
security report and how to reach you; do not put the details in it.

You should hear back within a week. A fix ships as a patch release; the release notes name the issue once it is fixed.

## In scope

- Anything that lets a page FormForge fills run code in the extension, read its storage, or reach your API key.
- Anything that sends page data anywhere other than the provider you configured, or sends it when the backend is
  *On-device only*.
- Anything FormForge writes to a page that it should not: a submit, a navigation, a click on a control that is not
  the one it is filling.

## Out of scope

- The behaviour of the pages you fill, or of the model providers.
- Test data that a form accepts but you consider implausible. That is a bug, not a vulnerability: open an ordinary
  issue with the Debug tab's report attached.

## Versions

Only the latest release is supported. The extension has no auto-update outside the Chrome Web Store; if you loaded it
unpacked, pull and reload.
