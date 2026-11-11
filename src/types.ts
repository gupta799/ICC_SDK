import type { Operations } from './generated/operations.js';
export type Operation = keyof Operations;
export interface Request {
    operation: Operation;
    method: string;
    path: string;
    body?: unknown;
    headers: Record<string, string>;
    query: Record<string, string | number>;
    signal?: AbortSignal;
}
export interface Response {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}
/** Must authenticate and encrypt requests and decrypt responses. Never pass bare fetch here for live ICC. */
export interface Transport {
    send(request: Request): Promise<Response>;
}
export interface EvidenceSink {
    record(event: {
        operation: Operation;
        status: number;
        outcome: string;
    }): Promise<void>;
}
export interface CallOptions {
    path?: Record<string, string>;
    headers?: Record<string, string>;
    query?: Record<string, string | number>;
    signal?: AbortSignal;
}
export interface Result<T> {
    kind: 'success' | 'action_required' | 'accepted' | 'unverified';
    status: number;
    data: T;
}
export class ValidationError extends Error {
    constructor(public issues: string[]) { super(issues.join('; ')); this.name = 'ValidationError'; }
}
export class ApiError extends Error {
    constructor(public status: number, public reason?: string) { super(`ICC request failed (${status})`); this.name = 'ApiError'; }
}
export class UnknownOutcomeError extends Error {
    constructor(public operation: Operation) { super(`Outcome unknown for ${operation}; reconcile before retrying`); this.name = 'UnknownOutcomeError'; }
}
