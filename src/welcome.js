/* The shortcuts as Chrome actually bound them. A suggested key is taken only
 * if it is free at install time, and the page must not promise one Chrome gave
 * to something else; an unassigned one links to where it can be set. */
(function () {
    'use strict';
    if (!chrome.commands || !chrome.commands.getAll) return;
    chrome.commands.getAll((commands) => {
        for (const c of commands || []) {
            for (const el of document.querySelectorAll(`[data-cmd="${c.name}"]`)) {
                if (c.shortcut) el.textContent = c.shortcut;
                else {
                    el.textContent = 'not set';
                    el.title = 'Set it under chrome://extensions/shortcuts';
                    el.style.color = 'var(--warn)';
                }
            }
        }
    });
})();
