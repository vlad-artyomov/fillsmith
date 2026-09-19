/* The shortcuts as Chrome actually bound them. A suggested key is taken only
 * if it is free at install time, and the page must not promise one Chrome gave
 * to something else; an unassigned one links to where it can be set. */
(function () {
    'use strict';
    if (!chrome.commands || !chrome.commands.getAll) return;
    const keys = {'fill-form': 'k-fill', 'refill-form': 'k-refill', 'clear-form': 'k-clear', 'fill-field': 'k-field'};
    chrome.commands.getAll((commands) => {
        for (const c of commands || []) {
            const el = keys[c.name] && document.getElementById(keys[c.name]);
            if (!el) continue;
            if (c.shortcut) el.textContent = c.shortcut;
            else {
                el.textContent = 'not set';
                el.title = 'Set it under chrome://extensions/shortcuts';
                el.style.color = 'var(--warn)';
            }
        }
    });
})();
