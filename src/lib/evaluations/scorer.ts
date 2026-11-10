export const PROPOSED_RUBRIC_VERSION = 'local-rule-v1-proposal';

export const DIMENSION_WEIGHTS = {
  technical: 0.3,
  experience: 0.25,
  work_context: 0.15,
  career_alignment: 0.3,
} as const;

export type DimensionName = keyof typeof DIMENSION_WEIGHTS;
export type FilterState = 'pass' | 'fail' | 'unknown';

export interface EvaluationFact {
  id: string;
  versionId: string;
  versionNo: number;
  type: string;
  verificationStatus: 'verified' | 'unverified' | 'retracted';
  value: unknown;
}

export interface EvaluationEvidence {
  kind: 'profile_fact' | 'preference' | 'posting_revision';
  reference: string;
  factId?: string;
  factVersionId?: string;
  versionNo?: number;
  excerpt?: string;
}

export interface EvaluationDimension {
  name: DimensionName;
  score: number | null;
  weight: number;
  reason: string;
  evidence: EvaluationEvidence[];
  gaps: string[];
}

export interface HardFilterResult {
  name: string;
  state: FilterState;
  reason: string;
  evidence: EvaluationEvidence[];
}

export interface EvaluationComputation {
  status: 'scored' | 'insufficient_data' | 'unreachable';
  score: number | null;
  decision: 'shortlist' | 'review' | 'excluded';
  dimensions: EvaluationDimension[];
  hardFilters: HardFilterResult[];
  matches: string[];
  gaps: string[];
  unknowns: string[];
  vetoes: string[];
  rubricVersion: string;
  engine: 'local-rule-based';
}

