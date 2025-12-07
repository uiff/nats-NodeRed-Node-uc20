
import { connect } from 'nats';
import fetch from 'node-fetch';

const CONFIG = {
    host: '192.168.10.116',
    port: 49360,
    clientId: 'fbd387b6-7ac9-4bca-ada8-d7a272698324',
    clientSecret: 'PE7_cBSwPy~PQtxoHGOpa1pKRp',
    tokenEndpoint: 'https://192.168.10.116/oauth2/token'
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function requestToken() {
    console.log(`Requesting token from ${CONFIG.tokenEndpoint}...`);
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'hub.variables.provide hub.variables.readwrite',
    });
    const basic = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');

    try {
        const response = await fetch(CONFIG.tokenEndpoint, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: params,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Token request failed: ${response.status} ${text}`);
        }
        const json = await response.json();
        return json.access_token;
    } catch (err) {
        console.error("Token Error:", err.message);
        process.exit(1);
    }
}

async function main() {
    console.log(`Testing NATS Server: ${CONFIG.host}`);

    const token = await requestToken();
    console.log("Token acquired.");

    try {
        console.log(`Connecting to NATS at ${CONFIG.host}:${CONFIG.port}...`);
        const nc = await connect({
            servers: `${CONFIG.host}:${CONFIG.port}`,
            token: token,
            name: 'test-connectivity'
        });
        console.log(`\nSUCCESS: Connected to NATS!`);
        console.log(`Server ID: ${nc.getServer()}`);

        await nc.close();
        console.log("Connection closed.");
    } catch (err) {
        console.error("NATS Connection Error:", err.message);
    }
}

main().catch(console.error);
