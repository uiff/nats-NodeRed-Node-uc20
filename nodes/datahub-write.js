import { encodeWriteVariablesCommand } from '../lib/payloads.js';

export default function (RED) {
    function DataHubWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Get config node
        const configNode = RED.nodes.getNode(config.connection);
        if (!configNode) {
            node.error('Missing u-OS config');
            node.status({ fill: 'red', shape: 'dot', text: 'no config' });
            return;
        }

        // Store configuration
        this.providerId = config.providerId?.trim();
        this.variableId = config.variableId ? parseInt(config.variableId, 10) : null;

        if (!this.providerId) {
            node.error('Provider ID is required');
            node.status({ fill: 'red', shape: 'dot', text: 'no provider ID' });
            return;
        }

        if (this.variableId === null || isNaN(this.variableId)) {
            node.error('Variable ID is required and must be a number');
            node.status({ fill: 'red', shape: 'dot', text: 'invalid variable ID' });
            return;
        }

        node.status({ fill: 'green', shape: 'ring', text: 'ready' });

        // Handle incoming messages
        node.on('input', async function (msg) {
            const value = msg.payload;

            if (value === undefined || value === null) {
                node.warn('msg.payload is empty, nothing to write');
                return;
            }

            try {
                // Get NATS connection from config node
                const nc = await configNode.getNatsConnection();
                if (!nc) {
                    node.error('NATS connection not available');
                    node.status({ fill: 'red', shape: 'dot', text: 'no connection' });
                    return;
                }

                // Build write command
                const writeCommand = encodeWriteVariablesCommand([
                    {
                        id: node.variableId,
                        value: value
                    }
                ]);

                // Publish write command
                const subject = `v1.loc.${node.providerId}.vars.cmd.write`;
                nc.publish(subject, writeCommand);

                node.status({ fill: 'green', shape: 'dot', text: `wrote: ${value}` });

                // Output confirmation
                msg.payload = {
                    success: true,
                    providerId: node.providerId,
                    variableId: node.variableId,
                    value: value
                };
                node.send(msg);

            } catch (err) {
                node.error(`Write failed: ${err.message}`, msg);
                node.status({ fill: 'red', shape: 'dot', text: 'write error' });
            }
        });

        node.on('close', function () {
            node.status({});
        });
    }

    RED.nodes.registerType('datahub-write', DataHubWriteNode);
}
