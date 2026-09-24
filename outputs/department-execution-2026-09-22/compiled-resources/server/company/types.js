export class CompanyError extends Error {
    code;
    constructor(code, message = code) {
        super(message);
        this.code = code;
        this.name = 'CompanyError';
    }
}
