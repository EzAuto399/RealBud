import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgencySetupSettings } from '../shared/agency-setup.ts';
import type { BillMailSource, BillSourceEvidence } from '../shared/source-bills.ts';
import { previewBillSource } from './source-bill-rules.ts';
import { validateSourcePdfEvidence, type SourcePdfEvidence } from './source-attachments.ts';

export interface BillProposalReceipt {
  payloadDigest: string; sourceDigest: string; recipeId: string; recipeRevision: number;
  sourceReference: string; authorityDigest: string; input: Record<string, unknown>;
  attachmentEvidence?: { source: BillSourceEvidence; pdfs: SourcePdfEvidence[] };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hold = (): never => { throw Object.assign(new Error('The saved invoice preparation failed its integrity check. Keep its evidence and recover the saved data.'), { status: 503 }); };
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return hold();
  return value;
};
const text = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || !empty && !value.trim()) return hold();
  return value;
};
const isoDate = (value: unknown): string => {
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || Date.parse(value) < 0 || new Date(value).toISOString() !== value) return hold();
  return value;
};

/** Bounded source input includes only text extracted by the host, never a worker-supplied file path. */
export function billProposalInput(settings: Pick<AgencySetupSettings, 'timeZone' | 'agencyName' | 'propertyReferences'>, source: BillSourceEvidence, asOf: string, pdfs: SourcePdfEvidence[] = []): Record<string, unknown> {
  for(const pdf of pdfs) {
    const attachment=source.message.attachments.find(a=>a.id===pdf.attachment.id);
    if(!attachment)return hold();
    validateSourcePdfEvidence(pdf,{accountId:source.accountId,threadId:source.threadId,messageId:source.message.id,attachment:attachment as SourcePdfEvidence['attachment']});
  }
  return { version: 1, sourceReference: `realbud-bill:${source.digest}`, asOf, timezone: settings.timeZone, agency: { name: settings.agencyName },
    coverage: { complete: false, agreedAccounts: [source.accountId], accounts: [{ accountId: source.accountId, expectedThreadCount: 1, returnedThreadCount: 1, paginationComplete: true, threadHistoryComplete: false }],
      failedSources: ['Selected saved message only; this preparation does not establish whole-inbox or complete invoice coverage.'], missingAttachments: source.message.attachments.filter(a=>!pdfs.some(p=>p.attachment.id===a.id)).map(a => a.id) },
    documentCount: 1, documents: [{ documentId: `mail-${source.identity}`, sourceId: source.message.id, accountId: source.accountId, threadId: source.threadId, body: source.message.body, subject: source.message.subject, sender: source.message.from, receivedAt: new Date(source.message.at).toISOString(), bodyTruncated: source.message.bodyTruncated, attachmentIds: source.message.attachments.map(a => a.id) }],
    attachments: source.message.attachments.map(a => {
      const pdf=pdfs.find(p=>p.attachment.id===a.id);
      return pdf?{attachmentId:a.id,fileName:a.name,status:'read',text:pdf.text,pages:pdf.pages,sha256:pdf.sha256,textSha256:pdf.textSha256,trust:'untrusted-source-content'}:{ attachmentId: a.id, fileName: a.name, status: 'not-read' };
    }), allowedAttachmentPaths: [],
    propertyMap: settings.propertyReferences.map(p => ({ propertyId: p.propertyId, reference: p.reference, aliases: p.aliases })),
  };
}

/** Pure persisted-input validation shared by live replay/admission and backup.
 * Legacy inputs omit attachment MIME/size and the full approved authority. Their
 * digests cannot be reconstructed here; live admission also compares the entire
 * input to the current trusted source and authority, preserving the saved asOf. */
