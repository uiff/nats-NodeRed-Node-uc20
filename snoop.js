const { connect, StringCodec } = require('nats');

(async () => {
    // defaults
    const server = process.env.NATS_URL || "nats://127.0.0.1:4222";

    console.log(`Connecting to NATS at ${server}...`);
    console.log("To change, run: export NATS_URL='nats://<ip>:<port>' && node snoop.js");

    try {
        const nc = await connect({ servers: server });
        const sc = StringCodec();
        console.log("Connected! Snooping on u-os.hub.providers.>");
        console.log("Waiting for packets... (Ctrl+C to stop)");

        // Subscribe to specific providers to avoid permission errors
        // "nodered" (our provider) and "u_os_adm" (the reference provider)
        const sub1 = nc.subscribe("u-os.hub.providers.nodered.data");
        const sub2 = nc.subscribe("u-os.hub.providers.u_os_adm.data");

        console.log("Listening on .nodered.data and .u_os_adm.data...");

        // Handle both subscriptions
        (async () => {
            for await (const m of sub1) {
                console.log(`\n[${m.subject}] Data Length: ${m.data.length}`);
                console.log(`HEX: ${Buffer.from(m.data).toString('hex')}`);
            }
        })();
        (async () => {
            for await (const m of sub2) {
                console.log(`\n[${m.subject}] Data Length: ${m.data.length}`);
                console.log(`HEX: ${Buffer.from(m.data).toString('hex')}`);
            }
        })();
    } catch (err) {
        console.error("Connection failed:", err.message);
    }
})();
