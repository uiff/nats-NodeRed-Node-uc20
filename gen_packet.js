import { buildVariablesChangedEvent } from './lib/payloads.js';
import { VariableDataType } from './lib/fbs/weidmueller/ucontrol/hub/variable-data-type.js';
import { VariableAccessType } from './lib/fbs/weidmueller/ucontrol/hub/variable-access-type.js';

const defs = [
    { id: 101, key: 'machine.status', dataType: 'STRING', access: 'READWRITE', experimental: false },
    { id: 102, key: 'machine.details.temp', dataType: 'FLOAT64', access: 'READWRITE', experimental: false }
];

const states = {
    101: { id: 101, value: "Running", quality: "GOOD", timestamp: Date.now() * 1000000 },
    102: { id: 102, value: 42.5, quality: "GOOD", timestamp: Date.now() * 1000000 }
};

// Mock fingerprint (not important for parsing structure, but must be u64)
const fingerprint = 1234567890n;

try {
    const payload = buildVariablesChangedEvent(defs, states, fingerprint);
    console.log("HEX:" + Buffer.from(payload).toString('hex'));
} catch (e) {
    console.error(e);
}
