// Independently authored two-machine fixture for the UNS workshop. No physical devices.
const devices = ['Haas01', 'Haas02'];
export function unsProbe(header) {
  return `<?xml version="1.0"?><MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:2.8">${header}<Devices>${devices.map(device => `<Device id="${device}" name="${device}" uuid="${device}"><Components><Controller id="${device}-controller" name="Controller"><DataItems><DataItem id="${device}-Sspeed" name="Sspeed" category="SAMPLE" type="ROTARY_VELOCITY" units="REVOLUTION/MINUTE"/><DataItem id="${device}-Sload" name="Sload" category="SAMPLE" type="LOAD" units="PERCENT"/><DataItem id="${device}-execution" name="execution" category="EVENT" type="EXECUTION"/><DataItem id="${device}-PartCountAct" name="PartCountAct" category="EVENT" type="PART_COUNT"/></DataItems></Controller></Components></Device>`).join('')}</Devices></MTConnectDevices>`;
}
export function unsCurrent(header, tick, from = 0) {
  const at = new Date().toISOString();
  const observation = (device, tag, name, value, sequence) => sequence < from ? '' : `<${tag} dataItemId="${device}-${name}" timestamp="${at}" sequence="${sequence}">${value}</${tag}>`;
  const streams = devices.map((device, index) => {
    const sequence = tick * 8 + index * 4 + 1;
    const samples = observation(device, 'RotaryVelocity', 'Sspeed', 7200 + index * 300 + tick % 100, sequence)
      + observation(device, 'Load', 'Sload', 35 + index * 10 + tick % 20, sequence + 1);
    const events = observation(device, 'Execution', 'execution', tick % 10 < 8 ? 'ACTIVE' : 'READY', sequence + 2)
      + observation(device, 'PartCount', 'PartCountAct', 1000 + index * 100 + tick, sequence + 3);
    return `<DeviceStream name="${device}" uuid="${device}"><ComponentStream component="Controller" componentId="${device}-controller"><Samples>${samples}</Samples><Events>${events}</Events></ComponentStream></DeviceStream>`;
  }).join('');
  return `<?xml version="1.0"?><MTConnectStreams xmlns="urn:mtconnect.org:MTConnectStreams:2.8">${header}<Streams>${streams}</Streams></MTConnectStreams>`;
}
