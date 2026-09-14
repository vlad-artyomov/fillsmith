/* FormForge — files for <input type="file">.
 *
 * Nothing is fetched and nothing is read from disk: the bytes are made here,
 * which is the only version of this that is safe to run on somebody else's
 * page. The kind of file follows the input's own `accept`.
 */
(function () {
    'use strict';

    const FILE_KINDS = [
        {re: /(^|,)\s*(image\/\*|image\/png|\.png)/i, ext: 'png', mime: 'image/png'},
        {re: /(image\/jpe?g|\.jpe?g)/i, ext: 'jpg', mime: 'image/jpeg'},
        {re: /(image\/svg|\.svg)/i, ext: 'svg', mime: 'image/svg+xml'},
        {re: /(application\/pdf|\.pdf)/i, ext: 'pdf', mime: 'application/pdf'},
        {re: /(text\/csv|\.csv)/i, ext: 'csv', mime: 'text/csv'},
        {re: /(application\/json|\.json)/i, ext: 'json', mime: 'application/json'},
        {re: /(text\/plain|\.txt)/i, ext: 'txt', mime: 'text/plain'}
    ];

    function fileKindFor(accept) {
        const a = String(accept || '').trim();
        if (!a) return FILE_KINDS[0];                 // a PNG is accepted nearly everywhere
        return FILE_KINDS.find(k => k.re.test(a)) || FILE_KINDS[0];
    }

    /* Image backgrounds. Every entry is dark enough for white text (the lightest
     * is 6.1:1 against white), and two files in a row never share a colour — two
     * identical attachments look like one, and are dropped by uploaders that
     * deduplicate by hash. */
    const IMAGE_COLOURS = [
        '#1f6f4f', '#1d5b6e', '#2f4858', '#3c4270', '#4a4063',
        '#5e3a55', '#6b3450', '#7a4038', '#8a4b32', '#7a5a1e',
        '#4a5a2a', '#2f5540', '#243a5e', '#5f4030', '#3a4a55'
    ];
    const lastInkFor = new Map();
    let lastInk = -1;

    function pickInk(key, rng) {
        const avoid = new Set([lastInk, lastInkFor.get(key)]);
        let i = Math.floor(rng() * IMAGE_COLOURS.length);
        for (let n = 0; n < IMAGE_COLOURS.length && avoid.has(i); n++) i = (i + 1) % IMAGE_COLOURS.length;
        lastInk = i;
        if (key) lastInkFor.set(key, i);
        return IMAGE_COLOURS[i];
    }

    // PDF text is Helvetica in WinAnsi, so non-ASCII is transliterated rather than mangled.
    function asciiish(s) {
        return String(s)
            .replace(/[äÄ]/g, m => m === 'ä' ? 'ae' : 'Ae')
            .replace(/[öÖ]/g, m => m === 'ö' ? 'oe' : 'Oe')
            .replace(/[üÜ]/g, m => m === 'ü' ? 'ue' : 'Ue')
            .replace(/ß/g, 'ss')
            .replace(/\s*[·•]\s*/g, ' - ')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\x20-\x7e]/g, '')
            .replace(/([()\\])/g, '\\$1');
    }

    // The ink lightened or darkened, so a composition needs one palette entry, not a second list.
    function shade(hex, amount) {
        const n = parseInt(hex.slice(1), 16);
        const mix = (v) => Math.max(0, Math.min(255, Math.round(v + (amount > 0 ? (255 - v) * amount : v * amount))));
        return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
    }

    /* A placeholder picture that reads as a picture: a flat ground, a few large
     * translucent shapes, the company as the caption. Flat regions keep a PNG at
     * 1200×800 well under the size a form refuses; a gradient would not. The
     * bottom-left corner stays the bare ground so a check can read the colour. */
    async function makeImage(kind, name, ink, persona, nth, rng) {
        const w = 1200, h = 800;
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = ink;
        g.fillRect(0, 0, w, h);

        const r = () => (rng ? rng() : Math.random());
        g.fillStyle = shade(ink, 0.22);
        g.beginPath();
        g.arc(w * (0.68 + r() * 0.12), h * (0.28 + r() * 0.14), h * (0.36 + r() * 0.1), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = shade(ink, -0.28);
        g.beginPath();
        g.arc(w * (0.86 + r() * 0.06), h * (0.72 + r() * 0.1), h * (0.18 + r() * 0.08), 0, Math.PI * 2);
        g.fill();
        g.save();
        g.translate(w * 0.5, h * 0.5);
        g.rotate(-Math.PI / 5);
        g.fillStyle = shade(ink, 0.1);
        g.fillRect(-w, h * (0.02 + r() * 0.1), w * 2, 44);
        g.restore();
        g.fillStyle = shade(ink, 0.45);
        for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) {
            g.beginPath();
            g.arc(w * 0.06 + x * 26, h * 0.1 + y * 26, 3, 0, Math.PI * 2);
            g.fill();
        }

        const title = String(persona.company || 'FormForge');
        g.fillStyle = '#ffffff';
        g.font = '600 56px ui-sans-serif, system-ui, -apple-system, sans-serif';
        g.fillText(title.length > 26 ? title.slice(0, 25) + '…' : title, 72, h - 148);
        g.globalAlpha = 0.85;
        g.font = '500 22px ui-sans-serif, system-ui, -apple-system, sans-serif';
        g.fillText(`FormForge test image · seed ${persona.seed}${nth ? ` · file ${nth}` : ''}`, 72, h - 104);
        g.globalAlpha = 0.6;
        g.font = '18px ui-sans-serif, system-ui, -apple-system, sans-serif';
        g.fillText(`${w} × ${h} · ${kind.ext.toUpperCase()} · ${new Date().toISOString().slice(0, 10)}`, 72, h - 72);
        g.globalAlpha = 1;
        const blob = await c.convertToBlob(kind.mime === 'image/jpeg' ? {
            type: kind.mime,
            quality: 0.9
        } : {type: kind.mime});
        return new File([blob], name, {type: kind.mime});
    }

    function makeSvg(kind, name, ink, persona, nth) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">` +
            `<defs><radialGradient id="w" cx="82%" cy="12%" r="70%">` +
            `<stop offset="0" stop-color="#fff" stop-opacity=".16"/>` +
            `<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
            `<rect width="480" height="320" fill="${ink}"/>` +
            `<rect width="480" height="320" fill="url(#w)"/>` +
            `<text x="28" y="62" fill="#fff" font-family="sans-serif" font-size="24" font-weight="600">FormForge</text>` +
            `<text x="28" y="94" fill="#fff" fill-opacity=".82" font-family="sans-serif" font-size="14">` +
            `seed ${persona.seed}${nth ? ` · file ${nth}` : ''}</text></svg>`;
        return new File([svg], name, {type: kind.mime});
    }

    /* A genuinely valid one-page A4 PDF that reads as a document: header, a
     * block of details, a paragraph or two, a small table, a footer. Only the
     * standard Helvetica faces, so nothing is embedded; a viewer that looks
     * inside finds a real page, not a stub. */
    const PDF = {w: 595, h: 842, margin: 56};

    // Greedy wrap on Helvetica's average advance; a little pessimistic, so no line runs into the margin.
    function wrapText(text, size, width) {
        const perLine = Math.max(10, Math.floor(width / (size * 0.5)));
        const out = [];
        let line = '';
        for (const word of String(text).split(/\s+/).filter(Boolean)) {
            if ((line + ' ' + word).trim().length > perLine && line) {
                out.push(line);
                line = word;
            } else line = (line + ' ' + word).trim();
        }
        if (line) out.push(line);
        return out;
    }

    function makePdf(kind, name, persona, stamp, nth) {
        const {w, h, margin} = PDF;
        const right = w - margin;
        const ops = [];
        const text = (str, x, y, size, bold, grey) => {
            ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${grey ? '0.42 0.45 0.5 rg' : '0.1 0.12 0.14 rg'} ${x.toFixed(1)} ${y.toFixed(1)} Td (${asciiish(str)}) Tj ET`);
        };
        const rule = (y, light) => ops.push(`${light ? '0.82 0.84 0.87' : '0.12 0.44 0.31'} RG ${light ? 0.6 : 1.4} w ${margin} ${y} m ${right} ${y} l S`);
        const textWidth = (str, size) => asciiish(str).length * size * 0.5;

        let y = h - margin;
        text(persona.company || 'FormForge', margin, y - 14, 18, true);
        const date = new Date().toISOString().slice(0, 10);
        text(date, right - textWidth(date, 10), y - 12, 10, false, true);
        rule(y - 26);

        y -= 78;
        text(nth ? `Test document ${nth}` : 'Test document', margin, y, 26, true);
        y -= 22;
        text(`Prepared for ${persona.fullName}`, margin, y, 11, false, true);

        y -= 40;
        const rows = [
            ['Name', persona.fullName], ['Position', persona.jobTitle], ['Company', persona.company],
            ['Address', `${persona.street}, ${persona.postal} ${persona.city}`], ['E-mail', persona.email], ['Phone', persona.phone]
        ].filter(([, v]) => v);
        for (const [k, v] of rows) {
            text(k, margin, y, 10, true, true);
            text(v, margin + 92, y, 10.5);
            y -= 17;
        }

        y -= 18;
        for (const para of [persona.paragraph, persona.sentence].filter(Boolean)) {
            for (const line of wrapText(para, 11, right - margin)) {
                text(line, margin, y, 11);
                y -= 16;
            }
            y -= 10;
        }

        y -= 8;
        const table = [['Item', 'Reference', 'Amount'], ['Test position 1', `${persona.seed}-01`, persona.amount || '1.00'],
            ['Test position 2', `${persona.seed}-02`, persona.quantity != null ? String(persona.quantity) : '2']];
        table.forEach((cells, i) => {
            if (i === 0) rule(y + 12, true);
            text(cells[0], margin, y, 10.5, i === 0);
            text(cells[1], margin + 220, y, 10.5, i === 0);
            text(String(cells[2]), right - textWidth(String(cells[2]), 10.5), y, 10.5, i === 0);
            rule(y - 6, true);
            y -= 20;
        });

        rule(margin + 30, true);
        text(stamp, margin, margin + 16, 8.5, false, true);
        const pageNo = 'Page 1 of 1';
        text(pageNo, right - textWidth(pageNo, 8.5), margin + 16, 8.5, false, true);

        const content = ops.join('\n');
        const objs = [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
            `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
        ];
        let pdf = '%PDF-1.4\n';
        const offsets = [0];
        objs.forEach((o, i) => {
            offsets.push(pdf.length);
            pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
        });
        const xref = pdf.length;
        pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
        for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
        pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        return new File([pdf], name, {type: kind.mime});
    }

    async function makeFile(kind, name, persona, nth, key, rng) {
        const stamp = `FormForge test file · seed ${persona.seed}` +
            (nth ? ` · file ${nth}` : '') + ` · ${new Date().toISOString().slice(0, 10)}`;
        const ink = pickInk(key, rng);
        switch (kind.ext) {
            case 'png':
            case 'jpg':
                return makeImage(kind, name, ink, persona, nth, rng);
            case 'svg':
                return makeSvg(kind, name, ink, persona, nth);
            case 'pdf':
                return makePdf(kind, name, persona, stamp, nth);
            case 'csv': {
                const rows = [['id', 'name', 'email', 'city'],
                    ['1', persona.fullName, persona.email, persona.city],
                    ['2', persona.company, persona.emailAlt, persona.country]];
                return new File([`# ${stamp}\n` + rows.map(r => r.join(',')).join('\n') + '\n'], name, {type: kind.mime});
            }
            case 'json':
                return new File([JSON.stringify({
                        note: stamp,
                        name: persona.fullName,
                        email: persona.email,
                        city: persona.city
                    }, null, 2)],
                    name, {type: kind.mime});
            default:
                return new File([`${stamp}\n\n${persona.paragraph}\n`], name, {type: kind.mime});
        }
    }

    /* Put generated files into a file input. `input.files` is settable only
     * through a DataTransfer; `input` then `change` is the pair Chrome fires when
     * a person picks files. Returns the file names, or null. */
    async function attachFiles(el, persona, key, rng) {
        const kind = fileKindFor(el.getAttribute('accept'));
        const base = `formforge-${String(persona.seed).toLowerCase()}`;
        const want = el.multiple ? 2 : 1;
        const dt = new DataTransfer();
        for (let i = 0; i < want; i++) {
            const name = `${base}${want > 1 ? '-' + (i + 1) : ''}.${kind.ext}`;
            dt.items.add(await makeFile(kind, name, persona, want > 1 ? i + 1 : 0, key, rng || Math.random));
        }
        el.files = dt.files;
        const names = Array.from(el.files).map(x => x.name).join(', ');
        for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, {bubbles: true, composed: true}));
        return names || null;
    }

    globalThis.FormForgeUploads = {attachFiles, fileKindFor, IMAGE_COLOURS};
})();
