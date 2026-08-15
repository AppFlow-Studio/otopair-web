// Mirrors the current Otopair service groupings used for service-aware UI states.

const OIL_CHANGE_SERVICES = new Set(["oil change"]);
const BATTERY_TEST_SERVICES = new Set(["battery test", "battery test service"]);
const TIRE_REPLACEMENT_SERVICES = new Set(["tire replacement"]);
const COOLANT_FLUSH_SERVICES = new Set(["coolant flush"]);
const TRANSMISSION_FLUID_SERVICES = new Set([
  "transmission fluid service",
  "transmission service",
]);
const TIRE_ROTATION_SERVICES = new Set(["tire rotation"]);
const TIRE_BALANCING_SERVICES = new Set([
  "tire balance",
  "tire balancing",
  "wheel balance",
  "wheel balancing",
]);
const WHEEL_ALIGNMENT_SERVICES = new Set(["wheel alignment"]);
const BRAKE_PAD_REPLACEMENT_SERVICES = new Set(["brake pad replacement"]);
const ROTOR_REPLACEMENT_SERVICES = new Set(["rotor replacement", "brake rotor replacement"]);
const BRAKE_FLUID_FLUSH_SERVICES = new Set(["brake fluid flush"]);
const POWER_STEERING_FLUSH_SERVICES = new Set(["power steering flush"]);
const ENGINE_AIR_FILTER_SERVICES = new Set([
  "engine air filter",
  "engine air filter replacement",
]);
const CABIN_AIR_FILTER_SERVICES = new Set([
  "cabin air filter",
  "cabin air filter replacement",
]);

const TIRE_AND_WHEEL_SERVICES = new Set([
  "tire rotation",
  "wheel balancing",
  "wheel alignment",
  "tire replacement",
  "tire installation",
  "tpms sensor calibration",
]);

// Live catalog brake services (normalized names). "Rotor Replacement" has no
// "brake" token, so it's covered explicitly + via the includes("rotor") check.
const BRAKE_SERVICES = new Set([
  "brake pad replacement",
  "rotor replacement",
  "brake fluid flush",
]);

// Live catalog fluid services (normalized names).
const FLUID_SERVICES = new Set([
  "oil change",
  "coolant flush",
  "transmission service",
  "brake fluid flush",
  "power steering flush",
  "differential service",
]);

function tokenizeServiceName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeServiceName(value: string) {
  return tokenizeServiceName(value);
}

export function normalizeServiceNames(services: string[]) {
  return services.map(normalizeServiceName).filter(Boolean);
}

export function isOilChangeService(value: string) {
  const normalized = normalizeServiceName(value);
  return OIL_CHANGE_SERVICES.has(normalized);
}

export function isBatteryTestService(value: string) {
  const normalized = normalizeServiceName(value);
  return BATTERY_TEST_SERVICES.has(normalized);
}

export function isTireReplacementService(value: string) {
  return TIRE_REPLACEMENT_SERVICES.has(normalizeServiceName(value));
}

export function isCoolantFlushService(value: string) {
  return COOLANT_FLUSH_SERVICES.has(normalizeServiceName(value));
}

export function isTransmissionFluidService(value: string) {
  return TRANSMISSION_FLUID_SERVICES.has(normalizeServiceName(value));
}

export function isTireService(value: string) {
  const normalized = normalizeServiceName(value);
  return (
    TIRE_AND_WHEEL_SERVICES.has(normalized) ||
    normalized.includes("tire") ||
    normalized.includes("wheel") ||
    normalized.includes("alignment") ||
    normalized.includes("tpms")
  );
}

export function isBrakeService(value: string) {
  const normalized = normalizeServiceName(value);
  return (
    BRAKE_SERVICES.has(normalized) ||
    normalized.includes("brake") ||
    normalized.includes("rotor")
  );
}

export function isFluidService(value: string) {
  const normalized = normalizeServiceName(value);
  return (
    FLUID_SERVICES.has(normalized) ||
    normalized.includes("coolant") ||
    normalized.includes("fluid") ||
    normalized.includes("flush")
  );
}

export function getBookingServiceFlags(services: string[]) {
  const normalized = normalizeServiceNames(services);
  const has = (catalog: Set<string>) => normalized.some((name) => catalog.has(name));
  return {
    hasOilChange: services.some(isOilChangeService),
    hasBatteryTest: services.some(isBatteryTestService),
    hasTireReplacement: services.some(isTireReplacementService),
    hasCoolantFlush: services.some(isCoolantFlushService),
    hasTransmissionFluidService: services.some(isTransmissionFluidService),
    hasTireRotation: has(TIRE_ROTATION_SERVICES),
    hasTireBalancing: has(TIRE_BALANCING_SERVICES),
    hasWheelAlignment: has(WHEEL_ALIGNMENT_SERVICES),
    hasBrakePadReplacement: has(BRAKE_PAD_REPLACEMENT_SERVICES),
    hasRotorReplacement: has(ROTOR_REPLACEMENT_SERVICES),
    hasBrakeFluidFlush: has(BRAKE_FLUID_FLUSH_SERVICES),
    hasPowerSteeringFlush: has(POWER_STEERING_FLUSH_SERVICES),
    hasEngineAirFilterReplacement: has(ENGINE_AIR_FILTER_SERVICES),
    hasCabinAirFilterReplacement: has(CABIN_AIR_FILTER_SERVICES),
    hasTireWork: services.some(isTireService),
    hasBrakeWork: services.some(isBrakeService),
    hasFluidWork: services.some(
      (service) => isOilChangeService(service) || isFluidService(service)
    ),
  };
}

export function serviceListsOverlap(left: string[], right: string[]) {
  const rightSet = new Set(normalizeServiceNames(right));
  return normalizeServiceNames(left).some((service) => rightSet.has(service));
}
