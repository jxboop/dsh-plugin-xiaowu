//#region lib/index.js
/**
 * Xiao Wu desktop pet, node half. Pure UI plugin: the empty apply exists so the
 * package appears in the host Cordis tree, which is what puts it on the
 * client-modules scan list. The pet itself ships through exports["./client"].
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
//#endregion
