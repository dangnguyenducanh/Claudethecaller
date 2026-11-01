import { describe, expect, it } from 'vitest';
import { CTC_LINE_PREFIX, sanitize, stripBlocks } from './index.ts';

describe('sanitize (D10)', () => {
  it('repeats until no block is left, so nested tags cannot rebuild one', () => {
    expect(sanitize('<pri<private>x</private>vate>SECRET</private> ok')).toBe(' ok');
    expect(sanitize('<pri\u0001vate>S</private>')).toBe('');
  });
  it('pins the ctc line prefix', () => expect(CTC_LINE_PREFIX).toBe('ctc: '));
  it('removes the three tag blocks, also across lines', () => {
    expect(sanitize('a<private>x\ny</private>b')).toBe('ab');
    expect(sanitize('a<system-reminder>x</system-reminder>b<persisted-output>y</persisted-output>c')).toBe('abc');
  });
  it('removes to the end for an unclosed tag and keeps a lone closing tag and other cases', () => {
    expect(sanitize('keep<private>secret to the end')).toBe('keep');
    expect(sanitize('a</private>b')).toBe('a</private>b');
    expect(sanitize('<Private>x</Private>')).toBe('<Private>x</Private>');
  });
  it('removes whole lines that start with the ctc prefix after whitespace', () => {
    expect(sanitize('x\nctc: T4.1 -> a\ny')).toBe('x\ny');
    expect(sanitize('x\n   ctc: indented\ny')).toBe('x\ny');
    expect(sanitize('ctc:no space')).toBe('ctc:no space');
  });
  it('removes control characters except tab, newline and carriage return', () => {
    expect(sanitize('a\u0000b\u0007c\td\ne\u007f\r')).toBe('abc\td\ne\r');
  });
  it('cuts to maxChars without splitting a surrogate pair, and ignores a bad maxChars', () => {
    expect(sanitize('abc\u{1F600}', { maxChars: 4 })).toBe('abc');
    expect(sanitize('abcdef', { maxChars: 3 })).toBe('abc');
    expect(sanitize('abcdef', { maxChars: 0 })).toBe('abcdef');
    expect(sanitize('abcdef', { maxChars: 6 })).toBe('abcdef');
  });
  it('does not trim, and gives an empty string for a non-string', () => {
    expect(sanitize('  pad  ')).toBe('  pad  ');
    expect(sanitize(42 as unknown as string)).toBe('');
  });
  it('is linear on many blocks', () => {
    const t0 = Date.now();
    expect(sanitize('<private>x</private>.'.repeat(50000))).toBe('.'.repeat(50000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('is linear on 1 MB of deeply nested tags built from removed blocks', () => {
    const k = 50000;
    const t0 = Date.now();
    expect(sanitize('<pri'.repeat(k) + '<private></private>' + 'vate>a</private>'.repeat(k))).toBe('');
    expect(stripBlocks('<pri'.repeat(k) + '<private></private>' + 'vate>a</private>'.repeat(k), ['private'])).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('is linear on a long run of carriage returns and keeps a tag split by a removed block', () => {
    const t0 = Date.now();
    expect(sanitize('\r'.repeat(1_000_000))).toBe('\r'.repeat(1_000_000));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(stripBlocks('<system-reminder><pri<private>x</private>vate>y</private>z</system-reminder>w', ['private', 'system-reminder'])).toBe('w');
    expect(stripBlocks('a<pri<private>x</private>vate>y', ['private'])).toBe('a');
  });
});
