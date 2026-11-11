import type { ClientRequest } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { VicUnknownOutcomeError, VicValidationError, type VicHttpRequest, type VicHttpResponse, type VicTransport } from './types.js';

export interface VicMtlsTransportOptions {
    /** Trusted backend configuration, never a URL taken from agent/tool input. */
    baseUrl?: string;
    /** PEM certificate/key buffers also accept Node Buffer, which extends Uint8Array. */
    cert: string | Uint8Array;
    key: string | Uint8Array;
    ca?: string | Uint8Array | Array<string | Uint8Array>;
    passphrase?: string;
    /** Optional VDP account credentials as required by the onboarded integration. */
    basicAuth?: { username: string; password: string };
    timeoutMs?: number;
    maxBodyBytes?: number;
}

/** Dedicated TLS agent; certificate and hostname verification are always enabled. */
export class VicMtlsTransport implements VicTransport {
    private readonly origin: URL;
    private readonly agent: Agent;
    private readonly timeoutMs: number;
    private readonly maxBodyBytes: number;
    private readonly auth?: string;
    constructor(options: VicMtlsTransportOptions) {
        try { this.origin = new URL(options.baseUrl ?? 'https://sandbox.api.visa.com'); }
        catch { throw new VicValidationError(['baseUrl: expected a valid HTTPS origin']); }
        if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password
            || this.origin.search || this.origin.hash || this.origin.pathname !== '/')
            throw new VicValidationError(['baseUrl: expected HTTPS origin without credentials, path, query or fragment']);
        if (!options.cert || !options.key) throw new VicValidationError(['cert and key: required for mutual TLS']);
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647
            || !Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1)
            throw new VicValidationError(['timeoutMs and maxBodyBytes must be positive bounded integers']);
        if (options.basicAuth) {
            if (!options.basicAuth.username || !options.basicAuth.password || options.basicAuth.username.includes(':'))
                throw new VicValidationError(['basicAuth: expected username and password']);
            this.auth = `${options.basicAuth.username}:${options.basicAuth.password}`;
        }
        const pem = (value: string | Uint8Array) => typeof value === 'string' ? value : Buffer.from(value);
        this.agent = new Agent({ cert: pem(options.cert), key: pem(options.key),
            ca: options.ca === undefined ? undefined : Array.isArray(options.ca) ? options.ca.map(pem) : pem(options.ca),
            passphrase: options.passphrase, rejectUnauthorized: true, minVersion: 'TLSv1.2', keepAlive: true });
    }
    close(): void { this.agent.destroy(); }
    async send(input: VicHttpRequest): Promise<VicHttpResponse> {
        input.signal?.throwIfAborted();
        if (!/^\/vacp\/v2\/(credentials-for-instruction|instructions\/[^/?#]+\/(credentials|confirmation|cancel))$/.test(input.path)
            || !['POST', 'PUT'].includes(input.method)) throw new VicValidationError(['path/method: unsupported Direct VIC request']);
        let body: string;
        try { body = JSON.stringify(input.body); } catch { throw new VicValidationError(['body: expected JSON']); }
        if (typeof body !== 'string' || Buffer.byteLength(body) > this.maxBodyBytes) throw new VicValidationError(['body: maximum size exceeded']);
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (error?: unknown, result?: VicHttpResponse) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                input.signal?.removeEventListener('abort', abort);
                if (error) reject(error); else resolve(result!);
            };
            const failure = () => finish(new VicUnknownOutcomeError(input.operation));
            let req: ClientRequest;
            const abort = () => { req?.destroy(); failure(); };
            try {
                req = httpsRequest(new URL(input.path, this.origin), {
                    method: input.method, agent: this.agent, auth: this.auth,
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) },
                }, response => {
                    let bytes = 0;
                    const chunks: Buffer[] = [];
                    response.on('data', (chunk: Buffer) => {
                        bytes += chunk.length;
                        if (bytes > this.maxBodyBytes) { response.destroy(); req.destroy(); failure(); }
                        else chunks.push(chunk);
                    });
                    response.on('error', failure);
                    response.on('aborted', failure);
                    response.on('end', () => {
                        if (settled) return;
                        let parsed: unknown;
                        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                        catch { failure(); return; }
                        finish(undefined, { status: response.statusCode ?? 0, body: parsed });
                    });
                });
            } catch { failure(); return; }
            req.on('error', failure);
            timer = setTimeout(abort, this.timeoutMs);
            input.signal?.addEventListener('abort', abort, { once: true });
            if (input.signal?.aborted) { abort(); return; }
            req.end(body);
        });
    }
}
