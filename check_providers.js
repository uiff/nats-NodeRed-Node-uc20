import fetch from 'node-fetch';
import https from 'https';

const config = {
    tokenEndpoint: 'https://192.168.10.100/oauth2/token',
    apiEndpoint: 'https://192.168.10.100/u-os-hub/api/v1/providers',
    clientId: '00693b23-3068-4937-9389-6d1ca1efe43a',
    clientSecret: 'GQMPkOrGVlotKmZCwJ1Fio20kw'
};

async function getAccessToken() {
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'hub.variables.provide hub.variables.readwrite',
    });
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const agent = new https.Agent({ rejectUnauthorized: false });

    const res = await fetch(config.tokenEndpoint, {
        method: 'POST',
        agent,
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });
    if (!res.ok) throw new Error(`Token failed: ${res.status}`);
    const json = await res.json();
    return json.access_token;
}

async function check() {
    try {
        const token = await getAccessToken();
        const agent = new https.Agent({ rejectUnauthorized: false });
        console.log("Fetching providers...");

        let res = await fetch(config.apiEndpoint, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            agent
        });

        if (!res.ok) {
            console.log("u-OS API failed, trying DataHub API fallback...");
            res = await fetch('https://192.168.10.100/datahub/v1/providers', {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                agent
            });
            if (!res.ok) throw new Error(`API failed: ${res.status}`);
        }

        const providers = await res.json();
        console.log("Providers found:", JSON.stringify(providers, null, 2));

        const targetProvider = 'nr';
        const provider = providers.find(p => p.id === targetProvider);

        if (provider) {
            console.log(`\nFound target provider: ${targetProvider}`);
            // Fetch variables for this provider
            const varsRes = await fetch(`https://192.168.10.100/datahub/v1/providers/${targetProvider}/variables`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                agent
            });
            if (varsRes.ok) {
                const vars = await varsRes.json();
                console.log(`Variables for ${targetProvider}:`, JSON.stringify(vars, null, 2));
            } else {
                console.log(`Failed to fetch variables: ${varsRes.status}`);
            }
        } else {
            console.log(`\nTarget provider '${targetProvider}' NOT found in list.`);
        }

    } catch (e) {
        console.error('Error in check:', e);
    }
}

check();
