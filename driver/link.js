// The one seam between this plugin and an AXT600.
//
// adapter.js knows nothing about the wire. It talks to a "link", which is
// anything with these members:
//
//   connect()                  -> { model, firmware, name }
//   configureScan(scan)        scan = { startHz, stepHz, deviceCount }
//                              -> the scan the unit actually settled on, same shape
//   startScan(onTile)          calls onTile({ antenna, startHz, stepHz,
//                              amplitudesDbm }) for every piece of scan data
//   stopScan()
//   close()                    release everything; not a failure
//   onFatal                    assigned by the user; call it when the link dies
//
// Two implementations exist: SimulatedAxt600, which pretends, and
// Axt600NetworkLink below, which will speak the real protocol once it has been
// captured from a unit (docs/protocolo.md). Implementing the real one means
// filling in that class and nothing else: discovery aside, the adapter, the
// sweep assembly and the tests stay as they are.

import { SimulatedAxt600 } from './simulated-axt600.js';

export const SIMULATED_HOST = 'simulated';

/** Is this device the pretend one? */
export const isSimulated = (device) =>
  device?.config?.host === SIMULATED_HOST || /^sim:/.test(device?.id ?? '');

/**
 * The link for a device. `timeScale` speeds up the simulator: 1 is real time,
 * which is what someone looking at the plugin in SoundBase should see.
 */
export function createLink(device, { host, timeScale = 1 } = {}) {
  if (isSimulated(device)) return new SimulatedAxt600({ timeScale });
  return new Axt600NetworkLink({ host });
}

export class ProtocolPendingError extends Error {
  constructor(host) {
    super(
      `This plugin cannot talk to a real AXT600 yet: the unit's network protocol ` +
        `still has to be captured (see docs/protocolo.md). The AXT600 at ${host} ` +
        `was not contacted. Turn on "Simulated AXT600" in the plugin settings ` +
        `to try the plugin without hardware.`
    );
    this.name = 'ProtocolPendingError';
    this.code = 'protocol_pending';
  }
}

/**
 * The real AXT600, over the network.
 *
 * Deliberately empty. Shure does not publish this protocol, and guessing at a
 * device's wire format is how a plugin ends up confusing a unit in the middle
 * of a show. Every method here gets written from packet captures of Wireless
 * Workbench talking to a real AXT600 — docs/protocolo.md says how to make them
 * and what to look for.
 */
export class Axt600NetworkLink {
  constructor({ host }) {
    this.host = host;
    this.onFatal = null;
  }

  async connect() {
    throw new ProtocolPendingError(this.host);
  }

  async configureScan() {
    throw new ProtocolPendingError(this.host);
  }

  async startScan() {
    throw new ProtocolPendingError(this.host);
  }

  async stopScan() {}

  close() {
    this.onFatal = null;
  }
}
