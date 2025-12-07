const { connect, StringCodec } = require('nats');

(async () => {
    // Connect to NATS
    const nc = await connect({ servers: "nats://127.0.0.1:4222" });
    const sc = StringCodec();

    console.log("Snooping on u-os.hub.providers.>");

    // Subscribe to everything under providers
    const sub = nc.subscribe("u-os.hub.providers.>");

    for await (const m of sub) {
        console.log(`[${m.subject}] Data Length: ${m.data.length}`);
        // Print Hex Dump
        const hex = Buffer.from(m.data).toString('hex');
        console.log(`HEX: ${hex}`);
    }
})();
