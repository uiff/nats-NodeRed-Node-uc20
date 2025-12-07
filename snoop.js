const { connect, StringCodec, JSONCodec } = require('nats');
const { extractDefinition, extractVariables } = require('./lib/payloads.js');
// Note: We might need to mock or import payloads properly if it depends on flatbuffers
// Ideally we just dump hex if we can't decode easily without complex imports.

// Simple hex dump for now to confirm flow
async function run() {
    const nc = await connect({ servers: "192.168.10.100:49360" });
    const sc = StringCodec();

    const providerId = process.argv[2] || "nodered";

    console.log(`Snooping on provider: ${providerId}`);

    // Subscribe to Definition Changes
    const defSub = nc.subscribe(`v1.loc.${providerId}.def.evt.changed`);
    (async () => {
        for await (const m of defSub) {
            console.log(`[DEF] Received ${m.data.length} bytes. Subject: ${m.subject}`);
            // verify fingerprint/content if possible
        }
    })();

    // Subscribe to Variable Changes (Heartbeat)
    const varSub = nc.subscribe(`v1.loc.${providerId}.vars.evt.changed`);
    (async () => {
        for await (const m of varSub) {
            const now = new Date().toISOString();
            console.log(`[VAR] ${now} Received ${m.data.length} bytes.`);
        }
    })();

    console.log("Listening...");
    await new Promise(r => { }); // Wait forever
}

run().catch(console.error);
