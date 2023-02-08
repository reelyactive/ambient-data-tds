/*
 * Copyright reelyActive 2022-2023
 * We believe in an open Internet of Things
 */


// Begin configurable parameters
// -----------------------------

const ENABLE_MIXING = true;
const PACKET_MIXING_DELAY_MILLISECONDS = 10000;
const ENABLE_UDP_LISTENER = true;

// ---------------------------
// End configurable parameters


module.exports.enableMixing = ENABLE_MIXING;
module.exports.mixingDelayMilliseconds = PACKET_MIXING_DELAY_MILLISECONDS;
module.exports.enableUDPListener = ENABLE_UDP_LISTENER;
