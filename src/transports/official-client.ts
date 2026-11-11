import contracts from '../generated/contracts.json' with { type: 'json' };
import type { Operation, Transport, Request, Response } from '../types.js';
/** Adapts configured official CyberSource API instances (JWT and MLE enabled).
 * Instances use a dedicated ApiClient per tenant to avoid shared singleton configuration.
 * Does not log payment data or retry mutations. */
export class OfficialClientTransport implements Transport {
    private apis: Partial<Record<Operation, object>>;
    constructor(apis: Partial<Record<Operation, object>>) { this.apis = apis; }
    async send(request: Request): Promise<Response> {
        const api = this.apis[request.operation] as Record<string, Function> | undefined;
        const fn = api?.[request.operation];
        if (!fn)
            throw new Error('Missing configured official API instance');
        const meta = contracts[request.operation];
        const pathValues: Record<string, string> = {};
        const segments = meta.path.split('/');
        request.path.split('/').forEach((v, i) => { const match = segments[i]?.match(/^\{(.+)\}$/); if (match)
            pathValues[match[1]] = decodeURIComponent(v); });
        const args: unknown[] = [];
        const opts: Record<string, unknown> = {};
        for (const p of meta.parameters) {
            const val = p.in === 'path' ? pathValues[p.name] : p.in === 'body' ? (request.body ?? {}) : p.in === 'header' ? Object.entries(request.headers).find(([k]) => k.toLowerCase() === p.name.toLowerCase())?.[1] : request.query[p.name];
            if (p.required)
                args.push(val);
            else {
                const camel = p.name.replace(/[-_]([a-zA-Z])/g, (_, c: string) => c.toUpperCase());
                const name = camel[0].toLowerCase() + camel.slice(1);
                if (val !== undefined)
                    opts[name] = val;
            }
        }
        if (meta.parameters.some(p => !p.required))
            args.push(opts);
        return new Promise((resolve, reject) => fn.apply(api, [...args, (error: unknown, data: unknown, response?: {
                status?: number;
                statusCode?: number;
            }) => {
                const status = response?.status ?? response?.statusCode;
                if (status)
                    resolve({ status, body: data });
                else if (error)
                    reject(error);
                else
                    reject(new Error('Official client omitted HTTP status'));
            }]));
    }
}
