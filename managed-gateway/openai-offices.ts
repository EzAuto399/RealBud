/** Our OpenAI org, one API key per office. Operator mapping + monthly wholesale → retail.
 * Clients never see the key, USD, or margin. Website Charge stays accepted AUD. */
import { canonical, id, integer, requireThat, type PortalPrincipal } from './contracts.ts';
import { digest, UsageLedger } from './ledger.ts';
import { periodAt, retailProposal } from './money.ts';
import type { OpenAICostsSnapshot } from './openai-costs.ts';

export interface OpenAIOfficeKey {
  id: string;
  companyId: string;
  apiKeyId: string;
  startsAt: number;
  endsAt: number;
  evidence: string;
}
export interface OpenAIRetailPolicy {
  version: string;
  companyId: string;
  fxNumerator: string;
  fxDenominator: string;
  fxSource: string;
  method: 'markup' | 'margin';
  basisPoints: number;
  /** false = GST-only pass-through; stored % is kept for a later policy version. */
  apply?: boolean;
}
interface OfficeLine {
  companyId: string;
  period: string;
  wholesaleUsd: string;
  retailNanoAud: string;
  chargedNanoAud: string;
  included: boolean;
  status: 'ready' | 'unmapped' | 'meter_reconciliation_required' | 'period_closed';
}

function apiKeyId(value: unknown): asserts value is string {
  requireThat(typeof value === 'string' && /^key_[A-Za-z0-9]{6,80}$/.test(value), 'invalid_openai_key_id');
}
function usdToNano(text: string): string {
  requireThat(/^\d{1,12}(\.\d{1,9})?$/.test(text), 'invalid_usd');
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0').slice(0, 9))).toString();
}

