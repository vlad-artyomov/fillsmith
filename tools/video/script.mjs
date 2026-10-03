/* The promo film's script: every word on screen and every timing, in one place.
 * Read by tools/video.mjs (how many frames, which fills to record) and by the
 * stage (what to show when). Times are seconds from the start of their scene.
 *
 * A scene that records a fill names a take: the page, and when the fill is
 * pressed. Its beats pin moments of that fill — named in the fill's own log —
 * to moments of the film, so a slow control can be dwelt on and a fast one
 * passed over. Between two beats the fill runs at whatever speed joins them.
 *
 * Every scene after the first starts on a bar of the music (MUSIC below), so a
 * scene's length is a whole number of bars, and the hook is the pickup.
 */

export const FPS = 60;
export const SIZE = {w: 1920, h: 1080};
/* The popup's panes are shown four times their size in a frame drawn at twice
 * its own, so they are captured at eight times theirs: pixel for pixel, never stretched. */
export const POPUP_SCALE = 8;

// The fill every take makes: one seed, so one person, in every scene.
export const FILL = {
    locale: 'en-US', seed: 'STORE1', useAI: true, overwrite: true, emailDomain: 'example.com', debugTab: true
};
// "Today", in the page and in the filler, so the calendar and every date in it come out the same.
export const EPOCH = '2026-10-05T10:00:00';
// How long the on-device model takes to answer a batch, in the fill's own time.
export const MODEL_MS = 1400;

/* How a scene arrives. `camera`: the window carries on from the scene before and
 * only the words change. `push`: the old scene leaves to the left and the new one
 * comes in from the right, the cut falling while both are moving. */
export const SCENES = [
    {
        id: 'hook', dur: 3,
        take: {page: 'form.html'},
        title: 'Still typing<br>test data?',
        // The junk stays in the field while the camera pulls back, and goes just before the press.
        typing: {field: 'requester', at: 0.3, text: 'asdf', every: 0.12, erase: 2.3}
    },
    {
        id: 'fill', dur: 8, enter: 'camera',
        title: 'Fill any form<br>in one click.',
        keys: {at: 0.05, press: 0.45, keys: ['Alt', 'Shift', 'F']},
        // When the camera moves in on the card, to read its verdict; the only time the film does.
        cardAt: 4.8,
        // The take carries on from the hook: the same page, pressed here, on the beat at 3.5 s.
        fillAt: 0.55,
        // The whole form in about four seconds: the product takes two, and this is the scene that says it is quick.
        beats: [
            ['field:Contact person', 0.75],
            ['field:Work email', 0.95],
            ['field:Office country', 1.15],
            ['open:1', 1.3],
            ['pick:1', 1.65],
            ['field:Go-live date', 1.8],
            ['open:2', 1.9],
            ['pick:2', 2.25],
            ['field:Internal ticket', 2.4],
            ['field:Screenshot', 2.55],
            ['file', 2.6],
            ['field:Needs sign-off before release', 2.8],
            ['field:Release notes', 2.95],
            ['improve', 3.15],
            ['ai:1', 3.75],
            ['ai:2', 3.9],
            ['toast', 4.4]
        ]
    },
    {
        id: 'controls', dur: 8, enter: 'push',
        take: {page: 'form.html', fillAt: 0.2},
        title: 'Even the<br>custom ones.',
        // One word each, kept on screen as a list: a sentence per close-up was gone before it could be read.
        shots: [
            {at: 0, on: 'country', text: 'Dropdowns'},
            {at: 2, on: 'golive', text: 'Date pickers'},
            {at: 4, on: 'screenshot', text: 'File uploads'},
            {at: 6, on: 'notes', text: 'Rich text'}
        ],
        beats: [
            ['field:Contact person', 0.3],
            ['field:Office country', 0.45],
            ['open:1', 0.8],
            ['pick:1', 1.65],
            ['field:Go-live date', 2.25],
            ['open:2', 2.6],
            ['pick:2', 3.65],
            ['field:Internal ticket', 4.2],
            ['field:Screenshot', 4.35],
            ['file', 4.8],
            ['field:Needs sign-off before release', 5.6],
            ['field:Release notes', 5.75],
            ['paste:1', 6.0],
            ['improve', 7.5]
        ]
    },
    {
        id: 'person', dur: 6, enter: 'push',
        take: {page: 'person.html', fillAt: 0.35},
        title: 'One believable<br>person.',
        text: 'Email from the name.<br>ZIP and phone from the city.',
        beats: [['field:Full name', 0.45], ['toast', 1.1]],
        // Which parts of which fields belong together, drawn in this order; each lands on a beat.
        ties: [
            {at: 1.25, from: ['name', 'Jennyfer Parisian'], to: ['email', 'jennyfer.parisian']},
            {at: 2.25, from: ['city', 'Philadelphia'], to: ['zip', '19103']},
            {at: 3.25, from: ['city', 'Philadelphia'], to: ['contactNumber', '(215)']}
        ]
    },
    {
        id: 'ai', dur: 6, enter: 'push',
        // Pressed a moment before the scene, so its first frame already shows the rules' work.
        take: {page: 'form.html', fillAt: -0.05},
        // The presses of a first pass that is over in a frame are not worth a ring each.
        rings: false,
        title: 'AI built into<br>Chrome.',
        text: 'No key. No bill.',
        pill: {at: 1.0},
        /* The payoff is the swap — the filler's word replaced by the model's — so the
         * scene ends on it, and opens on a form the rules have already filled: the
         * first pass is over by the second frame, before the window has slid in. */
        beats: [
            ['field:Release notes', 0],
            ['improve', 0.8],
            ['ai:1', 2.0],
            ['ai:2', 2.75],
            ['toast', 3.5]
        ]
    },
    {
        id: 'repeat', dur: 4, enter: 'push',
        title: 'Reproduce<br>any bug.',
        text: 'Same seed,<br>same person.',
        seed: {at: 0.4, every: 0.07},
        debug: {at: 1.3}
    },
    {
        id: 'end', dur: 6, enter: 'push',
        name: 'Fillsmith',
        line: 'Free AI form filler',
        cta: 'Add to Chrome — it’s free',
        // True wherever the film plays: beside the store's own button, on YouTube, on a phone that cannot install it.
        find: 'Search “Fillsmith” in the Chrome Web Store'
    }
];

