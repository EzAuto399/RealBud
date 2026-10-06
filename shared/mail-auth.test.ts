import { describe, expect, it } from 'vitest';
import { mailAuthConfirms, mailAuthWords, parseMailAuth } from './mail-auth.ts';

const GMAIL = 'mx.google.com; dkim=pass header.i=@post.xero.com header.s=fictional header.b=FICTIONAL; '
  + 'spf=pass (google.com: domain of bounce@post.xero.com designates 192.0.2.10 as permitted sender; fictional) smtp.mailfrom=bounce@post.xero.com; '
  + 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=post.xero.com';

describe('Gmail Authentication-Results', () => {
  it('reads DMARC, DKIM and SPF results with their domains', () => {
    expect(parseMailAuth(GMAIL)).toEqual({
      dmarc: { result: 'pass', domain: 'post.xero.com' },
      dkim: [{ result: 'pass', domain: 'post.xero.com' }],
      spf: { result: 'pass', domain: 'post.xero.com' },
    });
    expect(parseMailAuth('mx.google.com; dkim=pass header.d=Xero.com header.s=x; dkim=fail header.d=fictional-evil.example')!.dkim)
      .toEqual([{ result: 'pass', domain: 'xero.com' }, { result: 'fail', domain: 'fictional-evil.example' }]);
    expect(parseMailAuth('mx.google.com; none')).toEqual({ dmarc: null, dkim: [], spf: null });
  });

  it('ignores a header not stamped by Gmail, including a sender-written "pass"', () => {
    expect(parseMailAuth('mail.fictional-evil.example; dmarc=pass header.from=fictional-plumbing.example')).toBeNull();
    expect(parseMailAuth('mx.google.com.fictional-evil.example; dmarc=pass header.from=fictional-plumbing.example')).toBeNull();
    expect(parseMailAuth(undefined)).toBeNull();
    expect(parseMailAuth('')).toBeNull();
  });

  it('fails closed on injected or ambiguous results', () => {
    const forged = 'header.from=fictional-plumbing.example';
    // A "dmarc=pass" (and its ';') inside a quoted string or a comment is never a result.
    expect(parseMailAuth(`mx.google.com; dkim=none reason="x; dmarc=pass ${forged}"; dmarc=fail ${forged}`)!.dmarc).toEqual({ result: 'fail', domain: 'fictional-plumbing.example' });
    expect(parseMailAuth(`mx.google.com; spf=softfail (fictional; dmarc=pass ${forged} (nested; dmarc=pass)) smtp.mailfrom=a@fictional-evil.example; dmarc=fail ${forged}`)!.dmarc!.result).toBe('fail');
    expect(parseMailAuth(`mx.google.com; dkim=none (a "quote; dmarc=pass ${forged}) inside a comment"; dmarc=fail ${forged}`)).toBeNull();
    // Two DMARC results, an unbalanced quote or parenthesis, a value with spaces, or DKIM/DMARC disagreeing: unverified.
    expect(parseMailAuth(`mx.google.com; dmarc=pass ${forged}; dmarc=fail ${forged}`)).toBeNull();
    expect(parseMailAuth(`mx.google.com; dkim=none reason="unclosed; dmarc=pass ${forged}`)).toBeNull();
    expect(parseMailAuth(`mx.google.com; dkim=none (unclosed; dmarc=pass ${forged}`)).toBeNull();
    expect(parseMailAuth(`mx.google.com; dkim=none) ; dmarc=pass ${forged}`)).toBeNull();
    expect(parseMailAuth('mx.google.com; dmarc=pass header.from=fictional-evil.example fictional-plumbing.example')).toBeNull();
    expect(parseMailAuth('mx.google.com; dkim=pass header.d=fictional-plumbing.example; dkim=fail header.d=fictional-plumbing.example')).toBeNull();
    expect(parseMailAuth(`mx.google.com; dkim=pass header.d=fictional-plumbing.example; dmarc=fail ${forged}`)).toBeNull();
    expect(parseMailAuth(`mx.google.com mx.google.com; dmarc=pass ${forged}`)).toBeNull();
  });

  it('confirms a From domain only by DMARC pass for it or DKIM pass for it or a parent', () => {
    const auth = parseMailAuth(GMAIL);
    expect(mailAuthConfirms(auth, 'post.xero.com')).toBe(true);
    expect(mailAuthConfirms(auth, 'fictional-plumbing.example')).toBe(false);
    const parent = parseMailAuth('mx.google.com; dkim=pass header.d=xero.com');
    expect(mailAuthConfirms(parent, 'post.xero.com')).toBe(true);
    expect(mailAuthConfirms(parent, 'notxero.com')).toBe(false);
    // Gmail's DMARC verdict for the From domain overrules a parent signature (e.g. strict alignment, or a public-suffix signer).
    expect(mailAuthConfirms(parseMailAuth('mx.google.com; dkim=pass header.d=xero.com; dmarc=fail header.from=post.xero.com'), 'post.xero.com')).toBe(false);
    expect(mailAuthConfirms(parseMailAuth('mx.google.com; dkim=pass header.i=@com.au; dmarc=fail header.from=fictional-plumbing.com.au'), 'fictional-plumbing.com.au')).toBe(false);
    // A single-label signer is never read as a domain.
    expect(mailAuthConfirms(parseMailAuth('mx.google.com; dkim=pass header.d=example'), 'fictional-plumbing.example')).toBe(false);
    // SPF alone, DKIM for another domain, or a failed DMARC never confirm.
    expect(mailAuthConfirms(parseMailAuth('mx.google.com; spf=pass smtp.mailfrom=a@fictional-plumbing.example; dkim=pass header.i=@fictional-evil.example; dmarc=fail header.from=fictional-plumbing.example'), 'fictional-plumbing.example')).toBe(false);
    expect(mailAuthConfirms(null, 'post.xero.com')).toBe(false);
  });

  it('describes the result in words', () => {
    expect(mailAuthWords(parseMailAuth('mx.google.com; dkim=none; dmarc=fail header.from=fictional-plumbing.example'))).toBe('DMARC fail, DKIM none');
    expect(mailAuthWords(null)).toBe('no Gmail authentication result');
  });
});
