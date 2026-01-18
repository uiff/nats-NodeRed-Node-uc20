const fetch = require('node-fetch');
const { connect, jwtAuthenticator } = require('nats');
const https = require('https');
const DEFAULT_SCOPE = 'hub.variables.provide hub.variables.readwrite hub.variables.readonly'; // hub.providers.read removed as it does not exist

if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

let adminRoutesRegistered = false;

const path = require('path');
const { pathToFileURL } = require('url');

// Dynamic Import Helper (copied from datahub-input.js)
const payloadModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'payloads.js')).href;
const subjectsModuleUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'subjects.js')).href;
const definitionResponseUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'fbs', 'weidmueller', 'ucontrol', 'hub', 'read-provider-definition-query-response.js')).href;

const loadModules = async (nodeInstance) => {
  try {
    nodeInstance.log(`Loading ESM modules from: ${payloadModuleUrl}, ${subjectsModuleUrl}`);
    const [payloads, subjects, fbsDesc] = await Promise.all([
      import(payloadModuleUrl),
      import(subjectsModuleUrl),
      import(definitionResponseUrl),
    ]);
    nodeInstance.payloads = payloads;
    nodeInstance.subjects = subjects;
    nodeInstance.fbsDesc = fbsDesc;
    nodeInstance.log('ESM Modules loaded successfully.');
  } catch (err) {
    nodeInstance.error(`CRITICAL: Failed to load ESM modules: ${err.message}`);
    nodeInstance.error(err.stack);
  }
};

