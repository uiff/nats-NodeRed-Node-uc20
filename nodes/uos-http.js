const fetch = require('node-fetch');
const https = require('https');

module.exports = function (RED) {
    function UosHttpNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.uosConfig = RED.nodes.getNode(config.uosConfig);
        node.mode = config.mode; // 'datahub' or 'system'

        // DataHub Config
        node.dhAction = config.dhAction; // 'read', 'write', 'list_providers', 'list_variables'
        node.dhProvider = config.dhProvider;
        node.dhVariable = config.dhVariable;

        // System Config
        node.sysCategory = config.sysCategory; // 'logging', 'network', 'system', 'security', 'recovery'
        node.sysAction = config.sysAction; // dynamic based on category

        if (!node.uosConfig) {
            node.error('No u-OS Configuration configured!');
            return;
        }

        const httpsAgent = new https.Agent({
            rejectUnauthorized: false
        });

        node.on('input', async function (msg) {
            const token = await node.uosConfig.getToken();
            if (!token) {
                node.error('Authentication failed (No Token)', msg);
                return;
            }

            let url = '';
            let method = 'GET';
            let body = null;
            let baseUrl = `https://${node.uosConfig.host}:443`; // HTTPS Port 443 implies standard web server (nginx proxy)

            try {
                if (node.mode === 'datahub') {
                    baseUrl += '/u-os-hub/api/v1';

                    // Allow override from msg for dynamic usage
                    const provider = msg.provider || node.dhProvider;
                    const variable = msg.variable || node.dhVariable;

                    switch (node.dhAction) {
                        case 'list_providers':
                            url = `${baseUrl}/providers`;
                            break;
                        case 'list_variables':
                            if (!provider) throw new Error('Provider ID required');
                            url = `${baseUrl}/providers/${provider}/variables`;
                            if (msg.payload && typeof msg.payload === 'object') {
                                // allow query params like prefixes
                            }
                            break;
                        case 'read':
                            if (!provider || !variable) throw new Error('Provider ID and Variable Key required');
                            url = `${baseUrl}/providers/${provider}/variables/${variable}`;
                            break;
                        case 'write':
                            if (!provider || !variable) throw new Error('Provider ID and Variable Key required');
                            url = `${baseUrl}/providers/${provider}/variables/${variable}`;
                            method = 'POST';
                            body = JSON.stringify({ key: variable, value: msg.payload });
                            break;
                        default:
                            throw new Error(`Unknown DataHub Action: ${node.dhAction}`);
                    }

                } else if (node.mode === 'system') {
                    baseUrl += '/u-os-adm/api/v1';

                    switch (node.sysCategory) {
                        case 'system':
                            if (node.sysAction === 'info') url = `${baseUrl}/system/info`;
                            else if (node.sysAction === 'nameplate') url = `${baseUrl}/system/nameplate`;
                            else if (node.sysAction === 'disks') url = `${baseUrl}/system/disks`;
                            else if (node.sysAction === 'reboot') { url = `${baseUrl}/system:reboot`; method = 'POST'; }
                            break;
                        case 'network':
                            if (node.sysAction === 'get_state') url = `${baseUrl}/network/state`;
                            else if (node.sysAction === 'get_config') url = `${baseUrl}/network/config`;
                            else if (node.sysAction === 'set_config') { url = `${baseUrl}/network/config`; method = 'PUT'; body = JSON.stringify(msg.payload); }
                            else if (node.sysAction === 'update_config') { url = `${baseUrl}/network/config`; method = 'PATCH'; body = JSON.stringify(msg.payload); } // Content-Type merg-patch?
                            break;
                        case 'logging':
                            if (node.sysAction === 'entries') url = `${baseUrl}/logging/entries`;
                            else if (node.sysAction === 'sources') url = `${baseUrl}/logging/sources`;
                            else if (node.sysAction === 'create_report') { url = `${baseUrl}/logging/reports`; method = 'POST'; }
                            break;
                        case 'security':
                            if (node.sysAction === 'get_config') url = `${baseUrl}/security/config`;
                            else if (node.sysAction === 'set_config') { url = `${baseUrl}/security/config`; method = 'PUT'; body = JSON.stringify(msg.payload); }
                            break;
                        case 'recovery':
                            if (node.sysAction === 'factory_reset') { url = `${baseUrl}/recovery:factory-reset`; method = 'POST'; }
                            break;
                        default:
                            throw new Error(`Unknown System Category: ${node.sysCategory}`);
                    }
                }

                node.status({ fill: 'blue', shape: 'dot', text: 'requesting...' });

                const headers = {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                };

                if (node.mode === 'system' && node.sysCategory === 'network' && node.sysAction === 'update_config') {
                    headers['Content-Type'] = 'application/merge-patch+json';
                }

                const response = await fetch(url, {
                    method,
                    headers,
                    body,
                    agent: httpsAgent
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }

                // Parse Response
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    msg.payload = await response.json();
                } else {
                    msg.payload = await response.text();
                }

                msg.statusCode = response.status;
                node.send(msg);
                node.status({ fill: 'green', shape: 'dot', text: 'Ok' });

            } catch (err) {
                node.error(err, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'Error' });
            }
        });
    }

    RED.nodes.registerType('uos-http', UosHttpNode);
};
