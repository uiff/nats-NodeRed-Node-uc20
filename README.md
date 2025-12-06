# node-red-contrib-uos-nats

**Note:** This custom Node-RED package is built and maintained by [IoTUeli](https://www.linkedin.com/in/iotueli/) and is **not** an official Weidmüller product. For questions, feature requests, or support please contact IoTUeli directly. Repository: <https://github.com/uiff/nats-NodeRed-Node-uc20>

Node-RED nodes to read and write u-OS Data Hub variables via NATS. This package exposes three building blocks:

1. **u-OS Config** – stores host, OAuth client credentials and manages the shared NATS connection.
2. **DataHub Input** – subscribes to an existing provider and emits JSON messages. Enter the provider ID and optional comma-separated variable names.
3. **DataHub Output** – automatically registers a provider (default `nodered`), flattens incoming JSON structures and publishes them to the Data Hub.

The nodes reuse the FlatBuffer helpers from the standalone Node sample, so they speak the native NATS API.

## Installation

### From npm (recommended)
```bash
cd ~/.node-red
npm install node-red-contrib-uos-nats
```
### From local folder (if you want to test before publishing)
```bash
npm install /path/to/local/NATS-NodeRED
```

Restart Node-RED. You will find the nodes under the *DataHub-NATS* category.

## u-OS Config Node

Fields:

- **Host / Port** – IP address of your controller (e.g. `192.168.10.100`) and the NATS port `49360`.
- **Client Name** – used for the NATS inbox prefix (`_INBOX.<name>`).
- **Client ID / Secret** – OAuth2 client credentials created in the Control Center.
- **Scope** – defaults to `hub.variables.provide hub.variables.readwrite hub.variables.readonly`. Note: The API does not require a specific "read providers" scope; listing providers is covered by the standard variable scopes.
- **Granted scopes** – click *Refresh* to query the token endpoint and show the scopes currently granted to that client.

The config node automatically fetches tokens via Client Credentials flow.

## DataHub Input Node

- Select the u-OS config node, then choose one of the discovered providers from the dropdown. 
- **Troubleshooting**: If the dropdown remains empty, check the Node-RED debug tab. The node logs the API response count. Ensure your OAuth client has `hub.variables.readonly` permission.
- Pick the variables you need from the multi-select list. Leave it empty to receive all variables.

## DataHub Output Node

- Reuses the u-OS config node. The provider ID defaults to `nodered` and is created automatically upon the first message.
- Send a JSON object to the input pin. **Nested objects are supported** and create subcategories automatically:
  ```json
  {
    "machine": {
      "temperature": 45.2,
      "status": {
        "active": true,
        "mode": "remote"
      }
    }
  }
  ```
  This creates/updates the following variables:
  - `machine.temperature` (FLOAT64)
  - `machine.status.active` (BOOLEAN)
  - `machine.status.mode` (STRING)

- The node infers data types (INT64/FLOAT64/BOOLEAN/STRING) and automatically publishes definition updates when new keys are seen.
- Read requests (`v1.loc.<provider>.vars.qry.read`) are answered using the most recent values, so other consumers can subscribe to your Node-RED provider.

## Example Flow

1. Drop a **u-OS Config** node, fill in host/port and OAuth credentials from the Control Center.
2. Add a **DataHub Input** node, select the config, choose the provider from the dropdown (or type the provider ID if the API access is restricted) and pick the variables you care about. Connect the output to a Debug node.
3. Add a **DataHub Output** node, leave provider ID = `nodered` and send structured JSON (e.g. from a Function node). The values instantly appear in the Data Hub under the provider `nodered`.

> Tip: Because both nodes rely on the Control Center HTTP API for metadata they inherit the same permissions as your OAuth client. Make sure the client has at least `hub.variables.readonly` for the input node and `hub.variables.provide hub.variables.readwrite` for the output node.

## TODO

- Export a sample Node-RED flow (`flows.json`).
- Optional helper node for write commands targeting existing providers.
- Automated tests.
