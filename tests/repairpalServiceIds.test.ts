import { describe, it, expect } from "vitest";
import { SERVICE_REPAIRPAL_IDS } from "../convex/vehicleEnrichment/repairpalEndpointMatch";

describe("SERVICE_REPAIRPAL_IDS", () => {
  it("maps single-id services", () => {
    expect(SERVICE_REPAIRPAL_IDS.oil_change).toEqual({ serviceIds: [107] });
    expect(SERVICE_REPAIRPAL_IDS.spark_plugs).toEqual({ serviceIds: [128] });
    expect(SERVICE_REPAIRPAL_IDS.battery_replacement).toEqual({ serviceIds: [590] });
    expect(SERVICE_REPAIRPAL_IDS.wheel_alignment).toEqual({ serviceIds: [169] });
    expect(SERVICE_REPAIRPAL_IDS.brake_fluid_flush).toEqual({ serviceIds: [33] });
  });
  it("maps multi-id scope services", () => {
    expect(SERVICE_REPAIRPAL_IDS.filter_replacement).toEqual({ serviceIds: [14, 35] });        // air + cabin
    expect(SERVICE_REPAIRPAL_IDS.transmission_service).toEqual({ serviceIds: [507] });          // full-pan preferred
    expect(SERVICE_REPAIRPAL_IDS.rotor_replacement).toEqual({ serviceIds: [31, 4453439] });     // standalone + composite
  });
});
