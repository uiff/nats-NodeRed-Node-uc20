import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import { ProviderDefinitionChangedEventT } from './fbs/weidmueller/ucontrol/hub/provider-definition-changed-event.js';
import { ProviderDefinitionT } from './fbs/weidmueller/ucontrol/hub/provider-definition.js';
import { VariableDefinitionT } from './fbs/weidmueller/ucontrol/hub/variable-definition.js';
import { VariableAccessType } from './fbs/weidmueller/ucontrol/hub/variable-access-type.js';
import { VariableDataType } from './fbs/weidmueller/ucontrol/hub/variable-data-type.js';
import { VariablesChangedEventT } from './fbs/weidmueller/ucontrol/hub/variables-changed-event.js';
import { VariableListT } from './fbs/weidmueller/ucontrol/hub/variable-list.js';
import { VariableT } from './fbs/weidmueller/ucontrol/hub/variable.js';
import { VariableQuality } from './fbs/weidmueller/ucontrol/hub/variable-quality.js';
import { VariableValue } from './fbs/weidmueller/ucontrol/hub/variable-value.js';
import { VariableValueInt64, VariableValueInt64T } from './fbs/weidmueller/ucontrol/hub/variable-value-int64.js';
import { VariableValueFloat64, VariableValueFloat64T } from './fbs/weidmueller/ucontrol/hub/variable-value-float64.js';
import { VariableValueString, VariableValueStringT } from './fbs/weidmueller/ucontrol/hub/variable-value-string.js';
import { VariableValueBoolean, VariableValueBooleanT } from './fbs/weidmueller/ucontrol/hub/variable-value-boolean.js';
import { TimestampT } from './fbs/weidmueller/ucontrol/hub/timestamp.js';
import { ReadVariablesQueryResponseT } from './fbs/weidmueller/ucontrol/hub/read-variables-query-response.js';
import { ReadVariablesQueryRequestT } from './fbs/weidmueller/ucontrol/hub/read-variables-query-request.js';
const DEFAULT_QUALITY = 'GOOD';
export function buildProviderDefinitionEvent(defs) {
    const fingerprint = computeFingerprint(defs);
    const providerDefinition = new ProviderDefinitionT();
    providerDefinition.fingerprint = fingerprint;
    providerDefinition.variableDefinitions = defs.map(toFlatDefinition);
    const event = new ProviderDefinitionChangedEventT(providerDefinition);
    const builder = new flatbuffers.Builder(1024);
    const offset = event.pack(builder);
    builder.finish(offset);
    return { payload: builder.asUint8Array(), fingerprint };
}
export function buildVariablesChangedEvent(defs, states, fingerprint) {
    const varList = buildVariableList(defs, states, fingerprint);
    const event = new VariablesChangedEventT(varList);
    const builder = new flatbuffers.Builder(1024);
    builder.finish(event.pack(builder));
    return builder.asUint8Array();
}
export function buildReadVariablesResponse(defs, states, fingerprint) {
    const varList = buildVariableList(defs, states, fingerprint);
    const response = new ReadVariablesQueryResponseT(varList);
    const builder = new flatbuffers.Builder(1024);
    builder.finish(response.pack(builder));
    return builder.asUint8Array();
}
export function buildReadVariablesQuery(ids) {
    const query = new ReadVariablesQueryRequestT(ids ?? []);
    const builder = new flatbuffers.Builder(128);
    builder.finish(query.pack(builder));
    return builder.asUint8Array();
}
export function decodeVariableList(list) {
    if (!list)
        return [];
    const result = [];
    for (let i = 0; i < list.itemsLength(); i += 1) {
        const item = list.items(i);
        if (!item)
            continue;
        let decoded;
        switch (item.valueType()) {
            case VariableValue.Int64: {
                const holder = new VariableValueInt64();
                item.value(holder);
                decoded = Number(holder.value());
                break;
            }
            case VariableValue.Float64: {
                const holder = new VariableValueFloat64();
                item.value(holder);
                decoded = holder.value();
                break;
            }
            case VariableValue.Boolean: {
                const holder = new VariableValueBoolean();
                item.value(holder);
                decoded = !!holder.value();
                break;
            }
            case VariableValue.String:
            default: {
                const holder = new VariableValueString();
                item.value(holder);
                decoded = holder.value()?.toString() ?? '';
                break;
            }
        }
        const ts = item.timestamp();
        const seconds = ts ? Number(ts.seconds()) : 0;
        const nanos = ts ? ts.nanos() : 0;
        result.push({
            id: item.id(),
            value: decoded,
            timestampNs: seconds * 1000000000 + nanos,
            quality: DEFAULT_QUALITY,
        });
    }
    return result;
}
// Added to support NATS-based definition fetching
import { ReadProviderDefinitionQueryResponse } from './fbs/weidmueller/ucontrol/hub/read-provider-definition-query-response.js';

