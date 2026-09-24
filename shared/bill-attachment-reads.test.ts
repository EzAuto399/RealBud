import { describe, expect, it } from 'vitest';
import { billAttachmentReads } from './bill-proposals.ts';
const row={attachmentId:'fictional-pdf',fileName:'fictional.pdf',pages:1,text:'Fictional bill text',sha256:'a'.repeat(64)};
describe('PDF reading UI projection',()=>{
  it('keeps legacy receipts compatible and projects verified text',()=>{expect(billAttachmentReads(undefined)).toEqual([]);expect(billAttachmentReads([row])).toEqual([row]);});
  it.each([null,{},[row,row],[{...row,pages:0}],[{...row,text:''}],[{...row,fileName:'../other.pdf'}],[{...row,bytesBase64:'hidden'}]])('rejects malformed or overbroad result %j',value=>expect(()=>billAttachmentReads(value)).toThrow());
});
