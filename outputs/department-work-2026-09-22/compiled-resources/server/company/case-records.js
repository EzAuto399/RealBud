import { CompanyError } from "./types.js";
/** Call only after the scope is locked and current write authority is checked. */
export async function insertCaseRecord(client, actor, input) {
    try {
        await client.query(`INSERT INTO realbud_company.cases(company_id,id,scope_id,title,description,assignee_member_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [actor.companyId, input.id, input.scopeId, input.title, input.description ?? '', input.assigneeMemberId ?? null]);
    }
    catch (error) {
        // A reused request can collide with an invisible case. Do not expose it or
        // turn the conflict into an uncertain server error; the transaction aborts.
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
            throw new CompanyError('conflict');
        throw error;
    }
}