export function decodeProviderDefinition(buffer) {
    const bb = new flatbuffers.ByteBuffer(buffer);
    const response = ReadProviderDefinitionQueryResponse.getRootAsReadProviderDefinitionQueryResponse(bb);
    const providerDef = response.providerDefinition();

    if (!providerDef) return [];

    const result = [];
    const len = providerDef.variableDefinitionsLength();
    for (let i = 0; i < len; i++) {
        const item = providerDef.variableDefinitions(i);
        if (!item) continue;

        // Inverse mapping of DataType/AccessType needed if we want full fidelity,
        // but for now we mainly need ID and Key.
        result.push({
            id: item.id(),
            key: item.key(),
            dataType: 'UNKNOWN', // Mapping back from Enum to String if strictly needed
            access: item.accessType() === VariableAccessType.READ_WRITE ? 'READ_WRITE' : 'READ_ONLY'
        });
    }
    return result;
}

function toFlatDefinition(def) {
    const result = new VariableDefinitionT();
    result.id = def.id;
    result.key = def.key;
    result.experimental = Boolean(def.experimental);
    result.dataType = mapDataType(def.dataType);
    result.accessType = def.access === 'READ_WRITE' ? VariableAccessType.READ_WRITE : VariableAccessType.READ_ONLY;
    return result;
}
function buildVariableList(defs, states, fingerprint) {
    const statesMap = new Map(states.map((s) => [s.id, s]));
    const items = [];
    for (const def of defs) {
        const state = statesMap.get(def.id);
        if (!state)
            continue;
        const variable = new VariableT();
        variable.id = def.id;
        const [valueType, value] = toValueUnion(def.dataType, state.value);
        variable.valueType = valueType;
        variable.value = value;
        variable.timestamp = toTimestamp(state.timestampNs);
        variable.quality = VariableQuality.GOOD;
        items.push(variable);
    }
    const list = new VariableListT();
    list.providerDefinitionFingerprint = fingerprint;
    list.baseTimestamp = items.length ? (items[0].timestamp ?? toTimestamp(Date.now() * 1000000)) : toTimestamp(Date.now() * 1000000);
    list.items = items;
    return list;
}
function toTimestamp(ns) {
    const ts = new TimestampT();
    ts.seconds = BigInt(Math.floor(ns / 1000000000));
    ts.nanos = ns % 1000000000;
    return ts;
}
function toValueUnion(type, value) {
    switch (type) {
        case 'INT64': {
            const holder = new VariableValueInt64T();
            holder.value = BigInt(Math.trunc(Number(value)));
            return [VariableValue.Int64, holder];
        }
        case 'FLOAT64': {
            const holder = new VariableValueFloat64T();
            holder.value = Number(value);
            return [VariableValue.Float64, holder];
        }
        case 'BOOLEAN': {
            const holder = new VariableValueBooleanT();
            holder.value = Boolean(value);
            return [VariableValue.Boolean, holder];
        }
        case 'STRING':
        default: {
            const holder = new VariableValueStringT();
            holder.value = String(value);
            return [VariableValue.String, holder];
        }
    }
}
function mapDataType(type) {
    switch (type) {
        case 'INT64':
            return VariableDataType.INT64;
        case 'FLOAT64':
            return VariableDataType.FLOAT64;
        case 'BOOLEAN':
            return VariableDataType.BOOLEAN;
        case 'STRING':
        default:
            return VariableDataType.STRING;
    }
}
function computeFingerprint(defs) {
    const hash = createHash('sha256');
    for (const def of [...defs].sort((a, b) => a.id - b.id)) {
        hash.update(`${def.id}:${def.key}:${def.dataType}:${def.access}:${def.experimental ?? false}`);
    }
    const digest = hash.digest();
    return digest.readBigUInt64BE(0);
}
