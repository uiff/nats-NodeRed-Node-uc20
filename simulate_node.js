
import { connect } from 'nats';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

// --- STUBBED / MOCKED CONFIG ---
const CONFIG = {
    host: '192.168.10.100',
    port: 49360,
    clientId: '00693b23-3068-4937-9389-6d1ca1efe43a',
    clientSecret: 'GQMPkOrGVlotKmZCwJ1Fio20kw',
    providerId: 'nr', // The CRITICAL config
    scope: 'hub.variables.provide hub.variables.readwrite hub.variables.readonly'
};

// --- AUTH MOCK ---
const fetch = (await import('node-fetch')).default;
async function getToken() {
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: CONFIG.scope,
    });
    const basic = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
    const tokenEndpoint = `https://${CONFIG.host}/oauth2/token`;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: params,
    });
    const json = await res.json();
    return json.access_token;
}

// --- LOGIC FROM datahub-output.js ---
const ensureDefinition = (defMap, definitions, stateMap, nextId, key, dataType) => {
    const normalized = key.trim();
    if (defMap.has(normalized)) {
        return { def: defMap.get(normalized), created: false };
    }
    // Logic from 0.2.25
    nextId.val += 1; // Increment wrapped value
    const def = {
        id: nextId.val,
        key: normalized,
        dataType,
        access: 'READWRITE', // Fixed in 0.2.25
    };
    defMap.set(normalized, def);
    definitions.push(def);
    stateMap.set(def.id, {
        id: def.id,
        value: dataType === 'STRING' ? '' : 0, // Simplified default
        timestampNs: Date.now() * 1_000_000,
        quality: 'GOOD',
    });
    return { def, created: true };
};

const inferType = (value) => {
    if (typeof value === 'boolean') return 'BOOLEAN';
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INT64' : 'FLOAT64';
    }
    return 'STRING';
};

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

// --- MAIN ---
async function main() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const payloadsUrl = path.join(__dirname, 'lib', 'payloads.js');
    const subjectsUrl = path.join(__dirname, 'lib', 'subjects.js');

    console.log("Loading modules...");
    const payloads = await import(payloadsUrl);
    const subjects = await import(subjectsUrl);

    console.log("Getting Token...");
    const token = await getToken();

    console.log("Connecting NATS...");
    const nc = await connect({
        servers: `nats://${CONFIG.host}:${CONFIG.port}`,
        token,
        name: 'simulate-node'
    });

    // Node State
    const defMap = new Map();
    const definitions = [];
    const stateMap = new Map();
    let nextId = { val: 100 }; // Wrapped to pass by ref-ish
    let fingerprint = BigInt(0);

    // INPUT PAYLOAD (User's Example)
    const msg = {
        payload: {
            "simulation": {
                "status": "running",
                "details": { "temp": 45.2, "count": 123 }
            }
        }
    };

    console.log("Processing Input:", JSON.stringify(msg.payload));
    const entries = flattenPayload(msg.payload);

    let definitionsChanged = false;
    entries.forEach(({ key, value }) => {
        if (value === undefined || value === null) return;
        const { def, created } = ensureDefinition(defMap, definitions, stateMap, nextId, key, inferType(value));
        if (created) definitionsChanged = true;

        // Update state
        const state = stateMap.get(def.id);
        state.value = value;
        state.timestampNs = Date.now() * 1_000_000;
        stateMap.set(def.id, state);
    });

    console.log("Definitions:", JSON.stringify(definitions, null, 2));

    console.log("Setting up Read Subscription...");
    const sub = nc.subscribe(subjects.readVariablesQuery(CONFIG.providerId));
    (async () => {
        for await (const m of sub) {
            try {
                const request = payloads.decodeReadVariablesQuery(m.data); // Assuming decode function exists or just responding to all
                console.log(`Received Read Request on ${m.subject}`);

                // Build Response
                const stateObj = {};
                for (const s of stateMap.values()) stateObj[s.id] = s;

                const response = payloads.buildReadVariablesResponse(definitions, stateObj, fingerprint);

                if (m.reply) {
                    await nc.publish(m.reply, response);
                    console.log(`Sent Read Response to ${m.reply}`);
                } else {
                    console.log("Request had no reply subject");
                }
            } catch (err) {
                console.error("Error handling read request:", err);
            }
        }
    })();

    if (definitionsChanged) {
        console.log("Sending Definition Update...");
        const { payload, fingerprint: fp } = payloads.buildProviderDefinitionEvent(definitions);
        fingerprint = fp;
        await nc.publish(subjects.providerDefinitionChanged(CONFIG.providerId), payload);

        console.log("Waiting 500ms (Node Logic)...");
        await new Promise(r => setTimeout(r, 500));
    }

    console.log("Sending Variables...");
    const stateObj = {};
    for (const s of stateMap.values()) stateObj[s.id] = s;

    const varPayload = payloads.buildVariablesChangedEvent(definitions, stateObj, fingerprint);
    await nc.publish(subjects.varsChangedEvent(CONFIG.providerId), varPayload);

    console.log("--- HEARTBEAT LOOP ---");
    // Heartbeat logic
    setInterval(async () => {
        console.log("Heartbeat: Publishing Definition...");
        const { payload } = payloads.buildProviderDefinitionEvent(definitions);
        await nc.publish(subjects.providerDefinitionChanged(CONFIG.providerId), payload);

        console.log("Heartbeat: Publishing Values (Simulating Activity)...");
        await nc.publish(subjects.varsChangedEvent(CONFIG.providerId), varPayload);
    }, 5000);

}

main().catch(console.error);
