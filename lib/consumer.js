import { connect } from 'nats';
import * as flatbuffers from 'flatbuffers';
import { requestToken } from './auth.js';
import { CLIENT_NAME, NATS_SERVER, PROVIDER_ID } from './config.js';
import { buildReadVariablesQuery, decodeVariableList } from './payloads.js';
import { readVariablesQuery, varsChangedEvent } from './subjects.js';
import { ReadVariablesQueryResponse } from './fbs/weidmueller/ucontrol/hub/read-variables-query-response.js';
import { VariablesChangedEvent } from './fbs/weidmueller/ucontrol/hub/variables-changed-event.js';
async function main() {
    console.log(`[consumer] Lausche auf Provider ${PROVIDER_ID}`);
    const token = await requestToken();
    const nc = await connect({
        servers: NATS_SERVER.split(','),
        token,
        name: `${CLIENT_NAME}-node-consumer`,
        inboxPrefix: `_INBOX.${CLIENT_NAME}`,
    });
    console.log('[consumer] NATS verbunden:', nc.getServer());
    const snapshotMsg = await nc.request(readVariablesQuery(PROVIDER_ID), buildReadVariablesQuery(), {
        timeout: 2000,
    });
    const snapshotBuffer = new flatbuffers.ByteBuffer(snapshotMsg.data);
    const snapshotResponse = ReadVariablesQueryResponse.getRootAsReadVariablesQueryResponse(snapshotBuffer);
    const initialStates = decodeVariableList(snapshotResponse.variables());
    console.log('[consumer] Snapshot:', initialStates);
    const sub = nc.subscribe(varsChangedEvent(PROVIDER_ID));
    (async () => {
        for await (const msg of sub) {
            const buffer = new flatbuffers.ByteBuffer(msg.data);
            const event = VariablesChangedEvent.getRootAsVariablesChangedEvent(buffer);
            const states = decodeVariableList(event.changedVariables());
            if (states.length === 0)
                continue;
            console.log('[consumer] Änderung erhalten:', states);
        }
    })().catch((err) => console.error('[consumer] Subscription error', err));
}
main().catch((err) => {
    console.error('[consumer] Fehler:', err);
    process.exit(1);
});
