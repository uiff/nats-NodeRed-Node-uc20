import fetch from 'node-fetch';
import { CLIENT_ID, CLIENT_SECRET, TOKEN_ENDPOINT, TOKEN_SCOPE } from './config.js';
export async function requestToken() {
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: TOKEN_SCOPE,
    });
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await fetch(TOKEN_ENDPOINT, {
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
    const json = (await response.json());
    if (!json.access_token) {
        throw new Error('Token response missing access_token');
    }
    return json.access_token;
}
