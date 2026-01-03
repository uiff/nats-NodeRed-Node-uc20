const VERSION_PREFIX = 'v1';
const LOCATION_PREFIX = 'loc';
export function varsChangedEvent(providerId) {
    return `${VERSION_PREFIX}.${LOCATION_PREFIX}.${providerId}.vars.evt.changed`;
}
export function readVariablesQuery(providerId) {
    return `${VERSION_PREFIX}.${LOCATION_PREFIX}.${providerId}.vars.qry.read`;
}
export function providerDefinitionChanged(providerId) {
    return `${VERSION_PREFIX}.${LOCATION_PREFIX}.${providerId}.def.evt.changed`;
}
export function registryProviderQuery(providerId) {
    return `${VERSION_PREFIX}.${LOCATION_PREFIX}.registry.providers.${providerId}.def.qry.read`;
}
export function readProviderDefinitionQuery(providerId) {
    return `${VERSION_PREFIX}.${LOCATION_PREFIX}.${providerId}.def.qry.read`;
}
export function registryStateEvent() {
    return `${VERSION_PREFIX}.${LOCATION_PREFIX}.registry.state.evt.changed`;
}
export function writeVariablesCommand(providerId) {
    return `${VERSION_PREFIX}.${LOCATION_PREFIX}.${providerId}.vars.cmd.write`;
}
