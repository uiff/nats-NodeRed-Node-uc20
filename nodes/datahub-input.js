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

        // Retry Definition Fetch via NATS if Map is empty OR if we have Heuristic IDs (missingId)
        // Heuristic IDs (ID=Index) are dangerous because they might not match the real NATS IDs (e.g. 291 vs 5)
        const hasMissingIds = Array.from(defMap.values()).some(d => d.missingId);

        if ((defMap.size === 0 && this.manualDefs.length === 0) || hasMissingIds) {
          try {
            // Changed from warn to debug to reduce noise as per user request
            this.debug(hasMissingIds
              ? `Loaded variables have unresolved IDs (Heuristic). Attempting NATS Discovery to resolve real IDs for ${this.providerId}...`
              : `Attempting NATS Discovery (Direct) for ${this.providerId}...`
            );

            // Strategy 1: Direct Provider Query (Standard for many providers)
            const requestOptions = { timeout: 2000 };
            // Reuse serialRequest if available to avoid blocking connection? 
            // Discovery is one-off, nc.request is fine, but safer to use serial if we updated input.js fully. 
            // Start uses 'nc' directly currently. That's fine for now as it's sequential in 'start'.

            const defMsg = await nc.request(subjects.readProviderDefinitionQuery(this.providerId), payloads.buildReadProviderDefinitionQuery(), requestOptions);
            const defs = payloads.decodeProviderDefinition(defMsg.data);

            if (defs && defs.variables.length > 0) {
              this.debug(`NATS Discovery Successful: Received ${defs.variables.length} definitions with real IDs.`);
              // Overwrite/Update defMap
              // Logic: Match by KEY. DataHub providers should have unique keys.
              // If we have existing "fake" ID 5 for "temp", and NATS says "temp" is ID 291.
              // We need to update defMap to use 291.

              // Clear Heuristic entries if we trust NATS fully? 
              // Or just merge?
              // Safer: Create a lookup from NATS.
              const realMap = new Map();
              defs.variables.forEach(d => realMap.set(d.key, d));

              // Update existing defMap
              // If we had a heuristic entry, replace it.
              // We rebuild defMap based on NATS mostly, but keep manual fallback?

              // Let's iterate NATS defs and Populating defMap.
              // Note: NATS Defs don't have 'missingId'.
              defs.variables.forEach(d => {
                // If we overwrite, we lose manual metadata (if any)? 
                // REST might have had better metadata? Usually NATS is source of truth for IDs.
                defMap.set(d.id, d);
              });

              // Use Key Matching to remove old Heuristic entries?
              // Heuristic entries are stored by Key (via fetchProviderVariables logic? No, by ID).
              // We need to clean up the Fake IDs (0..N) if they don't map to real IDs.
              // Actually, if we just add real IDs, we have duplicates?
              // Map is Key=ID.
              // Fake ID 5: { key: 'voltage' }
              // Real ID 291: { key: 'voltage' }
              // If user selected 'voltage', filtering uses KEYS (processStates line 104).
              // Resolution (line 195) iterates values and matches Key.
              // It will find BOTH 5 and 291.
              // targetIds will get [5, 291].
              // DataHub gets request [5, 291].
              // 5 is invalid -> ignored.
              // 291 is valid -> returns value.
              // Result: It works! (Partially, effectively).

              // But cleaner to remove heuristic ones.
              for (const [id, def] of defMap.entries()) {
                if (def.missingId) {
                  const real = realMap.get(def.key);
                  if (real && real.id !== id) {
                    defMap.delete(id); // Remove fake ID
                  }
                }
              }
              this.warn(`IDs resolved via NATS. Mapped ${defs.variables.length} real IDs.`);
            }

          } catch (firstErr) {
            // Strategy 2: Registry Query
            try {
              if (!hasMissingIds) { // Only log if we were truly empty
                this.warn(`NATS Direct failed (${firstErr.message}), trying Registry Discovery...`);
              }
              const regMsg = await nc.request(subjects.registryProviderQuery(this.providerId), payloads.buildReadProviderDefinitionQuery(), { timeout: 2000 });
              const defs = payloads.decodeProviderDefinition(regMsg.data);
              if (defs && defs.variables.length > 0) {
                this.warn(`NATS Registry Discovery: Loaded ${defs.variables.length} variables.`);
                // Same merge logic
                const realMap = new Map();
                defs.variables.forEach(d => realMap.set(d.key, d));
                defs.variables.forEach(d => defMap.set(d.id, d));
                for (const [id, def] of defMap.entries()) {
                  if (def.missingId) {
                    const real = realMap.get(def.key);
                    if (real && real.id !== id) {
                      defMap.delete(id);
                    }
                  }
                }
              }
            } catch (secondErr) {
              if (!hasMissingIds) {
                this.warn(`All Discovery methods failed (REST, NATS Direct, NATS Registry). Please use Manual Definitions (Name:ID). Error: ${secondErr.message}`);
              } else {
                this.warn(`NATS ID Resolution failed. Continuing with Heuristic (Index-based) IDs. This generally fails for advanced providers.`);
              }
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
                if (defMap.size > 0) {
                  this.warn(`Snapshot Aborted: None of the ${this.variables.length} requested variables could be resolved to IDs. (Provider has ${defMap.size} vars).`);
                } else {
                  // If defMap is empty (Discovery failed), we might want to try reading ALL to see if we get lucky? 
                  // Or just rely on Manual Defs fallback which would have populated defMap.
                  // Safe default: Abort to avoid flooding if discovery failed.
                  this.warn('Snapshot Aborted: Provider Definition not ready (no IDs resolved).');
                }
                return;
              }
            }

            // If Wildcard (empty targetIds and isWildcard=true) -> Request ALL.
            // If Specific (targetIds has items) -> Request specific.
            // Use serialRequest via Config Node to prevent concurrency issues on the connection
            let snapshotMsg;
            if (typeof connection.serialRequest === 'function') {
              snapshotMsg = await connection.serialRequest(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(targetIds), { timeout: 5000 });
            } else {
              // Fallback for older config nodes (should not happen if package updated correctly)
              snapshotMsg = await nc.request(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery(targetIds), { timeout: 5000 });
            }

            const bb = new flatbuffers.ByteBuffer(snapshotMsg.data);
            const snapshotObj = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(bb);
            const states = payloads.decodeVariableList(snapshotObj.variables());

            // Re-process states (lookup names, formatting)
            const filteredSnapshot = processStates(states);

            if (filteredSnapshot.length > 0) {
              this.send({ payload: { type: 'snapshot', variables: filteredSnapshot } });
            } else {
              if (states.length > 0) {
                this.warn(`Snapshot received data but everything was filtered out. Check Variable selection. Debug: First raw ID: ${states[0].id}, DefMap has it? ${defMap.has(states[0].id)}`);
              } else {
                // EMPTY RESPONSE
                // Check if we requested multiple IDs. Some providers fail on bulk read.
                if (targetIds.length > 1) {
                  this.warn(`Snapshot Bulk Read failed (Empty List). Retrying ${targetIds.length} variables individually...`);
                  const accumulatedStates = [];

                  for (const id of targetIds) {
                    try {
                      let msg;
                      if (typeof connection.serialRequest === 'function') {
                        msg = await connection.serialRequest(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery([id]), { timeout: 2000 });
                      } else {
                        msg = await nc.request(subjects.readVariablesQuery(this.providerId), payloads.buildReadVariablesQuery([id]), { timeout: 2000 });
                      }
                      const singleResponse = payloads.decodeVariableList(ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(new flatbuffers.ByteBuffer(msg.data)).variables());
                      if (singleResponse.length > 0) {
                        accumulatedStates.push(...singleResponse);
                      }
                    } catch (e) { /* ignore single failures */ }
                  }

                  const accumulatedFiltered = processStates(accumulatedStates);
                  if (accumulatedFiltered.length > 0) {
                    this.send({ payload: { type: 'snapshot', variables: accumulatedFiltered } });
                    this.warn(`Snapshot Recovery successful! Retrieved ${accumulatedFiltered.length} items via single requests.`);
                    return; // Success
                  }
                }

                this.warn(`Snapshot received empty list from Data Hub. (Requested ${targetIds.length > 0 ? targetIds.length + ' specific IDs' : 'ALL variables'}).`);
              }
            }
          } catch (requestErr) {
            this.warn(`Snapshot failed: ${requestErr.message}`);
          }
        };



        // Initial snapshot with random jitter into prevent concurrency overload
        // (If multiple nodes start simultaneously)
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 500) + 100));
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
