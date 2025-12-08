import { connect } from 'nats';
import { requestToken } from './auth.js';
import { CLIENT_NAME, NATS_SERVER, PROVIDER_ID, PUBLISH_INTERVAL_MS, VARIABLE_DEFINITIONS, } from './config.js';
import { SimulationEngine } from './simulation.js';
import { buildProviderDefinitionEvent, buildReadVariablesResponse, buildVariablesChangedEvent, parseRegistryStateEvent, } from './payloads.js';
import { providerDefinitionChanged, readVariablesQuery, varsChangedEvent, registryStateEvent } from './subjects.js';
async function main() {
    console.log(`[provider] Node Provider für ${PROVIDER_ID} wird gestartet…`);
    const token = await requestToken();
    const nc = await connect({
        servers: NATS_SERVER.split(','),
        token,
        name: `${CLIENT_NAME}-node-provider`,
        inboxPrefix: `_INBOX.${CLIENT_NAME}`,
    });
    console.log('[provider] NATS verbunden:', nc.getServer());
    const simulation = new SimulationEngine(VARIABLE_DEFINITIONS);

    // Initial Publish
    let { payload: definitionPayload, fingerprint } = buildProviderDefinitionEvent(VARIABLE_DEFINITIONS);
    await nc.publish(providerDefinitionChanged(PROVIDER_ID), definitionPayload);

    // Registry State Listener (Keep Alive)
    nc.subscribe(registryStateEvent(), {
        callback: async (err, msg) => {
            if (err) return;
            try {
                const state = parseRegistryStateEvent(msg.data);
                if (state === 1) { // 1 = RUNNING
                    console.log('[provider] Registry restart detected. Re-publishing definition...');
                    const { payload: newPayload } = buildProviderDefinitionEvent(VARIABLE_DEFINITIONS);
                    await nc.publish(providerDefinitionChanged(PROVIDER_ID), newPayload);
                }
            } catch (e) {
                console.error('[provider] Error handling registry state:', e);
            }
        }
    });

    const readSubject = readVariablesQuery(PROVIDER_ID);
    const sub = nc.subscribe(readSubject, {
        callback: async (err, msg) => {
            if (err) {
                console.error('[provider] Fehler beim Read-Subscribe', err);
                return;
            }
            if (!msg.reply)
                return;
            const responsePayload = buildReadVariablesResponse(VARIABLE_DEFINITIONS, simulation.snapshot(), fingerprint);
            await nc.publish(msg.reply, responsePayload);
        },
    });
    const timer = setInterval(async () => {
        const states = simulation.advance();
        const payload = buildVariablesChangedEvent(VARIABLE_DEFINITIONS, states, fingerprint);
        await nc.publish(varsChangedEvent(PROVIDER_ID), payload);
    }, PUBLISH_INTERVAL_MS);
    const shutdown = async () => {
        clearInterval(timer);
        sub.drain();
        await nc.drain();
        console.log('[provider] Verbindung geschlossen');
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((err) => {
    console.error('[provider] Fehler:', err);
    process.exit(1);
});
