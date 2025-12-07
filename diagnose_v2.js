import { connect } from 'nats';
import * as path from 'path';
import { fileURLToPath } from 'url';

// --- CONFIGURATION ---
const NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:49360';
const PROVIDER_ID = 'diagnose_prov'; // Unique ID to avoid conflicts
// ---------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadsUrl = path.join(__dirname, 'lib', 'payloads.js');
const subjectsUrl = path.join(__dirname, 'lib', 'subjects.js');
const authUrl = path.join(__dirname, 'lib', 'auth.js');

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    console.log(`[Diagnose] Starting... ProviderID: ${PROVIDER_ID}`);

    const payloads = await import(payloadsUrl);
    const subjects = await import(subjectsUrl);
    const { requestToken } = await import(authUrl);

    console.log("[Diagnose] Requesting Token...");
    // Ensure we have a token (assumes uos-config style env vars or local flow permissions)
    // If running in container, might need env vars or rely on default token location
    let token;
    try {
        token = await requestToken();
        console.log("[Diagnose] Token acquired.");
    } catch (e) {
        console.error("[Diagnose] Token request failed:", e.message);
        console.log("Ensure you have CLIENT_ID and CLIENT_SECRET env vars if needed.");
        return;
    }

    console.log(`[Diagnose] Connecting to NATS ${NATS_URL}...`);
    const nc = await connect({
        servers: NATS_URL,
        token: token,
        name: 'diagnose-script'
    });
    console.log("[Diagnose] NATS Connected.");

    // Define 1 simple variable
    const definitions = [{
        id: 999,
        key: 'diagnose.test',
        dataType: 'STRING',
        access: 'READ_ONLY' // Important: Match v0.2.58 behavior
    }];

    const stateObj = {
        999: {
            id: 999,
            value: 'Hello World',
            timestamp: BigInt(Date.now()) * 1_000_000n, // Correct BigInt
            quality: 'GOOD'
        }
    };

    console.log("[Diagnose] Building Definition...");
    const defEvent = payloads.buildProviderDefinitionEvent(definitions);
    console.log(`[Diagnose] Fingerprint: ${defEvent.fingerprint}`);

    const defSubject = subjects.providerDefinitionChanged(PROVIDER_ID);
    console.log(`[Diagnose] Publishing Definition to: ${defSubject}`);
    await nc.publish(defSubject, defEvent.payload);

    console.log("[Diagnose] Building Values...");
    const valPayload = payloads.buildVariablesChangedEvent(definitions, stateObj, defEvent.fingerprint);
    const valSubject = subjects.varsChangedEvent(PROVIDER_ID);
    console.log(`[Diagnose] Publishing Values to: ${valSubject}`);
    await nc.publish(valSubject, valPayload);

    console.log("[Diagnose] Done check DataHub! (Ctrl+C to stop)");

    // Heartbeat loop
    setInterval(async () => {
        // console.log("[Diagnose] Heartbeat...");
        stateObj[999].timestamp = BigInt(Date.now()) * 1_000_000n;
        const p = payloads.buildVariablesChangedEvent(definitions, stateObj, defEvent.fingerprint);
        await nc.publish(valSubject, p);
    }, 10000);
}

main().catch(err => {
    console.error("[Diagnose] Fatal Error:", err);
});