export class OpenAIOffices {
  readonly ledger: UsageLedger;
  constructor(ledger: UsageLedger) {
    this.ledger = ledger;
  }
  mapKey(mapping: OpenAIOfficeKey) {
    id(mapping.id);
    id(mapping.companyId);
    id(mapping.evidence);
    apiKeyId(mapping.apiKeyId);
    integer(mapping.startsAt, Number.MAX_SAFE_INTEGER);
    integer(mapping.endsAt, Number.MAX_SAFE_INTEGER);
    requireThat(mapping.startsAt < mapping.endsAt, 'invalid_mapping_window');
    this.ledger.tenant(mapping.companyId);
    this.ledger.db.transaction(() => {
      const prior = this.ledger.db.get<{ body: string }>('SELECT body FROM report_key_mappings WHERE id=?', mapping.id);
      if (prior) {
        requireThat(prior.body === canonical(mapping), 'key_mapping_conflict', 409);
        return;
      }
      requireThat(
        !this.ledger.db.get(
          'SELECT id FROM report_key_mappings WHERE provider=? AND key_ref=? AND starts<? AND ends>?',
          'openai',
          mapping.apiKeyId,
          mapping.endsAt,
          mapping.startsAt,
        ),
        'key_mapping_overlap',
        409,
      );
      this.ledger.db.run(
        'INSERT INTO report_key_mappings(id,provider,key_ref,starts,ends,body) VALUES(?,?,?,?,?,?)',
        mapping.id,
        'openai',
        mapping.apiKeyId,
        mapping.startsAt,
        mapping.endsAt,
        canonical(mapping),
      );
      this.ledger.db.append(mapping.companyId, 'openai_office_key_mapped', null, this.ledger.now(), {
        id: mapping.id,
        companyId: mapping.companyId,
        evidence: mapping.evidence,
      });
    });
  }
  previewMonth(snapshot: OpenAICostsSnapshot, period: string, policies: Record<string, string>) {
    requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(period), 'invalid_period');
    const totals = new Map<string, number>();
    for (const bucket of snapshot.buckets) {
      const at = bucket.startTime * 1000;
      if (periodAt(at) !== period) continue;
      for (const [key, usd] of Object.entries(bucket.byApiKeyId)) {
        totals.set(key, (totals.get(key) ?? 0) + Number(usd));
      }
    }
    const lines: OfficeLine[] = [];
    for (const [apiKeyIdValue, usd] of totals) {
      const start = Date.parse(`${period}-01T00:00:00Z`);
      const mapped = this.ledger.db.get<{ body: string }>(
        'SELECT body FROM report_key_mappings WHERE provider=? AND key_ref=? AND starts<=? AND ends>?',
        'openai',
        apiKeyIdValue,
        start,
        start,
      );
      if (!mapped) {
        lines.push({
          companyId: '',
          period,
          wholesaleUsd: usd.toFixed(8),
          retailNanoAud: '0',
          chargedNanoAud: '0',
          included: false,
          status: 'unmapped',
        });
        continue;
      }
      const mapping: OpenAIOfficeKey = JSON.parse(mapped.body);
      const tenant = this.ledger.tenant(mapping.companyId);
      const policyId = policies[mapping.companyId];
      requireThat(policyId, 'openai_policy_required', 409);
      const saved = this.ledger.db.get<{ body: string }>('SELECT body FROM report_policies WHERE id=?', policyId);
      requireThat(saved, 'openai_policy_required', 409);
      const policy: OpenAIRetailPolicy = JSON.parse(saved.body);
      requireThat(policy.companyId === mapping.companyId, 'openai_policy_scope_mismatch', 409);
      const wholesaleUsd = usd.toFixed(8);
      const retail = retailProposal({
        costNano: usdToNano(wholesaleUsd),
        fxNumerator: policy.fxNumerator,
        fxDenominator: policy.fxDenominator,
        method: policy.method,
        basisPoints: policy.basisPoints,
        apply: policy.apply,
      });
      const monthStart = start;
      const included = monthStart < tenant.includedUntil;
      let status: OfficeLine['status'] = 'ready';
      if (this.ledger.requests(mapping.companyId).some((r) => r.period === period)) status = 'meter_reconciliation_required';
      if (
        this.ledger.db.get(
          'SELECT id FROM statements WHERE tenant=? AND period>=? UNION ALL SELECT id FROM invoices WHERE tenant=? AND period>=?',
          mapping.companyId,
          period,
          mapping.companyId,
          period,
        )
      )
        status = 'period_closed';
      lines.push({
        companyId: mapping.companyId,
        period,
        wholesaleUsd,
        retailNanoAud: retail,
        chargedNanoAud: included ? '0' : retail,
        included,
        status,
      });
    }
    return { period, lines, previewDigest: digest({ period, lines }) };
  }
  recordPolicy(policy: OpenAIRetailPolicy) {
    [policy.version, policy.companyId, policy.fxSource].forEach(id);
    this.ledger.tenant(policy.companyId);
    retailProposal({ costNano: '0', ...policy });
    this.ledger.db.transaction(() => {
      const prior = this.ledger.db.get<{ body: string }>('SELECT body FROM report_policies WHERE id=?', policy.version);
      if (prior) {
        requireThat(prior.body === canonical(policy), 'report_policy_conflict', 409);
        return;
      }
      this.ledger.db.run('INSERT INTO report_policies(id,body) VALUES(?,?)', policy.version, canonical(policy));
      this.ledger.db.append(policy.companyId, 'private_report_policy_recorded', null, this.ledger.now(), {
        version: policy.version,
        companyId: policy.companyId,
      });
    });
  }
  commitMonth(snapshot: OpenAICostsSnapshot, period: string, policies: Record<string, string>, expectedDigest: string) {
    return this.ledger.db.transaction(() => {
      const preview = this.previewMonth(snapshot, period, policies);
      requireThat(preview.previewDigest === expectedDigest, 'openai_preview_changed', 409);
      requireThat(preview.lines.every((l) => l.status === 'ready'), 'openai_review_required', 409);
      const importDigest = digest({ provider: 'openai', period, preview: preview.previewDigest });
      if (this.ledger.db.get('SELECT digest FROM report_imports WHERE digest=?', importDigest)) {
        return { importDigest, duplicate: true };
      }
      this.ledger.db.run(
        'INSERT INTO report_imports(digest,body) VALUES(?,?)',
        importDigest,
        canonical({ schema: 'realbud-openai-costs-v1', period, importedAt: this.ledger.now() }),
      );
      for (const line of preview.lines) {
        const source = this.ledger.db.get<{ mode: string }>('SELECT mode FROM billing_sources WHERE tenant=? AND period=?', line.companyId, line.period);
        requireThat(!source || source.mode === 'report', 'billing_source_conflict', 409);
        if (!source) this.ledger.db.run("INSERT INTO billing_sources(tenant,period,mode) VALUES(?,?,'report')", line.companyId, line.period);
        this.ledger.db.append(line.companyId, 'report_usage_accepted', null, this.ledger.now(), {
          period: line.period,
          model: 'openai',
          rateVersion: `openai-${period}`,
          units: {},
          retailNanoAud: line.retailNanoAud,
          chargedNanoAud: line.chargedNanoAud,
          included: line.included,
          source: 'openai_costs',
        });
      }
      return { importDigest, duplicate: false };
    });
  }
  customerPreview(actor: PortalPrincipal, preview: { lines: OfficeLine[] }) {
    return {
      period: preview.lines[0]?.period ?? null,
      lines: preview.lines
        .filter((l) => l.companyId === actor.companyId && l.status === 'ready')
        .map((l) => ({ period: l.period, chargedNanoAud: l.chargedNanoAud, included: l.included })),
    };
  }
}
