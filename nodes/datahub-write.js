const path = require('path');
const { pathToFileURL } = require('url');

const payloadModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'payloads.js')).href;

// Simple cache for provider definitions (5 min TTL)
const providerCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

module.exports = function (RED) {
    async function resolveVariableKey(nc, providerId, key, node, payloads) {
        const cacheKey = `${providerId}`;
        const cached = providerCache.get(cacheKey);

        // Check cache
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            const variable = cached.definition.variables.find(v => v.key === key);
            if (variable) {
                node.debug && node.debug(`Key '${key}' resolved to ID ${variable.id} (cached)`);
                // Return full object including type
                return { id: variable.id, dataType: variable.dataType };
            }
        }

        // Query provider definition
        let definition = null;
        try {
            const query = payloads.buildReadProviderDefinitionQuery();

            // Strategy 1: Direct Query (v1.loc.<provider>.def.qry.read)
            // This is required for providers like Node-RED itself or simple Python scripts
            const directSubject = `v1.loc.${providerId}.def.qry.read`;
            try {
                const response = await nc.request(directSubject, query, { timeout: 1000 });
                definition = payloads.decodeProviderDefinition(response.data);
            } catch (err) {
                node.debug && node.debug(`Direct Query failed: ${err.message}`);
            }

            // Strategy 2: Registry Query (v1.loc.registry.providers.<provider>.def.qry.read)
            // Fallback for managed providers
            if (!definition) {
                const registrySubject = `v1.loc.registry.providers.${providerId}.def.qry.read`;
                const response = await nc.request(registrySubject, query, { timeout: 2000 });
                definition = payloads.decodeProviderDefinition(response.data);
            }

            if (!definition) {
                throw new Error(`Provider ${providerId} not found (tried Direct & Registry)`);
            }

            // Cache the definition
            providerCache.set(cacheKey, {
                definition,
                timestamp: Date.now()
            });

            // Find variable by key
            const variable = definition.variables.find(v => v.key === key);
            if (!variable) {
                throw new Error(`Variable key '${key}' not found in provider ${providerId}`);
            }

            node.debug && node.debug(`Key '${key}' resolved to ID ${variable.id} (Type: ${variable.dataType})`);
            return { id: variable.id, dataType: variable.dataType };

        } catch (err) {
            throw new Error(`Failed to resolve key '${key}': ${err.message}`);
        }
    }

    function DataHubWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        console.log('DataHub Write Node initialized');

        // Get config node
        const configNode = RED.nodes.getNode(config.connection);
        if (!configNode) {
            node.error('Missing u-OS config');
            node.status({ fill: 'red', shape: 'dot', text: 'no config' });
            return;
        }

        // Store configuration
        this.providerId = config.providerId?.trim();
        this.variableId = config.variableId ? parseInt(config.variableId, 10) : null;
        this.variableKey = config.variableKey?.trim();
        this.resolvedId = null; // Cached resolved ID
        this.resolvedDataType = null; // Cached Data Type for strict writing
        this.payloads = null; // Will be loaded dynamically

        if (!this.providerId) {
            node.error('Provider ID is required');
            node.status({ fill: 'red', shape: 'dot', text: 'no provider ID' });
            return;
        }

        // Validate: either ID or Key required
        if (!this.variableId && !this.variableKey) {
            node.error('Either Variable ID or Variable Key is required');
            node.status({ fill: 'red', shape: 'dot', text: 'missing variable' });
            return;
        }

        // If ID provided and valid, use it
        if (this.variableId && !isNaN(this.variableId)) {
            this.resolvedId = this.variableId;
            node.status({ fill: 'green', shape: 'ring', text: 'ready' });
        } else if (this.variableKey) {
            // Key provided - will resolve on first message
            node.status({ fill: 'yellow', shape: 'ring', text: 'key needs resolution' });
        } else {
            node.error('Invalid Variable ID');
            node.status({ fill: 'red', shape: 'dot', text: 'invalid ID' });
            return;
        }

        // Load payloads module dynamically
        import(payloadModuleUrl).then(payloads => {
            node.payloads = payloads;
        }).catch(err => {
            node.error(`Failed to load payloads module: ${err.message}`);
        });

        // Handle incoming messages
        node.on('input', async function (msg) {
            const value = msg.payload;

            if (value === undefined || value === null) {
                node.warn('msg.payload is empty, nothing to write');
                return;
            }

            if (!node.payloads) {
                node.error('Payloads module not loaded yet');
                return;
            }

            try {
                // Get NATS connection from config node
                const nc = await configNode.acquire();
                if (!nc) {
                    node.error('NATS connection not available');
                    node.status({ fill: 'red', shape: 'dot', text: 'no connection' });
                    return;
                }

                // Resolve variable ID if needed
                let varId = node.resolvedId;
                let varType = node.resolvedDataType;

                if (!varId && node.variableKey) {
                    node.status({ fill: 'yellow', shape: 'dot', text: 'resolving key...' });
                    const resolved = await resolveVariableKey(nc, node.providerId, node.variableKey, node, node.payloads);
                    varId = resolved.id;
                    varType = resolved.dataType; // Store resolved type

                    node.resolvedId = varId;
                    node.resolvedDataType = varType;
                    node.status({ fill: 'green', shape: 'ring', text: 'ready' });
                }

                // Build write command
                const writeCommand = node.payloads.encodeWriteVariablesCommand([
                    {
                        id: varId,
                        value: value,
                        dataType: varType // Pass dataType for strict encoding
                    }
                ]);

                // Publish write command
                const subject = `v1.loc.${node.providerId}.vars.cmd.write`;
                nc.publish(subject, writeCommand);

                node.status({ fill: 'green', shape: 'dot', text: `wrote: ${value}` });

                // Output confirmation
                msg.payload = {
                    success: true,
                    providerId: node.providerId,
                    variableId: varId,
                    variableKey: node.variableKey || null,
                    value: value
                };
                node.send(msg);

            } catch (err) {
                node.error(`Write failed: ${err.message}`, msg);
                node.status({ fill: 'red', shape: 'dot', text: 'write error' });
            }
        });

        node.on('close', function () {
            if (configNode) {
                configNode.release();
            }
            node.status({});
        });
    }

    RED.nodes.registerType('datahub-write', DataHubWriteNode);


};
