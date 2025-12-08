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
          // Retry soon? Let's verify logic. 
          // If fail, we try again in 1 minute.
          this.startTokenRefresh(60 + 60);
        }
      }, delay);
    };

    this.getToken = async (force = false) => {
      const now = Date.now();
      if (!force && this.tokenInfo && now < this.tokenInfo.expiresAt - tokenMarginMs) {
        return this.tokenInfo.token;
      }
      this.log(`Retrieving new access token for ${this.clientId}`);
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.scope,
      });
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const tokenEndpoint = `https://${this.host}/oauth2/token`;
      const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params,
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
        expiresAt: now + ((json.expires_in || 3600) * 1000),
        grantedScope: json.scope || this.scope,
      };

      // Schedule next refresh
      this.startTokenRefresh(json.expires_in || 3600);

      return this.tokenInfo.token;
    };

    this.ensureConnection = async () => {
      if (this.nc) {
        return this.nc;
      }
      // Ensure we have a valid token initially
      await this.getToken();

      // Use jwtAuthenticator to allow dynamic token refresh on reconnect
      try {
        this.nc = await connect({
          servers: `nats://${this.host}:${this.port}`,
          // Authenticator must be SYNCHRONOUS. We rely on background refresh to keep this.tokenInfo current.
          // Token function must be SYNCHRONOUS if we rely on background refresh.
          token: () => {
            return this.tokenInfo ? this.tokenInfo.token : '';
          },
          name: this.clientName,
          inboxPrefix: `_INBOX.${this.clientName}`,
          maxReconnectAttempts: -1, // Infinite reconnects
          reconnectTimeWait: 2000,
        });
        this.log(`NATS connecting with Name: '${this.clientName}'`);
      } catch (e) {
        this.error(`NATS connect failed: ${e.message}`);
        throw e;
      }
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

    this.fetchProviderVariables = async (providerId) => {
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

    this.on('close', (done) => {
      this.release().finally(done);
    });
  }

  if (!adminRoutesRegistered) {
    adminRoutesRegistered = true;
    RED.httpAdmin.get('/uos/providers/:id', async (req, res) => {
      const node = RED.nodes.getNode(req.params.id);
      if (!node) {
        res.status(404).json({ error: 'config not found' });
        return;
      }
      try {
        const providers = await node.fetchProviders();
        res.json(providers);
      }
      catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    RED.httpAdmin.get('/uos/providers/:id/:providerId/variables', async (req, res) => {
      const node = RED.nodes.getNode(req.params.id);
      if (!node) {
        res.status(404).json({ error: 'config not found' });
        return;
      }
      try {
        const vars = await node.fetchProviderVariables(req.params.providerId);
        res.json(vars);
      }
      catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    RED.httpAdmin.get('/uos/oauth-scopes/:id', async (req, res) => {
      const node = RED.nodes.getNode(req.params.id);
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
  }

  RED.nodes.registerType('uos-config', UosConfigNode, {
    credentials: {
      clientId: { type: 'text' },
      clientSecret: { type: 'password' },
    },
  });
};
