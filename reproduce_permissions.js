import { connect } from 'nats';
import * as payloads from './lib/payloads.js';
import * as subjects from './lib/subjects.js';
import fetch from 'node-fetch';

// Configuration (mimicking user's environment based on logs/previous files)
const config = {
    servers: '192.168.10.100:49360',
    clientId: '76df2b35-a7e7-4ba5-9e10-06b8a24a0b02',
    clientSecret: 'WcKIUVPCf59fJHmcADwhY5zojA',
    providerId: 'sampleprovider', // Will try 'nr' later
    tokenEndpoint: 'https://192.168.10.100:49360/auth/token'
};

// Helper to get token
async function getAccessToken(scopes) {
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: scopes || 'hub.variables.provide hub.variables.readwrite',
    });
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

    // Ignore self-signed certs for test
    const https = await import('https');
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
            console.warn(`Token request status: ${response.status}`);
            return null;
        }
        const json = await response.json();
        return json.access_token;
    } catch (e) {
        console.warn('Token fetch error:', e.message);
        return null;
    }
}

async function testSubscription(testProviderId) {
    console.log(`\nTesting Provider ID: "${testProviderId}"`);

    // 1. Get Token
    const token = await getAccessToken();
    if (!token) {
        console.error('Failed to get token');
        return;
    }

    try {
        // 2. Connect
        const nc = await connect({
            servers: config.servers,
            token: token
        });
        // console.log(`Connected to ${nc.getServer()}`);

        // 3. Try to Subscribe to the Definition Query subject (The one causing error)
        // Subject: v1.loc.<providerId>.def.qry.read
        const subject = subjects.readProviderDefinitionQuery(testProviderId);
        console.log(`Attempting subscribe to: ${subject}`);

        const sub = nc.subscribe(subject, {
            callback: (err, msg) => {
                if (err) console.error('Callback error:', err);
            }
        });

        console.log('Subscription active... check for immediate permission error logs logic in NATS client...');

        // Use a slight delay and check if connection closes or emits error
        // NATS client usually throws or emits 'error' on permission violation?
        // Or connection.closed() resolves with error?

        await new Promise(r => setTimeout(r, 1000));

        // Also try to Publish initial definition (just to be complete)
        const defSub = subjects.providerDefinitionChanged(testProviderId); // v1.loc.<pid>.def.evt.changed
        // console.log(`Publishing update to: ${defSub}`);
        // nc.publish(defSub, new Uint8Array([1,2,3])); // Dummy payload

        await nc.drain();
        console.log('Success (no crash yet).');

    } catch (err) {
        console.error('FAILED with error:', err.message);
        if (err.message.includes('Permissions Violation')) {
            console.error('>>> CONFIRMED: Permission Violation reproduced!');
        }
    }
}

async function run() {
    await testSubscription('sampleprovider'); // Valid ID?
    await testSubscription('nr');             // User's failing ID
}

run();
