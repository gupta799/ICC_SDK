import contracts from '../generated/contracts.json' with { type: 'json' };
import { TransportConfigurationError, type Operation, type Transport, type Request, type Response } from '../types.js';

type CallbackResponse = {
    status?: number;
    statusCode?: number;
    text?: unknown;
    body?: unknown;
    data?: unknown;
    header?: unknown;
    headers?: unknown;
};
type OfficialMethod = (...args: unknown[]) => unknown;
type ApiInstance = Record<string, unknown>;

export interface OfficialClientTransportOptions {
    /** Bounds callback waits, including failures before the official client calls back.
     * This does not cancel a request or establish that a timed-out mutation failed. */
    timeoutMs?: number;
}

function responseBody(data: unknown, response?: CallbackResponse): unknown {
    // Official model conversion discards unknown provider fields. The translated
    // response text retains the original decrypted JSON, including error bodies.
    if (typeof response?.text === 'string' && response.text.length > 0) {
        try { return JSON.parse(response.text); }
        catch { return response.text; }
    }
    return response?.data ?? response?.body ?? data;
}

function responseHeaders(response?: CallbackResponse): Record<string, string> {
    const source = response?.headers ?? response?.header;
    if (!source || typeof source !== 'object') return {};
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (typeof value === 'string' || typeof value === 'number') result[name.toLowerCase()] = String(value);
        else if (Array.isArray(value) && value.every(item => typeof item === 'string')) result[name.toLowerCase()] = value.join(', ');
    }
    return result;
}

/** Adapts caller-configured official CyberSource API instances.
 * Use a dedicated ApiClient per tenant with JWT and required request/response MLE.
 * Network/authentication configuration remains the caller's responsibility.
 * Does not log payment data or retry mutations. */
export class OfficialClientTransport implements Transport {
    private readonly apis: Partial<Record<Operation, object>>;
    private readonly timeoutMs: number;

    constructor(apis: Partial<Record<Operation, object>>, options: OfficialClientTransportOptions = {}) {
        this.apis = { ...apis };
        this.timeoutMs = options.timeoutMs ?? 30_000;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647)
            throw new TransportConfigurationError('timeoutMs must be a positive integer no greater than 2147483647');
        for (const [operation, value] of Object.entries(this.apis)) {
            const api = value as ApiInstance | undefined;
            if (!api || typeof api[operation] !== 'function')
                throw new TransportConfigurationError(`Missing official API method for ${operation}`);
        }
    }

    async send(request: Request): Promise<Response> {
        request.signal?.throwIfAborted();
        const api = this.apis[request.operation] as ApiInstance | undefined;
        const fn = api?.[request.operation] as OfficialMethod | undefined;
        if (typeof fn !== 'function')
            throw new TransportConfigurationError(`Missing configured official API instance for ${request.operation}`);
        const meta = contracts[request.operation];
        if (!meta || request.method !== meta.method)
            throw new TransportConfigurationError('Request does not match the official operation contract');
        const pathValues: Record<string, string> = {};
        const segments = meta.path.split('/');
        const values = request.path.split('/');
        if (segments.length !== values.length)
            throw new TransportConfigurationError('Request path does not match the official operation contract');
        segments.forEach((segment, index) => {
            const match = segment.match(/^\{(.+)\}$/);
            if (match) {
                try { pathValues[match[1]] = decodeURIComponent(values[index]); }
                catch { throw new TransportConfigurationError('Request path has invalid encoding'); }
                if (!pathValues[match[1]]) throw new TransportConfigurationError('Request path parameter is empty');
            } else if (segment !== values[index]) {
                throw new TransportConfigurationError('Request path does not match the official operation contract');
            }
        });
        const args: unknown[] = [];
        const opts: Record<string, unknown> = {};
        for (const parameter of meta.parameters) {
            const value = parameter.in === 'path' ? pathValues[parameter.name]
                : parameter.in === 'body' ? request.body
                : parameter.in === 'header' ? Object.entries(request.headers).find(([name]) => name.toLowerCase() === parameter.name.toLowerCase())?.[1]
                : request.query[parameter.name];
            if (parameter.required) args.push(value);
            else if (value !== undefined) {
                const camel = parameter.name.replace(/[-_]([a-zA-Z])/g, (_, character: string) => character.toUpperCase());
                opts[camel[0].toLowerCase() + camel.slice(1)] = value;
            }
        }
        if (meta.parameters.some(parameter => !parameter.required)) args.push(opts);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Official client callback timed out; request outcome is not established')), this.timeoutMs);
            const callback = (error: unknown, data: unknown, response?: CallbackResponse) => {
                clearTimeout(timer);
                const status = response?.status ?? response?.statusCode;
                if (Number.isInteger(status) && status! >= 100 && status! <= 599 && (!error || status! >= 400)) {
                    resolve({ status: status!, body: responseBody(data, response), headers: responseHeaders(response) });
                } else reject(new Error(error ? 'Official client request failed without a usable HTTP response' : 'Official client omitted a valid HTTP status'));
            };
            try {
                const pending = fn.apply(api, [...args, callback]);
                if (pending && typeof (pending as { then?: unknown }).then === 'function') {
                    Promise.resolve(pending).catch(() => {
                        clearTimeout(timer);
                        reject(new Error('Official client request failed'));
                    });
                }
            }
            catch {
                clearTimeout(timer);
                // Arbitrary SDK throws may occur after dispatch. Only explicit
                // configuration checks above are safe pre-dispatch failures.
                reject(new Error('Official client request failed'));
            }
        });
    }
}
