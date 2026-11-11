/** Test-only HTTP boundary. Synthetic commerce; never accepts real cards or contacts Visa. */
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSimulatedCommerce, type SimulatedCommerceOptions } from '../../dist/agent/simulation.js';
import type { ConsumerAuthenticator, MerchantCheckoutConnector, PaymentAuthorizationProvider } from '../../src/agent/types.ts';

export async function createReferenceMerchant(options: SimulatedCommerceOptions = {}) {
    const commerce = createSimulatedCommerce(options);
    let disconnectCompletion = false;
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const chunk of request) {
                const buffer = Buffer.from(chunk);
                length += buffer.length;
                if (length > 65_536) throw new Error('Reference request too large');
                chunks.push(buffer);
            }
            const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            let output: unknown;
            switch (request.url) {
                case '/quote': output = await commerce.merchant.quote(input); break;
                case '/refresh': output = await commerce.merchant.refresh(input); break;
                case '/authenticate': output = await commerce.authenticate(input); break;
                case '/authorize': output = await commerce.payments.authorize(input); break;
                case '/complete': {
                    output = await commerce.merchant.complete(input);
                    if (disconnectCompletion) { disconnectCompletion = false; response.destroy(); return; }
                    break;
                }
                case '/lookup': output = await commerce.merchant.lookup(input) ?? null; break;
                case '/confirm': await commerce.payments.confirm!(input); output = null; break;
                default: response.writeHead(404).end(); return;
            }
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(output));
        } catch {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'REFERENCE_REQUEST_REJECTED' }));
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function send(path: string, input: { signal?: AbortSignal } & object): Promise<any> {
        const { signal, ...payload } = input;
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const request = httpRequest(origin + path, { method: 'POST', signal,
                headers: { 'content-type': 'application/json' } }, response => {
                const buffers: Buffer[] = [];
                response.on('data', chunk => buffers.push(Buffer.from(chunk)));
                response.on('error', reject);
                response.on('end', () => {
                    if (response.statusCode !== 200) { reject(new Error('Reference merchant rejected request')); return; }
                    try { resolve(JSON.parse(Buffer.concat(buffers).toString('utf8'))); } catch { reject(new Error('Invalid reference response')); }
                });
            });
            request.setTimeout(5_000, () => request.destroy(new Error('Reference request timed out')));
            request.on('error', reject);
            request.end(JSON.stringify(payload));
        });
    }
    const merchant: MerchantCheckoutConnector = {
        id: commerce.merchant.id,
        quote: input => send('/quote', input),
        refresh: input => send('/refresh', input),
        complete: input => send('/complete', input),
        lookup: async input => await send('/lookup', input) ?? undefined,
    };
    const payments: PaymentAuthorizationProvider = {
        id: commerce.payments.id,
        authorize: input => send('/authorize', input),
        confirm: async input => { await send('/confirm', input); },
    };
    const authenticate: ConsumerAuthenticator = input => send('/authenticate', input);
    return { origin, merchant, payments, authenticate, commerce,
        disconnectNextCompletionResponse() { disconnectCompletion = true; },
        close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}
