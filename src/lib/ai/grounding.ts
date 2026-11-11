const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
  nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6,
  tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11,
  'dua belas': 12, 'tiga belas': 13, 'empat belas': 14, 'lima belas': 15,
  'enam belas': 16, 'tujuh belas': 17, 'delapan belas': 18,
  'sembilan belas': 19, 'dua puluh': 20,
};

const METRIC_UNITS = [
  'years?', 'yrs?', 'tahun', 'months?', 'bulan', 'weeks?', 'minggu', 'days?', 'hari',
  'hours?', 'jam', 'percent', 'persen', '%', 'times', 'kali', 'employees?', 'people',
  'orang', 'projects?', 'proyek', 'clients?', 'customers?', 'pelanggan', 'million',
  'billion', 'juta', 'miliar',
];
const UNIT_PATTERN = METRIC_UNITS.join('|');

interface Quantity {
  value: number;
  unit: string | null;
  display: string;
}

function normalizeNumber(raw: string): number | null {
  const normalized = raw.includes(',') && !raw.includes('.')
    ? (/,\d{3}$/u.test(raw) ? raw.replaceAll(',', '') : raw.replace(',', '.'))
    : raw.replaceAll(',', '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function quantities(text: string): Quantity[] {
  const result: Quantity[] = [];
  const digitPattern = new RegExp(`(?<![\\p{L}\\p{N}])([+-]?\\d{1,3}(?:,\\d{3})+|[+-]?\\d+(?:[.,]\\d+)?)(?:\\s*\\+)?(?:\\s*(${UNIT_PATTERN}))?(?![\\p{L}\\p{N}])`, 'giu');
  for (const match of text.matchAll(digitPattern)) {
    const value = normalizeNumber(match[1]!);
    if (value === null) continue;
    const unit = match[2]?.toLocaleLowerCase('en-US') ?? null;
    result.push({ value, unit, display: `${match[1]}${unit ? ` ${unit}` : ''}` });
  }

  const numberWords = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
  const wordPattern = new RegExp(`(?<![\\p{L}\\p{N}])(${numberWords})(?:\\s*\\+)?\\s+(${UNIT_PATTERN})(?![\\p{L}\\p{N}])`, 'giu');
  for (const match of text.matchAll(wordPattern)) {
    const value = NUMBER_WORDS[match[1]!.toLocaleLowerCase('en-US')];
    if (value === undefined) continue;
    const unit = match[2]!.toLocaleLowerCase('en-US');
    result.push({ value, unit, display: `${match[1]} ${unit}` });
  }
  return result;
}

function evidenceText(value: unknown, keyPath = ''): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' && Number.isFinite(value)) {
    const unit = /(?:years?|experience|tenure|tahun)/iu.test(keyPath) ? 'years'
      : /(?:months?|bulan)/iu.test(keyPath) ? 'months'
        : /(?:percent|percentage|rate|persen)/iu.test(keyPath) ? 'percent' : '';
    return [`${value}${unit ? ` ${unit}` : ''}`];
  }
  if (Array.isArray(value)) return value.flatMap((item) => evidenceText(item, keyPath));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, item]) => evidenceText(item, `${keyPath} ${key}`));
  }
  return [];
}

/**
 * Return quantitative claims that cannot be matched to selected evidence.
 * This is a conservative guard for dates and numeric claims, not a semantic
 * entailment check; the generated content still requires owner review.
 */
export function unsupportedQuantities(texts: string[], factValues: unknown[]): string[] {
  const supported = factValues.flatMap((value) => evidenceText(value)).flatMap(quantities);
  const unsupported = texts.flatMap(quantities).filter((claim) => !supported.some((source) =>
    source.value === claim.value && (!claim.unit || source.unit === claim.unit),
  ));
  return [...new Set(unsupported.map((claim) => claim.display))];
}

export interface WorkDateConflict {
  factVersionId: string;
  reason: 'end_before_start' | 'duplicate_employer_dates_disagree';
  employer: string | null;
  start: string;
  end: string;
}

interface DateValue { label: string; ordinal: number; openEnded: boolean }

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
  october: 10, nov: 11, november: 11, dec: 12, december: 12,
  januari: 1, februari: 2, maret: 3, mei: 5, juni: 6, juli: 7,
  agustus: 8, oktober: 10, desember: 12,
};

