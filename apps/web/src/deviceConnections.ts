import type { BrowseNode, Connection, DeviceConnectionType, DevicePoint, DeviceSettings, TagWriteDataType } from "./types";

export const deviceTypes: DeviceConnectionType[] = ["modbus-tcp", "ab-eip", "siemens-s7", "beckhoff-ads"];
export const scalarTypes: TagWriteDataType[] = ["Boolean", "Int16", "UInt16", "Int32", "UInt32", "Int64", "Float", "Double", "String"];
export const numericScalarTypes: TagWriteDataType[] = scalarTypes.filter(type => type !== "Boolean" && type !== "String");
export const pointStorageType = (point: DevicePoint) => point.rawDataType ?? point.dataType;
export const allenBradleyFamilies = ["ControlLogix", "CompactLogix", "Micro800", "MicroLogix", "Slc500", "Plc5"] as const;
export const allenBradleyFamilyName = (family: string) => family === "Slc500" ? "SLC 500" : family === "Plc5" ? "PLC-5" : family === "Micro800" ? "Micro800 (Micro850 / Micro870)" : family;
export const isLogixFamily = (family = "ControlLogix") => family === "ControlLogix" || family === "CompactLogix";
export const isPcccFamily = (family: string) => ["MicroLogix", "Slc500", "Plc5"].includes(family);
export const supportsNativeDeviceBrowse = (type: DeviceConnectionType, family?: string) => type === "beckhoff-ads" || type === "ab-eip" && isLogixFamily(family);
export const engineeringPointTypes = (type: DeviceConnectionType, family?: string) => type === "ab-eip" && !isPcccFamily(family ?? "ControlLogix") ? scalarTypes.filter(dataType => dataType !== "String") : scalarTypes;
export const rawNumericPointTypes = (type: DeviceConnectionType, family?: string): TagWriteDataType[] => type === "ab-eip" && isPcccFamily(family ?? "") ? ["Int16", "UInt16", "Float", ...(family === "MicroLogix" ? ["Int32", "UInt32"] as TagWriteDataType[] : [])] : numericScalarTypes;
export function withAllenBradleyFamily(settings: DeviceSettings, family: string): DeviceSettings {
  return { ...settings, controllerFamily: family, route: isLogixFamily(family) ? settings.route || "1,0" : "" };
}
export function validateAllenBradleySettings(settings: DeviceSettings): string[] {
  const family = settings.controllerFamily ?? "ControlLogix", route = settings.route ?? "";
  if (!allenBradleyFamilies.includes(family as typeof allenBradleyFamilies[number])) return ["Choose a supported Allen Bradley controller family."];
  if (!isLogixFamily(family)) return route ? ["This controller profile uses a direct connection and requires a blank CIP route."] : [];
  const components = route.split(",");
  return /^\d{1,3}(,\d{1,3})+$/.test(route) && components.length % 2 === 0 && components.every(part => Number(part) <= 255) ? [] : ["ControlLogix and CompactLogix require numeric port/link route pairs such as 1,0."];
}
export const isDeviceType = (type: string): type is DeviceConnectionType => deviceTypes.includes(type as DeviceConnectionType);
export const isEquipmentType = (type: string) => type === "opcua" || isDeviceType(type) || ["mtconnect", "i3x", "mqtt"].includes(type);
export const connectionTypeName = (type: Connection["type"]) => ({ opcua: "OPC UA client", sqlite: "SQLite", sqlserver: "SQL Server", anylog: "AnyLog query node", "modbus-tcp": "Modbus TCP", "ab-eip": "Allen Bradley EtherNet/IP", "siemens-s7": "Siemens S7", "beckhoff-ads": "Beckhoff ADS", mtconnect: "MTConnect agent", i3x: "i3X source", mqtt: "MQTT subscriber" })[type];
export const defaultDeviceSettings = (type: DeviceConnectionType): DeviceSettings => ({ host: "192.168.1.10", port: type === "modbus-tcp" ? 502 : type === "ab-eip" ? 44818 : type === "siemens-s7" ? 102 : 851, points: [],
  ...(type === "modbus-tcp" ? { unitId: 1 } : type === "ab-eip" ? { controllerFamily: "ControlLogix", route: "1,0" } : type === "siemens-s7" ? { controllerFamily: "S71200", rack: 0, slot: 0 } : { localAmsNetId: "", targetAmsNetId: "" }) });
