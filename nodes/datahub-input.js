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
    this.variableMode = config.variableMode || 'all';
    try {
      this.variables = JSON.parse(config.variables || '[]').map(normalizeKey).filter((k) => k);
    }
    catch (err) {
      this.variables = [];
    }

    let nc;
    let sub;
    let closed = false;
    const defMap = new Map();

    const shouldInclude = (key) => {
      if (this.variableMode === 'all' || !this.variables.length) {
        return true;
      }
      const needle = normalizeKey(key);
      if (this.variableMode === 'single') {
        return needle === this.variables[0];
      }
      return this.variables.includes(needle);
    };

    const processStates = (states) => {
      return states
        .map((state) => ({
        providerId: this.providerId,
        id: state.id,
        key: defMap.get(state.id)?.key || state.id,
        value: state.value,
        quality: state.quality,
        timestampNs: state.timestampNs,
      }))
        .filter((state) => shouldInclude(state.key));
    };

    const start = async () => {
      try {
        this.status({ fill: 'yellow', shape: 'ring', text: 'connecting…' });
        const [payloads, subjects, readRespMod, changeEventMod] = await loadModules();
        const { ReadVariablesQueryResponse } = readRespMod;
        const { VariablesChangedEvent } = changeEventMod;
        const definitions = await connection.fetchProviderVariables(this.providerId);
        definitions.forEach((def) => defMap.set(def.id, def));
        nc = await connection.acquire();
        this.status({ fill: 'green', shape: 'dot', text: 'connected' });

        const snapshotMsg = await nc.request(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(), { timeout: 2000 });
        const bb = new flatbuffers.ByteBuffer(snapshotMsg.data);
        const snapshotObj = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(bb);
        const states = payloads.decodeVariableList(snapshotObj.variables());
        const filteredSnapshot = processStates(states);
        if (filteredSnapshot.length) {
          this.send({ payload: { type: 'snapshot', variables: filteredSnapshot } });
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
        })().catch((err) => this.warn(`subscription error: ${err.message}`));
      }
      catch (err) {
        this.status({ fill: 'red', shape: 'ring', text: 'error' });
        this.error(err.message);
      }
    };

    start();

    this.on('close', async (done) => {
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
