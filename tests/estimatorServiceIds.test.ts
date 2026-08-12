import { describe, it, expect } from "vitest";
import { SERVICE_ESTIMATOR_IDS } from "../convex/vehicleEnrichment/estimatorEndpointMatch";

describe("SERVICE_ESTIMATOR_IDS", () => {
  it("maps single-id services", () => {
    expect(SERVICE_ESTIMATOR_IDS.oil_change).toEqual({ serviceIds: [107] });
    expect(SERVICE_ESTIMATOR_IDS.spark_plugs).toEqual({ serviceIds: [128] });
    expect(SERVICE_ESTIMATOR_IDS.battery_replacement).toEqual({ serviceIds: [590] });
    expect(SERVICE_ESTIMATOR_IDS.wheel_alignment).toEqual({ serviceIds: [169] });
    expect(SERVICE_ESTIMATOR_IDS.brake_fluid_flush).toEqual({ serviceIds: [33] });
  });
  it("maps multi-id scope services", () => {
    expect(SERVICE_ESTIMATOR_IDS.filter_replacement).toEqual({ serviceIds: [14, 35] });        // air + cabin
    expect(SERVICE_ESTIMATOR_IDS.transmission_service).toEqual({ serviceIds: [507] });          // full-pan preferred
    expect(SERVICE_ESTIMATOR_IDS.rotor_replacement).toEqual({ serviceIds: [31, 4453439] });     // standalone + composite
  });
});
