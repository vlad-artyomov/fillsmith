/* The promo film's script: every word on screen and every timing, in one place.
 * Read by tools/video.mjs (how many frames, which fills to record) and by the
 * stage (what to show when). Times are seconds from the start of their scene.
 *
 * A scene that records a fill names a take: the page, and when the fill is
 * pressed. Its beats pin moments of that fill — named in the fill's own log —
 * to moments of the film, so a slow control can be dwelt on and a fast one
 * passed over. Between two beats the fill runs at whatever speed joins them.
 */

export const FPS = 60;
export const SIZE = {w: 1920, h: 1080};
export const STORE_URL = 'https://chromewebstore.google.com/detail/amhpkgalagghaabpdnkjclkkjcellabm';

// The fill every take makes: one seed, so one person, in every scene.
export const FILL = {
    locale: 'en-US', seed: 'STORE1', useAI: true, overwrite: true, emailDomain: 'example.com', debugTab: true
};
// "Today", in the page and in the filler, so the calendar and every date in it come out the same.
export const EPOCH = '2026-10-05T10:00:00';
// How long the on-device model takes to answer a batch, in the fill's own time.
export const MODEL_MS = 1400;

export const SCENES = [
    {
        id: 'hook', dur: 4,
        take: {page: 'form.html'},
        title: 'Still typing<br>test data?',
        typing: {field: 'requester', at: 0.7, text: 'asdf', every: 0.16, erase: 1.9}
    },
    {
        id: 'fill', dur: 10,
        title: 'Fill any form<br>in one click.',
        keys: {at: 0.25, press: 0.55, keys: ['Alt', 'Shift', 'F']},
        // When the camera moves in on the card, to read its verdict.
        cardAt: 8.1,
        // The take carries on from the hook: the same page, pressed here.
        fillAt: 0.75,
        beats: [
            ['field:Contact person', 0.95],
            ['field:Work email', 1.4],
            ['field:Office country', 1.85],
            ['open:1', 2.05],
            ['pick:1', 2.6],
            ['field:Go-live date', 2.85],
            ['open:2', 3.05],
            ['pick:2', 3.6],
            ['field:Internal ticket', 3.85],
            ['field:Screenshot', 4.25],
            ['file', 4.35],
            ['field:Needs sign-off before release', 4.85],
            ['field:Release notes', 5.25],
            ['improve', 5.7],
            ['ai:1', 6.9],
            ['ai:2', 7.3],
            ['toast', 7.8]
        ]
    },
    {
        id: 'controls', dur: 8, dissolve: 0.4,
        take: {page: 'form.html', fillAt: 0.2},
        title: 'Even the<br>custom ones.',
        shots: [
            {at: 0, on: 'country', text: 'Opens the dropdown.<br>Picks a real option.'},
            {at: 2.1, on: 'golive', text: 'Clicks the day<br>in the calendar.'},
            {at: 4.2, on: 'screenshot', text: 'Generates a real PNG<br>for the upload.'},
            {at: 6.0, on: 'notes', text: 'Pastes real markup<br>into the editor.'}
        ],
        beats: [
            ['field:Contact person', 0.3],
            ['field:Office country', 0.45],
            ['open:1', 0.8],
            ['pick:1', 1.7],
            ['field:Go-live date', 2.35],
            ['open:2', 2.7],
            ['pick:2', 3.75],
            ['field:Internal ticket', 4.3],
            ['field:Screenshot', 4.45],
            ['file', 4.9],
            ['field:Needs sign-off before release', 5.9],
            ['field:Release notes', 6.25],
            ['paste:1', 6.6],
            ['improve', 7.9]
        ]
    },
    {
        id: 'person', dur: 6, dissolve: 0.4,
        take: {page: 'person.html', fillAt: 0.35},
        title: 'One believable<br>person.',
        text: 'The email follows the name.<br>The ZIP and the phone, the city.',
        beats: [['field:Full name', 0.45], ['toast', 1.1]],
        // Which parts of which fields belong together, drawn in this order.
        ties: [
            {at: 1.5, from: ['name', 'Jennyfer Parisian'], to: ['email', 'jennyfer.parisian']},
            {at: 2.5, from: ['city', 'Philadelphia'], to: ['zip', '19103']},
            {at: 3.3, from: ['city', 'Philadelphia'], to: ['contactNumber', '(215)']}
        ]
    },
    {
        id: 'ai', dur: 7, dissolve: 0.4,
        take: {page: 'form.html', fillAt: 0.15},
        title: 'AI built into<br>Chrome.',
        text: 'No key. No bill.',
        pill: {at: 0.8},
        cardAt: 4.9,
        beats: [
            ['field:Contact person', 0.2],
            ['field:Release notes', 0.6],
            ['improve', 1.0],
            ['ai:1', 3.4],
            ['ai:2', 4.6],
            ['toast', 5.3]
        ]
    },
    {
        id: 'repeat', dur: 6, dissolve: 0.4,
        title: 'Reproduce<br>any bug.',
        text: 'Pin a seed, get the same person.<br>See where every value came from.',
        seed: {at: 0.6, every: 0.12},
        debug: {at: 2.4}
    },
    {
        id: 'end', dur: 7, dissolve: 0.5,
        name: 'Fillsmith',
        line: 'Free AI form filler',
        cta: 'Add to Chrome — it’s free',
        url: 'chromewebstore.google.com'
    }
];

// Where each scene has said what it came to say: the frames `--stills` writes, one per scene.
export const KEY_FRAMES = {hook: 1.5, fill: 9.2, controls: 1.5, person: 4.6, ai: 4.75, repeat: 5.0, end: 3.5};
// The YouTube thumbnail: the filled form under the claim, in film seconds.
export const POSTER = {at: 12.0, w: 1280, h: 720};
/* The README's GIF, cut from the film. A GIF's frame delay is whole hundredths,
 * and browsers slow anything under two of them, so 50 fps is as smooth as it goes. */
export const GIF = {from: 4.45, to: 21.65, fps: 50, width: 880};

let at = 0;
for (const s of SCENES) {
    s.start = at;
    at += s.dur;
}
export const DURATION = at;
