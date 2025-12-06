const path = require('path');
const { pathToFileURL } = require('url');
const flatbuffers = require('flatbuffers');

const payloadModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'payloads.js')).href;
const subjectsModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'subjects.js')).href;
const readResponseUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'fbs', 'weidmueller', 'ucontrol', 'hub', 'read-variables-query-response.js')).href;
const changeEventUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'fbs', 'weidmueller', 'ucontrol', 'hub', 'variables-changed-event.js')).href;

const loadModules = () => Promise.all([
  import(payloadModuleUrl),
  import(subjectsModuleUrl),
  import(readResponseUrl),
  import(changeEventUrl),
]);

const normalizeKey = (key) => (key ? String(key).trim() : '');

module.exports = function (RED) {
  function DataHubInputNode(config) {
    RED.nodes.createNode(this, config);
    const connection = RED.nodes.getNode(config.connection);
    if (!connection) {
      this.status({ fill: 'red', shape: 'ring', text: 'missing config' });
      this.error('Please select a u-OS config node.');
      return;
    }

    this.providerId = config.providerId || 'sampleprovider';
    this.pollingInterval = parseInt(config.pollingInterval, 10) || 0; // ms, 0 = disabled (default)
    const text = config.variablesText || '';
    this.variables = text
      .split(',')
      .map((entry) => (entry ? String(entry).trim() : ''))
      .filter((entry) => entry.length > 0);

    let nc;
    let sub;
    let closed = false;
    const defMap = new Map();

    const shouldInclude = (key) => {
      if (!this.variables.length) {
        return true;
      }
      const needle = normalizeKey(key);
      return this.variables.includes(needle);
    };

    const processStates = (states) => {
      // Helper to find definition by ID (fuzzy match string/number)
      const getDef = (id) => defMap.get(id) || defMap.get(String(id)) || defMap.get(Number(id));

      const mapped = states.map((state) => ({
        providerId: this.providerId,
        id: state.id,
        key: getDef(state.id)?.key || state.id,
        value: state.value,
        quality: state.quality,
        timestampNs: state.timestampNs,
      }));

      // Warn if we have filters but no definitions (all keys will be raw IDs)
      if (this.variables.length > 0 && defMap.size === 0 && mapped.length > 0) {
        this.warnOnce('Filtering active but Variable Definitions failed to load (API Error). Names cannot be resolved, so filters will likely block all data. Please fix the API error (check Provider ID/Permissions).');
      }

      return mapped.filter((state) => shouldInclude(state.key));
    };

    // Helper to warn only once per deployment to avoid log spam
    this.warnOnce = (msg) => {
      if (!this.warned) {
        this.warn(msg);
        this.warned = true;
      }
    };

    let performSnapshot = async () => { }; // Placeholder

    const start = async () => {
      try {
        this.status({ fill: 'yellow', shape: 'ring', text: 'connecting…' });
        const [payloads, subjects, readRespMod, changeEventMod] = await loadModules();
        const { ReadVariablesQueryResponse } = readRespMod;
        const { VariablesChangedEvent } = changeEventMod;

        try {
          const definitions = await connection.fetchProviderVariables(this.providerId);
          definitions.forEach((def) => defMap.set(def.id, def));
        } catch (e) {
          this.warn(`REST API failed (${e.message}). Attempting NATS fallback...`);
          try {
            // Fallback: Fetch definitions via NATS
            // We need to load the response type dynamically as well if not already loaded
            const { ReadProviderDefinitionQueryResponse } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'fbs', 'weidmueller', 'ucontrol', 'hub', 'read-provider-definition-query-response.js')).href);

            // Ensure we have a connection even if start() isn't fully done (we might need to move this)
            // But 'nc' is acquired below. Let's acquire it first if possible, or do this AFTER acquired.
            // Refactoring: We will move this logic 'down' after nc is acquired.
          } catch (natsErr) {
            this.warn(`NATS definition fetch also failed: ${natsErr.message}`);
          }
        }

        nc = await connection.acquire();
        this.status({ fill: 'green', shape: 'dot', text: 'connected' });

        // Retry Definition Fetch via NATS if Map is empty
        if (defMap.size === 0) {
          try {
            this.warn(`Attempting to fetch definitions via NATS for ${this.providerId}...`);
            const defMsg = await nc.request(`v1.loc.${this.providerId}.def.qry.read`, new Uint8Array(0), { timeout: 2000 });
            // We need to decode this manually or use a helper
            // Importing payloads to use our new decode function
            // Assuming payloads is already loaded above

            const defs = payloads.decodeProviderDefinition(defMsg.data);
            this.warn(`NATS Fallback: Loaded ${defs.length} definitions.`);
            defs.forEach((def) => defMap.set(def.id, def));
          } catch (err) {
            this.warn(`NATS Fallback failed: ${err.message}`);
          }
        }

        performSnapshot = async () => {
          // Debugging connection state
          if (!nc || nc.isClosed()) {
            this.warn('Snapshot skipped: Connection is closed or not ready.');
            return;
          }

          try {
            // Log before request
            // this.warn(`Requesting snapshot for ${this.providerId}... (DefMap size: ${defMap.size})`);

            const snapshotMsg = await nc.request(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(), { timeout: 2000 });

            const bb = new flatbuffers.ByteBuffer(snapshotMsg.data);
            const snapshotObj = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(bb);
            const states = payloads.decodeVariableList(snapshotObj.variables());

            // this.warn(`Received ${states.length} items from NATS.`);

            const filteredSnapshot = processStates(states);

            // this.warn(`Filtered down to ${filteredSnapshot.length} items. (Selected vars: ${this.variables.length})`);

            if (filteredSnapshot.length) {
              this.send({ payload: { type: 'snapshot', variables: filteredSnapshot } });
            } else {
              if (states.length > 0) {
                this.warn(`Snapshot received data but everything was filtered out. Check Variable selection. Debug: First raw ID: ${states[0].id}, DefMap has it? ${defMap.has(states[0].id)}`);
              } else {
                this.warn('Snapshot received empty list from Data Hub.');
              }
            }
          } catch (requestErr) {
            this.warn(`Snapshot failed: ${requestErr.message}`);
          }
        };



        // Initial snapshot
        await performSnapshot();

        // Setup polling if configured
        if (this.pollingInterval > 0) {
          this.pollingTimer = setInterval(() => {
            performSnapshot().catch(err => this.error(`Polling error: ${err.message}`));
          }, this.pollingInterval);
        }

        sub = nc.subscribe(subjects.varsChangedEvent(this.providerId));
        (async () => {
          for await (const msg of sub) {
            const eventBB = new flatbuffers.ByteBuffer(msg.data);
            const event = VariablesChangedEvent.getRootAsVariablesChangedEvent(eventBB);
            const changeStates = payloads.decodeVariableList(event.changedVariables());
            const filtered = processStates(changeStates);
            if (filtered.length === 0) {
              continue;
            }
            this.send({ payload: { type: 'change', variables: filtered } });
          }
        })().catch((err) => {
          this.status({ fill: 'red', shape: 'ring', text: 'sub error' });
          this.error(`subscription error: ${err.message}`);
        });
      }
      catch (err) {
        this.status({ fill: 'red', shape: 'ring', text: err.message });
        this.error(err.message);
      }
    };

    this.on('input', (msg, send, done) => {
      performSnapshot()
        .then(() => done())
        .catch((err) => done(err));
    });

    start();

    this.on('close', async (done) => {
      if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
      }
      if (closed) {
        done();
        return;
      }
      closed = true;
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

  RED.nodes.registerType('datahub-input', DataHubInputNode);
};
