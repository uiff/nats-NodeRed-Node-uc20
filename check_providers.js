
import fetch from 'node-fetch';
import https from 'https';

const config = {
    host: '192.168.10.100',
    port: 49360,
    clientId: '00693b23-3068-4937-9389-6d1ca1efe43a',
    clientSecret: 'GQMPkOrGVlotKmZCwJ1Fio20kw',
    providerId: 'nr'
};

async function check() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    console.log(`Checking provider '${config.providerId}' on ${config.host}...`);

    // 1. Get Token
    const authUrl = `https://${config.host}/oauth2/token`;
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'hub.variables.provide hub.variables.readwrite hub.variables.readonly'
    });
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const agent = new https.Agent({ rejectUnauthorized: false });

    console.log("Fetching token...");
    const tokenRes = await fetch(authUrl, {
        method: 'POST',
        agent,
        headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    if (!tokenRes.ok) throw new Error(`Token failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const { access_token } = await tokenRes.json();

    // 2. Fetch Variables
    console.log("Fetching variables...");
    // Try standard API first
    let url = `https://${config.host}/u-os-hub/api/v1/providers/${config.providerId}/variables`;
    let res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` }, agent });

    if (res.status === 404) {
        console.log("404 on standard API, trying fallback...");
        url = `https://${config.host}/datahub/v1/providers/${config.providerId}/variables`;
        res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` }, agent });
    }

    if (!res.ok) {
        throw new Error(`Failed to fetch variables: ${res.status} ${await res.text()}`);
    } else {
        const json = await res.json();
        console.log(`\nSUCCESS! Found ${json.length} variables for '${config.providerId}':`);
        json.forEach(v => {
            console.log(` - [${v.id}] ${v.key} (${v.dataType}, ${v.access})`);
        });
    }
}

check().catch(console.error);