export interface EvaluationInput {
  preferences: Record<string, unknown>;
  facts: EvaluationFact[];
  title: string;
  company: string;
  location: string | null;
  description: string;
  salary: unknown;
  postingRevisionId: string | null;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'our', 'the', 'to', 'with', 'you', 'your',
  'dan', 'di', 'dengan', 'dari', 'ini', 'itu', 'ke', 'oleh', 'pada', 'untuk',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('id-ID')
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .replace(/\.+(?=\s|$)/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function hasPhrase(text: string, phrase: string): boolean {
  const normalizedText = normalize(text);
  const normalizedPhrase = normalize(phrase);
  return Boolean(normalizedPhrase) && ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function tokens(value: string): string[] {
  return [...new Set(
    normalize(value)
      .split(' ')
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  )];
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

function preferenceStrings(preferences: Record<string, unknown>, keys: string[]): string[] {
  const values = keys.flatMap((key) => collectStrings(preferences[key]));
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const key = normalize(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function factEvidence(fact: EvaluationFact, excerpt?: string): EvaluationEvidence {
  return {
    kind: 'profile_fact',
    reference: `profile_fact:${fact.id}:v${fact.versionNo}`,
    factId: fact.id,
    factVersionId: fact.versionId,
    versionNo: fact.versionNo,
    ...(excerpt ? { excerpt } : {}),
  };
}

function preferenceEvidence(key: string, value: string): EvaluationEvidence {
  return { kind: 'preference', reference: `preferences.${key}`, excerpt: value };
}

function postingEvidence(input: EvaluationInput): EvaluationEvidence[] {
  if (!input.postingRevisionId) return [];
  return [{
    kind: 'posting_revision',
    reference: `posting_revision:${input.postingRevisionId}`,
  }];
}

function skillsFromFacts(facts: EvaluationFact[], status: EvaluationFact['verificationStatus']): Array<{
  term: string;
  fact: EvaluationFact;
}> {
  const output: Array<{ term: string; fact: EvaluationFact }> = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.type !== 'skill' || fact.verificationStatus !== status) continue;
    for (const raw of collectStrings(fact.value)) {
      for (const part of raw.split(/[,;\n|]+/u)) {
        const term = part.trim();
        const key = normalize(term);
        if (!key || seen.has(key) || key.length > 80) continue;
        seen.add(key);
        output.push({ term, fact });
      }
    }
  }
  return output;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const grouped = /^\d{1,3}(?:[.,]\d{3})+$/u.test(normalized);
  if (!grouped && !/^\d+(?:[.,]\d+)?$/u.test(normalized)) return null;
  const parsed = Number(grouped ? normalized.replace(/[.,]/g, '') : normalized.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function yearsFromValue(value: unknown): number | null {
  if (typeof value === 'number') return numberValue(value);
  if (typeof value === 'string') {
    const years = value.match(/(\d+(?:[.,]\d+)?)\s*\+?\s*(?:years?|yrs?|tahun)/iu);
    return years ? numberValue(years[1]) : null;
  }
  if (!isRecord(value)) return null;
  for (const key of ['totalYearsExperience', 'yearsExperience', 'durationYears', 'years']) {
    if (value[key] !== undefined) {
      const parsed = yearsFromValue(value[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function requiredYears(description: string): { years: number } | null {
  const patterns = [
    /(?:at least|minimum(?: of)?|min\.?|setidaknya|minimal)\s*(\d+(?:[.,]\d+)?)\s*\+?\s*(?:years?|yrs?|tahun)(?:\s+of)?\s+(?:(?:relevant|professional|work)\s+)?(?:experience|pengalaman)/iu,
    /(\d+(?:[.,]\d+)?)\s*\+?\s*(?:years?|yrs?|tahun)(?:\s+of)?\s+(?:(?:relevant|professional|work)\s+)?(?:experience|pengalaman)/iu,
    /(?:experience|pengalaman|berpengalaman)(?:\s+(?:at least|minimum|minimal))?\s*(\d+(?:[.,]\d+)?)\s*\+?\s*(?:years?|yrs?|tahun)/iu,
  ];
  for (const pattern of patterns) {
    const match = description.match(pattern);
    const years = match ? numberValue(match[1]) : null;
    if (match && years !== null) return { years };
  }
  return null;
}

function salaryRange(value: unknown): { min: number | null; max: number | null; currency: string | null } | null {
  if (typeof value === 'number') return { min: value, max: value, currency: null };
  if (!isRecord(value)) return null;
  const min = ['min', 'minimum', 'from', 'low', 'amount'].map((key) => numberValue(value[key])).find((n) => n !== null) ?? null;
  const max = ['max', 'maximum', 'to', 'high', 'amount'].map((key) => numberValue(value[key])).find((n) => n !== null) ?? min;
  const currencyValue = value.currency ?? value.currencyCode ?? value.unit;
  const currency = typeof currencyValue === 'string' ? currencyValue.trim().toUpperCase() : null;
  if (min === null && max === null) return null;
  return { min, max, currency };
}

function preferenceSalary(preferences: Record<string, unknown>): { amount: number; currency: string | null } | null {
  const value = preferences.minimumSalary ?? preferences.salaryFloor;
  if (typeof value === 'number' || typeof value === 'string') {
    const amount = numberValue(value);
    return amount === null ? null : { amount, currency: null };
  }
  if (!isRecord(value)) return null;
  const amount = numberValue(value.amount ?? value.minimum ?? value.min);
  if (amount === null) return null;
  const currency = value.currency ?? value.currencyCode;
  return { amount, currency: typeof currency === 'string' ? currency.trim().toUpperCase() : null };
}

function detectedWorkModes(text: string): Set<string> {
  const modes = new Set<string>();
  if (/(remote|work from home|wfh|jarak jauh|fully remote)/iu.test(text)) modes.add('remote');
  if (/(hybrid|hybrid working|work from office and home)/iu.test(text)) modes.add('hybrid');
  if (/(on[ -]?site|in[ -]?office|work from office|onsite|di kantor)/iu.test(text)) modes.add('onsite');
  return modes;
}

function canonicalWorkMode(value: string): string | null {
  const normalized = normalize(value);
  if (/remote|wfh|jarak jauh/u.test(normalized)) return 'remote';
  if (/hybrid/u.test(normalized)) return 'hybrid';
  if (/onsite|on site|in office|di kantor/u.test(normalized)) return 'onsite';
  return null;
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function buildDimension(
  name: DimensionName,
  score: number | null,
  reason: string,
  evidence: EvaluationEvidence[],
  gaps: string[] = [],
): EvaluationDimension {
  return { name, score: score === null ? null : round(Math.min(100, Math.max(0, score))), weight: DIMENSION_WEIGHTS[name], reason, evidence, gaps };
}

export function scoreJob(input: EvaluationInput): EvaluationComputation {
  const facts = input.facts;
  const verifiedSkills = skillsFromFacts(facts, 'verified');
  const unverifiedSkills = skillsFromFacts(facts, 'unverified');
  const descriptionAvailable = input.description.trim().length > 0;
  const postingText = input.description;
  const searchablePostingText = [
    input.title,
    input.company,
    input.location ?? '',
    input.description,
  ].join('\n');
  const dimensions: EvaluationDimension[] = [];
  const matches: string[] = [];
  const gaps: string[] = [];
  const unknowns: string[] = [];
  const hardFilters: HardFilterResult[] = [];

  const skillMatches = descriptionAvailable
    ? verifiedSkills.filter(({ term }) => hasPhrase(postingText, term))
    : [];
  const skillGaps = descriptionAvailable
    ? verifiedSkills.filter(({ term }) => !hasPhrase(postingText, term)).map(({ term }) => term)
    : [];
  const technicalScore = descriptionAvailable && verifiedSkills.length
    ? (skillMatches.length / verifiedSkills.length) * 100
    : null;
  dimensions.push(buildDimension(
    'technical',
    technicalScore,
    technicalScore === null
      ? descriptionAvailable
        ? 'Belum ada skill terverifikasi untuk dibandingkan.'
        : 'Deskripsi posting belum tersedia; skor teknis tidak dihitung dari judul saja.'
      : `${skillMatches.length} dari ${verifiedSkills.length} skill terverifikasi disebut persis pada teks posting. Ini ukuran cakupan kata yang disebut, bukan peluang diterima.`,
    [
      ...skillMatches.map(({ term, fact }) => factEvidence(fact, term)),
      ...postingEvidence(input),
    ],
    skillGaps,
  ));
  matches.push(...skillMatches.map(({ term }) => `Skill disebut: ${term}`));
  gaps.push(...skillGaps.map((term) => `Skill terverifikasi tidak disebut: ${term}`));
  if (technicalScore === null) {
    unknowns.push(descriptionAvailable
      ? 'Skill teknis belum memiliki fakta terverifikasi.'
      : 'Deskripsi posting belum tersedia untuk membandingkan skill.');
  }

  const verifiedExperience = facts.filter(
    (fact) => fact.type === 'work_experience' && fact.verificationStatus === 'verified',
  );
  const candidateYears = verifiedExperience
    .map((fact) => ({ fact, years: yearsFromValue(fact.value) }))
    .filter((entry): entry is { fact: EvaluationFact; years: number } => entry.years !== null)
    .sort((a, b) => b.years - a.years)[0];
  const required = requiredYears(input.description);
  const experienceScore = candidateYears && required && required.years > 0
    ? Math.min(100, (candidateYears.years / required.years) * 100)
    : null;
  const experienceReason = experienceScore === null
    ? 'Butuh fakta pengalaman kerja terverifikasi dengan jumlah tahun dan persyaratan tahun yang tertulis pada posting.'
    : `Profil mencatat ${candidateYears.years} tahun; posting meminta ${required.years} tahun.`;
  dimensions.push(buildDimension(
    'experience',
    experienceScore,
    experienceReason,
    [
      ...(candidateYears ? [factEvidence(candidateYears.fact, `${candidateYears.years} tahun`)] : []),
      ...postingEvidence(input),
    ],
    experienceScore !== null && candidateYears && required && candidateYears.years < required.years
      ? [`Dokumentasi pengalaman (${candidateYears.years} tahun) di bawah persyaratan tertulis (${required.years} tahun).`]
      : [],
  ));
  if (experienceScore === null) unknowns.push('Kecocokan tahun pengalaman belum dapat dihitung dari bukti yang tersedia.');

  const contextCriteria: Array<{ score: number; reason: string; evidence: EvaluationEvidence[] }> = [];
  const preferredLocations = preferenceStrings(input.preferences, ['preferredLocations', 'locations']);
  if (preferredLocations.length) {
    if (!input.location) {
      unknowns.push('Lokasi lowongan tidak tersedia untuk membandingkan preferensi lokasi.');
    } else {
      const matched = preferredLocations.find((location) => hasPhrase(input.location ?? '', location));
      contextCriteria.push({
        score: matched ? 100 : 0,
        reason: matched ? `Lokasi cocok: ${matched}.` : `Lokasi posting (${input.location}) tidak cocok persis dengan lokasi pilihan.`,
        evidence: [preferenceEvidence('preferredLocations', preferredLocations.join(', ')), ...postingEvidence(input)],
      });
    }
  }

  const preferredModes = preferenceStrings(input.preferences, ['preferredWorkModes', 'workModes'])
    .map((mode) => canonicalWorkMode(mode))
    .filter((mode): mode is string => mode !== null);
  if (preferredModes.length) {
    const availableModes = descriptionAvailable ? detectedWorkModes(postingText) : new Set<string>();
    if (!availableModes.size) {
      unknowns.push('Mode kerja tidak disebut dengan jelas pada posting.');
    } else {
      const matchedMode = preferredModes.find((mode) => availableModes.has(mode));
      contextCriteria.push({
        score: matchedMode ? 100 : 0,
        reason: matchedMode ? `Mode kerja cocok: ${matchedMode}.` : `Mode kerja terdeteksi (${[...availableModes].join(', ')}) tidak cocok dengan pilihan.`,
        evidence: [preferenceEvidence('preferredWorkModes', preferredModes.join(', ')), ...postingEvidence(input)],
      });
    }
  }

  const minSalary = preferenceSalary(input.preferences);
  if (minSalary) {
    const offered = salaryRange(input.salary);
    if (!offered || (minSalary.currency && minSalary.currency !== offered.currency)) {
      unknowns.push('Rentang gaji belum tersedia atau mata uangnya tidak cocok dengan batas gaji profil.');
    } else {
      const salaryScore = offered.max !== null && offered.max < minSalary.amount
        ? 0
        : offered.min !== null && offered.min >= minSalary.amount
          ? 100
          : 60;
      contextCriteria.push({
        score: salaryScore,
        reason: salaryScore === 100
          ? 'Batas bawah gaji posting memenuhi minimum profil.'
          : salaryScore === 60
            ? 'Rentang gaji mencakup minimum profil, tetapi batas bawahnya belum memenuhi minimum.'
            : 'Batas atas gaji posting di bawah minimum profil.',
        evidence: [preferenceEvidence('minimumSalary', `${minSalary.amount} ${minSalary.currency ?? ''}`.trim()), ...postingEvidence(input)],
      });
    }
  }

  const contextScore = contextCriteria.length
    ? contextCriteria.reduce((sum, item) => sum + item.score, 0) / contextCriteria.length
    : null;
  dimensions.push(buildDimension(
    'work_context',
    contextScore,
    contextCriteria.length
      ? contextCriteria.map((item) => item.reason).join(' ')
      : 'Preferensi lokasi, mode kerja, atau gaji yang dapat dibandingkan belum diisi atau belum didukung data posting.',
    contextCriteria.flatMap((item) => item.evidence),
    contextCriteria.filter((item) => item.score === 0).map((item) => item.reason),
  ));
  if (contextScore === null) unknowns.push('Kecocokan preferensi kerja belum dapat dihitung.');
  else if (contextScore > 0) matches.push(...contextCriteria.filter((item) => item.score > 0).map((item) => item.reason));

  const targetTitles = preferenceStrings(input.preferences, ['targetTitles', 'targetRoles', 'targetPositions']);
  let careerScore: number | null = null;
  const careerEvidence: EvaluationEvidence[] = [];
  if (targetTitles.length && input.title) {
    const titleTokens = new Set(tokens(input.title));
    careerScore = Math.max(...targetTitles.map((target) => {
      const targetTokens = tokens(target);
      if (!targetTokens.length) return 0;
      const exact = hasPhrase(input.title, target);
      if (exact) return 100;
      return (targetTokens.filter((token) => titleTokens.has(token)).length / targetTokens.length) * 100;
    }));
    careerEvidence.push(preferenceEvidence('targetTitles', targetTitles.join(', ')), ...postingEvidence(input));
    if (careerScore > 0) matches.push(`Judul lowongan berbagi kata kunci dengan target posisi (${round(careerScore)}%).`);
    else gaps.push(`Judul lowongan tidak berbagi kata kunci dengan target posisi: ${targetTitles.join(', ')}.`);
  } else {
    unknowns.push('Target posisi karier belum diisi.');
  }
  dimensions.push(buildDimension(
    'career_alignment',
    careerScore,
    careerScore === null
      ? 'Tambahkan targetTitles pada preferensi untuk menilai keselarasan judul posisi.'
      : `Cakupan kata target posisi pada judul lowongan: ${round(careerScore)}%.`,
    careerEvidence,
    careerScore === 0 ? [`Target posisi: ${targetTitles.join(', ')}.`] : [],
  ));

  const excludedTerms = preferenceStrings(input.preferences, ['excludeTerms', 'negativeKeywords']);
  if (excludedTerms.length) {
    if (!searchablePostingText.trim()) {
      hardFilters.push({ name: 'excludeTerms', state: 'unknown', reason: 'Teks lowongan tidak tersedia.', evidence: [] });
    } else {
      const found = excludedTerms.filter((term) => hasPhrase(searchablePostingText, term));
      hardFilters.push({
        name: 'excludeTerms',
        state: found.length ? 'fail' : 'unknown',
        reason: found.length
          ? `Kata yang dikecualikan ditemukan: ${found.join(', ')}.`
          : 'Kata pengecualian tidak ditemukan pada teks tersimpan, tetapi kelengkapan salinan posting belum dikonfirmasi.',
        evidence: [preferenceEvidence('excludeTerms', excludedTerms.join(', ')), ...postingEvidence(input)],
      });
    }
  }

  const excludedCompanies = preferenceStrings(input.preferences, ['excludedCompanies']);
  if (excludedCompanies.length) {
    if (!input.company.trim()) {
      hardFilters.push({ name: 'excludedCompanies', state: 'unknown', reason: 'Nama perusahaan tidak tersedia.', evidence: [] });
    } else {
      const found = excludedCompanies.find((company) => hasPhrase(input.company, company));
      hardFilters.push({
        name: 'excludedCompanies',
        state: found ? 'fail' : 'pass',
        reason: found ? `Perusahaan dikecualikan: ${found}.` : 'Perusahaan tidak cocok dengan daftar pengecualian.',
        evidence: [preferenceEvidence('excludedCompanies', excludedCompanies.join(', ')), ...postingEvidence(input)],
      });
    }
  }

  const excludedIndustries = preferenceStrings(input.preferences, ['excludedIndustries']);
  if (excludedIndustries.length) {
    hardFilters.push({
      name: 'excludedIndustries',
      state: 'unknown',
      reason: `Industri tidak diklasifikasikan dari bukti yang tersedia; perlu pemeriksaan manual (${excludedIndustries.join(', ')}).`,
      evidence: [preferenceEvidence('excludedIndustries', excludedIndustries.join(', '))],
    });
  }

  const requiredSkills = preferenceStrings(input.preferences, ['requiredSkills']);
  if (requiredSkills.length) {
    const missing = requiredSkills.filter((requiredSkill) => !verifiedSkills.some(({ term }) => hasPhrase(term, requiredSkill)));
    const mentionedUnverified = missing.filter((requiredSkill) => unverifiedSkills.some(({ term }) => hasPhrase(term, requiredSkill)));
    hardFilters.push({
      name: 'requiredSkills',
      state: missing.length ? 'unknown' : 'pass',
      reason: missing.length
        ? `Belum ada bukti terverifikasi untuk: ${missing.join(', ')}${mentionedUnverified.length ? ' (ada yang belum diverifikasi)' : ''}.`
        : 'Semua skill wajib memiliki fakta profil terverifikasi.',
      evidence: [
        preferenceEvidence('requiredSkills', requiredSkills.join(', ')),
        ...verifiedSkills.filter(({ term }) => requiredSkills.some((requiredSkill) => hasPhrase(term, requiredSkill))).map(({ term, fact }) => factEvidence(fact, term)),
        ...unverifiedSkills.filter(({ term }) => requiredSkills.some((requiredSkill) => hasPhrase(term, requiredSkill))).map(({ term, fact }) => factEvidence(fact, `${term} (belum diverifikasi)`)),
      ],
    });
  }

  const minimumSalaryFilter = preferenceSalary(input.preferences);
  if (minimumSalaryFilter) {
    const offered = salaryRange(input.salary);
    const currencyMismatch = Boolean(
      offered && minimumSalaryFilter.currency && minimumSalaryFilter.currency !== offered.currency,
    );
    const state: FilterState = !offered || offered.max === null || currencyMismatch
      ? 'unknown'
      : offered.max < minimumSalaryFilter.amount
        ? 'fail'
        : offered.min !== null && offered.min >= minimumSalaryFilter.amount
          ? 'pass'
          : 'unknown';
    hardFilters.push({
      name: 'minimumSalary',
      state,
      reason: state === 'unknown'
        ? 'Gaji atau mata uang pada posting belum cukup untuk memeriksa minimum.'
        : state === 'pass'
          ? 'Batas bawah rentang gaji memenuhi minimum profil.'
          : state === 'fail'
            ? 'Batas atas rentang gaji di bawah minimum profil.'
            : 'Rentang gaji mencakup minimum profil; kecocokan belum pasti.',
      evidence: [preferenceEvidence('minimumSalary', `${minimumSalaryFilter.amount} ${minimumSalaryFilter.currency ?? ''}`.trim()), ...postingEvidence(input)],
    });
  }

  const hardFails = hardFilters.filter((filter) => filter.state === 'fail');
  const hardUnknowns = hardFilters.filter((filter) => filter.state === 'unknown');
  const scoreAvailable = dimensions.every((dimension) => dimension.score !== null);
  const score = scoreAvailable && input.postingRevisionId && descriptionAvailable
    ? round(dimensions.reduce((sum, dimension) => sum + (dimension.score ?? 0) * dimension.weight, 0))
    : null;
  for (const filter of hardFails) {
    gaps.push(filter.reason);
  }
  for (const filter of hardUnknowns) {
    unknowns.push(filter.reason);
  }

  const decision = hardFails.length
    ? 'excluded'
    : unknowns.length || hardUnknowns.length || score === null
      ? 'review'
      : 'shortlist';
  return {
    status: !input.postingRevisionId ? 'unreachable' : score === null ? 'insufficient_data' : 'scored',
    score,
    decision,
    dimensions,
    hardFilters,
    matches,
    gaps: [...new Set(gaps)],
    unknowns: [...new Set(unknowns)],
    vetoes: hardFails.map((filter) => filter.name),
    rubricVersion: PROPOSED_RUBRIC_VERSION,
    engine: 'local-rule-based',
  };
}
