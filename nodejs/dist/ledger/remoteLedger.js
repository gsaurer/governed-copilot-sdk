/** Sends evidence records to a governance ledger endpoint instead of writing them locally. */
export class RemoteLedger {
    endpoint;
    options;
    constructor(endpoint, options = {}) {
        this.endpoint = endpoint;
        this.options = options;
    }
    async append(record) {
        try {
            const response = await fetch(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...record, source: this.options.source }),
            });
            if (!response.ok)
                throw new Error(`ledger_rejected_record:${response.status}`);
        }
        catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (!this.options.onError)
                throw failure;
            this.options.onError(failure);
        }
    }
}
