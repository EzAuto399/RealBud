// Receives selected bytes on stdin. Run only through pdf-text.ts's restricted
// subprocess: no filesystem writes, child processes or ambient secrets.
// The parser receives bytes only; external resource locations are never supplied.
import { getDocument } from 'unpdf/pdfjs';
let document, task;
try {
  const chunks=[]; let length=0;
  for await (const chunk of process.stdin) { length+=chunk.length; if(length>2_000_000)throw Error(); chunks.push(chunk); }
  // Only byte data is supplied; never a URL, password, CMap or font location.
  task=getDocument({data:new Uint8Array(Buffer.concat(chunks)),isEvalSupported:false,useWasm:false,
    useSystemFonts:false,disableFontFace:true,disableAutoFetch:true,disableStream:true,
    maxImageSize:1,stopAtErrors:true,verbosity:0});
  document=await task.promise;
  if(document.numPages<1||document.numPages>20)throw Error('page-limit');
  const pages=[];let size=0;
  for(let pageNo=1;pageNo<=document.numPages;pageNo++) {
    const page=await document.getPage(pageNo), content=await page.getTextContent();
    const text=content.items.map(item=>typeof item.str==='string'?item.str+(item.hasEOL?'\n':' '):'').join('').trim();
    // A scanned/blank page may contain invoice facts absent from the text layer.
    if(!text)throw Error('unreadable-page');
    size+=Buffer.byteLength(text);if(size>64_000)throw Error('text-limit');
    pages.push(text);page.cleanup();
  }
  process.stdout.write(JSON.stringify({text:pages.join('\n\n'),pages:document.numPages}));
} catch(error) {
  process.stdout.write(JSON.stringify({error:['page-limit','unreadable-page','text-limit'].includes(error?.message)?error.message:'unreadable-pdf'}));
  process.exitCode=1;
} finally {await task?.destroy?.().catch(()=>{});}