// Where each scene has said what it came to say: the frames `--stills` writes, one per scene.
export const KEY_FRAMES = {hook: 1.0, fill: 6.6, controls: 1.4, person: 4.4, ai: 3.2, repeat: 2.6, end: 3.0};
// The YouTube thumbnail: the filled form under the claim, with the card's verdict, in film seconds.
export const POSTER = {at: 7.6, w: 1280, h: 720};
/* The README's GIF, cut from the film. A GIF's frame delay is whole hundredths,
 * and browsers slow anything under two of them, so 50 fps is as smooth as it goes. */
export const GIF = {from: 2.6, to: 18.65, fps: 50, width: 880};

/* A camera move is exposed for half a frame (a 180° shutter) and blurred over
 * that many samples; a frame where nothing moves is taken once. */
export const MOTION_BLUR = {samples: 10, shutter: 180};

/* The score, written by tools/video/score.mjs. 120 BPM puts a bar on every
 * other second; `offset` is where bar one falls, so every scene after the hook
 * starts on one. One chord a bar, in MIDI notes, round and round. */
export const MUSIC = {
    bpm: 120,
    offset: 1,
    chords: [
        [50, 57, 61, 64, 66],   // Dmaj9
        [47, 54, 57, 61, 62],   // Bm9
        [43, 50, 54, 57, 59],   // Gmaj9
        [45, 52, 59, 61, 64]    // A, suspended
    ],
    // How much of the band plays under each scene: pad, pluck, bass, drums, from 0 to 1.
    parts: {
        hook: {pad: 0.6, pluck: 0, bass: 0, drums: 0},
        fill: {pad: 1, pluck: 1, bass: 1, drums: 1},
        controls: {pad: 1, pluck: 1, bass: 1, drums: 1},
        person: {pad: 1, pluck: 0.8, bass: 0.5, drums: 0},
        ai: {pad: 1, pluck: 1, bass: 1, drums: 0.7},
        repeat: {pad: 1, pluck: 1, bass: 1, drums: 1},
        end: {pad: 1, pluck: 0.4, bass: 0.6, drums: 0}
    },
    // The mix, in integrated loudness: what YouTube plays everything at.
    lufs: -14
};

let at = 0;
for (const s of SCENES) {
    s.start = at;
    at += s.dur;
}
export const DURATION = at;
