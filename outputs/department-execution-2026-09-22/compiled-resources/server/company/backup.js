import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { encryptJson, decryptJson, isEncryptedEnvelope } from "../desk-crypto.js";
import { companySchemaManifest } from "./schema.js";
// Data only, in foreign-key order. Restoring never executes uploaded SQL.
const TABLES = ['companies', 'members', 'sessions', 'invitations', 'scopes', 'scope_grants', 'knowledge_revisions', 'cases', 'claim_receipts', 'audit_events', 'member_credentials', 'workflow_templates', 'ownership_transfers', 'departure_receipts', 'portal_member_bindings', 'department_execution_grants', 'department_execution_claims', 'department_execution_events'];
const MAX_PLAIN_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 48 * 1024 * 1024;
export class OfficeBackupError extends Error {
}
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function passphraseKey(passphrase, salt) {
    if (typeof passphrase !== 'string' || passphrase.length < 16 || passphrase.length > 256)
        throw new OfficeBackupError('Use a backup passphrase of 16–256 characters and keep it separately from the backup.');
    return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
const table = (name) => `realbud_company.${name}`;
async function migrations(client) { return (await client.query('SELECT id,checksum FROM realbud_company.schema_migrations ORDER BY id')).rows; }
// Only this known, additive upgrade is admitted. Legacy rows must have their
// exact old fields before defaults are added; missing/extra fields never become
// an implicit assignment, access grant or retirement during restore.
const LEGACY_0005_COLUMNS = {
    scopes: ['company_id', 'id', 'owner_member_id', 'kind', 'name', 'revision', 'purpose'].sort(),
    cases: ['company_id', 'id', 'scope_id', 'title', 'status', 'fence', 'claim_token_hash', 'holder_member_id', 'lease_expires_at', 'outcome', 'created_at'].sort(),
};
function upgrade0005Rows(name, rows) {
    if (name !== 'scopes' && name !== 'cases')
        return rows;
    if (rows.some(row => !object(row) || Object.keys(row).sort().join(',') !== LEGACY_0005_COLUMNS[name].join(',') ||
        (name === 'cases' && !['open', 'claimed', 'recovery_required', 'done'].includes(String(row.status))))) {
        throw new OfficeBackupError('The backup contains unsupported fields or another office’s data.');
    }
    return rows.map(row => name === 'scopes'
        ? { ...row, retired_at: null, retired_by: null, retirement_note: '' }
        : { ...row, description: '', assignee_member_id: null });
}
async function transaction(pool, work, readonly = false) {
    const client = await pool.connect();
    try {
        await client.query(readonly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        await client.query("SET LOCAL statement_timeout='30s'");
        const value = await work(client);
        await client.query('COMMIT');
        return value;
    }
    catch (error) {
        await client.query('ROLLBACK').catch(() => { });
        throw error;
    }
    finally {
        client.release();
    }
}
export async function createOfficeBackup(pool, passphrase, companyId, sourceRetired) {
    const salt = randomBytes(16);
    const key = await passphraseKey(passphrase, salt);
    try {
        const snapshot = await transaction(pool, async (client) => {
            const result = { version: 1, companyId, createdAt: new Date().toISOString(), sourceRetired, migrations: await migrations(client), tables: {} };
            let bytes = 0, rows = 0;
            for (const name of TABLES) {
                const primary = await client.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY a.attnum`, [table(name)]);
                const columns = primary.rows.map(row => String(row.attname));
                if (!columns.length || columns.some(column => !/^[a-z_]+$/.test(column)))
                    throw new OfficeBackupError('The office schema needs service attention before backup.');
                result.tables[name] = [];
                for (let offset = 0;; offset += 500) {
                    const page = (await client.query(`SELECT * FROM ${table(name)} ORDER BY ${columns.map(column => `"${column}"`).join(',')} LIMIT 500 OFFSET $1`, [offset])).rows;
                    const serialized = JSON.stringify(page);
                    bytes += Buffer.byteLength(serialized);
                    rows += page.length;
                    if (bytes > MAX_PLAIN_BYTES || rows > 100_000)
                        throw new OfficeBackupError('This office exceeds the built-in backup limit of 32 MB or 100,000 records. Use an assisted database backup; no partial backup was issued.');
                    result.tables[name].push(...JSON.parse(serialized));
                    if (page.length < 500)
                        break;
                }
            }
            if (result.tables.companies.length !== 1 || result.tables.companies[0].id !== companyId)
                throw new OfficeBackupError('Back up one verified office at a time.');
            if (Buffer.byteLength(JSON.stringify(result)) > MAX_PLAIN_BYTES)
                throw new OfficeBackupError('The office exceeds the built-in backup size limit. Use an assisted database backup.');
            return { snapshot: result, rows };
        }, true);
        const backup = { format: 'realbud-office', version: 1, salt: salt.toString('hex'), payload: encryptJson(key, snapshot.snapshot) };
        const serialized = JSON.stringify(backup);
        if (Buffer.byteLength(serialized) > MAX_BACKUP_BYTES)
            throw new OfficeBackupError('The encrypted backup exceeds the supported size.');
        return { backup, receipt: { companyId, createdAt: snapshot.snapshot.createdAt, sourceRetired, records: snapshot.rows, sha256: createHash('sha256').update(serialized).digest('hex') } };
    }
    finally {
        key.fill(0);
    }
}
export async function restoreOfficeBackup(pool, backup, passphrase) {
    if (!object(backup) || backup.format !== 'realbud-office' || backup.version !== 1 || typeof backup.salt !== 'string' || !/^[a-f0-9]{32}$/.test(backup.salt) ||
        !isEncryptedEnvelope(backup.payload) || Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES)
        throw new OfficeBackupError('This is not a supported RealBud office backup.');
    const key = await passphraseKey(passphrase, Buffer.from(backup.salt, 'hex'));
    let snapshot;
    try {
        snapshot = decryptJson(key, backup.payload);
    }
    catch {
        throw new OfficeBackupError('The passphrase or backup integrity check failed. Existing data was not changed.');
    }
    finally {
        key.fill(0);
    }
    if (!snapshot || snapshot.version !== 1 || typeof snapshot.companyId !== 'string' || !/^[a-f0-9-]{36}$/.test(snapshot.companyId) || typeof snapshot.sourceRetired !== 'boolean' || typeof snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(snapshot.createdAt)) || !Array.isArray(snapshot.migrations) || !object(snapshot.tables) ||
        Buffer.byteLength(JSON.stringify(snapshot)) > MAX_PLAIN_BYTES ||
        !Object.values(snapshot.tables).every(Array.isArray))
        throw new OfficeBackupError('The backup manifest is invalid.');
    if (snapshot.tables.companies.length !== 1 || !object(snapshot.tables.companies[0]) || snapshot.tables.companies[0].id !== snapshot.companyId)
        throw new OfficeBackupError('The backup office identity is invalid.');
    const hash = createHash('sha256').update(JSON.stringify(backup)).digest('hex');
    return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('realbud-company-bootstrap',0))");
        const trusted = companySchemaManifest();
        const targetMatches = JSON.stringify(await migrations(client)) === JSON.stringify(trusted);
        const current = JSON.stringify(snapshot.migrations) === JSON.stringify(trusted);
        const knownLatest = trusted.map(migration => migration.id).join(',') === '0001,0002,0003,0004,0005,0006,0007,0008';
        const legacy0005 = knownLatest && JSON.stringify(snapshot.migrations) === JSON.stringify(trusted.slice(0, 5));
        const legacy0006 = knownLatest && JSON.stringify(snapshot.migrations) === JSON.stringify(trusted.slice(0, 6));
        const legacy0007 = knownLatest && JSON.stringify(snapshot.migrations) === JSON.stringify(trusted.slice(0, 7));
        if (!targetMatches || (!current && !legacy0005 && !legacy0006 && !legacy0007))
            throw new OfficeBackupError('Use a matching RealBud schema version to restore this backup before upgrading.');
        const older = legacy0005 || legacy0006;
        const beforeExecution = older || legacy0007;
        const executionTable = (name) => name.startsWith('department_execution_');
        const expectedTables = TABLES.filter(name => !(older && name === 'portal_member_bindings') && !(beforeExecution && executionTable(name)));
        if (Object.keys(snapshot.tables).sort().join(',') !== expectedTables.sort().join(','))
            throw new OfficeBackupError('The backup contains unsupported fields or another office’s data.');
        const restoredAuthority = randomUUID();
        let records = 0;
        for (const name of TABLES) {
            if ((await client.query(`SELECT 1 FROM ${table(name)} LIMIT 1`)).rowCount)
                throw new OfficeBackupError('Restore requires a new, empty host. Existing office data will not be overwritten.');
            const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='realbud_company' AND table_name=$1", [name])).rows.map(row => row.column_name).sort();
            let rows = (older && name === 'portal_member_bindings' || beforeExecution && executionTable(name)) ? [] : snapshot.tables[name];
            if (beforeExecution && name === 'members') {
                const legacyColumns = columns.filter(column => column !== 'execution_epoch').join(',');
                if (rows.some(row => !object(row) || Object.keys(row).sort().join(',') !== legacyColumns))
                    throw new OfficeBackupError('The backup contains unsupported fields or another office’s data.');
                rows = rows.map(row => ({ ...row, execution_epoch: 0 }));
            }
            if (legacy0005)
                rows = upgrade0005Rows(name, rows);
            if (older && name === 'companies') {
                if (rows.some(row => !object(row) || Object.keys(row).sort().join(',') !== 'created_at,id,name'))
                    throw new OfficeBackupError('The backup contains unsupported fields or another office’s data.');
                rows = rows.map(row => ({ ...row, remote_authority_incarnation: restoredAuthority, portal_issuer: null, portal_company_id: null }));
            }
            records += rows.length;
            if (records > 100_000 || rows.some(row => !object(row) || Object.keys(row).sort().join(',') !== columns.join(',') || (name !== 'companies' && row.company_id !== snapshot.companyId)))
                throw new OfficeBackupError('The backup contains unsupported fields or another office’s data.');
            for (let offset = 0; offset < rows.length; offset += 500) {
                await client.query(`INSERT INTO ${table(name)} SELECT * FROM json_populate_recordset(NULL::${table(name)},$1::json)`, [JSON.stringify(rows.slice(offset, offset + 500))]);
            }
        }
        await client.query('UPDATE realbud_company.companies SET remote_authority_incarnation=$1', [restoredAuthority]);
        await client.query('UPDATE realbud_company.portal_member_bindings SET revoked_at=clock_timestamp(),revision=revision+1 WHERE revoked_at IS NULL');
        await client.query('UPDATE realbud_company.department_execution_grants SET revoked_at=clock_timestamp(),revision=revision+1 WHERE revoked_at IS NULL');
        await client.query('UPDATE realbud_company.sessions SET revoked_at=clock_timestamp()');
        await client.query('UPDATE realbud_company.invitations SET revoked_at=clock_timestamp() WHERE redeemed_at IS NULL');
        await client.query("UPDATE realbud_company.cases SET status='recovery_required',fence=fence+1,claim_token_hash=NULL,lease_expires_at=NULL WHERE status='claimed'");
        await client.query('UPDATE realbud_company.ownership_transfers SET revoked_at=clock_timestamp() WHERE accepted_at IS NULL');
        const owners = await client.query("SELECT id FROM realbud_company.members WHERE company_id=$1 AND role='owner' AND active", [snapshot.companyId]);
        if (owners.rowCount !== 1)
            throw new OfficeBackupError('A restored office must have exactly one active owner.');
        const receipt = { companyId: snapshot.companyId, backupCreatedAt: snapshot.createdAt, restoredAt: new Date().toISOString(), backupSha256: hash, sourceRetired: snapshot.sourceRetired === true, records };
        await client.query('INSERT INTO realbud_company.audit_events(id,company_id,kind,details) VALUES($1,$2,$3,$4)', [randomUUID(), snapshot.companyId, 'host.restored', JSON.stringify(receipt)]);
        return receipt;
    });
}
/** Resolve a crash after COMMIT and before the local lifecycle receipt was saved. */
export async function officeRestoreReceipt(pool, backupSha256) {
    const result = await pool.query("SELECT details FROM realbud_company.audit_events WHERE kind='host.restored' AND details->>'backupSha256'=$1 ORDER BY created_at DESC LIMIT 1", [backupSha256]);
    return result.rows[0]?.details;
}