function parseDateValue(value: unknown): DateValue | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const label = String(value).trim();
  if (!label) return null;
  if (/^(?:present|current|now|sekarang|saat ini)$/iu.test(label)) {
    return { label, ordinal: Number.POSITIVE_INFINITY, openEnded: true };
  }
  const iso = label.match(/\b(19\d{2}|20\d{2}|21\d{2})(?:[-/.](0?[1-9]|1[0-2]))?(?:[-/.]\d{1,2})?\b/u);
  if (iso) return { label, ordinal: Number(iso[1]) * 12 + Number(iso[2] ?? 1), openEnded: false };
  const monthYear = label.match(/\b([A-Za-zÀ-ÿ]+)\.?\s+(19\d{2}|20\d{2}|21\d{2})\b/u)
    ?? label.match(/\b(19\d{2}|20\d{2}|21\d{2})\s+([A-Za-zÀ-ÿ]+)\.?\b/u);
  if (monthYear) {
    const monthName = (monthYear[1]!.match(/^\d/u) ? monthYear[2]! : monthYear[1]!).toLocaleLowerCase('id-ID');
    const year = Number(monthYear[1]!.match(/^\d/u) ? monthYear[1] : monthYear[2]);
    const month = MONTHS[monthName];
    if (month) return { label, ordinal: year * 12 + month, openEnded: false };
  }
  return null;
}

const START_KEYS = /^(?:start|from|fromdate|since|startdate|employmentstart|periodstart|datefrom|mulai|awal)$/iu;
const END_KEYS = /^(?:end|to|todate|until|enddate|employmentend|periodend|dateto|selesai|akhir)$/iu;
const EMPLOYER_KEYS = /^(?:employer|company|organization|organisation|employername|companyname|perusahaan)$/iu;
const ROLE_KEYS = /^(?:title|role|position|jobtitle|jabatan)$/iu;

function normalizedKey(value: string): string { return value.replace(/[^a-z]/giu, '').toLocaleLowerCase('en-US'); }

interface WorkRecord {
  factVersionId: string;
  employer: string | null;
  role: string | null;
  start: DateValue;
  end: DateValue;
}

function recordsFromValue(value: unknown, factVersionId: string): WorkRecord[] {
  const found: WorkRecord[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string') {
        const range = item.match(/\b((?:[A-Za-zÀ-ÿ]+\.?\s+)?(?:19\d{2}|20\d{2}|21\d{2}))\s*(?:-|–|—|to|through|sampai|hingga)\s*(present|current|now|sekarang|saat ini|(?:[A-Za-zÀ-ÿ]+\.?\s+)?(?:19\d{2}|20\d{2}|21\d{2}))\b/iu);
        if (range) {
          const start = parseDateValue(range[1]);
          const end = parseDateValue(range[2]);
          if (start && end) found.push({ factVersionId, employer: null, role: null, start, end });
        }
      }
      return;
    }
    const record = item as Record<string, unknown>;
    let start: DateValue | null = null;
    let end: DateValue | null = null;
    let employer: string | null = null;
    let role: string | null = null;
    for (const [key, child] of Object.entries(record)) {
      const normalized = normalizedKey(key);
      if (START_KEYS.test(normalized)) start = parseDateValue(child);
      if (END_KEYS.test(normalized)) end = parseDateValue(child);
      if (EMPLOYER_KEYS.test(normalized) && typeof child === 'string') employer = child.trim();
      if (ROLE_KEYS.test(normalized) && typeof child === 'string') role = child.trim();
    }
    if (start && end) found.push({ factVersionId, employer, role, start, end });
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}

/** Detect only clear timeline contradictions; overlapping concurrent roles are allowed. */
export function findWorkDateConflicts(facts: Array<{ factVersionId: string; value: unknown }>): WorkDateConflict[] {
  const records = facts.flatMap((fact) => recordsFromValue(fact.value, fact.factVersionId));
  const conflicts: WorkDateConflict[] = [];
  for (const record of records) {
    if (!record.end.openEnded && record.start.ordinal > record.end.ordinal) {
      conflicts.push({
        factVersionId: record.factVersionId, reason: 'end_before_start', employer: record.employer,
        start: record.start.label, end: record.end.label,
      });
    }
  }
  const seen = new Map<string, WorkRecord>();
  for (const record of records) {
    if (!record.employer || !record.role || !record.start || !record.end) continue;
    const key = `${record.employer.toLocaleLowerCase('en-US')}|${record.role.toLocaleLowerCase('en-US')}`;
    const previous = seen.get(key);
    const sameStartDifferentEnd = previous?.start.ordinal === record.start.ordinal && previous.end.ordinal !== record.end.ordinal;
    const sameEndDifferentStart = previous?.end.ordinal === record.end.ordinal && previous.start.ordinal !== record.start.ordinal;
    if (previous && (sameStartDifferentEnd || sameEndDifferentStart)) {
      conflicts.push({
        factVersionId: record.factVersionId, reason: 'duplicate_employer_dates_disagree', employer: record.employer,
        start: record.start.label, end: record.end.label,
      });
    } else if (!previous) seen.set(key, record);
  }
  return conflicts.slice(0, 10);
}
