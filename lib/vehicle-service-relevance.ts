// Mirrors the current Otopair service groupings used for service-aware UI states.

const OIL_CHANGE_SERVICES = new Set(["oil change"]);

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
  return {
    hasOilChange: services.some(isOilChangeService),
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
