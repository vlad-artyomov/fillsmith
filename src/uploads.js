/* FormForge — files for <input type="file">.
 *
 * Nothing is fetched and nothing is read from disk: the bytes are made here,
 * which is the only version of this that is safe to run on somebody else's
 * page. The kind of file follows the input's own `accept`.
 */
(function () {
  'use strict';

  const FILE_KINDS = [
    { re: /(^|,)\s*(image\/\*|image\/png|\.png)/i, ext: 'png', mime: 'image/png' },
    { re: /(image\/jpe?g|\.jpe?g)/i, ext: 'jpg', mime: 'image/jpeg' },
    { re: /(image\/svg|\.svg)/i, ext: 'svg', mime: 'image/svg+xml' },
    { re: /(application\/pdf|\.pdf)/i, ext: 'pdf', mime: 'application/pdf' },
    { re: /(text\/csv|\.csv)/i, ext: 'csv', mime: 'text/csv' },
    { re: /(application\/json|\.json)/i, ext: 'json', mime: 'application/json' },
    { re: /(text\/plain|\.txt)/i, ext: 'txt', mime: 'text/plain' }
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
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/([()\\])/g, '\\$1');
  }

  async function makeImage(kind, name, ink, persona, nth) {
    const w = 480, h = 320;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = ink;
    g.fillRect(0, 0, w, h);
    // Stacked translucent discs instead of a radial gradient: a smooth gradient takes the PNG from 7KB to 106KB.
    for (let i = 18; i > 0; i--) {
      g.fillStyle = 'rgba(255,255,255,.012)';
      g.beginPath();
      g.arc(w * 0.82, h * 0.12, w * 0.75 * i / 18, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#ffffff';
    g.font = '600 24px ui-sans-serif, system-ui, sans-serif';
    g.fillText('FormForge', 28, 62);
    g.globalAlpha = 0.82;
    g.font = '14px ui-sans-serif, system-ui, sans-serif';
    g.fillText(`seed ${persona.seed}${nth ? ` · file ${nth}` : ''}`, 28, 94);
    g.fillText(`${w}×${h} · ${kind.ext.toUpperCase()}`, 28, 118);
    g.globalAlpha = 1;
    const blob = await c.convertToBlob({ type: kind.mime });
    return new File([blob], name, { type: kind.mime });
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
    return new File([svg], name, { type: kind.mime });
  }

  // A minimal but genuinely valid single-page PDF; anything that looks inside rejects a fake one.
  function makePdf(kind, name, persona, stamp) {
    const lines = [
      ['FormForge test document', 18],
      [asciiish(persona.company), 11],
      [asciiish(`${persona.fullName} - ${persona.jobTitle}`), 11],
      [asciiish(`${persona.street}, ${persona.postal} ${persona.city}`), 11],
      [asciiish(stamp), 9]
    ].filter(([t]) => t);
    const body = lines.map(([t, size], i) => `BT /F1 ${size} Tf 40 ${292 - i * 26} Td (${t}) Tj ET`).join('\n');
    const text = `0.12 0.44 0.31 RG 1.5 w 40 276 m 380 276 l S\n${body}`;
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 340] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new File([pdf], name, { type: kind.mime });
  }

  async function makeFile(kind, name, persona, nth, key, rng) {
    const stamp = `FormForge test file · seed ${persona.seed}` +
      (nth ? ` · file ${nth}` : '') + ` · ${new Date().toISOString().slice(0, 10)}`;
    const ink = pickInk(key, rng);
    switch (kind.ext) {
      case 'png':
      case 'jpg': return makeImage(kind, name, ink, persona, nth);
      case 'svg': return makeSvg(kind, name, ink, persona, nth);
      case 'pdf': return makePdf(kind, name, persona, stamp);
      case 'csv': {
        const rows = [['id', 'name', 'email', 'city'],
          ['1', persona.fullName, persona.email, persona.city],
          ['2', persona.company, persona.emailAlt, persona.country]];
        return new File([`# ${stamp}\n` + rows.map(r => r.join(',')).join('\n') + '\n'], name, { type: kind.mime });
      }
      case 'json':
        return new File([JSON.stringify({ note: stamp, name: persona.fullName, email: persona.email, city: persona.city }, null, 2)],
          name, { type: kind.mime });
      default:
        return new File([`${stamp}\n\n${persona.paragraph}\n`], name, { type: kind.mime });
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
    for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true, composed: true }));
    return names || null;
  }

  globalThis.FormForgeUploads = { attachFiles, fileKindFor, IMAGE_COLOURS };
})();
