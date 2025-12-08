const path = require('path');
const { pathToFileURL } = require('url');

const payloadModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'payloads.js')).href;
const subjectsModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'subjects.js')).href;

const loadModules = () => Promise.all([
  import(payloadModuleUrl),
  import(subjectsModuleUrl),
]);

const inferType = (value) => {
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'INT64' : 'FLOAT64';
  }
  return 'STRING';
};

const defaultValue = (type) => {
  switch (type) {
    case 'BOOLEAN':
      return false;
    case 'INT64':
    case 'FLOAT64':
      return 0;
    case 'STRING':
    default:
      return '';
  }
};

const flattenPayload = (value, prefix = '') => {
  const entries = [];
  const path = (key) => (prefix ? `${prefix}.${key}` : key);

  // Extended Value Object Detection:
  // If object has 'value' AND ('quality' OR 'timestamp'), treat as single leaf with metadata.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('value' in value && ('quality' in value || 'timestamp' in value)) {
      entries.push({
        key: prefix || 'value', // If root is the object
        value: value.value,
        quality: value.quality,
        timestamp: value.timestamp
      });
      return entries;
    }

    Object.entries(value).forEach(([key, val]) => {
      if (val !== undefined) {
        entries.push(...flattenPayload(val, path(key)));
      }
    });
  }
  else if (Array.isArray(value)) {
    value.forEach((val, idx) => {
      if (val !== undefined) {
        entries.push(...flattenPayload(val, prefix ? `${prefix}[${idx}]` : `[${idx}]`));
      }
    });
  }
  else {
    const keyName = prefix || 'value';
    entries.push({ key: keyName, value });
  }
  return entries;
};

