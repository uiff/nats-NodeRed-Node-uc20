import { connect } from 'nats';
import * as payloads from './lib/payloads.js';
import * as subjects from './lib/subjects.js';
import fetch from 'node-fetch';
import https from 'https';

// --- Configuration ---
const config = {
    servers: process.env.NATS_SERVER || '192.168.10.100:49360',
    // Credentials provided by User
    clientId: process.env.CLIENT_ID || '00693b23-3068-4937-9389-6d1ca1efe43a',
    clientSecret: process.env.CLIENT_SECRET || 'GQMPkOrGVlotKmZCwJ1Fio20kw',
    providerId: process.env.PROVIDER_ID || 'nr',
    tokenEndpoint: process.env.TOKEN_ENDPOINT || 'https://192.168.10.100/oauth2/token'
};

const VARIABLE_DEFINITIONS = [
    { id: 1, key: 'test.counter', dataType: 'INT64', access: 'READ_WRITE' },
    { id: 2, key: 'test.status', dataType: 'STRING', access: 'READ_WRITE' }
];

// --- Helpers ---

async function getAccessToken() {
    console.log(`Requesting token from ${config.tokenEndpoint}...`);
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'hub.variables.provide hub.variables.readwrite',
    });
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const agent = new https.Agent({ rejectUnauthorized: false });

    try {
        const response = await fetch(config.tokenEndpoint, {
            method: 'POST',
            agent,
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: params,
        });

        if (!response.ok) {
            console.error(`Token request failed: ${response.status} ${await response.text()}`);
            return null;
        }

        const json = await response.json();
        return json.access_token;
    } catch (e) {
        console.error('Token connection error:', e);
        return null;
    }
}

async function main() {
    console.log(`Starting Local Test Provider: ${config.providerId}`);

    const token = await getAccessToken();
    if (!token) {
        console.error("Could not obtain token. Exiting.");
        process.exit(1);
    }

    try {
        const nc = await connect({
            servers: config.servers,
            token: token,
            name: 'local-test-provider'
        });
        console.log(`Connected to NATS: ${nc.getServer()}`);

        const { payload: definitionPayload, fingerprint } = payloads.buildProviderDefinitionEvent(VARIABLE_DEFINITIONS);

        // 1. Announce Provider (Initial Publish)
        console.log("Publishing initial definition event...");
        await nc.publish(subjects.providerDefinitionChanged(config.providerId), definitionPayload);

        // 2. Listen for Variable Read Queries (Standard requirement)
        const readSub = nc.subscribe(subjects.readVariablesQuery(config.providerId), {
            callback: async (err, msg) => {
                if (err) return console.error("Read Error:", err);
                if (!msg.reply) return;
                console.log("Received Variable Read Query");

                // Mock state
                const states = {
                    1: { id: 1, value: Date.now(), quality: 'GOOD', timestampNs: Date.now() * 1000000 },
                    2: { id: 2, value: "OK", quality: 'GOOD', timestampNs: Date.now() * 1000000 }
                };

                const response = payloads.buildReadVariablesResponse(VARIABLE_DEFINITIONS, states, fingerprint);
                msg.respond(response);
            }
        });

        // 3. Listen for Definition Queries (THE MISSING PIECE?)
        /*
        const defSub = nc.subscribe(subjects.readProviderDefinitionQuery(config.providerId), {
            callback: (err, msg) => {
                if (err) return console.error("Def Query Error:", err);
                if (!msg.reply) return;
                console.log(">>> RECEIVED DEFINITION QUERY! responding...");
                
                // Re-build payload to ensure freshness
                const { payload } = payloads.buildProviderDefinitionEvent(VARIABLE_DEFINITIONS);
                msg.respond(payload);
            }
        });
        */
        console.log(`(Skipped subscription to definition query due to permissions)`);

        console.log(`Provider running. ID: ${config.providerId}`);
        console.log("Press Ctrl+C to stop.");
        console.log(`Listening on: ${subjects.readProviderDefinitionQuery(config.providerId)}`);

        // Keep alive loop
        setInterval(async () => {
            // Republish definition to ensure discovery without query support
            console.log("Republishing definition...");
            await nc.publish(subjects.providerDefinitionChanged(config.providerId), definitionPayload);
        }, 5000);

        await nc.closed();

    } catch (err) {
        console.error("NATS Connection Error:", err);
    }
}

main();
