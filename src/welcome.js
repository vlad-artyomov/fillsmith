/* The shortcuts as Chrome actually bound them. A suggested key is taken only
 * if it is free at install time, and the page must not promise one Chrome gave
 * to something else; an unassigned one links to where it can be set. */
(function () {
    'use strict';
    if (chrome.commands && chrome.commands.getAll) {
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
    }

    // The page's zoom, so the arrow stays under the toolbar's puzzle piece when the page is zoomed.
    const zoomed = (z) => document.documentElement.style.setProperty('--zoom', String(z || 1));
    if (chrome.tabs && chrome.tabs.getCurrent && chrome.tabs.getZoom) {
        chrome.tabs.getCurrent((tab) => {
            if (!tab) return;
            chrome.tabs.getZoom(tab.id, zoomed);
            chrome.tabs.onZoomChange.addListener((e) => { if (e.tabId === tab.id) zoomed(e.newZoomFactor); });
        });
    }

    /* Until the icon is pinned it hides in the puzzle menu, and a user who
     * cannot find it cannot press it. Once it is pinned the hint has done its job. */
    const hint = document.getElementById('pin-hint');
    const show = (settings) => { hint.hidden = !!(settings && settings.isOnToolbar); };
    if (hint && chrome.action && chrome.action.getUserSettings) {
        chrome.action.getUserSettings().then(show, () => {});
        if (chrome.action.onUserSettingsChanged) chrome.action.onUserSettingsChanged.addListener(show);
    }
})();
