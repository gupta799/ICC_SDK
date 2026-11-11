import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Generate fresh, disposable localhost identities. No certificate or key is stored in the repository. */
export function createVicTestCertificates(): {
    ca: Buffer; serverCert: Buffer; serverKey: Buffer; clientCert: Buffer; clientKey: Buffer;
} {
    const directory = mkdtempSync(join(tmpdir(), 'icc-vic-tls-'));
    const path = (name: string) => join(directory, name);
    const openssl = (...args: string[]) => execFileSync('openssl', args, {
        stdio: 'ignore', timeout: 15_000,
    });
    try {
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
            '-keyout', path('ca-key.pem'), '-out', path('ca-cert.pem'), '-days', '2',
            '-subj', '/CN=ICC SDK disposable test CA',
            '-addext', 'basicConstraints=critical,CA:TRUE',
            '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
        openssl('req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
            '-keyout', path('server-key.pem'), '-out', path('server.csr'), '-subj', '/CN=localhost');
        writeFileSync(path('server.ext'), [
            'subjectAltName=DNS:localhost,IP:127.0.0.1',
            'extendedKeyUsage=serverAuth', 'keyUsage=digitalSignature,keyEncipherment', '',
        ].join('\n'), { mode: 0o600 });
        openssl('x509', '-req', '-sha256', '-in', path('server.csr'),
            '-CA', path('ca-cert.pem'), '-CAkey', path('ca-key.pem'), '-set_serial', '2',
            '-out', path('server-cert.pem'), '-days', '2', '-extfile', path('server.ext'));
        openssl('req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
            '-keyout', path('client-key.pem'), '-out', path('client.csr'),
            '-subj', '/CN=ICC SDK disposable test client');
        writeFileSync(path('client.ext'), 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature,keyEncipherment\n', { mode: 0o600 });
        openssl('x509', '-req', '-sha256', '-in', path('client.csr'),
            '-CA', path('ca-cert.pem'), '-CAkey', path('ca-key.pem'), '-set_serial', '3',
            '-out', path('client-cert.pem'), '-days', '2', '-extfile', path('client.ext'));
        return { ca: readFileSync(path('ca-cert.pem')), serverCert: readFileSync(path('server-cert.pem')),
            serverKey: readFileSync(path('server-key.pem')), clientCert: readFileSync(path('client-cert.pem')),
            clientKey: readFileSync(path('client-key.pem')) };
    } catch {
        throw new Error('Direct VIC TLS tests require the OpenSSL executable and permission to create disposable temporary files');
    } finally {
        // The server uses in-memory copies, so remove every on-disk key even before tests start.
        rmSync(directory, { recursive: true, force: true });
    }
}
