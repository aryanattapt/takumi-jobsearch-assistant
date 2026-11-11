import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { ApiError } from '@/lib/http/errors';

export interface ExtractedFactCandidate {
  type: 'contact' | 'location' | 'education' | 'work_experience' | 'skill' | 'language';
  value: unknown;
  confidence: number;
  evidence: string[];
}

const MAX_PDF_PAGES = 40;
const MAX_TEXT_LENGTH = 120_000;

function cleanText(value: string): string {
  return value
    .replace(new RegExp(String.fromCharCode(0), 'g'), '')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/** Extracts CV text on this server; document text is never sent to an AI provider. */
export async function extractDocumentText(buffer: Buffer, mediaType: string): Promise<string> {
  if (buffer.length > 10 * 1024 * 1024) {
    throw new ApiError(413, 'CV_TOO_LARGE', 'CV extraction is limited to 10 MiB');
  }
  let text: string;
  if (mediaType === 'text/plain') {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } else if (mediaType === 'application/pdf') {
    const loadingTask = getDocument({ data: Uint8Array.from(buffer), useWorkerFetch: false, stopAtErrors: true });
    const document = await loadingTask.promise;
    try {
      if (document.numPages > MAX_PDF_PAGES) {
        throw new ApiError(422, 'CV_PAGE_LIMIT', `CV extraction is limited to ${MAX_PDF_PAGES} pages`);
      }
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(content.items.flatMap((item) => {
          if (!('str' in item) || typeof item.str !== 'string') return [];
          return [`${item.str}${'hasEOL' in item && item.hasEOL ? '\n' : ' '}`];
        }).join(''));
      }
      text = pages.join('\n');
    } finally {
      await loadingTask.destroy();
    }
  } else if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else {
    throw new ApiError(422, 'CV_FORMAT_UNSUPPORTED', 'Extract text from PDF, DOCX, or TXT CV files');
  }
  const normalized = cleanText(text);
  if (normalized.length < 40) {
    throw new ApiError(422, 'CV_TEXT_NOT_FOUND', 'No usable text was found. Scanned image PDFs need OCR or manual entry.');
  }
  return normalized;
}

const HEADINGS: Array<{ type: ExtractedFactCandidate['type']; pattern: RegExp }> = [
  { type: 'skill', pattern: /^(?:technical\s+skills?|skills?|core\s+competencies|competencies|keahlian|kemampuan)(?:\s*[:-])?$/iu },
  { type: 'education', pattern: /^(?:education|academic\s+background|pendidikan)(?:\s*[:-])?$/iu },
  { type: 'work_experience', pattern: /^(?:work\s+experience|professional\s+experience|employment\s+history|experience|pengalaman\s+kerja|pengalaman)(?:\s*[:-])?$/iu },
  { type: 'language', pattern: /^(?:languages?|bahasa)(?:\s*[:-])?$/iu },
];
const NEXT_HEADING = /^(?:profile|summary|objective|about\s+me|contact|education|academic\s+background|pendidikan|work\s+experience|professional\s+experience|employment\s+history|experience|pengalaman\s+kerja|pengalaman|skills?|technical\s+skills?|core\s+competencies|competencies|keahlian|kemampuan|languages?|bahasa|certifications?|sertifikasi|projects?|proyek|references?|referensi)(?:\s*[:-])?$/iu;

function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[•●▪◦*–—-]+|\d+[.)])\s*/u, '').trim();
}

export function suggestCvFacts(text: string): ExtractedFactCandidate[] {
  const lines = cleanText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  const candidates: ExtractedFactCandidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = HEADINGS.find((entry) => entry.pattern.test(lines[index]!));
    if (!heading) continue;
    const evidence: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!.trim();
      if (NEXT_HEADING.test(candidate)) break;
      const cleaned = cleanLine(candidate);
      if (cleaned.length >= 2) evidence.push(cleaned.slice(0, 500));
      if (evidence.length >= (heading.type === 'skill' || heading.type === 'language' ? 40 : 12)) break;
    }
    if (evidence.length) {
      candidates.push({
        type: heading.type,
        value: heading.type === 'skill' || heading.type === 'language'
          ? { items: evidence.flatMap((item) => item.split(/[,;|]+/u).map((part) => part.trim()).filter(Boolean)).slice(0, 40) }
          : { items: evidence },
        confidence: 0.72,
        evidence: evidence.slice(0, 8),
      });
    }
  }
  const emails = [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [])].slice(0, 5);
  const phones = [...new Set(text.match(/(?:\+?\d[\d ().-]{7,}\d)/gu) ?? [])]
    .map((phone) => phone.trim()).filter((phone) => phone.replace(/\D/g, '').length >= 8).slice(0, 5);
  const links = [...new Set(text.match(/https?:\/\/[^\s<>"')]+/giu) ?? [])]
    .filter((link) => /linkedin|github|portfolio|personal/iu.test(link)).slice(0, 8);
  if (emails.length || phones.length || links.length) {
    candidates.unshift({
      type: 'contact', value: { emails, phones, links }, confidence: 0.95,
      evidence: lines.filter((line) => emails.some((item) => line.includes(item)) || phones.some((item) => line.includes(item)) || links.some((item) => line.includes(item))).slice(0, 4),
    });
  }
  for (const line of lines.filter((item) => /^(?:location|lokasi|domisili|based\s+in)\s*[:-]/iu.test(item)).slice(0, 3)) {
    const value = line.replace(/^(?:location|lokasi|domisili|based\s+in)\s*[:-]\s*/iu, '').trim();
    if (value) candidates.push({ type: 'location', value, confidence: 0.9, evidence: [line] });
  }
  const years = text.match(/\b(\d{1,2}(?:[.,]\d)?)\s*\+?\s*(?:years?|yrs?|tahun)\s+(?:of\s+)?(?:relevant\s+|professional\s+|work\s+)?(?:experience|pengalaman)\b/iu);
  if (years) {
    const amount = Number(years[1]!.replace(',', '.'));
    if (Number.isFinite(amount)) candidates.push({ type: 'work_experience', value: { totalYearsExperience: amount }, confidence: 0.85, evidence: [years[0]] });
  }
  return candidates.slice(0, 20);
}