export function validateSavedBillProposal(id: string, value: unknown): BillProposalReceipt {
  try {
    if (!/^bill-proposal:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) return hold();
    const r = exact(value, ['payloadDigest', 'sourceDigest', 'recipeId', 'recipeRevision', 'sourceReference', 'authorityDigest', 'input',...(object(value)&&Object.hasOwn(value,'attachmentEvidence')?['attachmentEvidence']:[])]);
    if (![r.payloadDigest, r.sourceDigest, r.authorityDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) ||
        typeof r.recipeId !== 'string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(r.recipeId) || !Number.isSafeInteger(r.recipeRevision) || Number(r.recipeRevision) < 1 || r.sourceReference !== `realbud-bill:${r.sourceDigest}` || !object(r.input)) return hold();
    const input = r.input;
    if(r.attachmentEvidence!==undefined) {
      const evidence=exact(r.attachmentEvidence,['source','pdfs']);
      if(!object(evidence.source)||!Array.isArray(evidence.pdfs)||evidence.pdfs.length!==1)return hold();
      const source=previewBillSource(evidence.source as unknown as BillMailSource);
      if(source.digest!==r.sourceDigest||!isDeepStrictEqual(source,evidence.source))return hold();
      const settings={agencyName:object(input.agency)?input.agency.name:'',timeZone:input.timezone,propertyReferences:input.propertyMap} as Pick<AgencySetupSettings,'agencyName'|'timeZone'|'propertyReferences'>;
      const baseInput=billProposalInput(settings,source,String(input.asOf));
      const {attachmentEvidence:_,...legacy}=r;
      validateSavedBillProposal(id,{...legacy,input:baseInput});
      const expected=billProposalInput(settings,source,String(input.asOf),evidence.pdfs as SourcePdfEvidence[]);
      if(!isDeepStrictEqual(input,expected))return hold();
      return r as unknown as BillProposalReceipt;
    }
    if (!Array.isArray(input.documents) || input.documents.length !== 1 || !object(input.documents[0]) || !Array.isArray(input.attachments) || input.attachments.length > 100 || !Array.isArray(input.propertyMap) || input.propertyMap.length > 2000) return hold();
    const doc = input.documents[0], agency = exact(input.agency, ['name']);
    const attachments = input.attachments.map(raw => {
      const row = exact(raw, ['attachmentId', 'fileName', 'status']);
      if (row.status !== 'not-read') return hold();
      return { id: text(row.attachmentId, 512), name: text(row.fileName, 255, true), mimeType: '', size: null };
    });
    const source = previewBillSource({ accountId: text(doc.accountId, 200), threadId: text(doc.threadId, 200), receiptId: 'retained-proposal-validation',
      message: { id: text(doc.sourceId, 200), at: Date.parse(isoDate(doc.receivedAt)), from: text(doc.sender, 2048, true), subject: text(doc.subject, 2048, true), body: text(doc.body, 12000, true), bodyTruncated: doc.bodyTruncated as boolean, attachments } });
    if (typeof doc.bodyTruncated !== 'boolean' || doc.documentId !== `mail-${hash([source.accountId, source.threadId, source.message.id])}` || !attachments.length && source.digest !== r.sourceDigest) return hold();
    const propertyMap = input.propertyMap.map(raw => {
      const row = exact(raw, ['propertyId', 'reference', 'aliases']);
      if (!Array.isArray(row.aliases) || row.aliases.length > 20) return hold();
      return { propertyId: text(row.propertyId, 120), reference: text(row.reference, 100), aliases: row.aliases.map(alias => text(alias, 200)) };
    });
    if (new Set(propertyMap.map(p => p.propertyId)).size !== propertyMap.length) return hold();
    const timeZone = text(input.timezone, 100, true);
    if (timeZone) { if (timeZone !== 'UTC' && !timeZone.includes('/')) return hold(); new Intl.DateTimeFormat('en', { timeZone }).format(0); }
    const expected = billProposalInput({ agencyName: text(agency.name, 120, true), timeZone, propertyReferences: propertyMap }, { ...source, digest: r.sourceDigest as string }, isoDate(input.asOf));
    if (!isDeepStrictEqual(input, expected)) return hold();
    return r as unknown as BillProposalReceipt;
  } catch { return hold(); }
}
