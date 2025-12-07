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
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
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
    this.providerId = config.providerId || connection.clientName || 'nodered';

    const defMap = new Map();
    const definitions = [];
    const stateMap = new Map();
    let nextId = 0;
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
        access: 'READ_WRITE',
      };
      defMap.set(normalized, def);
      definitions.push(def);
      stateMap.set(def.id, {
        id: def.id,
        value: defaultValue(dataType),
        timestampNs: Date.now() * 1_000_000,
        quality: 'GOOD',
      });
      return { def, created: true };
    };

    const sendDefinitionUpdate = async (payloads, subjects) => {
      const { payload, fingerprint: fp } = payloads.buildProviderDefinitionEvent(definitions);
      fingerprint = fp;
      await nc.publish(subjects.providerDefinitionChanged(this.providerId), payload);
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

    const start = async () => {
      try {
        this.status({ fill: 'yellow', shape: 'ring', text: 'connecting…' });
        const [payloads, subjects] = await loadModules();
        nc = await connection.acquire();
        await sendDefinitionUpdate(payloads, subjects);
        // Listen for Variable READ requests
        sub = nc.subscribe(subjects.readVariablesQuery(this.providerId), {
          callback: (err, msg) => {
            if (err) {
              this.warn(`Read request error: ${err.message}`);
              return;
            }
            handleRead(payloads, msg).catch((error) => this.warn(error.message));
          },
        });

        // Listen for Definition READ requests (Discovery)
        // SKIPPED: Permission Violation on v1.loc.<id>.def.qry.read
        // Data Hub seems to discover providers via initial announcement or direct variable reads.
        /*
        const defSub = nc.subscribe(subjects.readProviderDefinitionQuery(this.providerId), {
          callback: (err, msg) => {
            if (err) {
              this.warn(`Def request error: ${err.message}`);
              return;
            }
            if (!msg.reply) return;

            // Send known definition
            const { payload } = payloads.buildProviderDefinitionEvent(definitions);
            nc.publish(msg.reply, payload);
          }
        });
        */

        // Track the subscription to close it later if needed (though existing code only tracks 'sub')
        // Ideally we should track both or use a subscription manager, but for now let's hope 'sub' isn't the only one closed.
        // Actually, looking at close(), it likely calls connection.release(). NATS connection close cleans up subs.

        this.status({ fill: 'green', shape: 'dot', text: 'ready' });

        // Periodically republish definition to ensure visibility (Heartbeat)
        const outputHeartbeat = setInterval(() => {
          if (nc && !nc.isClosed()) {
            sendDefinitionUpdate(payloads, subjects).catch(err => {
              this.warn(`Heartbeat error: ${err.message}`);
            });
          }
        }, 10000); // Every 10 seconds

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

            const [payloadsMod, subjectsMod] = await loadModules();
            let definitionsChanged = false;
            const states = [];

            entries.forEach(({ key, value }) => {
              // Ensure we don't accidentally send undefined/null as value if logic slipped through
              if (value === undefined || value === null) return;

              const { def, created } = ensureDefinition(key, inferType(value));
              if (created) {
                definitionsChanged = true;
              }
              const state = {
                id: def.id,
                value,
                timestampNs: Date.now() * 1_000_000,
                quality: 'GOOD',
              };
              states.push(state);
              // states.push(state); // No longer pushing to a temporary 'states' array
              stateMap.set(def.id, state); // Update the global stateMap
            });
            if (definitionsChanged) {
              await sendDefinitionUpdate(payloadsMod, subjectsMod);
              // Give Data Hub a moment to process the new definition before sending values
              await new Promise(r => setTimeout(r, 500));
            }
            // Convert stateMap to Object for payload builder
            const stateObj = {};
            for (const s of stateMap.values()) {
              stateObj[s.id] = s;
            }
            try {
              const payload = payloadsMod.buildVariablesChangedEvent(definitions, stateObj, fingerprint);
              await nc.publish(subjectsMod.varsChangedEvent(this.providerId), payload);
            } catch (err) {
              this.error(`[v0.2.15] Encoding Error: ${err.message}. State: ${JSON.stringify(stateObj)}`);
            }
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
        if (sub) {
          await sub.drain();
        }
        if (outputHeartbeat) clearInterval(outputHeartbeat);
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
