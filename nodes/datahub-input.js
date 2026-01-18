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

    this.providerId = (config.providerId || 'sampleprovider').trim();
    this.triggerMode = config.triggerMode || 'event';
    this.pollingInterval = this.triggerMode === 'poll' ? (parseInt(config.pollingInterval, 10) || 1000) : 0;

    const manualText = config.manualVariables || '';

    // Initialize containers
    this.variables = [];
    this.manualDefs = [];

    // Parse Manual Variables (Name:ID)
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

    // Warn if manual config existed but resulted in no valid definitions (e.g. corruption or NaN IDs)
    if (manualText.length > 0 && this.manualDefs.length === 0) {
      this.warn("Configuration Warning: 'Selected Variables' contained data but no valid IDs could be parsed. Falling back to 'Read All'. Please re-select variables in the editor.");
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

        // Optimierte Discovery: Zentraler Abruf über Config Node (Cached & Deduped)
        try {
          // Versuche primär die NATS-Definition via Config Node zu holen
          if (typeof connection.getProviderDefinition === 'function') {
            const def = await connection.getProviderDefinition(this.providerId);
            if (def && def.variables) {
              def.variables.forEach((d) => defMap.set(d.id, d));
              this.debug(`Loaded ${def.variables.length} variables from Central Cache for ${this.providerId}`);
            }
          } else {
            const definitions = await connection.fetchProviderVariables(this.providerId);
            if (definitions) definitions.forEach((def) => defMap.set(def.id, def));
          }
        } catch (e) {
          // ... legacy fallback logic ...
          // (Simplified for replacement block to match existing context)
          // If NATS discovery failed, try fetchProviderVariables (REST) logic...
          this.debug(`Central NATS Discovery failed (${e.message}). Trying REST Fallback...`);
          try {
            const definitions = await connection.fetchProviderVariables(this.providerId);
            if (definitions) definitions.forEach((def) => defMap.set(def.id, def));
          } catch (restErr) {
            if (this.manualDefs.length === 0) {
              this.warn(`Discovery failed: ${restErr.message}. Using Manual/Raw.`);
            }
          }
        }

        // CRITICAL FIX: Acquire NATS Connection!
        nc = await connection.acquire();


        // Apply Manual Overrides / Additions
        this.manualDefs.forEach(d => {
          if (!defMap.has(d.id)) {
            defMap.set(d.id, { ...d, type: 'MANUAL', dataType: 'UNKNOWN', access: 'READ_ONLY' });
          }
        });

        // GATE: If no definitions found (Discovery Failed AND No Manual), skip polling to avoid 503 spam
        const hasDefinitions = defMap.size > 0;
        if (!hasDefinitions) {
          this.warn(`Startup Aborted for '${this.providerId}': No Variable Definitions found (Discovery failed & No Manual Defs). Polling/Snapshot would just error 503.`);
          this.status({ fill: 'red', shape: 'dot', text: 'discovery failed' });
          return; // Stop here, do not start Interval or Subscription
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
            let isWildcard = (this.variables.length === 0);

            if (!isWildcard) {
              // Reverse lookup: Find Def by Key
              const requestedKeys = new Set(this.variables);

              for (const def of defMap.values()) {
                if (requestedKeys.has(def.key)) {
                  targetIds.push(Number(def.id));
                }
              }

              // CRITICAL FIX: If user requested specific variables but we found NONE, 
              // we MUST NOT send an empty list, because that would interpret as "Read All".
              if (targetIds.length === 0) {
                // Already handled by Gate above mostly, but good for safety
                this.warn(`Snapshot Aborted: None of the ${this.variables.length} requested variables could be resolved to IDs.`);
                return;
              }
            }

            // If Wildcard (empty targetIds and isWildcard=true) -> Request ALL.
            // If Specific (targetIds has items) -> Request specific.
            // Use serialRequest via Config Node to prevent concurrency issues on the connection
            // Simple Snapshot Logic using Config Node Semaphore
            // The Config Node now handles concurrency (max 3 parallel), preventing 503s naturally.
            // We use a simple retry wrapper just in case.
            let lastError;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                let snapshotMsg;
                // If config node has serialRequest (Semaphore), use it.
                if (typeof connection.serialRequest === 'function') {
                  snapshotMsg = await connection.serialRequest(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(targetIds), { timeout: 10000 });
                } else {
                  // Fallback to direct request (unsafe)
                  snapshotMsg = await nc.request(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(targetIds), { timeout: 10000 });
                }

                const bb = new flatbuffers.ByteBuffer(snapshotMsg.data);
                const snapshotObj = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(bb);
                const states = payloads.decodeVariableList(snapshotObj.variables());

                const filteredSnapshot = processStates(states);
                if (filteredSnapshot.length > 0) {
                  this.send({ payload: { type: 'snapshot', variables: filteredSnapshot } });
                  this.status({ fill: 'green', shape: 'dot', text: 'active' });
                } else {
                  // Handle empty/partial...
                  this.status({ fill: 'green', shape: 'ring', text: 'active (empty)' });
                }
                return true; // Success

              } catch (err) {
                lastError = err;
                // If semaphore is full or timeout, wait a bit
                await new Promise(r => setTimeout(r, 1000 * attempt));
              }
            }
            if (lastError) {
              const msg = lastError.message || '';
              if (msg.includes('503') || msg.includes('no responders')) {
                this.debug(`Snapshot skipped (Provider offline/503): ${msg}`);
                this.status({ fill: 'yellow', shape: 'dot', text: 'provider offline' });
              } else if (msg.includes('Cooldown')) {
                this.debug(`Snapshot skipped (Cooldown): ${msg}`);
                this.status({ fill: 'yellow', shape: 'ring', text: 'cooldown (10s)' });
              } else if (msg.includes('Authorization') || msg.includes('Permission')) {
                this.debug(`Snapshot skipped (Auth): ${msg}`);
                this.status({ fill: 'yellow', shape: 'ring', text: 'auth failed' });
              } else {
                this.warn(`Snapshot failed: ${msg}`);
                this.status({ fill: 'red', shape: 'ring', text: 'snapshot error' });
              }
            }
          } catch (e) {
            const msg = e.message || '';
            if (msg.includes('503') || msg.includes('no responders')) {
              this.debug(`Snapshot skipped (Provider offline/503): ${msg}`);
            } else if (msg.includes('Cooldown')) {
              // Ignore cooldown errors in outer catch
            } else {
              this.warn(`Snapshot failed: ${msg}`);
            }
          }
        };



        await performSnapshot();

        // RECONNECT LOGIC
        const setupSubscription = async () => {
          // Ensure we are using the latest connection
          try {
            nc = await connection.acquire();
          } catch (e) {
            this.debug(`Reconnect acquire failed: ${e.message}`);
            return;
          }

          if (sub) {
            try { await sub.drain(); } catch (e) { }
          }

          this.log(`Subscribing to changes for ${this.providerId}...`);
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
            // ... error handling similar to below ...
            let txt = 'sub error';
            let msg = err.message || '';
            if (msg.includes('Authorization') || msg.includes('permissions') || msg.includes('10003')) {
              txt = 'auth violation';
            }
            // Only show red if it's not a known disconnect
            if (!msg.includes('closed') && !msg.includes('draining')) {
              this.status({ fill: 'red', shape: 'ring', text: txt });
              this.warn(`subscription error: ${err.message}`);
            }
          });
        };

        connection.on('reconnected', () => {
          this.log('NATS Connection restored. Refreshing Snapshot & Subscription...');
          this.status({ fill: 'green', shape: 'ring', text: 'reconnected' });
          performSnapshot(); // Refresh values
          setupSubscription(); // Re-suscriber
        });

        // Setup polling if configured
        if (this.pollingInterval > 0) {
          this.pollingTimer = setInterval(() => {
            performSnapshot().catch(err => this.error(`Polling error: ${err.message}`));
          }, this.pollingInterval);
        }

        await setupSubscription();
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
