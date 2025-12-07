import { buildProviderDefinitionEvent } from './lib/payloads.js';

const defs = [
    { id: 101, key: 'machine.status', dataType: 'STRING', access: 'READWRITE', experimental: false },
    { id: 102, key: 'machine.details.temp', dataType: 'FLOAT64', access: 'READWRITE', experimental: false }
];

try {
    const { payload, fingerprint } = buildProviderDefinitionEvent(defs);
    console.log("Fingerprint: " + fingerprint);
    console.log("HEX:" + Buffer.from(payload).toString('hex'));
} catch (e) {
    console.error(e);
}
