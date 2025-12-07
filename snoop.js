const { connect, StringCodec } = require('nats');

(async () => {
    // defaults
    const server = process.env.NATS_URL || "nats://127.0.0.1:49360";
    // NOTE: You need a Token! NATS_TOKEN env var is best.
    // export NATS_TOKEN=$(curl -s -X POST "https://localhost/oauth2/token" ... )

    console.log(`Connecting to NATS at ${server}...`);

    try {
        const nc = await connect({
            servers: server,
            token: process.env.NATS_TOKEN
        });
        const sc = StringCodec();
        console.log("Connected! Snooping on v1.loc.nodered.>");

        const sub = nc.subscribe("v1.loc.nodered.>");
        for await (const m of sub) {
            console.log(`\n[${m.subject}] Data Length: ${m.data.length}`);
            // console.log(`HEX: ${Buffer.from(m.data).toString('hex')}`);
        }
    } catch (err) {
        console.error("Connection failed:", err.message);
    }
})();