export const pointAddressHint = (type: DeviceConnectionType, family?: string) => type === "modbus-tcp" ? "Zero-based address: holdingRegister:0, inputRegister:0, coil:0 or discreteInput:0."
  : type === "ab-eip" ? isPcccFamily(family ?? "") ? `PCCC: N7:0/B3:0 Int16 or UInt16, N7:0/0 Boolean, F8:0 Float, ST9:0 String (capacity 1–82).${family === "MicroLogix" ? " L9:0 Int32 or UInt32 is supported on MicroLogix." : " L files are outside this family profile."} File 0–255, element 0–65,535, bit 0–15. I/O, status, timer/counter files and subfields are outside this profile.` : family === "Micro800" ? "Controller-scoped symbol such as SpeedSetpoint or MyStruct.Value. Numeric and Boolean storage only; Program: scope and String layouts are outside this Micro800 profile." : "Controller symbol such as SpeedSetpoint or Program:Main.SpeedSetpoint."
  : type === "siemens-s7" ? "DB10.DBD20, DB10.DBX0.3, MW0 or M0.0. String points use a DBB address and declared capacity."
  : "PLC symbol such as MAIN.SpeedSetpoint. Use Browse symbols after saving to explore the controller.";
export const newDevicePoint = (type: DeviceConnectionType, index: number, family?: string): DevicePoint => ({ id: `point${index}`, name: `Point ${index}`, address: type === "modbus-tcp" ? `holdingRegister:${index - 1}` : type === "siemens-s7" ? "DB1.DBW0" : type === "ab-eip" && isPcccFamily(family ?? "") ? "N7:0" : type === "ab-eip" && family === "Micro800" ? "SpeedSetpoint" : "MAIN.SpeedSetpoint", dataType: type === "ab-eip" && isPcccFamily(family ?? "") ? "Int16" : "UInt16", writable: false, scale: 1, offset: 0 });
export function mappedDevicePoint(connection: Connection | undefined, node: BrowseNode) {
  const id = node.browseMode === "native" ? node.pointId : node.pointId ?? node.nodeId;
  return id ? connection?.device?.points.find(point => point.id === id && (node.browseMode !== "native" || point.address === node.address)) : undefined;
}
export function nativeDevicePoint(type: DeviceConnectionType, node: BrowseNode, index: number, controllerFamily?: string): DevicePoint {
  if (!engineeringPointTypes(type, controllerFamily).includes(node.dataType as TagWriteDataType)) throw new Error("Choose a supported scalar symbol for this controller profile.");
  return { ...newDevicePoint(type, index), name: node.displayName, address: node.address ?? node.nodeId,
    dataType: node.dataType as TagWriteDataType, rawDataType: node.dataType as TagWriteDataType,
    ...(node.dataType === "String" ? { stringLength: node.stringLength ?? (type === "ab-eip" ? 82 : 80) } : {}) };
}
export const stringCapacityLimit = (type: DeviceConnectionType, writable: boolean) => type === "siemens-s7" ? 254 : type === "ab-eip" ? 82 : type === "modbus-tcp" ? writable ? 246 : 250 : 1024;
export const maximumMapBytes = 768 * 1024;
export function deviceMapBytes(points: DevicePoint[]) {
  const normalized = points.map(point => ({ id: point.id, name: point.name, address: point.address, dataType: point.dataType, rawDataType: point.rawDataType ?? null, writable: point.writable, byteSwap: point.byteSwap ?? false, wordSwap: point.wordSwap ?? false, stringLength: point.stringLength ?? 32, scale: point.scale ?? 1, offset: point.offset ?? 0 }));
  return new TextEncoder().encode(JSON.stringify(normalized)).length;
}

