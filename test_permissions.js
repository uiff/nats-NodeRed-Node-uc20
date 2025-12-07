import { connect, JSONCodec } from 'nats';
import * as path from 'path';
import { fileURLToPath } from 'url';

// User Credentials from config.py
const CONFIG = {
    host: '192.168.10.100',
    port: 49360,
    clientId: '76df2b35-a7e7-4ba5-9e10-06b8a24a0b02',
    clientSecret: 'WcKIUVPCf59fJHmcADwhY5zojA',
    scope: 'hub.variables.provide hub.variables.readwrite'
};

const fetch = (await import('node-fetch')).default;

async function getToken() {
    console.log("Requesting Token...");
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

    if (!res.ok) {
        throw new Error(`Token failed: ${await res.text()}`);
    }
    const json = await res.json();
    console.log("Got Token.");
    return json.access_token;
}

async function testPublish(nc, providerId) {
    const subject = `u-os.hub.providers.${providerId}.definition`;
    console.log(`Testing Publish to: ${subject}`);
    try {
        // Empty payload is fine, we just want to see if NATS rejects it
        await nc.publish(subject, new Uint8Array([0]));
        await nc.flush();
        console.log(`✅ SUCCESS: Publishing to '${providerId}' allowed.`);
        return true;
    } catch (err) {
        console.log(`❌ FAILED: Publishing to '${providerId}' denied! Error: ${err.message}`);
        return false;
    }
}

async function main() {
    try {
        const token = await getToken();
        console.log("Connecting NATS...");
        const nc = await connect({
            servers: `nats://${CONFIG.host}:${CONFIG.port}`,
            token,
            name: 'perm-tester'
        });
        console.log("Connected.");

        // Test 1: nodered (Failing ID)
        await testPublish(nc, 'nodered');

        // Test 2: sampleprovider (Working ID)
        await testPublish(nc, 'sampleprovider');

        // Test 3: random (Random ID)
        await testPublish(nc, 'test' + Date.now());

        await nc.close();
    } catch (err) {
        console.error("FATAL:", err);
    }
}

main();
