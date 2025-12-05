import 'dotenv/config';
export const HUB_HOST = process.env.HUB_HOST ?? '192.168.10.108';
export const HUB_PORT = Number(process.env.HUB_PORT ?? 49360);
export const PROVIDER_ID = process.env.PROVIDER_ID ?? 'sampleprovider';
export const CLIENT_NAME = process.env.CLIENT_NAME ?? 'sampleprovider';
export const CLIENT_ID = process.env.CLIENT_ID ?? '';
export const CLIENT_SECRET = process.env.CLIENT_SECRET ?? '';
export const TOKEN_SCOPE = process.env.TOKEN_SCOPE ?? 'hub.variables.provide hub.variables.readwrite';
export const TOKEN_ENDPOINT = process.env.TOKEN_ENDPOINT ?? `https://${HUB_HOST}/oauth2/token`;
export const PUBLISH_INTERVAL_MS = Number(process.env.PUBLISH_INTERVAL_MS ?? 1000);
export const NATS_SERVER = process.env.NATS_SERVER ?? `nats://${HUB_HOST}:${HUB_PORT}`;
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('[config] CLIENT_ID/CLIENT_SECRET fehlen – bitte .env ausfüllen.');
}
export const VARIABLE_DEFINITIONS = [
    { id: 5, key: 'diagnostics.status_text', dataType: 'STRING', access: 'READ_WRITE' },
    { id: 6, key: 'diagnostics.error_count', dataType: 'INT64', access: 'READ_WRITE' },
    { id: 7, key: 'diagnostics.temperature', dataType: 'FLOAT64', access: 'READ_ONLY' },
    { id: 8, key: 'diagnostics.is_running', dataType: 'BOOLEAN', access: 'READ_WRITE' },
];