module.exports = function (RED) {
  function UosConfigNode(config) {
    try {
      RED.nodes.createNode(this, config);
      this.log('Initializing UosConfigNode...');
      this.host = config.host || '127.0.0.1';
      this.port = Number(config.port) || 49360;
      this.clientName = config.clientName || 'nodered';

      // SAFETY: Prevent impersonating the system provider
      if (typeof this.clientName === 'string' && this.clientName.toLowerCase() === 'u_os_sbm') {
        this.warn("Illegal Client Name 'u_os_sbm' detected! It conflicts with the system provider. Forcing rename to 'nodered'.");
        this.clientName = 'nodered';
      }
      this.scope = DEFAULT_SCOPE;
      this.clientId = this.credentials ? this.credentials.clientId : null;
      this.clientSecret = this.credentials ? this.credentials.clientSecret : null;
      this.tokenInfo = null;
      this.nc = null;
      this.users = 0;
      this.nodeId = this.id; // Store ID for logging

      this.payloads = null;
      this.subjects = null;
      this.fbsDesc = null;

      // Load modules
      loadModules(this);

    } catch (e) {
      console.error("UosConfigNode Constructor Error:", e);
    }

    if (!this.clientId || !this.clientSecret) {
      this.warn('CLIENT_ID oder CLIENT_SECRET fehlen. Bitte in den Node-RED Einstellungen setzen.');
    }

    const tokenMarginMs = 60 * 1000;

    // Timer for background refresh
    this.refreshTimer = null;

    this.startTokenRefresh = (expiresInSeconds) => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      // Refresh 60 seconds before expiration
      const delay = Math.max(1000, (expiresInSeconds - 60) * 1000);
      this.refreshTimer = setTimeout(async () => {
        try {
          await this.getToken(true); // Force refresh
        } catch (e) {
          this.warn(`Token refresh failed: ${e.message}`);
          // Retry in 60 seconds
          this.startTokenRefresh(120); // Treat as if we have 120s left (so we retry in 60s)
        }
      }, delay);
    };

    this.getToken = async (force = false) => {
      const now = Date.now();
      if (!force && this.tokenInfo && now < this.tokenInfo.expiresAt - tokenMarginMs) {
        return this.tokenInfo.token;
      }

      // Deduplication: Return existing promise if we are already fetching
      if (this.pendingTokenRequest) {
        this.log(`Joining pending token request...`);
        return this.pendingTokenRequest;
      }

      this.log(`Retrieving new access token for ${this.clientId}`);

      this.pendingTokenRequest = (async () => {
        try {
          const params = new URLSearchParams({
            grant_type: 'client_credentials',
            scope: this.scope,
          });
          const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
          const tokenEndpoint = `https://${this.host}/oauth2/token`;

          let lastError;
          // Retry logic inside the singleton request
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: {
                  Authorization: `Basic ${basic}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Accept: 'application/json',
                },
                body: params,
                timeout: 30000
              });

              if (!res.ok) {
                const text = await res.text();
                throw new Error(`Token request failed: ${res.status} ${text}`);
              }
              const json = await res.json();
              if (!json.access_token) {
                throw new Error('Token response missing access_token');
              }
              this.tokenInfo = {
                token: json.access_token,
                expiresAt: Date.now() + ((json.expires_in || 3600) * 1000),
                grantedScope: json.scope || this.scope,
              };

              // Schedule next refresh
              this.startTokenRefresh(json.expires_in || 3600);

              return this.tokenInfo.token;

            } catch (e) {
              lastError = e;
              this.warn(`Token fetch attempt ${attempt}/3 failed: ${e.message}`);
              if (attempt < 3) {
                await new Promise(resolve => setTimeout(resolve, 3000));
              }
            }
          }
          throw lastError || new Error("Token fetch failed after 3 attempts");

        } finally {
          this.pendingTokenRequest = null; // Clear flag
        }
      })();

      return this.pendingTokenRequest;
    };

    this.ensureConnection = async () => {
      // Circuit Breaker: If we recently failed auth, do not try again for 10 seconds.
      if (this.authFailureTimestamp && (Date.now() - this.authFailureTimestamp < 10000)) {
        throw new Error(`Authentication Cooldown Active. Retrying later.`);
      }

      if (this.nc) {
        return this.nc;
      }
      // Deduplication: Return existing promise if we are already connecting
      if (this.connectionPromise) {
        // this.log('Joining pending connection request...');
        return this.connectionPromise;
      }

      this.connectionPromise = (async () => {
        try {
          // Ensure we have a valid token initially
          await this.getToken();

          this.nc = await connect({
            servers: `nats://${this.host}:${this.port}`,
            // Authenticator must be SYNCHRONOUS. We rely on background refresh to keep this.tokenInfo current.
            // Token function must be SYNCHRONOUS if we rely on background refresh.
            token: () => {
              return this.tokenInfo ? this.tokenInfo.token : '';
            },
            // REVERT: Use Configured Client Name for Connection.
            // Using UUID caused "Authorization Violation" for some users.
            // Sanitize clientName for Inbox usage (Strict NATS subjects)
            const safeClientName = this.clientName.replace(/[^a-zA-Z0-9_-]/g, '_');

            // inboxPrefix: `_INBOX.${safeClientName}`, // RESTORED: Spec requires strictly this format (ACLs enforce it). 
            // Using safeClientName avoids invalid subject errors.
            inboxPrefix: `_INBOX.${safeClientName}`,
            maxReconnectAttempts: -1, // Infinite reconnects
            reconnectTimeWait: 2000,
          });

          this.log(`NATS connecting as Name: '${this.clientName}' (Dedup Active)`);

          // Reset Failure timestamp on success
          this.authFailureTimestamp = 0;
          return this.nc;

        } catch (e) {
          if (e.message && (e.message.includes('Authorization') || e.message.includes('Permissions') || e.message.includes('Authentication'))) {
            this.warn(`NATS Authorization failed. Invalidating token cache. Circuit Breaker active for 10s.`);
            this.tokenInfo = null; // Force fresh token next time
            this.authFailureTimestamp = Date.now(); // Start Cooldown
          }
          this.error(`NATS connect failed: ${e.message}`);
          throw e;
        } finally {
          this.connectionPromise = null;
        }
      })();
      return this.connectionPromise;
      this.nc.closed().then(() => {
        this.nc = null;
        this.emit('disconnected');
      }).catch((err) => {
        this.nc = null;
        this.emit('disconnected', err);
      });

      // Monitor for reconnects to emit 'reconnected' event
      (async () => {
        if (!this.nc) return;
        for await (const s of this.nc.status()) {
          if (s.type === 'reconnect') {
            this.emit('reconnected');
          }
        }
      })();

      return this.nc;
    };

    // Parallel Request Queue (Semaphore)
    // Limits concurrency to avoid 503 errors while allowing reasonable speed.
    this.activeRequests = 0;
    this.maxConcurrent = 5; // Allow 5 parallel snapshot requests
    this.requestQueue = [];

    this.processQueue = async () => {
      // While we have capacity and pending items
      while (this.activeRequests < this.maxConcurrent && this.requestQueue.length > 0) {
        const { task, resolve, reject } = this.requestQueue.shift();
        this.activeRequests++;

        // Execute task (non-blocking for the loop)
        (async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (err) {
            reject(err);
          } finally {
            this.activeRequests--;
            this.processQueue(); // Trigger next task
          }
        })();
      }
    };

    /**
     * Queues a NATS request to respect concurrency limits.
     * Replaces the old strict serial queue which was too slow.
     */
    this.serialRequest = (subject, payload, options = {}) => {
      return new Promise((resolve, reject) => {
        const task = async () => {
          const nc = await this.ensureConnection();
          return nc.request(subject, payload, options);
        };
        this.requestQueue.push({ task, resolve, reject });
        this.processQueue();
      });
    };

    /**
     * @deprecated Use serialRequest for concurrency safety
     */
    this.acquire = async () => {
      this.users += 1;
      return this.ensureConnection();
    };

    this.getGrantedScopes = async () => {
      await this.getToken();
      return this.tokenInfo?.grantedScope || '';
    };

    this.fetchProviders = async () => {
      const token = await this.getToken();
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };

      // Helper to try fetch
      const tryFetch = async (url) => {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          if (res.status === 404) return null; // Not found, indicate to try next
          throw new Error(`API error ${res.status} from ${url}`);
        }
        return res;
      };

      // 1. Try standard u-OS API
      let res = await tryFetch(`https://${this.host}/u-os-hub/api/v1/providers`);

      // 2. Fallback to older datahub API if 404
      if (!res) {
        this.log('Falling back to /datahub/v1/providers endpoint');
        res = await tryFetch(`https://${this.host}/datahub/v1/providers`);
      }

      if (!res) {
        throw new Error('Provider list failed: Path not found (tried both /u-os-hub/... and /datahub/...)');
      }

      const json = await res.json();
      this.log(`Fetched ${Array.isArray(json) ? json.length : 'unknown'} providers from API`);
      return json;
    };

    // --- PROVIDER DEFINITION CACHE & LOOKUP ---
    this.providerCache = new Map(); // Cache results: { timestamp, data }
    this.pendingLookups = new Map(); // Deduplication: ProviderId -> Promise

    /**
     * Retrieves the provider definition (Variables List), utilizing Cache and Request Deduplication.
     * Guaranteed to return a Promise that resolves to the definition object.
     */
    this.getProviderDefinition = async (inputProviderId) => {
      const providerId = (inputProviderId || '').trim();
      if (!providerId) return null;

      // Check Cache First (Dedup)TTL 5 minutes)
      const cached = this.providerCache.get(providerId);
      if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
        return cached.data;
      }

      // 2. Check for In-Flight Request (Deduplication)
      if (this.pendingLookups.has(providerId)) {
        this.log(`Joining pending lookup for provider '${providerId}'`);
        return this.pendingLookups.get(providerId);
      }

      // 3. Start New Lookup
      const lookupPromise = (async () => {
        try {
          // ENSURE MODULES LOADED
          if (!this.payloads || !this.subjects) {
            // Simple poll wait if modules aren't ready (should be fast)
            let attempts = 0;
            while ((!this.payloads || !this.subjects) && attempts < 20) {
              await new Promise(r => setTimeout(r, 200));
              attempts++;
            }
            if (!this.payloads) throw new Error("Modules failed to load.");
          }

          // 1. Attempt NATS Direct Query (v1.loc.{id}.def.qry.read)
          // Some providers (like older u-OS services) only respond to this, not Registry.
          try {
            if (this.subjects && this.payloads && this.payloads.buildReadProviderDefinitionQuery) {
              const directSubject = this.subjects.readProviderDefinitionQuery(providerId);
              const reqPayload = this.payloads.buildReadProviderDefinitionQuery();

              // Short timeout (1s) to be snappy
              const responseMsg = await this.serialRequest(directSubject, reqPayload, { timeout: 1000 });

              if (responseMsg && responseMsg.data) {
                const decoded = this.payloads.decodeProviderDefinition(responseMsg.data);
                if (decoded) {
                  this.log(`Fetched definition via NATS Direct Query for '${providerId}' (Fingerprint: ${decoded.fingerprint})`);
                  this.providerCache.set(providerId, { timestamp: Date.now(), data: decoded });
                  return decoded;
                }
              }
            }
          } catch (directErr) {
            this.debug(`NATS Direct Query failed for '${providerId}' (${directErr.message}). Trying Registry...`);
          }

          // 2. Attempt NATS Registry Lookup (Preferred: Provides Fingerprint)
          // Uses v1.loc.registry.providers.{providerId}.def.qry.read
          try {
            if (this.subjects && this.payloads && this.payloads.buildReadProviderDefinitionQuery) {
              const subject = this.subjects.registryProviderQuery(providerId);
              const reqPayload = this.payloads.buildReadProviderDefinitionQuery();

              // Use serialRequest to respect Semaphore 
              // (Short timeout for Registry, faster failover to REST)
              const responseMsg = await this.serialRequest(subject, reqPayload, { timeout: 2000 });

              if (responseMsg && responseMsg.data) {
                const decoded = this.payloads.decodeProviderDefinition(responseMsg.data);
                if (decoded) {
                  this.log(`Fetched definition via NATS Registry for '${providerId}' (Fingerprint: ${decoded.fingerprint})`);
                  this.providerCache.set(providerId, { timestamp: Date.now(), data: decoded });
                  return decoded;
                }
              }
            }
          } catch (natsErr) {
            this.debug(`NATS Registry lookup failed for '${providerId}' (${natsErr.message}). Falling back to REST.`);
          }

          // 3. Fallback to REST API (Legacy/No Fingerprint)
          const vars = await this.fetchProviderVariables(providerId);
          if (!vars) {
            // If both failed, we throw
            throw new Error(`Definition lookup failed for '${providerId}' via both NATS and REST.`);
          }

          this.warn(`Using REST definition for '${providerId}'. Fingerprint missing (Write operations on strict providers may fail).`);

          // Structure for consistency
          const def = {
            fingerprint: BigInt(0),
            variables: vars
          };

          this.providerCache.set(providerId, { timestamp: Date.now(), data: def });
          return def;

        } catch (err) {
          this.warn(`Definition lookup failed for '${providerId}': ${err.message}`);
          throw err;
        } finally {
          this.pendingLookups.delete(providerId);
        }
      })();

      this.pendingLookups.set(providerId, lookupPromise);
      return lookupPromise;
    };


    /**
     * Resolves a Variable Key to an ID using the cached definition.
     */
    this.resolveVariableId = async (providerId, variableKey) => {
      try {
        const def = await this.getProviderDefinition(providerId);
        if (!def || !def.variables) return null;

        const v = def.variables.find(v => v.key === variableKey);
        if (v) {
          return {
            id: v.id,
            fingerprint: def.fingerprint || BigInt(0),
            dataType: v.dataType
          };
        }

        // Try explicit numeric string fallback
        if (!isNaN(variableKey)) {
          return { id: parseInt(variableKey), fingerprint: BigInt(0) }; // Fallback, no fingerprint known
        }

        return null;
      } catch (e) {
        return null; // Resolve failed
      }
    };

    this.fetchProviderVariables = async (inputProviderId) => {
      const providerId = (inputProviderId || '').trim();
      const token = await this.getToken();
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };

      const tryFetch = async (url) => {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          if (res.status === 404) return null;
          // Don't throw yet, legitimate for fallback logic
          return null;
        }
        return res;
      };

      // 0. Try getting Provider Metadata (likely contains Definitions with IDs)
      let res = await tryFetch(`https://${this.host}/u-os-hub/api/v1/providers/${providerId}`);
      if (res) {
        const meta = await res.json();
        // Check if metadata contains variables definition
        if (meta && Array.isArray(meta.variables) && meta.variables.length > 0) {
          this.log(`Fetched ${meta.variables.length} vars via Provider Metadata.`);

          // Apply Heuristic: ID = Index if missing
          meta.variables.forEach((v, i) => {
            if (v.id === undefined && v.Id === undefined) {
              v.id = i;
              v.missingId = true;
            }
          });

          return meta.variables;
        }
      }

      // 1. Try standard u-OS API (Variables List - often only values)
      res = await tryFetch(`https://${this.host}/u-os-hub/api/v1/providers/${providerId}/variables`);

      // 2. Fallback to older datahub API
      if (!res) {
        this.log(`Falling back to /datahub/v1/providers/${providerId}/variables endpoint`);
        res = await tryFetch(`https://${this.host}/datahub/v1/providers/${providerId}/variables`);
      }

      if (!res) {
        throw new Error(`Variable list failed: Path not found (404) for provider ${providerId}`);
      }

      const json = await res.json();
      if (Array.isArray(json) && json.length > 0) {
        this.log(`Fetched ${json.length} vars via variables list. Using Heuristic: ID = Index if missing.`);

        json.forEach((v, i) => {
          // If ID is missing, assign the index as ID (matches u_os_adm behavior)
          if (v.id === undefined && v.Id === undefined) {
            v.id = i;
            v.missingId = true; // Flag for debug
          }
        });
      }
      return json;
    };

    this.acquire = async () => {
      this.users += 1;
      return this.ensureConnection();
    };

    this.release = async () => {
      this.users = Math.max(0, this.users - 1);
      if (this.users === 0) {
        if (this.refreshTimer) {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = null;
        }
        if (this.nc) {
          const nc = this.nc;
          this.nc = null;
          try {
            await nc.drain();
          }
          catch (err) {
            this.warn(`Fehler beim Schließen der NATS-Verbindung: ${err.message}`);
          }
        }
      }
    };

    this.on('close', async (done) => {
      // Force Close Connection on Full Deploy (ignore reference count)
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }

      if (this.nc) {
        const nc = this.nc;
        this.nc = null;
        this.users = 0;
        try {
          // Drain ensures all pending messages are sent before closing
          await nc.drain();
          // this.log('NATS Connection flushed and closed.');
        } catch (err) {
          this.warn(`Error closing NATS connection: ${err.message}`);
        }
      }
      done();
    });
  }

  // Helper for stateless or stateful token acquisition
  const getStatelessToken = async (host, clientId, clientSecret) => {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams({ grant_type: 'client_credentials', scope: DEFAULT_SCOPE });
    const res = await fetch(`https://${host}/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params,
      timeout: 5000
    });
    if (!res.ok) throw new Error(`Token Auth failed: ${res.status}`);
    const json = await res.json();
    return json.access_token;
  };

  RED.httpAdmin.get('/uos/providers/:id', async (req, res) => {
    const nodeId = req.params.id;
    const node = RED.nodes.getNode(nodeId);

    try {
      if (node) {
        const providers = await node.fetchProviders();
        res.json(providers);
      } else {
        // Stateless Mode: Check headers/query for manual config
        const host = req.query.host || req.headers['x-uos-host'];
        const startClientId = req.query.clientId || req.headers['x-uos-clientid'];
        const startClientSecret = req.query.clientSecret || req.headers['x-uos-clientsecret'];

        if (!host || !startClientId || !startClientSecret) {
          res.status(404).json({ error: 'config not found and no manual credentials provided' });
          return;
        }

        // Perform manual fetch
        const token = await getStatelessToken(host, startClientId, startClientSecret);
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

        // Try fetch logic (simplified copy of fetchProviders)
        const fetchFn = async (url) => {
          const r = await fetch(url, { headers, timeout: 5000 });
          if (!r.ok && r.status !== 404) throw new Error(`API error ${r.status}`);
          return r.ok ? r : null;
        };

        let pRes = await fetchFn(`https://${host}/u-os-hub/api/v1/providers`);
        if (!pRes) pRes = await fetchFn(`https://${host}/datahub/v1/providers`);

        if (!pRes) throw new Error('Providers endpoint not found');
        const data = await pRes.json();
        res.json(data);
      }
    }
    catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  RED.httpAdmin.get('/uos/providers/:id/:providerId/variables', async (req, res) => {
    const nodeId = req.params.id;
    const node = RED.nodes.getNode(nodeId);
    const providerId = req.params.providerId;

    try {
      if (node) {
        const vars = await node.fetchProviderVariables(providerId);
        res.json(vars);
      } else {
        // Stateless Mode
        const host = req.query.host || req.headers['x-uos-host'];
        const startClientId = req.query.clientId || req.headers['x-uos-clientid'];
        const startClientSecret = req.query.clientSecret || req.headers['x-uos-clientsecret'];

        if (!host || !startClientId || !startClientSecret) {
          res.status(404).json({ error: 'config not found and no manual credentials provided' });
          return;
        }

        const token = await getStatelessToken(host, startClientId, startClientSecret);
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        const fetchFn = async (url) => {
          const r = await fetch(url, { headers, timeout: 5000 });
          if (!r.ok && r.status !== 404) return null; // Safe fail
          return r.ok ? r : null;
        };

        let vRes = await fetchFn(`https://${host}/u-os-hub/api/v1/providers/${providerId}`);
        let variables = [];

        // Metadata check
        if (vRes) {
          const meta = await vRes.json();
          if (meta && Array.isArray(meta.variables)) {
            variables = meta.variables;
          }
        }
        if (variables.length === 0) {
          vRes = await fetchFn(`https://${host}/u-os-hub/api/v1/providers/${providerId}/variables`);
          if (!vRes) vRes = await fetchFn(`https://${host}/datahub/v1/providers/${providerId}/variables`);

          if (vRes) variables = await vRes.json();
        }

        // Heuristic
        if (Array.isArray(variables)) {
          variables.forEach((v, i) => {
            if (v.id === undefined && v.Id === undefined) {
              v.id = i;
            }
          });
        }

        res.json(variables);
      }
    }
    catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  RED.httpAdmin.get('/uos/oauth-scopes/:id', async (req, res) => {
    const node = RED.nodes.getNode(req.params.id);
    // Stateless scope check is tricky without full Oauth flow parse. 
    // Skip for now or implement if critical.
    if (!node) {
      res.status(404).json({ error: 'config not found' });
      return;
    }
    try {
      const scope = await node.getGrantedScopes();
      res.json({ scope });
    }
    catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stateless connection check for "Test Connection" button
  RED.httpAdmin.post('/uos/check-connection', async (req, res) => {
    const { host, port, clientId, clientSecret } = req.body;
    if (!host || !clientId || !clientSecret) {
      res.status(400).json({ error: 'Missing host, clientId or clientSecret' });
      return;
    }

    let nc = null;
    try {
      // 1. Get Token
      const tokenEndpoint = `https://${host}/oauth2/token`;
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: DEFAULT_SCOPE,
      });

      // Use custom agent to allow self-signed certs safely if needed (or rely on env var)
      // Note: process.env.NODE_TLS_REJECT_UNAUTHORIZED is already handled globally in this file

      const tokenRes = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params,
      });

      if (!tokenRes.ok) {
        throw new Error(`Token fetch failed: ${tokenRes.status} ${await tokenRes.text()}`);
      }
      const tokenJson = await tokenRes.json();
      const token = tokenJson.access_token;

      // 2. Fetch Providers (API Check)
      // Try fallback logic similar to instance method
      const tryFetch = async (url) => {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        if (!r.ok && r.status !== 404) throw new Error(`API ${r.status}`);
        return r.ok ? r : null;
      };

      let apiRes = await tryFetch(`https://${host}/u-os-hub/api/v1/providers`);
      if (!apiRes) apiRes = await tryFetch(`https://${host}/datahub/v1/providers`);

      if (!apiRes) throw new Error('API endpoint not found');

      const providers = await apiRes.json();
      const count = Array.isArray(providers) ? providers.length : 0;

      // 3. NATS Check (optional but good)
      // We verify NATS connectivity quickly
      nc = await connect({
        servers: `nats://${host}:${port || 49360}`,
        token,
        name: `nodered-check-${Date.now()}`,
        waitOnFirstConnect: true,
        maxReconnectAttempts: 1,
      });

      res.json({ success: true, providers: count, providersList: providers, connected: true });
    }
    catch (err) {
      res.status(500).json({ error: err.message });
    }
    finally {
      if (nc) nc.drain().catch(() => { });
    }
  });


  RED.nodes.registerType('uos-config', UosConfigNode, {
    credentials: {
      clientId: { type: 'text' },
      clientSecret: { type: 'password' },
    },
  });
};
