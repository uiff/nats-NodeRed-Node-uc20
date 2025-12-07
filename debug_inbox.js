
import { connect } from 'nats';
import * as path from 'path';
import { fileURLToPath } from 'url';

// CONFIG: .100 Server, 'nr' credentials
const NATS_SERVER = '192.168.10.100:49360';
const CLIENT_ID = '00693b23-3068-4937-9389-6d1ca1efe43a';
const CLIENT_SECRET = 'GQMPkOrGVlotKmZCwJ1Fio20kw';
const PROVIDER_ID = 'nr';

// Imports
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadsUrl = path.join(__dirname, 'lib', 'payloads.js');
const subjectsUrl = path.join(__dirname, 'lib', 'subjects.js');
const authUrl = path.join(__dirname, 'lib', 'auth.js');

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.env.HUB_HOST = '192.168.10.100';
    process.env.HUB_PORT = '49360';
    process.env.CLIENT_ID = CLIENT_ID;
    process.env.CLIENT_SECRET = CLIENT_SECRET;

    console.log("Loading modules...");
    const payloads = await import(payloadsUrl);
    const subjects = await import(subjectsUrl);
    const { requestToken } = await import(authUrl);

    console.log("Getting token...");
    const token = await requestToken();

    console.log("Connecting to NATS (Simulating uos-config.js settings)...");
    const nc = await connect({
        servers: NATS_SERVER,
        token: token,
        name: 'nr-nodered', // Matches uos-config default pattern
        inboxPrefix: '_INBOX.nr' // Simulating inbox prefix
    });

    console.log("Connected. Defining variable...");
    const definitions = [{
        id: 77,
        key: 'test.inboxshim.var',
        dataType: 'STRING',
        access: 'READ_WRITE'
    }];

    const stateObj = {
        77: {
            id: 77,
            value: 'InboxShim',
            timestampNs: Date.now() * 1000000,
            quality: 'GOOD'
        }
    };

    console.log("Building definition...");
    const { payload, fingerprint } = payloads.buildProviderDefinitionEvent(definitions);

    console.log(`Publishing definition to ${subjects.providerDefinitionChanged(PROVIDER_ID)}...`);
    await nc.publish(subjects.providerDefinitionChanged(PROVIDER_ID), payload);

    console.log("Publishing values via Heartbeat loop...");

    setInterval(async () => {
        console.log("Ping (Publishing Definition)...");
        await nc.publish(subjects.providerDefinitionChanged(PROVIDER_ID), payload);
        // Also var payload
        const varPayload = payloads.buildVariablesChangedEvent(definitions, stateObj, fingerprint);
        await nc.publish(subjects.varsChangedEvent(PROVIDER_ID), varPayload);
    }, 2000);
}

main().catch(console.error);
