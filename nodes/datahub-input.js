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

      return states
        .map((state) => ({
          providerId: this.providerId,
          id: state.id,
          key: getDef(state.id)?.key || state.id,
          value: state.value,
          quality: state.quality,
          timestampNs: state.timestampNs,
        }))
        .filter((state) => shouldInclude(state.key));
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
          this.warn(`Could not fetch variable definitions: ${e.message}`);
        }

        nc = await connection.acquire();
        this.status({ fill: 'green', shape: 'dot', text: 'connected' });

        performSnapshot = async () => {
          // Only request snapshot if connected
          if (!nc || nc.isClosed()) return;
          try {
            const snapshotMsg = await nc.request(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(), { timeout: 2000 });
            const bb = new flatbuffers.ByteBuffer(snapshotMsg.data);
            const snapshotObj = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(bb);
            const states = payloads.decodeVariableList(snapshotObj.variables());
            const filteredSnapshot = processStates(states);
            if (filteredSnapshot.length) {
              this.send({ payload: { type: 'snapshot', variables: filteredSnapshot } });
            }
          } catch (requestErr) {
            // Log snapshot failures to help debugging
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
