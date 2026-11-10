import { describe, expect, it } from 'vitest';
import { compileTextPdf } from '@/lib/documents/pdf';

describe('local PDF compiler', () => {
  it('creates an extractable one-page PDF with a passing text and layout check', () => {
    const result = compileTextPdf('# CV\n\n- TypeScript and PostgreSQL experience', 1);
    expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.buffer.toString('ascii')).toContain('- TypeScript and PostgreSQL experience) Tj');
    expect(result.check).toMatchObject({
      status: 'passed',
      textLayerPresent: true,
      layoutWithinPage: true,
      pageCount: 1,
    });
  });

  it('reports a page-limit failure rather than claiming a long draft passed', () => {
    const result = compileTextPdf(Array.from({ length: 60 }, (_, index) => `Line ${index + 1}`).join('\n'), 1);
    expect(result.check.status).toBe('failed');
    expect(result.check.layoutWithinPage).toBe(false);
    expect(result.check.issues).toContain('layout_or_page_limit_failed');
  });

  it('rejects an empty source document', () => {
    expect(() => compileTextPdf('  \n', 1)).toThrow('PDF_INPUT_INVALID');
  });
});
