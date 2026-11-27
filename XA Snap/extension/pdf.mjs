import { fillTemplate } from './data.mjs';

const paper = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a3: [841.89, 1190.55] };
const encoder = new TextEncoder();
const point = value => Number(value.toFixed(3));
const literal = value => '(' + String(value).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&') + ')';
const MAX_PAGE = 14400;

function documentWriter() {
  const objects = [];
  const bytes = value => typeof value === 'string' ? encoder.encode(value) : value;
  function finish(root) {
    const header = bytes('%PDF-1.7\n');
    const parts = [header];
    const offsets = [0];
    let size = header.length;
    for (const [index, body] of objects.entries()) {
      if (!body) throw new Error('PDF contains an incomplete object.');
      offsets.push(size);
      const object = [bytes((index + 1) + ' 0 obj\n'), ...body.map(bytes), bytes('\nendobj\n')];
      parts.push(...object);
      size += object.reduce((sum, part) => sum + part.length, 0);
    }
    const directory = offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    parts.push(bytes('xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + directory +
      'trailer\n<< /Size ' + offsets.length + ' /Root ' + root + ' 0 R >>\nstartxref\n' + size + '\n%%EOF\n'));
    return new Blob(parts, { type: 'application/pdf' });
  }
  function add(...body) {
    return objects.push(body.length ? body : null);
  }
  function set(id, ...body) {
    objects[id - 1] = body;
  }
  function stream(dictionary, data) {
    const body = bytes(data);
    return add('<< /Length ' + body.length + ' ' + dictionary + ' >>\nstream\n', body, '\nendstream');
  }
  return { add, set, stream, finish };
}

function pagePlan(entry, settings) {
  const margin = Math.min(144, Math.max(0, Number(settings.pdfMargin) || 0));
  let dimensions = paper[settings.pdfSize];
  if (settings.pdfSize === 'custom') {
    const width = Math.max(72, Math.min(MAX_PAGE, Number(settings.pdfWidth) || 595));
    const height = Math.max(72, Math.min(MAX_PAGE, Number(settings.pdfHeight) || 842));
    dimensions = [width, height];
  }
  if (!dimensions) {
    const scale = Math.min(0.75, (MAX_PAGE - margin * 2) / Math.max(entry.width, entry.height));
    return [{ start: 0, end: entry.height, width: entry.width * scale + margin * 2, height: entry.height * scale + margin * 2, scale, margin }];
  }
  const [width, height] = settings.pdfOrientation === 'landscape' ? [...dimensions].reverse() : dimensions;
  const inset = Math.min(margin, (Math.min(width, height) - 24) / 2);
  const scale = (width - inset * 2) / entry.width;
  const tile = Math.max(1, Math.floor((height - inset * 2) / scale));
  const pages = [];
  for (let start = 0; start < entry.height;) {
    let end = Math.min(entry.height, start + tile);
    if (settings.pdfSmart && end < entry.height) {
      const lines = (entry.text || []).filter(box => box.y >= start + tile * 0.83 && box.y < end + 1);
      let cutoff = end;
      for (let attempt = 0; attempt < 30; attempt++) {
        const crossing = lines.filter(box => box.y < cutoff && box.y + box.height > cutoff);
        if (!crossing.length) break;
        cutoff = Math.floor(Math.min(...crossing.map(box => box.y)));
      }
      if (cutoff > start + tile * 0.83) end = cutoff;
    }
    pages.push({ start, end, width, height, scale, margin: inset });
    if (pages.length > 300) throw new Error('This PDF would exceed 300 pages. Select Fit to image or choose a larger paper size.');
    start = end;
  }
  return pages;
}

function positionOnPage(box, page) {
  const y = Math.max(box.y, page.start);
  const bottom = Math.min(box.y + box.height, page.end);
  if (bottom <= y) return null;
  const x = page.margin + box.x * page.scale;
  return [point(x), point(page.height - page.margin - (bottom - page.start) * page.scale),
    point(x + box.width * page.scale), point(page.height - page.margin - (y - page.start) * page.scale)];
}

