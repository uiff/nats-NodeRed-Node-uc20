
import { connect } from 'nats';
import * as path from 'path';
import { fileURLToPath } from 'url';

const NATS_SERVER = '192.168.10.116:49360';
const TOKEN_ENDPOINT = 'https://192.168.10.116/oauth2/token';
const CLIENT_ID = 'fbd387b6-7ac9-4bca-ada8-d7a272698324';
const CLIENT_SECRET = 'PE7_cBSwPy~PQtxoHGOpa1pKRp';
const PROVIDER_ID = 'hub';

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
    const token = await requestToken();

    console.log("Connecting to NATS...");
    const nc = await connect({
        servers: NATS_SERVER,
        token: token,
        name: 'simple-repro'
    });

    const definitions = [{
        id: 1,
        key: 'simple.var',
        dataType: 'STRING',
        access: 'READ_WRITE'
    }];

    // Simulate initial state
    const stateObj = {
        1: {
            id: 1,
            value: 'Hello World',
            timestampNs: Date.now() * 1000000,
            quality: 'GOOD'
        }
    };

    // Log NATS errors
    (async () => {
        for await (const s of nc.status()) {
            console.log(`[NATS] ${s.type}: ${s.data}`);
        }
    })().then();

    // Subscribe to Registry Events
    const regSub = `v1.loc.registry.providers.${PROVIDER_ID}.def.evt.changed`;
    console.log(`Subscribing to ${regSub}...`);
    nc.subscribe(regSub, {
        callback: (err, msg) => {
            if (err) console.error("Registry Event Error:", err);
            else console.log("Registry Event Received (size):", msg.data.length);
        }
    });

    console.log("Building definition...");
    const { payload, fingerprint } = definitions.length > 0 ? payloads.buildProviderDefinitionEvent(definitions) : { payload: new Uint8Array(0), fingerprint: 0 };

    console.log(`Publishing definition to ${subjects.providerDefinitionChanged(PROVIDER_ID)}...`);
    await nc.publish(subjects.providerDefinitionChanged(PROVIDER_ID), payload);

    console.log("Publishing values...");
    const varPayload = payloads.buildVariablesChangedEvent(definitions, stateObj, fingerprint);
    await nc.publish(subjects.varsChangedEvent(PROVIDER_ID), varPayload);

    // Periodically republish
    setInterval(async () => {
        console.log("Ping (Publishing Definition)...");
        await nc.publish(subjects.providerDefinitionChanged(PROVIDER_ID), payload);
    }, 5000);

    setTimeout(() => console.log("Done waiting."), 5000);
}

main().catch(console.error);
