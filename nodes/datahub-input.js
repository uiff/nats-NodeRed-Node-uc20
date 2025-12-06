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
    this.mode = config.mode || 'auto';
    this.triggerMode = config.triggerMode || 'event';
    this.pollingInterval = this.triggerMode === 'poll' ? (parseInt(config.pollingInterval, 10) || 1000) : 0;

    const text = config.variablesText || '';
    const manualText = config.manualVariables || '';
    const singleName = config.singleName || '';
    const singleId = config.singleId || '';

    // Initialize containers
    this.variables = [];
    this.manualDefs = [];

    // --- Mode-Based Initialization ---
    if (this.mode === 'manual_single') {
      // Mode: Manual Single
      // Strictly use Single Name/ID. Ignore others.
      if (singleName && singleId !== '') {
        const id = parseInt(singleId, 10);
        if (!isNaN(id)) {
          this.manualDefs.push({ id, key: String(singleName).trim() });
        }
      }
    }
    else if (this.mode === 'manual_multi') {
      // Mode: Manual Multi (Table)
      if (manualText) {
        manualText.split(',').forEach(entry => {
          let trimmed = entry ? String(entry).trim() : '';
          if (trimmed.includes(':')) {
            const parts = trimmed.split(':');
            const name = parts[0].trim();
            const id = parseInt(parts[1].trim(), 10);
            if (name && !isNaN(id)) {
              this.manualDefs.push({ id, key: name });
            }
          }
        });
      }
    }
    else {
      // Mode: Auto (Default)
      // NEW: Auto-Mode now ALSO uses manualText (UI stores name:id pairs there)
      // This gives us the IDs we need!
      if (manualText) {
        manualText.split(',').forEach(entry => {
          let trimmed = entry ? String(entry).trim() : '';
          if (trimmed.includes(':')) {
            const parts = trimmed.split(':');
            const name = parts[0].trim();
            const id = parseInt(parts[1].trim(), 10);
            if (name && !isNaN(id)) {
              this.manualDefs.push({ id, key: name });
            }
          }
        });
      }

      // Legacy: Also parse variablesText for backward compatibility
      this.variables = text
        .split(',')
        .map((entry) => (entry ? String(entry).trim() : ''))
        .filter((entry) => entry.length > 0);
    }

    let nc;
    let sub;
    let closed = false;
    const defMap = new Map();

    // Fix: Add manual keys to the filter list (this.variables) so they act as whitelist
    if (this.manualDefs.length > 0) {
      this.manualDefs.forEach(d => {
        const needle = normalizeKey(d.key);
        if (needle && !this.variables.includes(needle)) {
          this.variables.push(needle);
        }
      });
    }

    // Pre-populate raw map with manual definitions
    this.manualDefs.forEach(d => defMap.set(d.id, { ...d, type: 'MANUAL', dataType: 'UNKNOWN', access: 'READ_ONLY' }));

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
      // Skip warning if we have manual definitions or successfully loaded map
      if (this.variables.length > 0 && defMap.size === 0 && mapped.length > 0) {
        this.warnOnce('Filtering active but Variable Definitions failed to load (API Error). Names cannot be resolved. Try using "Name:ID" format to manually map variables.');
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

        // Try to fetch definitions (Discovery), but respect manual defs
        try {
          // Verify connection first or use connection helper? 
          // fetchProviderVariables uses HTTP, so it's independent of 'nc'
          const definitions = await connection.fetchProviderVariables(this.providerId);
          definitions.forEach((def) => defMap.set(def.id, def));
        } catch (e) {
          // Only warn if we don't have manual defs to fall back on
          if (this.manualDefs.length === 0) {
            this.warn(`REST API failed (${e.message}). Attempting NATS fallback...`);
          } else {
            this.warn(`REST API Discovery failed, but using ${this.manualDefs.length} manual definitions.`);
          }

          try {
            // Fallback: Fetch definitions via NATS
            // ... import and logic remains ... 
            // We can skip NATS fetch if manual defs are sufficient? 
            // Better to try anyway to get Metadata (DataType etc).
            const { ReadProviderDefinitionQueryResponse } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'fbs', 'weidmueller', 'ucontrol', 'hub', 'read-provider-definition-query-response.js')).href);
          } catch (natsErr) {
            if (this.manualDefs.length === 0) this.warn(`NATS definition fetch also failed: ${natsErr.message}`);
          }
        }


        nc = await connection.acquire();
        this.status({ fill: 'green', shape: 'dot', text: 'connected' });

        // Retry Definition Fetch via NATS if Map is empty AND no manual defs
        if (defMap.size === 0 && this.manualDefs.length === 0) {
          try {
            // Strategy 1: Direct Provider Query (Standard for many providers)
            this.warn(`Attempting NATS Discovery (Direct) for ${this.providerId}...`);
            const defMsg = await nc.request(subjects.readProviderDefinitionQuery(this.providerId), payloads.buildReadProviderDefinitionQuery(), { timeout: 1000 });
            const defs = payloads.decodeProviderDefinition(defMsg.data);
            this.warn(`NATS Direct Discovery: Loaded ${defs.length} variables.`);
            defs.forEach((def) => defMap.set(def.id, def));
          } catch (firstErr) {
            // Strategy 2: Registry Query (Central lookup, often requires different perms or used by Hub)
            try {
              this.warn(`NATS Direct failed (${firstErr.message}), trying Registry Discovery...`);
              // Note: 'registryProviderQuery' accesses the central registry which might proxy the definition
              const regMsg = await nc.request(subjects.registryProviderQuery(this.providerId), payloads.buildReadProviderDefinitionQuery(), { timeout: 2000 });
              const defs = payloads.decodeProviderDefinition(regMsg.data);
              this.warn(`NATS Registry Discovery: Loaded ${defs.length} variables.`);
              defs.forEach((def) => defMap.set(def.id, def));
            } catch (secondErr) {
              this.warn(`All Discovery methods failed (REST, NATS Direct, NATS Registry). Please use Manual Definitions (Name:ID). Error: ${secondErr.message}`);
            }
          }
        }

        performSnapshot = async () => {
          // Debugging connection state
          if (!nc || nc.isClosed()) {
            this.warn('Snapshot skipped: Connection is closed or not ready.');
            return;
          }

          try {
            // Resolve requested variable names to IDs
            let targetIds = [];
            if (this.variables.length > 0) {
              // Reverse lookup: Find Def by Key
              const requestedKeys = new Set(this.variables);

              // Debug Map Content before filtering
              // if (defMap.size > 0 && providerRequestCount < 2) { 
              //    this.warn(`DefMap Dump (Size ${defMap.size}): ${Array.from(defMap.values()).map(d=>d.key).slice(0,5).join(', ')} ...`);
              // }

              for (const def of defMap.values()) {
                if (requestedKeys.has(def.key)) {
                  targetIds.push(Number(def.id));
                }
              }
              if (targetIds.length === 0 && defMap.size > 0) {
                // Warning logic ...
                const sampleKeys = Array.from(defMap.values()).filter(d => d.type !== 'MANUAL').map(d => `'${d.key}'`).slice(0, 5).join(', ');
                this.warn(`Snapshot Warning: None of the ${this.variables.length} configured variables were found in the Provider Definition.`);
                if (!sampleKeys && this.manualDefs.length > 0) {
                  this.warn('   -> Manual Definitions are configured but did not match the requested variable names? Check capitalization.');
                }
              }
            }

            // If we have specific IDs, request only those. Otherwise request all (empty array).
            const snapshotMsg = await nc.request(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(targetIds), { timeout: 2000 });

            const bb = new flatbuffers.ByteBuffer(snapshotMsg.data);
            const snapshotObj = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(bb);
            const states = payloads.decodeVariableList(snapshotObj.variables());

            // Re-process states (lookup names, formatting)
            const filteredSnapshot = processStates(states);

            if (filteredSnapshot.length) {
              this.send({ payload: { type: 'snapshot', variables: filteredSnapshot } });
            } else {
              if (states.length > 0) {
                this.warn(`Snapshot received data but everything was filtered out. Check Variable selection. Debug: First raw ID: ${states[0].id}, DefMap has it? ${defMap.has(states[0].id)}`);
              } else {
                this.warn(`Snapshot received empty list from Data Hub. (Requested ${targetIds.length > 0 ? targetIds.length + ' specific IDs' : 'ALL variables'}).`);
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
