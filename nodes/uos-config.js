const fetch = require('node-fetch');
const { connect } = require('nats');

if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

let adminRoutesRegistered = false;

module.exports = function (RED) {
  function UosConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.host = config.host || '127.0.0.1';
    this.port = Number(config.port) || 49360;
    this.clientName = config.clientName || 'nodered';
    this.scope = config.scope || 'hub.variables.provide hub.variables.readwrite';
    this.clientId = this.credentials.clientId;
    this.clientSecret = this.credentials.clientSecret;
    this.tokenInfo = null;
    this.nc = null;
    this.users = 0;

    if (!this.clientId || !this.clientSecret) {
      this.warn('CLIENT_ID oder CLIENT_SECRET fehlen. Bitte in den Node-RED Einstellungen setzen.');
    }

    const tokenMarginMs = 60 * 1000;

    this.getToken = async () => {
      const now = Date.now();
      if (this.tokenInfo && now < this.tokenInfo.expiresAt - tokenMarginMs) {
        return this.tokenInfo.token;
      }
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
      return this.tokenInfo.token;
    };

    this.ensureConnection = async () => {
      if (this.nc) {
        return this.nc;
      }
      const token = await this.getToken();
      this.nc = await connect({
        servers: `nats://${this.host}:${this.port}`,
        token,
        name: `${this.clientName}-nodered`,
        inboxPrefix: `_INBOX.${this.clientName}`,
      });
      this.nc.closed().then(() => {
        this.nc = null;
      }).catch(() => {
        this.nc = null;
      });
      return this.nc;
    };

    this.getGrantedScopes = async () => {
      await this.getToken();
      return this.tokenInfo?.grantedScope || '';
    };

    this.fetchProviders = async () => {
      const token = await this.getToken();
      const res = await fetch(`https://${this.host}/datahub/v1/providers`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        throw new Error(`Provider list failed: ${res.status}`);
      }
      return res.json();
    };

    this.fetchProviderVariables = async (providerId) => {
      const token = await this.getToken();
      const res = await fetch(`https://${this.host}/datahub/v1/providers/${providerId}/variables`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        throw new Error(`Variable list failed: ${res.status}`);
      }
      return res.json();
    };

    this.acquire = async () => {
      this.users += 1;
      return this.ensureConnection();
    };

    this.release = async () => {
      this.users = Math.max(0, this.users - 1);
      if (this.users === 0 && this.nc) {
        const nc = this.nc;
        this.nc = null;
        try {
          await nc.drain();
        }
        catch (err) {
          this.warn(`Fehler beim Schließen der NATS-Verbindung: ${err.message}`);
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
  }

  RED.nodes.registerType('uos-config', UosConfigNode, {
    credentials: {
      clientId: { type: 'text' },
      clientSecret: { type: 'password' },
    },
  });
};