async function jpegTile(bitmap, page) {
  const width = bitmap.width;
  const height = page.end - page.start;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, page.start, width, height, 0, 0, width, height);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer());
}

function pdfText(value, x, y, size, rendering = 0, color = '0 g', width = 0) {
  const scaling = width ? Math.max(5, Math.min(800, width / (String(value).length * size * 0.52) * 100)) : 100;
  return 'BT ' + color + ' /F1 ' + point(size) + ' Tf ' + rendering + ' Tr ' + point(scaling) +
    ' Tz 1 0 0 1 ' + point(x) + ' ' + point(y) + ' Tm ' + literal(value) + ' Tj ET\n';
}

export async function makePDF(entries, settings) {
  if (!entries.length) throw new Error('Choose at least one screenshot.');
  const plan = entries.map(entry => pagePlan(entry, settings));
  const total = plan.reduce((sum, pages) => sum + pages.length, 0);
  const pdf = documentWriter();
  const root = pdf.add();
  const pages = pdf.add();
  const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const ids = [];
  for (const [index, entry] of entries.entries()) {
    const bitmap = await createImageBitmap(entry.image);
    try {
      for (const page of plan[index]) {
        const { margin, width, height, scale, start, end } = page;
        const image = pdf.stream('/Type /XObject /Subtype /Image /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Width ' +
          bitmap.width + ' /Height ' + (end - start), await jpegTile(bitmap, page));
        const imageHeight = (end - start) * scale;
        const values = { page: ids.length + 1, pages: total };
        let body = 'q ' + point(entry.width * scale) + ' 0 0 ' + point(imageHeight) + ' ' + point(margin) + ' ' +
          point(height - margin - imageHeight) + ' cm /I1 Do Q\n';
        if (settings.pdfText) {
          for (const word of entry.text || []) {
            const rect = positionOnPage(word, page);
            if (word.y >= start && rect && word.value) body += pdfText(word.value, rect[0], rect[1], Math.max(1, (rect[3] - rect[1]) * 0.82), 3, '0 g', rect[2] - rect[0]);
          }
        }
        if (settings.pdfHeader) body += pdfText(fillTemplate(settings.pdfHeader, entry, values), margin, height - Math.max(10, margin * 0.72), 9);
        if (settings.pdfFooter) body += pdfText(fillTemplate(settings.pdfFooter, entry, values), margin, Math.max(3, margin * 0.38), 9);
        if (settings.pdfWatermark) {
          body += 'q /Watermark gs\n' + pdfText(fillTemplate(settings.pdfWatermark, entry, values), margin + 12, height / 2, 24, 0, '0.28 g') + 'Q\n';
        }
        const annotations = [];
        if (settings.pdfLinks) {
          for (const link of entry.links || []) {
            const rect = positionOnPage(link, page);
            if (rect && /^https?:/i.test(link.url)) {
              annotations.push(pdf.add('<< /Type /Annot /Subtype /Link /Rect [' + rect.join(' ') + '] /Border [0 0 0]' +
                ' /A << /S /URI /URI ' + literal(link.url) + ' >> >>'));
            }
          }
        }
        const content = pdf.stream('', body);
        ids.push(pdf.add('<< /Type /Page /Parent ' + pages + ' 0 R /MediaBox [0 0 ' + point(width) + ' ' + point(height) +
          '] /Resources << /Font << /F1 ' + font + ' 0 R >> /XObject << /I1 ' + image +
          ' 0 R >> /ExtGState << /Watermark << /Type /ExtGState /ca 0.35 >> >> >> /Contents ' + content +
          ' 0 R /Annots [' + annotations.map(id => id + ' 0 R').join(' ') + '] >>'));
      }
    } finally { bitmap.close(); }
  }
  pdf.set(pages, '<< /Type /Pages /Count ' + ids.length + ' /Kids [' + ids.map(id => id + ' 0 R').join(' ') + '] >>');
  pdf.set(root, '<< /Type /Catalog /Pages ' + pages + ' 0 R >>');
  return pdf.finish(root);
}

