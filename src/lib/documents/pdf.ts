export interface PdfCheck {
  status: 'passed' | 'failed';
  signature: boolean;
  eofMarker: boolean;
  pageCount: number;
  maxPages: number;
  textLayerPresent: boolean;
  layoutWithinPage: boolean;
  visibleLineCount: number;
  issues: string[];
}

export interface CompiledPdf {
  buffer: Buffer;
  check: PdfCheck;
}

function toPdfText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^\x20-\x7e]/gu, '?');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (word.length > width) {
      if (line) lines.push(line);
      for (let offset = 0; offset < word.length; offset += width) {
        const piece = word.slice(offset, offset + width);
        if (piece.length === width) lines.push(piece);
        else line = piece;
      }
      continue;
    }
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function visibleLines(markdown: string): string[] {
  const result: string[] = [];
  for (const rawLine of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    const clean = toPdfText(rawLine)
      .replace(/^\s{0,3}#{1,6}\s*/u, '')
      .replace(/^\s*[-*+]\s+/u, '- ')
      .replace(/\*\*(.*?)\*\*/gu, '$1')
      .replace(/`([^`]*)`/gu, '$1')
      .replace(/[\t ]+/gu, ' ')
      .trim();
    if (!clean) {
      result.push('');
      continue;
    }
    result.push(...wrap(clean, 88));
  }
  while (result.at(-1) === '') result.pop();
  return result;
}

function escapeLiteral(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
}

function buildPdf(lines: string[]): Buffer {
  const linesPerPage = 52;
  const pageCount = Math.max(1, Math.ceil(lines.length / linesPerPage));
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  const textObjectIds: number[] = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageLines = lines.slice(pageIndex * linesPerPage, (pageIndex + 1) * linesPerPage);
    const commands = [
      'BT',
      '/F1 10 Tf',
      '50 790 Td',
      '14 TL',
      ...pageLines.flatMap((line) => [`(${escapeLiteral(line)}) Tj`, 'T*']),
      'ET',
    ].join('\n');
    const stream = `${commands}\n`;
    const textId = add(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${textId} 0 R >>`);
    textObjectIds.push(textId);
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;

  let output = '%PDF-1.4\n% AJSA local PDF compiler\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  // Catch accidental regressions where text gets converted to vector outlines
  // or omitted while the PDF header still looks valid.
  if (!textObjectIds.length || !output.includes(' Tj')) {
    throw new Error('PDF_TEXT_LAYER_MISSING');
  }
  return Buffer.from(output, 'ascii');
}

/** A dependency-free, offline PDF renderer. It never loads fonts, files, URLs, or plugins. */
export function compileTextPdf(markdown: string, maxPages: number): CompiledPdf {
  if (!markdown.trim() || markdown.length > 20_000) {
    throw new Error('PDF_INPUT_INVALID');
  }
  const lines = visibleLines(markdown);
  const pageCount = Math.max(1, Math.ceil(lines.length / 52));
  const buffer = buildPdf(lines);
  const pdfText = buffer.toString('ascii');
  const expectedLines = lines.filter(Boolean);
  const textLayerPresent = expectedLines.length > 0 && expectedLines.every((line) =>
    pdfText.includes(`(${escapeLiteral(line)}) Tj`),
  );
  const signature = buffer.subarray(0, 8).toString('ascii') === '%PDF-1.4';
  const eofMarker = pdfText.endsWith('%%EOF');
  const actualPageCount = [...pdfText.matchAll(/\/Type \/Page\b/gu)].length;
  const layoutWithinPage = lines.every((line) => line.length <= 88) && actualPageCount <= maxPages;
  const issues: string[] = [];
  if (!signature || !eofMarker) issues.push('pdf_structure_invalid');
  if (!textLayerPresent) issues.push('text_layer_missing');
  if (!layoutWithinPage) issues.push('layout_or_page_limit_failed');
  if (actualPageCount !== pageCount) issues.push('page_count_mismatch');
  if (actualPageCount > maxPages) issues.push('page_limit_exceeded');
  const check: PdfCheck = {
    status: issues.length === 0 ? 'passed' : 'failed',
    signature,
    eofMarker,
    pageCount: actualPageCount,
    maxPages,
    textLayerPresent,
    layoutWithinPage,
    visibleLineCount: expectedLines.length,
    issues,
  };
  return { buffer, check };
}
