import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { generate } from '../vendor/selfsigned.mjs';
/** Native Node implementation on both OSs; never installs an OS trust root. */
export async function createHostCertificate(hostname) {
    if (typeof hostname !== 'string' || hostname.length > 253 || (!isIP(hostname) &&
        !hostname.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))))
        throw new Error('Enter this computer’s network name or IP address.');
    const now = Date.now();
    // selfsigned@5 breaks BasicConstraints under current @peculiar; 2.4.1 is sync RSA.
    const material = generate([{ name: 'commonName', value: hostname }], {
        keySize: 2048, algorithm: 'sha256',
        days: 365, notBeforeDate: new Date(now - 60_000),
        extensions: [
            { name: 'basicConstraints', cA: false, critical: true },
            { name: 'keyUsage', digitalSignature: true, critical: true },
            { name: 'extKeyUsage', serverAuth: true },
            { name: 'subjectAltName', altNames: [isIP(hostname) ? { type: 7, ip: hostname } : { type: 2, value: hostname }] },
        ],
    });
    validateHostCertificate(material.cert, material.private, hostname);
    return { cert: material.cert, key: material.private };
}
export function validateHostCertificate(cert, key, hostname, options = {}) {
    const certificate = new X509Certificate(cert);
    const validHost = isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname, { wildcards: false });
    if (!validHost || Date.parse(certificate.validFrom) > Date.now() || (!options.allowExpired && Date.parse(certificate.validTo) <= Date.now()) ||
        !certificate.checkPrivateKey(createPrivateKey(key)) || !certificate.verify(createPublicKey(cert))) {
        throw new Error('The host certificate needs service attention. Existing company data has been preserved.');
    }
}
export function parseCompanyPairing(code, options = {}) {
    if (typeof code !== 'string' || code.length > 12_000 || !/^RB1\.[A-Za-z0-9_-]+$/.test(code))
        throw new Error('This host code is invalid. Copy it again from the host computer.');
    try {
        const value = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString('utf8'));
        if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'certificatePem,companyId,origin,version' ||
            typeof value.certificatePem !== 'string' || value.certificatePem.length > 8000 ||
            typeof value.companyId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.companyId) || typeof value.origin !== 'string')
            throw new Error();
        const url = new URL(value.origin);
        if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password || !url.hostname)
            throw new Error();
        const cert = new X509Certificate(value.certificatePem);
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        if (!(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname, { wildcards: false })) ||
            (!options.allowExpired && Date.parse(cert.validTo) <= Date.now()) || Date.parse(cert.validFrom) > Date.now())
            throw new Error();
        return value;
    }
    catch {
        throw new Error('This host code is invalid or expired. Copy a current code from the host computer.');
    }
}
export function encodeCompanyPairing(value) {
    const code = 'RB1.' + Buffer.from(JSON.stringify(value)).toString('base64url');
    parseCompanyPairing(code);
    return code;
}
