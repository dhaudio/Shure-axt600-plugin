// The one seam between this plugin and an AXT600.
//
// adapter.js knows nothing about the wire. It talks to a "link", which is
// anything with these members:
//
//   connect()                  -> { model, firmware, name? }
//   configureScan(scan)        scan = { startHz, stepHz, deviceCount }
//                              -> the scan the unit is set to, same shape
//   startScan(onTile, onPassEnd)
//                              onTile({ startHz, stepHz, amplitudesDbm }) for
//                              every piece of scan data, in any order;
//                              onPassEnd() when a pass over the range is done
//   stopScan()
//   close()                    release everything; not a failure
//   onFatal                    assigned by the user; call it when the link dies
//
// Two implementations: SimulatedAxt600, which pretends, and Axt600NetworkLink,
// which speaks ACN to a real unit (driver/axt600-link.js).

import { SimulatedAxt600 } from './simulated-axt600.js';
import { Axt600NetworkLink } from './axt600-link.js';
import { SlpListener, SLP_PORT } from './slp.js';
import { cidFromString } from './acn.js';

export const SIMULATED_HOST = 'simulated';

/** Is this device the pretend one? */
export const isSimulated = (device) =>
  device?.config?.host === SIMULATED_HOST || /^sim:/.test(device?.id ?? '');

let slp = null;
/**
 * One listener for the whole plugin. SB_AXT600_SLP_PORT moves it to a loopback
 * port with no multicast, for tests.
 */
export function slpListener(log) {
  if (!slp) {
    const testPort = Number(process.env.SB_AXT600_SLP_PORT);
    slp = new SlpListener(
      testPort
        ? { port: testPort, multicast: false, log }
        : { port: SLP_PORT, multicast: true, log }
    );
  }
  return slp;
}

/**
 * The link for a device. `timeScale` speeds up the simulator: 1 is real time,
 * which is what someone looking at the plugin in SoundBase should see.
 */
export function createLink(device, { host, timeScale = 1, log } = {}) {
  if (isSimulated(device)) return new SimulatedAxt600({ timeScale });
  return new Axt600NetworkLink({
    host,
    cid: cidFromString(device?.config?.cid),
    slp: slpListener(log),
    log,
  });
}

export { Axt600NetworkLink };
