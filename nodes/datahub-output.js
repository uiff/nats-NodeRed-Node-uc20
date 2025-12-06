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
    this.providerId = config.providerId || 'nodered';

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
      const snapshot = Array.from(stateMap.values());
      const response = payloads.buildReadVariablesResponse(definitions, snapshot, fingerprint);
      await nc.publish(msg.reply, response);
    };

    const start = async () => {
      try {
        this.status({ fill: 'yellow', shape: 'ring', text: 'connecting…' });
        const [payloads, subjects] = await loadModules();
        nc = await connection.acquire();
        await sendDefinitionUpdate(payloads, subjects);
        sub = nc.subscribe(subjects.readVariablesQuery(this.providerId), {
          callback: (err, msg) => {
            if (err) {
              this.warn(`Read request error: ${err.message}`);
              return;
            }
            handleRead(payloads, msg).catch((error) => this.warn(error.message));
          },
        });
        this.status({ fill: 'green', shape: 'dot', text: 'ready' });

        this.on('input', async (msg, send, done) => {
          try {
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
              stateMap.set(def.id, state);
            });
            if (definitionsChanged) {
              await sendDefinitionUpdate(payloadsMod, subjectsMod);
            }
            const payload = payloadsMod.buildVariablesChangedEvent(definitions, states, fingerprint);
            await nc.publish(subjectsMod.varsChangedEvent(this.providerId), payload);
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