/** Import validates authored configuration only; it never contacts a controller. */
export function validateDevicePoints(type: DeviceConnectionType, value: unknown, controllerFamily = "ControlLogix"): string[] {
  if (type === "ab-eip" && !allenBradleyFamilies.includes(controllerFamily as typeof allenBradleyFamilies[number])) return ["Choose a supported Allen Bradley controller family."];
  if (!Array.isArray(value)) return ["Register-map JSON must be an array of points or an object with a points array."];
  if (value.length > 10000) return ["A map may contain at most 10,000 points."];
  const errors: string[] = [], ids = new Set<string>();
  const fields = new Set(["id", "name", "address", "dataType", "rawDataType", "writable", "byteSwap", "wordSwap", "stringLength", "scale", "offset"]);
  for (let index = 0; index < value.length && errors.length < 50; index++) {
    const point = value[index], at = `Point ${index + 1}`;
    if (!point || typeof point !== "object" || Array.isArray(point)) { errors.push(`${at}: enter a point object.`); continue; }
    const item = point as Record<string, unknown>;
    if (Object.keys(item).some(key => !fields.has(key))) errors.push(`${at}: unrecognized point fields.`);
    if (typeof item.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id)) errors.push(`${at}: ID must start with a letter and use at most 64 letters, digits, underscores or hyphens.`);
    else if (ids.has(item.id)) errors.push(`${at}: duplicate ID ${item.id}.`); else ids.add(item.id);
    // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(item.name)) errors.push(`${at}: enter a name of 1–256 characters without control characters.`);
    // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
    if (typeof item.address !== "string" || !item.address.trim() || item.address.length > 512 || /[\u0000-\u001f\u007f-\u009f&=;]/.test(item.address)) errors.push(`${at}: enter an address of 1–512 characters without control characters or &, =, ;.`);
    if (!scalarTypes.includes(item.dataType as TagWriteDataType)) errors.push(`${at}: choose a supported scalar data type.`);
    const storageType = item.rawDataType ?? item.dataType;
    if (!scalarTypes.includes(storageType as TagWriteDataType)) errors.push(`${at}: choose a supported raw storage type.`);
    if ((["Boolean", "String"].includes(String(item.dataType)) || ["Boolean", "String"].includes(String(storageType))) && storageType !== item.dataType) errors.push(`${at}: Boolean and String storage must match the engineering type.`);
    if (typeof item.writable !== "boolean") errors.push(`${at}: writable must be true or false.`);
    for (const key of ["byteSwap", "wordSwap"]) if (item[key] !== undefined && typeof item[key] !== "boolean") errors.push(`${at}: ${key} must be true or false.`);
    if (type !== "modbus-tcp" && (item.byteSwap === true || item.wordSwap === true)) errors.push(`${at}: this driver uses its native byte/word layout.`);
    for (const key of ["scale", "offset"]) if (item[key] !== undefined && (typeof item[key] !== "number" || !Number.isFinite(item[key]))) errors.push(`${at}: ${key} must be a finite number.`);
    if (item.scale === 0) errors.push(`${at}: scale must be nonzero.`);
    if (["Int16", "UInt16", "Int32", "UInt32", "Int64"].includes(String(storageType)) || ["Int16", "UInt16", "Int32", "UInt32", "Int64"].includes(String(item.dataType))) {
      for (const key of ["scale", "offset"]) if (typeof item[key] === "number" && (Math.abs(item[key]) > 7.922816251426433e28 || item[key] !== 0 && Math.abs(item[key]) < 1e-28)) errors.push(`${at}: integer scaling ${key} must fit decimal precision (nonzero magnitude 1e-28 through 7.9228e28).`);
    }
    if (["String", "Boolean"].includes(String(item.dataType)) && ((item.scale !== undefined && item.scale !== 1) || (item.offset !== undefined && item.offset !== 0))) errors.push(`${at}: scaling applies to numeric points only.`);
    if (item.dataType === "String" && (!Number.isInteger(item.stringLength) || Number(item.stringLength) < 1 || Number(item.stringLength) > stringCapacityLimit(type, item.writable === true))) errors.push(`${at}: declare a valid string capacity (1–${stringCapacityLimit(type, item.writable === true)}).`);
    else if (item.stringLength !== undefined && (!Number.isInteger(item.stringLength) || Number(item.stringLength) < 1 || Number(item.stringLength) > 1024)) errors.push(`${at}: stringLength must be a whole number from 1 through 1,024.`);
    if (type === "modbus-tcp" && typeof item.address === "string") {
      const address = /^(coil|discreteInput|inputRegister|holdingRegister):(\d+)$/.exec(item.address);
      if (!address || Number(address[2]) > 65535) errors.push(`${at}: enter an explicit Modbus space and zero-based offset 0–65,535.`);
      else {
        const bit = address[1] === "coil" || address[1] === "discreteInput";
        if (bit !== (item.dataType === "Boolean")) errors.push(`${at}: Boolean points use coils/discrete inputs; numeric/text points use registers.`);
        if (item.writable === true && ["discreteInput", "inputRegister"].includes(address[1])) errors.push(`${at}: input spaces are read-only.`);
        const width = bit ? 1 : ["Int64", "Double"].includes(String(storageType)) ? 4 : ["Int32", "UInt32", "Float"].includes(String(storageType)) ? 2 : storageType === "String" ? Math.ceil(Number(item.stringLength) / 2) : 1;
        if (Number(address[2]) + width > 65536) errors.push(`${at}: value crosses the Modbus address boundary.`);
        if (!bit && width > (item.writable === true ? 123 : 125)) errors.push(`${at}: value exceeds the Modbus request size.`);
        if (bit && (item.byteSwap === true || item.wordSwap === true)) errors.push(`${at}: Boolean points have no byte or word order.`);
      }
    }
    if (type === "ab-eip" && isPcccFamily(controllerFamily) && typeof item.address === "string") {
      const address = /^(ST|N|B|F|L)(\d{1,3}):(\d{1,5})(?:\/(\d{1,2}))?$/i.exec(item.address);
      if (!address || Number(address[2]) > 255 || Number(address[3]) > 65535 || address[4] !== undefined && Number(address[4]) > 15) errors.push(`${at}: use a supported PCCC file element within file 0–255, element 0–65,535 and bit 0–15.`);
      else {
        const file = address[1].toUpperCase(), bit = address[4] !== undefined;
        const valid = bit ? ["N", "B"].includes(file) && storageType === "Boolean" : ["N", "B"].includes(file) ? ["Int16", "UInt16"].includes(String(storageType)) : file === "F" ? storageType === "Float" : file === "ST" ? storageType === "String" : file === "L" && controllerFamily === "MicroLogix" && ["Int32", "UInt32"].includes(String(storageType));
        if (!valid) errors.push(`${at}: PCCC file and bit address must match a supported raw storage type for ${allenBradleyFamilyName(controllerFamily)}.`);
      }
    }
    if ((type === "ab-eip" && !isPcccFamily(controllerFamily) || type === "beckhoff-ads") && typeof item.address === "string") {
      const symbol = type === "ab-eip" && controllerFamily !== "Micro800" ? /^(?:Program:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?)*$/ : /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?)*$/;
      if (!symbol.test(item.address)) errors.push(`${at}: enter a controller symbol/member path or array element.`);
      if (type === "ab-eip" && (storageType === "String" || item.dataType === "String")) errors.push(`${at}: String storage is outside the qualified ${allenBradleyFamilyName(controllerFamily)} profile; use numeric/Boolean symbols.`);
    }
    if (type === "siemens-s7" && typeof item.address === "string") {
      const db = /^DB(\d{1,5})\.DB([XBWD])(\d{1,7})(?:\.([0-7]))?$/i.exec(item.address), direct = /^([MIQE])([BWD]?)(\d{1,7})(?:\.([0-7]))?$/i.exec(item.address);
      if (!db && !direct) errors.push(`${at}: enter an explicit S7 DB or memory byte/bit address.`);
      else {
        const layout = (db?.[2] ?? direct?.[2] ?? "").toUpperCase(), bit = db?.[4] ?? direct?.[4], start = Number(db?.[3] ?? direct?.[3]);
        const width = storageType === "String" ? Number(item.stringLength) + 2 : ["Int64", "Double"].includes(String(storageType)) ? 8 : ["Int32", "UInt32", "Float"].includes(String(storageType)) ? 4 : storageType === "Boolean" ? 1 : 2;
        if (item.dataType === "Boolean" ? bit === undefined || !["X", ""].includes(layout) : bit !== undefined || ["X", ""].includes(layout) || layout === "W" && width !== 2 || layout === "D" && width !== 4) errors.push(`${at}: S7 address layout must match the point data type.`);
        if (Number(db?.[1] ?? 0) > 65535 || start + width > 2097152) errors.push(`${at}: point crosses the supported S7 address boundary.`);
        if (item.writable === true && direct && direct[1].toUpperCase() !== "M") errors.push(`${at}: this S7 profile writes only DB and marker memory.`);
      }
    }
  }
  if (!errors.length && deviceMapBytes(value as DevicePoint[]) > maximumMapBytes) errors.push("The compact register map exceeds 768 KiB. Reduce the number or size of point definitions.");
  return errors;
}
export function parseDevicePointImport(type: DeviceConnectionType, text: string, controllerFamily?: string): DevicePoint[] {
  if (text.length > 2 * 1024 * 1024) throw new Error("Register-map JSON exceeds 2 MiB.");
  const parsed: unknown = JSON.parse(text), points = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { points?: unknown }).points : undefined;
  const errors = validateDevicePoints(type, points, controllerFamily);
  if (errors.length) throw new Error(errors.join("\n"));
  return points as DevicePoint[];
}
export function deviceMapChanges(before: DevicePoint[], after: DevicePoint[]) {
  const old = new Map(before.map(point => [point.id, point])), next = new Set(after.map(point => point.id));
  return [...after.map(point => ({ id: point.id, name: point.name, action: !old.has(point.id) ? "Add" : JSON.stringify(old.get(point.id)) === JSON.stringify(point) ? "Unchanged" : "Change" })), ...before.filter(point => !next.has(point.id)).map(point => ({ id: point.id, name: point.name, action: "Remove" }))];
}
