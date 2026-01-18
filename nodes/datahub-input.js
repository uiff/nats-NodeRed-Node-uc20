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

        performSnapshot = async (overrideItems) => {
          if (!nc || nc.isClosed()) {
            this.warn('Snapshot skipped: Connection is closed or not ready.');
            return;
          }

          // Group items by Provider
          // Default Provider: this.providerId
          const requests = new Map(); // ProviderId -> Set<VariableId>

          if (overrideItems) {
            // Dynamic Mode: Resolve each item
            for (const item of overrideItems) {
              let pId = (typeof item === 'object' && item.provider) ? item.provider : this.providerId;
              let key = (typeof item === 'object') ? item.key : item; // String or Object.key

              if (!key) continue;

              try {
                // Use Config Node Resolution (Cache)
                // This handles fetching definitions for ANY provider on demand
                const resolved = await connection.resolveVariableId(pId, key);

                if (!requests.has(pId)) requests.set(pId, new Set());
                requests.get(pId).add(resolved.id);
              } catch (e) {
                this.warn(`Dynamic Read: Skipping '${key}' on '${pId}': ${e.message}`);
              }
            }
          } else {
            // Static Mode: Use local defMap for configured provider
            const targetIds = new Set();
            const isWildcard = (this.variables.length === 0);
            if (!isWildcard) {
              const requestedKeys = new Set(this.variables);
              for (const def of defMap.values()) {
                if (requestedKeys.has(def.key)) targetIds.add(def.id);
              }
              if (targetIds.size === 0) {
                this.warn(`Snapshot Aborted: None of the configured variables could be resolved.`);
                return;
              }
            }
            requests.set(this.providerId, targetIds); // Empty Set = Wildcard
          }

          if (requests.size === 0) {
            this.warn("Snapshot Aborted: No valid variables resolved.");
            return;
          }

          const allResults = [];
          const errors = [];

          // Execute Requests (Serial or Parallel?) 
          // Using Serial to be safe with connection bandwidth
          for (const [pId, varIds] of requests) {
            try {
              let targetIdsArr = Array.from(varIds);

              // Request
              let snapshotMsg;
              if (typeof connection.serialRequest === 'function') {
                snapshotMsg = await connection.serialRequest(subjects.readVariablesQuery(pId), payloads.buildReadVariablesQuery(targetIdsArr), { timeout: 10000 });
              } else {
                snapshotMsg = await nc.request(subjects.readVariablesQuery(pId), payloads.buildReadVariablesQuery(targetIdsArr), { timeout: 10000 });
              }

              const bb = new flatbuffers.ByteBuffer(snapshotMsg.data);
              const snapshotObj = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(bb);
              const states = payloads.decodeVariableList(snapshotObj.variables());

              // Add Provider Info to Result?
              // ProcessStates adds keys, but we might want to know which provider it came from if mixed?
              // The current `processStates` maps IDs back to Keys using `defMap`. 
              // ISSUE: `defMap` only has local provider defs.
              // If we read from foreign provider, `processStates` will return IDs or "Unknown".
              // We need `resolveVariableId` to also START caching the reverse lookup or we assume result has IDs?
              // Wait, `decodeVariableList` returns {id, value}.
              // `processStates` tries to find Key.

              // QUICK FIX for Dynamic Multi-Provider:
              // If pId !== this.providerId, we don't have local defMap.
              // But `resolveVariableId` (in config) caches definitions.
              // We can ask config to resolve ID back to Key? Or just return ID?
              // Better: We know the Keys we asked for.

              // Let's modify processStates to accept a custom Map?
              // Or simple: Just return the raw objects with IDs if we can't map them?
              // Actually, for Dynamic Read, users might accept {id, value} or we try to enrich.

              const enriched = states.map(s => {
                // Try local defMap
                if (pId === this.providerId && defMap.has(s.id)) {
                  return { ...s, key: defMap.get(s.id).key, provider: pId };
                }
                // Try Config Node Cache (it has all fetched defs)
                const cachedDef = connection.getProviderVariable(pId, s.id);
                if (cachedDef) {
                  return { ...s, key: cachedDef.key, provider: pId };
                }
                return { ...s, key: `id:${s.id}`, provider: pId };
              });

              allResults.push(...enriched);

            } catch (err) {
              errors.push(`${pId}: ${err.message}`);
            }
          }

          if (allResults.length > 0) {
            this.send({ payload: { type: 'snapshot', variables: allResults } });
            this.status({ fill: 'green', shape: 'dot', text: 'active' });
          } else if (errors.length > 0) {
            this.warn(`Snapshot errors: ${errors.join('; ')}`);
            this.status({ fill: 'red', shape: 'ring', text: 'error' });
          } else {
            this.status({ fill: 'green', shape: 'ring', text: 'empty' });
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
      let overrideItems = null;
      if (Array.isArray(msg.payload) && msg.payload.length > 0) {
        // Pass the raw array items (String or Object {provider, key})
        // performSnapshot will handle filtering
        overrideItems = msg.payload;
      }

      performSnapshot(overrideItems)
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
