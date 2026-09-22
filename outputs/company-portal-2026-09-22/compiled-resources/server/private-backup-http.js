import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { privateBackupDownloadSessionCookie } from "./session-auth.js";
import { createPrivateBackupV2Api } from "./private-backup-v2-api.js";
import { PRIVATE_BACKUP_TRANSFER_API, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES, PRIVATE_BACKUP_TRANSFER_ERRORS, parsePrivateBackupDownloadTicket } from "../shared/private-backup-transfers.js";
function fail(status) { throw Object.assign(new Error('The backup request could not be read.'), { status }); }
function body(req, maximum) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0, done = false;
        const timer = setTimeout(() => finish(Object.assign(new Error('Backup request timed out.'), { status: 408 })), 30_000);
        timer.unref();
        function finish(error) {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            req.off('data', data);
            req.off('end', end);
            req.off('error', failed);
            req.off('aborted', aborted);
            if (error) {
                for (const chunk of chunks)
                    chunk.fill(0);
                chunks.length = 0;
                req.resume();
                reject(error);
            }
            else {
                const result = Buffer.concat(chunks, bytes);
                for (const chunk of chunks)
                    chunk.fill(0);
                resolve(result);
            }
        }
        function data(chunk) { bytes += chunk.length; if (bytes > maximum)
            return finish(Object.assign(new Error('Backup request too large.'), { status: 413 })); chunks.push(Buffer.from(chunk)); }
        function end() { finish(); }
        function failed() { finish(Object.assign(new Error('Backup request interrupted.'), { status: 400 })); }
        function aborted() { failed(); }
        req.on('data', data);
        req.once('end', end);
        req.once('error', failed);
        req.once('aborted', aborted);
        if (req.aborted || req.destroyed)
            failed();
    });
}
/** The HTTP host MUST validate local session/Host/Origin before this handler.
 * No exception message is returned; it may contain a key, path or source data. */
export async function handlePrivateBackupV2Http(req, res, url, service) {
    if (url.pathname !== PRIVATE_BACKUP_TRANSFER_API && !url.pathname.startsWith(`${PRIVATE_BACKUP_TRANSFER_API}/`))
        return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    let raw;
    try {
        const method = req.method ?? 'GET', chunk = method === 'PUT' && /\/uploads\/[^/]+\/chunks$/.test(url.pathname);
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
            fail(400);
        if (!['GET', 'HEAD'].includes(method)) {
            if (chunk && req.headers['content-type']?.split(';')[0] !== 'application/octet-stream')
                fail(400);
            if (!chunk && req.headers['content-type']?.split(';')[0] !== 'application/json')
                fail(400);
            raw = await body(req, chunk ? PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES : 16 * 1024);
        }
        let parsed;
        if (raw && !chunk) {
            try {
                parsed = raw.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) : {};
            }
            catch {
                fail(400);
            }
        }
        const api = createPrivateBackupV2Api({ service: () => service });
        const result = await api({ path: url.pathname, method, query: url.searchParams, body: parsed, bytes: chunk ? raw : undefined, chunkDigest: req.headers['x-realbud-chunk-sha256'] });
        if (!result)
            return false;
        if ('downloadTicket' in result) {
            await service.download(result.downloadTicket, async (ticket, chunks, signal) => {
                res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': ticket.archiveBytes,
                    'content-disposition': `attachment; filename="${ticket.filename}"`, 'referrer-policy': 'no-referrer' });
                await pipeline(Readable.from(chunks), res, { signal });
            });
        }
        else {
            if (method === 'POST' && /\/operations\/[^/]+\/download-ticket$/.test(url.pathname) && result.status === 200) {
                const ticket = parsePrivateBackupDownloadTicket(result.body);
                if (!ticket)
                    fail(503);
                res.setHeader('set-cookie', privateBackupDownloadSessionCookie(ticket));
            }
            json(result.status, result.body);
        }
    }
    catch (error) {
        if (res.headersSent || res.destroyed) {
            res.destroy();
            return true;
        }
        const rawStatus = error?.status, status = [400, 404, 408, 409, 413, 500, 503, 507].includes(rawStatus ?? 0) ? rawStatus : 503;
        const code = status === 413 || status === 507 ? 'insufficient-space' : status === 400 ? 'invalid-backup' : status === 409 ? 'workspace-busy' : 'storage-unavailable';
        json(status, { error: PRIVATE_BACKUP_TRANSFER_ERRORS[code], code });
    }
    finally {
        raw?.fill(0);
    }
    return true;
}