module.exports = function (RED) {
  function DataHubOutputNode(config) {
    RED.nodes.createNode(this, config);
    const connection = RED.nodes.getNode(config.connection);
    if (!connection) {
      this.status({ fill: 'red', shape: 'ring', text: 'missing config' });
      this.error('Please select a u-OS config node.');
      return;
    }
    // Retrieve configuration node
    // Default to Connection's Client Name (Friendly Name) because Client ID is often a UUID
    // that doesn't match the desired Provider ID. User typically expects 'nodered' not '0069...'
    let defaultId = connection.clientName;
    if (!defaultId) {
      // Fallback to ID if Name is missing (should not happen as Name is mandatory)
      defaultId = connection.clientId || 'nodered';
    }

    let pId = (config.providerId || '').trim();
    if (!pId) {
      pId = defaultId;
    }
    this.providerId = pId;
    // this.definitions = config.definitions || [];

    const defMap = new Map();
    const definitions = [];
    const stateMap = new Map();
    let nextId = 100;
    let fingerprint = 0;
    let nc;
    let sub;

    const ensureDefinition = (key, dataType) => {
      const normalized = key.trim();
      if (defMap.has(normalized)) {
        return { def: defMap.get(normalized), created: false };
      }
      const def = {
        id: nextId += 1,
        key: normalized,
        dataType,
        access: config.enableWrites ? 'READ_WRITE' : 'READ_ONLY',
      };
      defMap.set(normalized, def);
      definitions.push(def);
      stateMap.set(def.id, {
        id: def.id,
        value: defaultValue(dataType),
        timestamp: BigInt(Date.now()) * 1_000_000n,
        quality: 'GOOD',
      });
      return { def, created: true };
    };

    // --- SEND DEFINITION HELPER ---
    const sendDefinitionUpdate = async (modPayloads, modSubjects) => {
      if (!nc) return;
      try {
        const { payload, fingerprint: fp } = modPayloads.buildProviderDefinitionEvent(definitions);
        const subject = modSubjects.providerDefinitionChanged(this.providerId);

        console.log(`[DataHub Output] Publishing definition for Provider '${this.providerId}' to '${subject}'`);

        fingerprint = fp;
        await nc.publish(subject, payload);
        await nc.flush();
        console.log(`[DataHub Output] Definition published. FP: ${fp}`);
      } catch (err) {
        this.warn(`Definition update error: ${err.message}`);
      }
    };

    const handleRead = async (payloads, msg) => {
      if (!msg.reply)
        return;

      // Convert stateMap to ID-indexed Object for correct lookup in payloads.js
      const stateObj = {};
      for (const s of stateMap.values()) {
        stateObj[s.id] = s;
      }
      const response = payloads.buildReadVariablesResponse(definitions, stateObj, fingerprint);
      await nc.publish(msg.reply, response);
    };

    // Store loaded modules for heartbeat
    let loadedPayloads = null;
    let loadedSubjects = null;

    const sendValuesUpdate = async () => {
      if (!nc || nc.isClosed()) {
        // console.log('[DataHub Output] Heartbeat skipped: NATS closed.');
        return;
      }
      if (!loadedPayloads || !loadedSubjects) return;

      // If we have no definitions yet, nothing to send
      if (definitions.length === 0) return;

      // Log heartbeat occasionally to prove aliveness
      const nowMs = Date.now();
      if (!this.lastHeartbeatLog || nowMs - this.lastHeartbeatLog > 10000) {
        this.lastHeartbeatLog = nowMs;
      }

      const stateObj = {};
      for (const s of stateMap.values()) {
        s.timestamp = BigInt(Date.now()) * 1_000_000n; // Force refresh timestamp
        stateObj[s.id] = s;
      }
      try {
        const payload = loadedPayloads.buildVariablesChangedEvent(definitions, stateObj, fingerprint);
        const subject = loadedSubjects.varsChangedEvent(this.providerId);

        await nc.publish(subject, payload);
        await nc.flush();
      } catch (err) {
        this.warn(`Heartbeat error: ${err.message}`);
      }
    };

    const valueHeartbeat = setInterval(() => {
      sendValuesUpdate();
    }, 1000); // 1.0s interval matches Python SDK

    // Reconnect Handler (Defined outside start to be referenced in close)
    const onReconnect = () => {
      console.log('[DataHub Output] Connection restored (event). Re-sending definition...');
      this.status({ fill: 'green', shape: 'ring', text: 'reconnected' });
      // Force definition update immediately upon reconnection
      if (loadedPayloads && loadedSubjects) {
        sendDefinitionUpdate(loadedPayloads, loadedSubjects).catch(err => {
          this.warn(`Reconnect update error: ${err.message}`);
        });
      }
    };

    const start = async () => {
      try {
        console.log('[DataHub Output] Starting...');
        this.status({ fill: 'yellow', shape: 'ring', text: 'connecting…' });
        const [payloads, subjects] = await loadModules();
        console.log('[DataHub Output] Modules loaded.');
        loadedPayloads = payloads;
        loadedSubjects = subjects;

        nc = await connection.acquire();
        console.log('[DataHub Output] NATS acquired.');

        // ATTACH LISTENER HERE
        connection.on('reconnected', onReconnect);

        if (definitions.length > 0) {
          // Initial publish
          await sendDefinitionUpdate(payloads, subjects);

          // Subscribe to Registry State changes
          nc.subscribe(subjects.registryStateEvent(), {
            callback: (err, msg) => {
              if (err) return;
              try {
                const state = payloads.parseRegistryStateEvent(msg.data);
                if (state === 1) { // 1 = RUNNING
                  console.log('[DataHub Output] Registry is RUNNING. Re-publishing definition...');
                  sendDefinitionUpdate(payloads, subjects);
                }
              } catch (e) {
                console.warn('[DataHub Output] Registry state parse error:', e);
              }
            }
          });
          console.log('[DataHub Output] Subscribed to Registry State.');
        }

        // Listen for Variable READ requests
        sub = nc.subscribe(subjects.readVariablesQuery(this.providerId), {
          callback: (err, msg) => {
            if (err) {
              if (err.message.includes('Permissions Violation')) {
                return;
              }
              this.warn(`Read request error: ${err.message}`);
              return;
            }
            handleRead(payloads, msg).catch((error) => this.warn(error.message));
          },
        });
        console.log('[DataHub Output] Subscribed to Read Query.');

        // LISTEN FOR WRITE COMMANDS (BIDIRECTIONAL)
        if (config.enableWrites) {
          const writeSubject = subjects.writeVariablesCommand(this.providerId);
          console.log(`[DataHub Output] Subscribing to WRITE command: ${writeSubject}`);

          nc.subscribe(writeSubject, {
            callback: (err, msg) => {
              if (err) {
                this.warn(`Write command error: ${err.message}`);
                return;
              }
              try {
                const updates = payloads.decodeWriteVariablesCommand(msg.data);
                if (!updates || updates.length === 0) return;

                console.log(`[DataHub Output] Received WRITE for ${updates.length} vars.`);

                // Prepare output for Node-RED Flow
                const outputMsgs = [];
                let stateChanged = false;

                updates.forEach(update => {
                  // Find defining key by ID
                  // This is expensive O(N). Optimization: Map<ID, Key>
                  // But definitions are usually few (<1000).
                  // We have stateMap keyed by ID!
                  const currentState = stateMap.get(update.id);
                  if (currentState) {
                    // Update internal state
                    currentState.value = update.value;
                    currentState.timestamp = BigInt(Date.now()) * 1_000_000n;
                    currentState.quality = 'GOOD_LOCAL_OVERRIDE'; // Mark as written? Or just GOOD? 
                    // NATS Sample uses GOOD.

                    // Find key (optional, for convenience in msg)
                    const def = definitions.find(d => d.id === update.id);
                    const key = def ? def.key : `id_${update.id}`;

                    outputMsgs.push({
                      topic: key,
                      payload: update.value,
                      var: key,
                      value: update.value,
                      providerId: this.providerId,
                      _msgid: RED.util.generateId()
                    });
                    stateChanged = true;
                  }
                });

                if (stateChanged) {
                  // ACK changes back to DataHub (VariablesChangedEvent)
                  // This confirms to the writer that the value was accepted.
                  sendValuesUpdate();

                  // Emit to 2nd Output
                  if (outputMsgs.length > 0) {
                    // Node-RED send: [output1, output2]
                    // We send null to output1 (pass-through not involved here)
                    // We send array of msgs to output2? Or one by one?
                    // Ideally one array if multiple updates?
                    // Let's send them individually to be safe with flows.
                    outputMsgs.forEach(m => {
                      this.send([null, m]);
                    });
                  }
                }

              } catch (e) {
                this.warn(`Failed to process write command: ${e.message}`);
              }
            }
          });
        }

        this.status({ fill: 'green', shape: 'dot', text: 'ready' });

        // Heartbeat Restored: Provider disappears if definition is not refreshed.
        // Configurable via UI. Default 300s (5min).
        const hbIntervalSeconds = parseInt(config.heartbeatInterval) || 300;
        const hbIntervalMs = hbIntervalSeconds * 1000;

        console.log(`[DataHub Output] Definition Heartbeat set to ${hbIntervalSeconds}s`);

        const outputHeartbeat = setInterval(() => {
          if (nc && !nc.isClosed()) {
            // console.log('[DataHub Output] Sending Definition Heartbeat...');
            sendDefinitionUpdate(payloads, subjects).catch(err => {
              this.warn(`Heartbeat error: ${err.message}`);
            });
          }
        }, hbIntervalMs);


        this.on('input', async (msg, send, done) => {
          try {
            // Auto-parse string payloads
            if (typeof msg.payload === 'string') {
              try {
                msg.payload = JSON.parse(msg.payload);
              } catch (e) {
                // Ignore parse error, let validation below handle it
              }
            }

            if (!msg || !msg.payload || typeof msg.payload !== 'object') {
              done(new Error('Payload must be an object describing your structure.'));
              return;
            }
            const entries = flattenPayload(msg.payload);

            // Optimization: If payload is empty after flattening (e.g. only undefined values), stop here
            if (!entries.length) {
              done();
              return;
            }

            let definitionsChanged = false;

            entries.forEach((entry) => {
              const { key, value } = entry;
              // Ensure we don't accidentally send undefined/null as value if logic slipped through
              if (value === undefined || value === null) return;

              const { def, created } = ensureDefinition(key, inferType(value));
              if (created) {
                definitionsChanged = true;
              }

              // Handle custom timestamp
              let ts = BigInt(Date.now()) * 1_000_000n;
              if (entry.timestamp) {
                try {
                  // Support Date object or number (ms)
                  const ms = (entry.timestamp instanceof Date) ? entry.timestamp.getTime() : Number(entry.timestamp);
                  if (!isNaN(ms)) {
                    ts = BigInt(Math.floor(ms)) * 1_000_000n;
                  }
                } catch (e) { /* ignore */ }
              }

              // Handle custom quality
              let qual = 'GOOD';
              if (entry.quality) {
                qual = String(entry.quality).toUpperCase();
              }

              const state = {
                id: def.id,
                value,
                timestamp: ts,
                quality: qual,
              };
              // states.push(state); // No longer pushing to a temporary 'states' array
              stateMap.set(def.id, state); // Update the global stateMap
            });

            if (definitionsChanged) {
              // If definition changed, we MUST publish definition first
              await sendDefinitionUpdate(loadedPayloads, loadedSubjects);
              await new Promise(r => setTimeout(r, 200));
            }

            // Publish values immediately on input (don't wait for heartbeat)
            await sendValuesUpdate();

            send(msg);
            done();
          }
          catch (err) {
            done(err);
          }
        });
      }
      catch (err) {
        this.status({ fill: 'red', shape: 'ring', text: err.message });
        this.error(err.message);
      }
    };

    start();

    this.on('close', async (done) => {
      try {
        // REMOVE LISTENER
        if (connection && onReconnect) {
          connection.removeListener('reconnected', onReconnect);
        }

        if (valueHeartbeat) clearInterval(valueHeartbeat);
        if (sub) {
          await sub.drain();
        }
        await connection.release();
      }
      catch (err) {
        this.warn(`closing error: ${err.message}`);
      }
      done();
    });
  }

  RED.nodes.registerType('datahub-output', DataHubOutputNode);
};
