
import { connect, JSONCodec } from 'nats';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Mock Node-RED node logic
const flattenPayload = (value, prefix = '') => {
    const entries = [];
    const path = (key) => (prefix ? `${prefix}.${key}` : key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([key, val]) => {
            if (val !== undefined) {
                entries.push(...flattenPayload(val, path(key)));
            }
        });
    }
    else if (Array.isArray(value)) {
        value.forEach((val, idx) => {
            if (val !== undefined) {
                entries.push(...flattenPayload(val, prefix ? `${prefix}[${idx}]` : `[${idx}]`));
            }
        });
    }
    else {
        const keyName = prefix || 'value';
        entries.push({ key: keyName, value });
    }
    return entries;
};

// Config
const NATS_SERVER = process.env.NATS_SERVER || '192.168.10.116:49360';
const TOKEN_ENDPOINT = 'https://192.168.10.116/oauth2/token';
const CLIENT_ID = 'fbd387b6-7ac9-4bca-ada8-d7a272698324';
const CLIENT_SECRET = 'PE7_cBSwPy~PQtxoHGOpa1pKRp';
const PROVIDER_ID = 'nested-test';

// Imports
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadsUrl = path.join(__dirname, 'lib', 'payloads.js');
const subjectsUrl = path.join(__dirname, 'lib', 'subjects.js');
const authUrl = path.join(__dirname, 'lib', 'auth.js');

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.env.HUB_HOST = '192.168.10.116';
    process.env.HUB_PORT = '49360';
    process.env.CLIENT_ID = CLIENT_ID;
    process.env.CLIENT_SECRET = CLIENT_SECRET;

    console.log("Loading modules...");
    const payloads = await import(payloadsUrl);
    const subjects = await import(subjectsUrl);
    const { requestToken } = await import(authUrl);

    console.log("Getting token...");
    const token = await requestToken({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        tokenEndpoint: TOKEN_ENDPOINT
    });

    console.log("Connecting to NATS...");
    const nc = await connect({
        servers: NATS_SERVER,
        token: token,
        name: 'nested-repro'
    });

    // --- LOGIC FROM datahub-output.js ---
    const definitions = [];
    const defMap = new Map();
    const stateMap = new Map();
    let nextId = 0;
    let fingerprint = 0;

    const inferType = (value) => {
        if (typeof value === 'boolean') return 'BOOLEAN';
        if (typeof value === 'number') {
            return Number.isInteger(value) ? 'INT64' : 'FLOAT64';
        }
        return 'STRING';
    };

    const ensureDefinition = (key, dataType) => {
        if (defMap.has(key)) return { def: defMap.get(key), created: false };

        const def = {
            id: ++nextId,
            key: key,
            dataType,
            access: 'READ_WRITE'
        };
        defMap.set(key, def);
        definitions.push(def);
        stateMap.set(def.id, {
            id: def.id,
            value: dataType === 'STRING' ? '' : 0,
            timestampNs: Date.now() * 1000000,
            quality: 'GOOD'
        });
        return { def, created: true };
    };

    // INPUT PAYLOAD
    const msg = {
        payload: {
            "machine": {
                "status": "running",
                "details": {
                    "temp": 45.2
                }
            }
        }
    };

    console.log("Processing Payload:", JSON.stringify(msg.payload, null, 2));

    const entries = flattenPayload(msg.payload);
    console.log("Flattened entries:", entries);

    let definitionsChanged = false;
    entries.forEach(({ key, value }) => {
        const { created } = ensureDefinition(key, inferType(value));
        if (created) definitionsChanged = true;
        // Update state
        const def = defMap.get(key);
        stateMap.get(def.id).value = value;
        stateMap.get(def.id).timestampNs = Date.now() * 1000000;
    });

    if (definitionsChanged) {
        console.log("Definitions changed. Sending update...");
        const { payload, fingerprint: fp } = payloads.buildProviderDefinitionEvent(definitions);
        fingerprint = fp;
        await nc.publish(subjects.providerDefinitionChanged(PROVIDER_ID), payload);

        console.log("Waiting 100ms...");
        await new Promise(r => setTimeout(r, 100));
    }

    console.log("Sending values...");
    const stateObj = {};
    for (const s of stateMap.values()) stateObj[s.id] = s;

    const varPayload = payloads.buildVariablesChangedEvent(definitions, stateObj, fingerprint);
    await nc.publish(subjects.varsChangedEvent(PROVIDER_ID), varPayload);

    console.log(`Sent values for provider '${PROVIDER_ID}'. Check DataHub.`);

    // Keep alive and periodically republish definition and values
    setInterval(async () => {
        console.log("Republishing definition...");
        await nc.publish(subjects.providerDefinitionChanged(PROVIDER_ID), payload);

        console.log("Republishing values...");
        await nc.publish(subjects.varsChangedEvent(PROVIDER_ID), varPayload);
    }, 5000);
}

main().catch(console.error);
