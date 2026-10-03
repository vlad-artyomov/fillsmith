/* The film's score, synthesised: no samples, no licence, the same file every run.
 *
 * A band of four — a pad, a plucked arpeggio, a bass, a soft kit — plays one
 * chord a bar at MUSIC.bpm, louder or quieter scene by scene (MUSIC.parts). On
 * top of it sit the sounds of the film itself, at the times the stage reports
 * (film.cues()): a key for every key, a tick for every field the filler writes
 * — pitched on the chord of the moment, rising as the form fills — a chime when
 * the model's answers land, a rush of air when a scene is pushed away.
 *
 * Loudness is the encoder's job (loudnorm, to MUSIC.lufs); this only keeps the
 * peaks under full scale.
 */

const SR = 48000;
const TAU = Math.PI * 2;

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Seeded noise, so the hats and the air are the same on every run.
function noise(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return ((s >>> 0) / 4294967296) * 2 - 1;
    };
}

// RBJ biquad; `at` may change per sample for a sweep.
function biquad(type) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x, f, q = 0.7) => {
        const w = TAU * Math.min(f, SR * 0.45) / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
        let b0, b1, b2;
        if (type === 'lp') [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
        else if (type === 'hp') [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
        else [b0, b1, b2] = [a, 0, -a];
        const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
        const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        return y;
    };
}

// Freeverb: eight damped combs and four allpasses a side, the right side a little wider.
function reverb(size = 0.84, damp = 0.25) {
    const scale = SR / 44100;
    const make = (spread) => {
        const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map(n => ({
            buf: new Float32Array(Math.round((n + spread) * scale)), i: 0, store: 0
        }));
        const alls = [556, 441, 341, 225].map(n => ({buf: new Float32Array(Math.round((n + spread) * scale)), i: 0}));
        return (x) => {
            let out = 0;
            for (const c of combs) {
                const y = c.buf[c.i];
                c.store = y * (1 - damp) + c.store * damp;
                c.buf[c.i] = x + c.store * size;
                c.i = (c.i + 1) % c.buf.length;
                out += y;
            }
            for (const a of alls) {
                const b = a.buf[a.i];
                a.buf[a.i] = out + b * 0.5;
                out = b - out;
                a.i = (a.i + 1) % a.buf.length;
            }
            return out * 0.015;
        };
    };
    return [make(0), make(23)];
}

export function renderScore({duration, cues, scenes, music}) {
    const n = Math.ceil((duration + 0.05) * SR);
    const L = new Float32Array(n), R = new Float32Array(n);
    const sendL = new Float32Array(n), sendR = new Float32Array(n);
    const beat = 60 / music.bpm, bar = beat * 4;

    const put = (i, l, r, send = 0) => {
        if (i < 0 || i >= n) return;
        L[i] += l;
        R[i] += r;
        sendL[i] += l * send;
        sendR[i] += r * send;
    };

    // How loud each part is at time t: the scene's level, eased across a quarter second either side of a cut.
    const level = (part, t) => {
        const at = (x) => {
            const s = scenes.find(sc => x < sc.start + sc.dur) || scenes[scenes.length - 1];
            return (music.parts[s.id] || {})[part] ?? 0;
        };
        let sum = 0;
        for (let k = -2; k <= 2; k++) sum += at(t + k * 0.125);
        return sum / 5;
    };
    const chordAt = (t) => {
        const b = Math.floor((t - music.offset) / bar);
        return music.chords[((b % music.chords.length) + music.chords.length) % music.chords.length];
    };
    const endScene = scenes[scenes.length - 1];

    // --- pad: one chord a bar, slow in and out, partials falling away like a soft filter.
    {
        const firstBar = Math.floor((0 - music.offset) / bar);
        const lastBar = Math.ceil((duration - music.offset) / bar);
        for (let b = firstBar; b < lastBar; b++) {
            const t0 = Math.max(0, music.offset + b * bar);
            // The last chord rings out over the end card instead of changing under it.
            if (t0 > endScene.start + 0.01) break;
            const holdTo = t0 >= endScene.start - 0.01 ? duration : music.offset + (b + 1) * bar;
            const chord = chordAt(t0 + 0.01);
            const i0 = Math.round(t0 * SR), i1 = Math.min(n, Math.round((holdTo + 1.2) * SR));
            chord.forEach((note, v) => {
                const f = hz(note + 12);
                const pan = (v / (chord.length - 1)) * 1.2 - 0.6;
                for (let i = i0; i < i1; i++) {
                    const t = i / SR, dt = t - t0;
                    const att = Math.min(1, dt / 0.7), rel = t > holdTo ? Math.max(0, 1 - (t - holdTo) / 1.2) : 1;
                    const env = att * att * (3 - 2 * att) * rel;
                    if (env <= 0) continue;
                    let s = 0;
                    for (let h = 1; h <= 5; h++) {
                        const amp = 1 / Math.pow(h, 1.7);
                        s += amp * (Math.sin(TAU * f * h * 1.0035 * t + v) + Math.sin(TAU * f * h * 0.9965 * t + h));
                    }
                    const g = s * env * 0.016 * level('pad', t) * (1 + 0.15 * Math.sin(TAU * 0.2 * t + v));
                    put(i, g * (1 - pan) * 0.7, g * (1 + pan) * 0.7, 0.55);
                }
            });
        }
    }

    // --- pluck: eighth notes up and down the chord, an octave up, with a dotted-eighth echo.
    {
        const step = beat / 2, pattern = [1, 2, 3, 4, 3, 2, 4, 1];
        const delayL = new Float32Array(Math.round(step * 1.5 * SR)), delayR = new Float32Array(delayL.length);
        const dry = new Float32Array(n * 2);
        for (let k = 0; ; k++) {
            const t0 = music.offset + k * step;
            if (t0 >= duration) break;
            const lv = level('pluck', t0);
            if (lv <= 0.01) continue;
            const chord = chordAt(t0 + 0.001);
            const note = chord[pattern[k % pattern.length]] + 24;
            const f = hz(note), pan = (k % 2 ? 0.35 : -0.35);
            const accent = k % 4 === 0 ? 1 : 0.7;
            const i0 = Math.round(t0 * SR), len = Math.round(0.9 * SR);
            for (let j = 0; j < len && i0 + j < n; j++) {
                const t = j / SR;
                const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.16);
                const s = (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t) + 0.08 * Math.sin(TAU * 3 * f * t)) * env;
                const g = s * 0.045 * lv * accent;
                dry[(i0 + j) * 2] += g * (1 - pan);
                dry[(i0 + j) * 2 + 1] += g * (1 + pan);
            }
        }
        let di = 0;
        for (let i = 0; i < n; i++) {
            const l = dry[i * 2], r = dry[i * 2 + 1];
            const el = delayL[di], er = delayR[di];
            // Ping-pong: each side's echo feeds the other.
            delayL[di] = r + er * 0.32;
            delayR[di] = l + el * 0.32;
            di = (di + 1) % delayL.length;
            put(i, l + el * 0.3, r + er * 0.3, 0.35);
        }
    }

    // --- bass: the root, two octaves down, on beats one and three.
    {
        for (let k = 0; ; k++) {
            const t0 = music.offset + k * beat * 2;
            if (t0 >= duration) break;
            const lv = level('bass', t0);
            if (lv <= 0.01) continue;
            const f = hz(chordAt(t0 + 0.001)[0] - 12);
            const i0 = Math.round(t0 * SR), len = Math.round(beat * 2 * SR);
            for (let j = 0; j < len && i0 + j < n; j++) {
                const t = j / SR;
                // A plucked note, not a held one: a bass that sustains under every bar is a drone that eats the middle.
                const env = Math.min(1, t / 0.006) * (0.2 + 0.8 * Math.exp(-t / 0.18)) * Math.min(1, (len - j) / (0.05 * SR));
                const s = Math.tanh(1.4 * (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * 2 * f * t))) * env;
                put(i0 + j, s * 0.06 * lv, s * 0.06 * lv);
            }
        }
    }

    // --- kit: a soft kick on one and three, a clap on two and four, hats on the off-beats.
    {
        const rnd = noise(17);
        const hp = [biquad('hp'), biquad('hp')], bp = biquad('bp');
        for (let k = 0; ; k++) {
            const t0 = music.offset + k * beat / 2;
            if (t0 >= duration) break;
            const lv = level('drums', t0);
            if (lv <= 0.01) continue;
            const i0 = Math.round(t0 * SR);
            const onBeat = k % 2 === 0, which = (k / 2) % 4;
            if (onBeat && (which === 0 || which === 2)) {
                for (let j = 0; j < 0.45 * SR; j++) {
                    const t = j / SR;
                    const ph = TAU * (45 * t + 80 * 0.045 * (1 - Math.exp(-t / 0.045)));
                    const s = Math.sin(ph) * Math.exp(-t / 0.22) * Math.min(1, t / 0.002);
                    put(i0 + j, s * 0.14 * lv, s * 0.14 * lv);
                }
            }
            if (onBeat && (which === 1 || which === 3)) {
                for (let j = 0; j < 0.3 * SR; j++) {
                    const t = j / SR;
                    const s = bp(rnd(), 1500, 0.9) * Math.exp(-t / 0.07) * Math.min(1, t / 0.001);
                    put(i0 + j, s * 0.11 * lv, s * 0.11 * lv, 0.4);
                }
            }
            if (!onBeat) {
                for (let j = 0; j < 0.08 * SR; j++) {
                    const t = j / SR;
                    const s = hp[1](hp[0](rnd(), 7000), 7000) * Math.exp(-t / 0.025);
                    put(i0 + j, s * 0.035 * lv, s * 0.05 * lv);
                }
            }
        }
    }

    // --- into the end card: air rising for a bar, then one low, wide hit.
    {
        const rnd = noise(91), lp = biquad('lp'), hp = biquad('hp');
        const tEnd = endScene.start, i0 = Math.round((tEnd - bar) * SR), i1 = Math.round(tEnd * SR);
        for (let i = Math.max(0, i0); i < i1; i++) {
            const k = (i - i0) / (i1 - i0);
            const s = hp(lp(rnd(), 400 + 6000 * k * k), 200) * k * k * 0.06;
            put(i, s * (1 - k * 0.5), s * (0.5 + k * 0.5), 0.5);
        }
        for (let j = 0; j < 2.5 * SR; j++) {
            const t = j / SR;
            const s = Math.sin(TAU * (38 * t + 30 * 0.08 * (1 - Math.exp(-t / 0.08)))) * Math.exp(-t / 0.9) * Math.min(1, t / 0.004);
            put(i1 + j, s * 0.18, s * 0.18, 0.6);
        }
    }

    // --- the film's own sounds, under the music.
    {
        const rnd = noise(5);
        let rising = 0, lastField = -10;
        const tone = (i0, f, dur, amp, pan = 0, send = 0.3, partials = [1, 0.15]) => {
            for (let j = 0; j < dur * SR; j++) {
                const t = j / SR;
                const env = Math.min(1, t / 0.002) * Math.exp(-t / (dur / 4));
                let s = 0;
                partials.forEach((a, h) => {
                    s += a * Math.sin(TAU * f * (h + 1) * t);
                });
                put(i0 + j, s * env * amp * (1 - pan), s * env * amp * (1 + pan), send);
            }
        };
        const burst = (i0, f, dur, amp, pan = 0) => {
            const bp = biquad('bp');
            for (let j = 0; j < dur * SR; j++) {
                const t = j / SR;
                const s = bp(rnd(), f, 1.2) * Math.exp(-t / (dur / 5)) * amp;
                put(i0 + j, s * (1 - pan), s * (1 + pan));
            }
        };
        for (const c of cues) {
            const i0 = Math.round(c.t * SR);
            const chord = chordAt(c.t);
            switch (c.kind) {
                case 'key':
                    burst(i0, 3200, 0.03, 0.12, 0.1);
                    tone(i0, 1800, 0.02, 0.01, 0, 0);
                    break;
                case 'cap':
                    burst(i0, 900, 0.06, 0.2);
                    tone(i0, 220, 0.08, 0.04, 0, 0);
                    break;
                case 'press':
                    tone(i0, 2400, 0.04, 0.025, 0.2, 0.1);
                    break;
                case 'field': {
                    // Each field a step up the chord; a pause long enough starts the run again.
                    if (c.t - lastField > 1.5) rising = 0;
                    lastField = c.t;
                    const up = chord.slice(1);
                    const note = up[rising % up.length] + 24 + 12 * Math.floor(rising / up.length);
                    rising++;
                    tone(i0, hz(Math.min(note, 100)), 0.35, 0.03, (rising % 2 ? 0.25 : -0.25), 0.4);
                    break;
                }
                case 'ai':
                    tone(i0, hz(chord[1] + 36), 1.4, 0.035, -0.2, 0.7, [1, 0.3, 0.1]);
                    tone(i0 + Math.round(0.09 * SR), hz(chord[3] + 36), 1.4, 0.03, 0.2, 0.7, [1, 0.3]);
                    break;
                case 'pop':
                    for (let j = 0; j < 0.09 * SR; j++) {
                        const t = j / SR;
                        const s = Math.sin(TAU * (400 * t + 3000 * t * t)) * Math.exp(-t / 0.03);
                        put(i0 + j, s * 0.05, s * 0.05, 0.3);
                    }
                    break;
                case 'done':
                    tone(i0, hz(chord[0] + 36), 1.6, 0.03, -0.15, 0.7, [1, 0.25]);
                    tone(i0 + Math.round(0.12 * SR), hz(chord[2] + 36), 1.6, 0.03, 0.15, 0.7, [1, 0.25]);
                    break;
                case 'tie':
                    tone(i0, hz(chord[4] + 24), 0.5, 0.02, 0, 0.5);
                    break;
                case 'whoosh': {
                    // Air that passes right to left, peaking on the cut, as the scenes do.
                    const bp = biquad('bp'), a = Math.round((c.t - 0.35) * SR), len = Math.round(0.65 * SR);
                    for (let j = 0; j < len; j++) {
                        const k = j / len, shape = Math.sin(Math.PI * Math.pow(k, 0.8));
                        const s = bp(rnd(), 300 + 2600 * shape, 0.8) * shape * shape * 0.07;
                        put(a + j, s * (0.3 + k), s * (1.3 - k), 0.3);
                    }
                    break;
                }
                case 'swell': {
                    const lp = biquad('lp'), len = Math.round(1.0 * SR);
                    for (let j = 0; j < len; j++) {
                        const k = j / len, shape = Math.sin(Math.PI * k);
                        const s = lp(rnd(), 300 + 1500 * k) * shape * 0.035;
                        put(i0 + j, s, s, 0.6);
                    }
                    break;
                }
            }
        }
    }

    // --- room, fades, and the peaks held under full scale.
    const [rvL, rvR] = reverb();
    const fadeIn = 0.2 * SR, fadeOut = 2.0 * SR;
    let peak = 0;
    for (let i = 0; i < n; i++) {
        let l = L[i] + rvL(sendL[i] + sendR[i] * 0.3) * 1.0;
        let r = R[i] + rvR(sendR[i] + sendL[i] * 0.3) * 1.0;
        const g = Math.min(1, i / fadeIn, (n - i) / fadeOut);
        l = Math.tanh(l * g * 1.4) / 1.4;
        r = Math.tanh(r * g * 1.4) / 1.4;
        L[i] = l;
        R[i] = r;
        peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }
    return {L, R, peak, sampleRate: SR};
}

// 32-bit float WAV: what ffmpeg reads without a second thought.
export function wav({L, R, sampleRate}) {
    const n = L.length, bytes = n * 8;
    const b = Buffer.alloc(44 + bytes);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + bytes, 4);
    b.write('WAVE', 8);
    b.write('fmt ', 12);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(3, 20);
    b.writeUInt16LE(2, 22);
    b.writeUInt32LE(sampleRate, 24);
    b.writeUInt32LE(sampleRate * 8, 28);
    b.writeUInt16LE(8, 32);
    b.writeUInt16LE(32, 34);
    b.write('data', 36);
    b.writeUInt32LE(bytes, 40);
    for (let i = 0; i < n; i++) {
        b.writeFloatLE(L[i], 44 + i * 8);
        b.writeFloatLE(R[i], 48 + i * 8);
    }
    return b;
}
