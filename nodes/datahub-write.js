const path = require('path');
const { pathToFileURL } = require('url');

const payloadModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'payloads.js')).href;

// Simple cache for provider definitions (5 min TTL)
const providerCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

module.exports = function (RED) {
    // Helper to get or fetch provider definition
    async function getProviderDefinition(nc, providerId, node, payloads) {
        const cacheKey = `${providerId}`;
        const cached = providerCache.get(cacheKey);

        // Check cache
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            return cached.definition;
        }

        // Query provider definition
        let definition = null;
        try {
            const query = payloads.buildReadProviderDefinitionQuery();

            // Strategy 1: Direct Query (v1.loc.<provider>.def.qry.read)
            const directSubject = `v1.loc.${providerId}.def.qry.read`;
            try {
                const response = await nc.request(directSubject, query, { timeout: 1000 });
                definition = payloads.decodeProviderDefinition(response.data);
            } catch (err) {
                node.debug && node.debug(`Direct Query failed: ${err.message}`);
            }

            // Strategy 2: Registry Query (v1.loc.registry.providers.<provider>.def.qry.read)
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

            return definition;

        } catch (err) {
            throw new Error(`Failed to fetch definition for '${providerId}': ${err.message}`);
        }
    }

    async function resolveVariableKey(nc, providerId, key, node, payloads) {
        try {
            const definition = await getProviderDefinition(nc, providerId, node, payloads);

            // Find variable by key
            const variable = definition.variables.find(v => v.key === key);
            if (!variable) {
                throw new Error(`Variable key '${key}' not found in provider ${providerId}`);
            }

            node.debug && node.debug(`Key '${key}' resolved to ID ${variable.id} (Type: ${variable.dataType})`);
            return { id: variable.id, dataType: variable.dataType, fingerprint: definition.fingerprint };

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
        this.resolvedFingerprint = BigInt(0); // Cached Fingerprint
        this.payloads = null; // Will be loaded dynamically

        if (!this.providerId) {
            node.error('Provider ID is required');
            node.status({ fill: 'red', shape: 'dot', text: 'no provider ID' });
            return;
        }

        // Validate: either ID or Key required
        // Relaxed validation for Batch Mode (handled in Input)

        // If Key is provided, we should ALWAYS resolve it to ensure ID is fresh (Auto-Healing)
        // If only ID is provided (legacy), we trust it.
        if (this.variableKey) {
            // Trigger background resolution
            node.status({ fill: 'yellow', shape: 'dot', text: 'resolving...' });
            resolveVariableKey(await configNode.acquire(), this.providerId, this.variableKey, node, node.payloads)
                .then(resolved => {
                    node.resolvedId = resolved.id;
                    node.resolvedDataType = resolved.dataType;
                    node.resolvedFingerprint = resolved.fingerprint;

                    if (node.variableId && node.variableId !== resolved.id) {
                        node.debug(`Auto-Healed ID for '${this.variableKey}': Configured=${node.variableId}, Resolved=${resolved.id}`);
                    }
                    node.status({ fill: 'green', shape: 'ring', text: 'ready' });
                })
                .catch(err => {
                    node.warn(`ID Resolution failed for '${this.variableKey}': ${err.message}. Using configured ID: ${this.variableId}`);
                    // Fallback to configured ID if resolution failed
                    if (this.variableId && !isNaN(this.variableId)) {
                        node.resolvedId = this.variableId;
                        node.status({ fill: 'green', shape: 'ring', text: 'ready (fallback)' });
                    } else {
                        node.status({ fill: 'red', shape: 'dot', text: 'resolution failed' });
                    }
                });
        } else if (this.variableId && !isNaN(this.variableId)) {
            // Legacy/Manual Mode without Key
            this.resolvedId = this.variableId;
            node.status({ fill: 'green', shape: 'ring', text: 'ready' });
        }

        // Load payloads module dynamically
        import(payloadModuleUrl).then(payloads => {
            node.payloads = payloads;
        }).catch(err => {
            node.error(`Failed to load payloads module: ${err.message}`);
        });

        // Handle incoming messages
        node.on('input', async function (msg) {
            const rawPayload = msg.payload;

            if (rawPayload === undefined || rawPayload === null) {
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

                // Prepare list of variables to write
                let varsToWrite = [];
                let currentFingerprint = node.resolvedFingerprint || BigInt(0);

                // MODE 1: Batch Write (Object or Array) AND no configured single variable
                // If the user configured a Provider but NOT a Variable ID/Key, we assume Dynamic Mode.
                // OR if the user configured a Variable, we strictly use that (Single Mode).
                const isSingleMode = (node.variableId !== null || !!node.variableKey);

                if (!isSingleMode && typeof rawPayload === 'object' && !Buffer.isBuffer(rawPayload)) {
                    // Normalize input to Array of { key/id, value }
                    let items = [];
                    if (Array.isArray(rawPayload)) {
                        // Array: [{id:1, value:val}, {key:'k', value:val}]
                        items = rawPayload;
                    } else {
                        // Object: { "key": val, "id:1": val }
                        items = Object.entries(rawPayload).map(([k, v]) => {
                            // Detect if key is actually an ID (e.g. "5" or "id:5")? 
                            // Easier: treat all keys as Keys, unless user passes explicit Array.
                            const asInt = parseInt(k, 10);
                            if (!isNaN(asInt) && String(asInt) === k) {
                                return { id: asInt, value: v };
                            }
                            return { key: k, value: v };
                        });
                    }

                    // Process Items
                    for (const item of items) {
                        let targetId = item.id;
                        let targetType = item.dataType; // Optional explicit type

                        if (targetId === undefined) {
                            if (item.key) {
                                // Resolve Key
                                try {
                                    // Resolving individual keys for batch... this might be slow if uncached.
                                    // Optimization: resolveVariableKey uses cache.
                                    const resolved = await resolveVariableKey(nc, node.providerId, item.key, node, node.payloads);
                                    targetId = resolved.id;
                                    // Use resolved type if not explicit
                                    if (!targetType) targetType = resolved.dataType;
                                    // Use the fingerprint from the LAST resolution (assuming they come from same provider version)
                                    if (resolved.fingerprint) currentFingerprint = resolved.fingerprint;
                                } catch (e) {
                                    node.warn(`Skipping key '${item.key}': ${e.message}`);
                                    continue;
                                }
                            } else {
                                node.warn(`Skipping item without id or key: ${JSON.stringify(item)}`);
                                continue;
                            }
                        }

                        varsToWrite.push({
                            id: targetId,
                            value: item.value,
                            dataType: targetType
                        });
                    }

                    if (varsToWrite.length === 0) {
                        node.warn("No valid variables found in batch payload");
                        return;
                    }

                } else {
                    // MODE 2: Single Mode
                    if (!isSingleMode) {
                        // No variable configured and primitive payload? Error.
                        node.error("Configuration Error: No Variable configured and payload is not a batch object.");
                        return;
                    }

                    // Resolve variable ID if needed
                    let varId = node.resolvedId;
                    let varType = node.resolvedDataType;

                    // Logic to ensure we have a fingerprint (critical for strict providers)
                    // If we have an ID but no fingerprint, we must fetch the definition.
                    if (varId && (node.resolvedFingerprint === BigInt(0) || !node.resolvedFingerprint)) {
                        try {
                            node.status({ fill: 'yellow', shape: 'dot', text: 'fetching definition...' });
                            // Reuse resolveVariableKey logic but just to get definition? 
                            // We can't use resolveVariableKey easily if we don't have a key.
                            // But we can peek into the cache directly or force a lookup.
                            // Let's call a simplified lookup.

                            // We don't have a dedicated function for "getDefinition", so we construct it or assume key is available?
                            // If user selected from list, we might NOT have the key in config (if legacy)? 
                            // But usually we do.
                            // If we don't have key, we can matches by ID.

                            const definitions = await getProviderDefinition(nc, node.providerId, node, node.payloads);
                            node.resolvedFingerprint = definitions.fingerprint;
                            currentFingerprint = definitions.fingerprint;

                            // Optional: Verify ID matches and get Type
                            const foundVar = definitions.variables.find(v => v.id === varId);
                            if (foundVar) {
                                varType = foundVar.dataType;
                                node.resolvedDataType = varType; // update cache
                            }

                        } catch (e) {
                            node.warn(`Could not fetch fingerprint for provider ${node.providerId}: ${e.message}`);
                            // Non-fatal? If strict, write will fail. If not, 0 might work.
                        }
                    }

                    if (!varId && node.variableKey) {
                        node.status({ fill: 'yellow', shape: 'dot', text: 'resolving key...' });
                        const resolved = await resolveVariableKey(nc, node.providerId, node.variableKey, node, node.payloads);
                        varId = resolved.id;
                        varType = resolved.dataType;

                        node.resolvedId = varId;
                        node.resolvedDataType = varType;
                        node.resolvedFingerprint = resolved.fingerprint;
                        currentFingerprint = resolved.fingerprint;

                        node.status({ fill: 'green', shape: 'ring', text: 'ready' });
                    }

                    varsToWrite.push({
                        id: varId,
                        value: rawPayload,
                        dataType: varType
                    });
                }

                // Build write command (Flatbuffer)
                // Pass the fingerprint (defaults to 0 if not found)
                const writeCommand = node.payloads.encodeWriteVariablesCommand(varsToWrite, currentFingerprint);

                // Publish write command
                const subject = `v1.loc.${node.providerId}.vars.cmd.write`;
                nc.publish(subject, writeCommand);

                const count = varsToWrite.length;
                node.status({ fill: 'green', shape: 'dot', text: `wrote ${count} var(s)` });

                // Output confirmation
                msg.payload = {
                    success: true,
                    providerId: node.providerId,
                    count: count,
                    firstValue: varsToWrite[0].value
                };
                // If single write, maintain legacy output structure for compatibility?
                if (isSingleMode) {
                    msg.payload.variableId = varsToWrite[0].id;
                    msg.payload.variableKey = node.variableKey || null;
                    msg.payload.value = varsToWrite[0].value;
                }

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
